/**
 * Regression test for the external-write clobber bug.
 *
 * Inbox brief: 2026-05-17-open-file-autosave-clobbers-external-writes.md
 *
 * Scenario: a doc is opened (e.g. via `open_file`) and an external tool
 * (Write, an editor, a script) modifies the file on disk. Without a guard,
 * openwriter's next auto-save writes its stale in-memory version back to
 * disk, silently overwriting the external content.
 *
 * Fix verified by this test:
 *   1. `setActiveDocument` stamps `state.loadedMtime` from disk at load.
 *   2. `writeToDisk` checks the live disk mtime against `state.loadedMtime`
 *      before writing — if they differ, an external writer is in play and
 *      the save is blocked.
 *   3. An `onExternalWriteConflict` listener fires so the WS layer can
 *      broadcast to clients.
 *   4. `refreshLoadedMtime` lets reload_from_disk re-stamp after adopting
 *      external content (so the next save can proceed).
 *   5. `getExternalMtimeDrift` exposes the drift to get_pad_status callers.
 *
 * Run: `node scripts/test-external-write-guard.mjs`
 */

import { mkdirSync, rmSync, writeFileSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import {
  setActiveDocument,
  getDocument,
  save,
  cancelDebouncedSave,
  onExternalWriteConflict,
  getExternalMtimeDrift,
  refreshLoadedMtime,
} from '../dist/server/state.js';
import { setActiveProfile, ensureDataDir } from '../dist/server/helpers.js';

let passed = 0;
let failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log(`  PASS: ${msg}`); }
  else      { failed++; console.error(`  FAIL: ${msg}`); }
}

const TEST_PROFILE = `test-external-write-${Date.now()}`;
const TEST_PROFILE_DIR = join(homedir(), '.openwriter', 'profiles', TEST_PROFILE);
function cleanup() {
  cancelDebouncedSave();
  try { rmSync(TEST_PROFILE_DIR, { recursive: true, force: true }); } catch { /* best-effort */ }
}
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(1); });

setActiveProfile(TEST_PROFILE);
mkdirSync(TEST_PROFILE_DIR, { recursive: true });
ensureDataDir();

// Wait helper: ensure mtime ticks forward between writes (filesystems have
// varying mtime resolution — 1ms on NTFS, up to 1s on FAT/HFS).
function waitForMtimeBump() {
  const target = Date.now() + 50;
  while (Date.now() < target) { /* busy wait — short and deterministic */ }
}

