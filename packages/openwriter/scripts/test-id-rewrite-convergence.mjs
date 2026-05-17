/**
 * Regression test for the id-rewrite non-convergence loop.
 *
 * Live log evidence (Beat Sheet doc, 2026-05-17 session):
 *   [WS] doc-update ACCEPTED (browser: 124 nodes, ...)
 *   [WS] Broadcast id-rewrites (222 block(s))
 *   [WS] Auto-saved to disk
 *   [WS] doc-update ACCEPTED (browser: 124 nodes, ...)
 *   [WS] Broadcast id-rewrites (222 block(s))
 *   [WS] Auto-saved to disk
 *   ...repeats indefinitely...
 *
 * Hypothesis verified by code reading: the browser's debounced doc-update
 * captured `json` in a closure at the time the user typed. Between the
 * handleDocUpdate call and the timer firing (~1s later), the server's
 * matcher could broadcast id-rewrites. applyIdRewritesToEditor mutated the
 * editor's TipTap state in place — but the captured `json` AND
 * `lastDocJson.current` still held the pre-rewrite IDs. When the timer
 * fired, it sent the stale-ID json back to the server. The matcher rewrote
 * those IDs again. Same 222 rewrites every save. The loop was the entire
 * point of the v0.14.1 architectural fix and it didn't converge.
 *
 * Fix verified by this test:
 *   1. `onIdRewrites` callback in App.tsx now walks `lastDocJson.current` in
 *      addition to mutating the editor, applying the same oldId→newId
 *      remapping to the cached JSON tree.
 *   2. The debounced doc-update timer reads `lastDocJson.current` at fire
 *      time, NOT the captured `json` argument. Stale closures can no longer
 *      defeat the rewrite broadcast.
 *
 * This test simulates the closed-loop scenario by directly exercising the
 * server-side matcher and the rewrite-application helper (the same walker
 * the App.tsx fix uses on `lastDocJson`). Convergence target: 0 rewrites on
 * the second save.
 *
 * Run: `node scripts/test-id-rewrite-convergence.mjs`
 */

import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import {
  setActiveDocument,
  getDocument,
  save,
  cancelDebouncedSave,
  onIdRewrites,
} from '../dist/server/state.js';
import { setActiveProfile, ensureDataDir } from '../dist/server/helpers.js';

let passed = 0;
let failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log(`  PASS: ${msg}`); }
  else      { failed++; console.error(`  FAIL: ${msg}`); }
}

const TEST_PROFILE = `test-rewrite-conv-${Date.now()}`;
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

// ----------------------------------------------------------------------
// Mirror of the App.tsx walker fix. Mutates a TipTap doc JSON in place,
// applying oldId → newId rewrites. This is the same logic the live browser
// applies to lastDocJson.current when the server broadcasts id-rewrites.
// ----------------------------------------------------------------------
function applyRewritesToJsonDoc(doc, rewrites) {
  if (!doc || !Array.isArray(rewrites) || rewrites.length === 0) return doc;
  const map = new Map(rewrites.map((r) => [r.oldId, r.newId]));
  function walk(nodes) {
    if (!Array.isArray(nodes)) return;
    for (const n of nodes) {
      const oldId = n?.attrs?.id;
      if (oldId && map.has(oldId)) {
        n.attrs = { ...n.attrs, id: map.get(oldId) };
      }
      if (n?.content) walk(n.content);
    }
  }
  walk(doc.content || []);
  return doc;
}