try {
  // ==========================================================================
  // Setup: create a doc on disk, load it via setActiveDocument
  // ==========================================================================
  console.log('Setup: write doc to disk, load via setActiveDocument');

  const filePath = join(TEST_PROFILE_DIR, 'ext-test.md');
  const initialMd = '---\n{"title":"Ext Test","docId":"ext00001"}\n---\n\nOriginal openwriter content.\n\n';
  writeFileSync(filePath, initialMd, 'utf-8');
  waitForMtimeBump();

  const initialDoc = {
    type: 'doc',
    content: [
      { type: 'paragraph', attrs: { id: 'p01' }, content: [{ type: 'text', text: 'Original openwriter content.' }] },
    ],
  };
  setActiveDocument(initialDoc, 'Ext Test', filePath, false, undefined, { title: 'Ext Test', docId: 'ext00001' });

  // ==========================================================================
  // Bug A repro: external write between load and save → guard blocks save
  // ==========================================================================
  console.log('\nCase 1: external write between load and save is detected');
  {
    let conflictsReceived = [];
    const off = onExternalWriteConflict((c) => { conflictsReceived.push(c); });

    // Simulate an external tool overwriting the file on disk
    waitForMtimeBump();
    writeFileSync(filePath, '---\n{"title":"Ext Test","docId":"ext00001"}\n---\n\nEXTERNAL TOOL WROTE THIS — should not be clobbered.\n\n', 'utf-8');
    waitForMtimeBump();
    const externalContent = readFileSync(filePath, 'utf-8');

    // Attempt an openwriter save — should be blocked
    save();
    cancelDebouncedSave();

    const afterSave = readFileSync(filePath, 'utf-8');
    assert(afterSave === externalContent,
      'external content preserved on disk — save was blocked');
    assert(afterSave.includes('EXTERNAL TOOL WROTE THIS'),
      'external content still present (not overwritten by stale openwriter state)');
    assert(conflictsReceived.length === 1,
      `external-write-conflict listener fired exactly once (got ${conflictsReceived.length})`);
    assert(conflictsReceived[0]?.filePath === filePath,
      'conflict payload carries the file path');
    assert(typeof conflictsReceived[0]?.diskMtime === 'number' && conflictsReceived[0].diskMtime > 0,
      'conflict payload includes disk mtime');
    assert(typeof conflictsReceived[0]?.loadedMtime === 'number' && conflictsReceived[0].loadedMtime > 0,
      'conflict payload includes loaded mtime');
    assert(conflictsReceived[0].diskMtime !== conflictsReceived[0].loadedMtime,
      'conflict payload shows the mtimes differ');

    off();
  }

  // ==========================================================================
  // getExternalMtimeDrift surfaces the same drift for get_pad_status
  // ==========================================================================
  console.log('\nCase 2: getExternalMtimeDrift exposes the conflict');
  {
    const drift = getExternalMtimeDrift();
    assert(!!drift, 'drift is reported (not null)');
    assert(drift?.diskMtime !== drift?.loadedMtime,
      `drift values differ (disk=${drift?.diskMtime}, loaded=${drift?.loadedMtime})`);
  }

  // ==========================================================================
  // refreshLoadedMtime: adopt the external state, next save should proceed
  // ==========================================================================
  console.log('\nCase 3: refreshLoadedMtime allows subsequent saves to proceed');
  {
    // Caller pattern: read disk, updateDocument with the new content, refresh
    // mtime, save. (reload_from_disk does this.)
    refreshLoadedMtime();

    // Now adopt the external content into in-memory state
    const newDoc = {
      type: 'doc',
      content: [
        { type: 'paragraph', attrs: { id: 'p01' }, content: [{ type: 'text', text: 'EXTERNAL TOOL WROTE THIS — should not be clobbered.' }] },
        // openwriter then appends new content on top
        { type: 'paragraph', attrs: { id: 'p02' }, content: [{ type: 'text', text: 'New openwriter addition after reload.' }] },
      ],
    };
    setActiveDocument(newDoc, 'Ext Test', filePath, false, undefined, { title: 'Ext Test', docId: 'ext00001' });

    // No more drift
    assert(getExternalMtimeDrift() === null,
      'no drift after setActiveDocument re-stamped loadedMtime');

    // Save should now succeed
    let conflictsReceived = [];
    const off = onExternalWriteConflict((c) => { conflictsReceived.push(c); });
    save();
    cancelDebouncedSave();
    off();

    assert(conflictsReceived.length === 0,
      'no external-write conflict fired on the post-reload save');

    const afterSave = readFileSync(filePath, 'utf-8');
    assert(afterSave.includes('EXTERNAL TOOL WROTE THIS'),
      'external content still present after openwriter save (was preserved in-memory)');
    assert(afterSave.includes('New openwriter addition after reload'),
      'openwriter additions also landed on disk');
  }

  // ==========================================================================
  // Idempotent save: no external write, save succeeds without conflict
  // ==========================================================================
  console.log('\nCase 4: normal save with no external write fires no conflict');
  {
    let conflictsReceived = [];
    const off = onExternalWriteConflict((c) => { conflictsReceived.push(c); });

    // Trigger another save by mutating in-memory state
    const newDoc = {
      type: 'doc',
      content: [
        { type: 'paragraph', attrs: { id: 'p01' }, content: [{ type: 'text', text: 'EXTERNAL TOOL WROTE THIS — should not be clobbered.' }] },
        { type: 'paragraph', attrs: { id: 'p02' }, content: [{ type: 'text', text: 'New openwriter addition after reload.' }] },
        { type: 'paragraph', attrs: { id: 'p03' }, content: [{ type: 'text', text: 'Even more openwriter content.' }] },
      ],
    };
    setActiveDocument(newDoc, 'Ext Test', filePath, false, undefined, { title: 'Ext Test', docId: 'ext00001' });
    save();
    cancelDebouncedSave();
    off();

    assert(conflictsReceived.length === 0, 'no conflict on a clean save');
    const final = readFileSync(filePath, 'utf-8');
    assert(final.includes('Even more openwriter content'), 'newest content landed on disk');
  }

  // ==========================================================================
  // First save of a new doc (no prior file) should not falsely trip the guard
  // ==========================================================================
  console.log('\nCase 5: first save of a new doc does not trip the guard');
  {
    const newPath = join(TEST_PROFILE_DIR, 'fresh-doc.md');
    const freshDoc = {
      type: 'doc',
      content: [{ type: 'paragraph', attrs: { id: 'p_fresh' }, content: [{ type: 'text', text: 'Brand new doc.' }] }],
    };
    let conflictsReceived = [];
    const off = onExternalWriteConflict((c) => { conflictsReceived.push(c); });
    setActiveDocument(freshDoc, 'Fresh', newPath, false, undefined, { title: 'Fresh', docId: 'frsh0001' });
    save();
    cancelDebouncedSave();
    off();

    assert(conflictsReceived.length === 0, 'no conflict on first save of a new doc');
    const onDisk = readFileSync(newPath, 'utf-8');
    assert(onDisk.includes('Brand new doc'), 'new doc content lands on disk');
  }

  // ==========================================================================
  // The guard only blocks when mtime DIFFERS — repeated saves with no
  // external modification work normally
  // ==========================================================================
  console.log('\nCase 6: back-to-back saves work without spurious conflict');
  {
    let conflictsReceived = [];
    const off = onExternalWriteConflict((c) => { conflictsReceived.push(c); });

    for (let i = 0; i < 3; i++) {
      const doc = {
        type: 'doc',
        content: [{
          type: 'paragraph',
          attrs: { id: `p_iter_${i}` },
          content: [{ type: 'text', text: `Save iteration ${i}.` }],
        }],
      };
      const path = join(TEST_PROFILE_DIR, `iter-${i}.md`);
      setActiveDocument(doc, `Iter ${i}`, path, false, undefined, { title: `Iter ${i}`, docId: `itr0000${i}` });
      save();
      cancelDebouncedSave();
    }
    off();

    assert(conflictsReceived.length === 0, 'no spurious conflicts across 3 saves');
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed > 0 ? 1 : 0;
} catch (err) {
  console.error('TEST CRASH:', err);
  process.exitCode = 1;
}