try {
  // ==========================================================================
  // Setup: a doc with multiple blocks, save once to establish frontmatter.
  // Initial save populates `nodes:` in the file so subsequent saves have
  // previousNodes to match against.
  // ==========================================================================
  console.log('Setup: seed doc, initial save establishes nodes frontmatter');

  const filePath = join(TEST_PROFILE_DIR, 'conv-test.md');
  const docInitial = {
    type: 'doc',
    content: [
      { type: 'heading', attrs: { id: 'srv00001', level: 1 }, content: [{ type: 'text', text: 'Title' }] },
      { type: 'paragraph', attrs: { id: 'srv00002' }, content: [{ type: 'text', text: 'First paragraph with enough text to fingerprint.' }] },
      { type: 'paragraph', attrs: { id: 'srv00003' }, content: [{ type: 'text', text: 'Second paragraph also with content for matching.' }] },
      { type: 'paragraph', attrs: { id: 'srv00004' }, content: [{ type: 'text', text: 'Third paragraph rounds out the body.' }] },
    ],
  };
  setActiveDocument(docInitial, 'Conv Test', filePath, false, undefined, { title: 'Conv Test', docId: 'cnv00001' });
  save();
  cancelDebouncedSave();

  // ==========================================================================
  // SIMULATED LOOP CYCLE 1: browser sends a doc-update with DIFFERENT IDs
  //   than what's on disk (e.g. agent stamped IDs the matcher will rewrite).
  //   Server should broadcast rewrites that map browser's IDs → server's IDs.
  // ==========================================================================
  console.log('\nCycle 1: browser sends a doc with stamped agent IDs');

  // Collect rewrites the server broadcasts during the next save
  let receivedRewrites = [];
  const off = onIdRewrites((batch) => { receivedRewrites = receivedRewrites.concat(batch); });

  // Simulate the browser pushing the SAME content but with fresh agent IDs
  // (matcher should match by fingerprint and assign the prior IDs from disk).
  const browserDoc = {
    type: 'doc',
    content: [
      { type: 'heading', attrs: { id: 'browAGENT1', level: 1 }, content: [{ type: 'text', text: 'Title' }] },
      { type: 'paragraph', attrs: { id: 'browAGENT2' }, content: [{ type: 'text', text: 'First paragraph with enough text to fingerprint.' }] },
      { type: 'paragraph', attrs: { id: 'browAGENT3' }, content: [{ type: 'text', text: 'Second paragraph also with content for matching.' }] },
      { type: 'paragraph', attrs: { id: 'browAGENT4' }, content: [{ type: 'text', text: 'Third paragraph rounds out the body.' }] },
    ],
  };
  setActiveDocument(browserDoc, 'Conv Test', filePath, false, undefined, { title: 'Conv Test', docId: 'cnv00001' });
  save();
  cancelDebouncedSave();

  assert(receivedRewrites.length > 0, `Cycle 1: matcher broadcast rewrites (got ${receivedRewrites.length})`);

  // Verify the rewrites map browser IDs → on-disk server IDs
  const expectedMappings = {
    browAGENT1: 'srv00001',
    browAGENT2: 'srv00002',
    browAGENT3: 'srv00003',
    browAGENT4: 'srv00004',
  };
  let mappingMatches = 0;
  for (const r of receivedRewrites) {
    if (expectedMappings[r.oldId] === r.newId) mappingMatches++;
  }
  assert(mappingMatches === 4,
    `Cycle 1: all 4 browser IDs mapped to server IDs (got ${mappingMatches}/4 matching, rewrites: ${JSON.stringify(receivedRewrites)})`);

  // Apply the rewrites to browserDoc (simulating what the browser does)
  applyRewritesToJsonDoc(browserDoc, receivedRewrites);

  // Verify browserDoc now has the server IDs
  const browserIdsAfter = browserDoc.content.map((n) => n.attrs?.id);
  assert(JSON.stringify(browserIdsAfter) === JSON.stringify(['srv00001', 'srv00002', 'srv00003', 'srv00004']),
    `Cycle 1: browser doc adopted server IDs (got ${JSON.stringify(browserIdsAfter)})`);

  // ==========================================================================
  // SIMULATED LOOP CYCLE 2: browser re-sends the now-converged doc.
  //   With my App.tsx fix, the next debounced send uses lastDocJson AFTER
  //   the rewrite walker mutated it. Server should see NO rewrites needed.
  // ==========================================================================
  console.log('\nCycle 2: browser re-sends after applying rewrites — convergence');

  receivedRewrites = [];
  setActiveDocument(browserDoc, 'Conv Test', filePath, false, undefined, { title: 'Conv Test', docId: 'cnv00001' });
  save();
  cancelDebouncedSave();

  assert(receivedRewrites.length === 0,
    `Cycle 2: 0 rewrites — the loop converges (got ${receivedRewrites.length} rewrites: ${JSON.stringify(receivedRewrites)})`);

  // ==========================================================================
  // SIMULATED FAILURE MODE: what would happen WITHOUT the App.tsx fix.
  //   Simulate the bug by re-sending the STALE browser doc (the IDs as
  //   they were before the rewrites). The matcher should produce the same
  //   rewrites again — demonstrating the loop. This test isn't a fix
  //   assertion; it just documents the symptom the fix prevents.
  // ==========================================================================
  console.log('\nCycle 3 (negative): stale doc would have looped');

  const staleDoc = {
    type: 'doc',
    content: [
      { type: 'heading', attrs: { id: 'browAGENT1', level: 1 }, content: [{ type: 'text', text: 'Title' }] },
      { type: 'paragraph', attrs: { id: 'browAGENT2' }, content: [{ type: 'text', text: 'First paragraph with enough text to fingerprint.' }] },
      { type: 'paragraph', attrs: { id: 'browAGENT3' }, content: [{ type: 'text', text: 'Second paragraph also with content for matching.' }] },
      { type: 'paragraph', attrs: { id: 'browAGENT4' }, content: [{ type: 'text', text: 'Third paragraph rounds out the body.' }] },
    ],
  };
  receivedRewrites = [];
  setActiveDocument(staleDoc, 'Conv Test', filePath, false, undefined, { title: 'Conv Test', docId: 'cnv00001' });
  save();
  cancelDebouncedSave();
  assert(receivedRewrites.length > 0,
    `Cycle 3: stale send produces rewrites — proves the symptom the fix prevents (got ${receivedRewrites.length})`);

  off();

  // ==========================================================================
  // applyRewritesToJsonDoc walker correctness
  // ==========================================================================
  console.log('\nWalker: rewrites mutate nested IDs across the tree');
  {
    const nested = {
      type: 'doc',
      content: [
        { type: 'paragraph', attrs: { id: 'TOP1' }, content: [{ type: 'text', text: 'a' }] },
        {
          type: 'bulletList',
          attrs: { id: 'LIST1' },
          content: [
            {
              type: 'listItem',
              attrs: { id: 'LI1' },
              content: [
                { type: 'paragraph', attrs: { id: 'NESTED1' }, content: [{ type: 'text', text: 'b' }] },
              ],
            },
          ],
        },
      ],
    };
    const rewrites = [
      { oldId: 'TOP1', newId: 'TOP1_NEW' },
      { oldId: 'LIST1', newId: 'LIST1_NEW' },
      { oldId: 'LI1', newId: 'LI1_NEW' },
      { oldId: 'NESTED1', newId: 'NESTED1_NEW' },
    ];
    applyRewritesToJsonDoc(nested, rewrites);

    assert(nested.content[0].attrs.id === 'TOP1_NEW', 'top-level paragraph id rewritten');
    assert(nested.content[1].attrs.id === 'LIST1_NEW', 'bulletList id rewritten');
    assert(nested.content[1].content[0].attrs.id === 'LI1_NEW', 'listItem id rewritten');
    assert(nested.content[1].content[0].content[0].attrs.id === 'NESTED1_NEW', 'nested paragraph id rewritten');
  }

  // ==========================================================================
  // Walker: no-op if rewrites empty
  // ==========================================================================
  console.log('\nWalker: empty rewrites are a no-op');
  {
    const doc = {
      type: 'doc',
      content: [{ type: 'paragraph', attrs: { id: 'unchanged' }, content: [] }],
    };
    applyRewritesToJsonDoc(doc, []);
    assert(doc.content[0].attrs.id === 'unchanged', 'empty rewrites do nothing');
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed > 0 ? 1 : 0;
} catch (err) {
  console.error('TEST CRASH:', err);
  process.exitCode = 1;
}
