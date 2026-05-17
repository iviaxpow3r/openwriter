/**
 * Regression test for the active-doc fs.watch reload pathway.
 *
 * Bug pattern this protects against:
 *   1. User opens a doc in openwriter (e.g. a SKILL.md referenced from
 *      ~/.claude/skills/).
 *   2. An external tool (agent's Edit, VSCode, a script) writes to that
 *      file on disk.
 *   3. Browser autosave fires later with state from BEFORE the external
 *      write. Without the watcher, the server's docVersion hasn't moved,
 *      so the version check passes and the autosave silently clobbers
 *      the external content.
 *
 * Fix verified by this test:
 *   - setActiveDocument starts an fs.watch on the file.
 *   - External writes trigger reloadActiveDocFromDisk + bumpDocVersion.
 *   - An onDocumentReloaded listener fires so the WS layer can push the
 *     new state to clients (and the version bump makes stale autosaves
 *     hit the existing isVersionCurrent guard).
 *   - The watcher debounces editor temp-file-rename bursts.
 *   - Switching to a different active doc tears down the old watcher.
 *   - Pending overlay from sidecar re-attaches by nodeId after reload.
 *
 * Run: `node scripts/test-active-doc-watcher.mjs`
 */

import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import {
  setActiveDocument,
  getDocument,
  getDocVersion,
  cancelDebouncedSave,
  onDocumentReloaded,
  clearAllCaches,
} from '../dist/server/state.js';
import { setActiveProfile, ensureDataDir, getDataDir } from '../dist/server/helpers.js';
import { saveOverlay, loadOverlay } from '../dist/server/pending-overlay.js';

let passed = 0;
let failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log(`  PASS: ${msg}`); }
  else      { failed++; console.error(`  FAIL: ${msg}`); }
}

const TEST_PROFILE = `test-watcher-${Date.now()}`;
const TEST_PROFILE_DIR = join(homedir(), '.openwriter', 'profiles', TEST_PROFILE);
function cleanup() {
  cancelDebouncedSave();
  clearAllCaches();
  try { rmSync(TEST_PROFILE_DIR, { recursive: true, force: true }); } catch { /* best-effort */ }
}
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(1); });

setActiveProfile(TEST_PROFILE);
mkdirSync(TEST_PROFILE_DIR, { recursive: true });
ensureDataDir();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Wait for a watcher event to be processed. fs.watch is async + the
// handler has an 80ms debounce; 250ms is a comfortable margin without
// making the suite slow.
async function waitForWatcherTick() {
  await sleep(250);
}

try {
  // ==========================================================================
  // Case 1: external write fires document-reloaded with fresh content
  // ==========================================================================
  console.log('\nCase 1: external write triggers document-reloaded');

  const filePath = join(TEST_PROFILE_DIR, 'watch-test.md');
  const initialMd = '---\n{"title":"Watch Test","docId":"wat00001"}\n---\n\nInitial content.\n\n';
  writeFileSync(filePath, initialMd, 'utf-8');
  await sleep(50);

  const initialDoc = {
    type: 'doc',
    content: [
      { type: 'paragraph', attrs: { id: 'p_init_1' }, content: [{ type: 'text', text: 'Initial content.' }] },
    ],
  };

  let reloadEvent = null;
  const unsubscribe = onDocumentReloaded((event) => {
    reloadEvent = event;
  });

  setActiveDocument(initialDoc, 'Watch Test', filePath, false, undefined, { title: 'Watch Test', docId: 'wat00001' });
  const versionBefore = getDocVersion();

  // Simulate external write — agent edits the file on disk via something
  // that isn't openwriter (Edit tool, VSCode, etc.).
  const externalMd = '---\n{"title":"Watch Test","docId":"wat00001"}\n---\n\nExternal content from another tool.\n\n';
  writeFileSync(filePath, externalMd, 'utf-8');

  await waitForWatcherTick();

  assert(reloadEvent !== null, 'document-reloaded fired after external write');
  assert(reloadEvent?.filename === 'watch-test.md', `filename in event: got ${reloadEvent?.filename}`);
  const reloadedText = reloadEvent?.document?.content?.[0]?.content?.[0]?.text;
  assert(reloadedText === 'External content from another tool.', `reloaded text: got ${JSON.stringify(reloadedText)}`);
  assert(getDocVersion() > versionBefore, `docVersion bumped (before: ${versionBefore}, after: ${getDocVersion()})`);
  assert(reloadEvent?.orphans?.length === 0, `no orphans on plain reload: got ${reloadEvent?.orphans?.length}`);
  assert(reloadEvent?.staleBaseline?.length === 0, `no stale-baseline on plain reload: got ${reloadEvent?.staleBaseline?.length}`);

  unsubscribe();

  // ==========================================================================
  // Case 2: self-write (atomicWriteFileSync via writeToDisk) does NOT
  // trigger document-reloaded — the watcher must filter own writes.
  // ==========================================================================
  console.log('\nCase 2: self-write does not trigger reload');

  let selfReloadEvent = null;
  const unsub2 = onDocumentReloaded((event) => { selfReloadEvent = event; });

  // Trigger a save via openwriter — should NOT fire reload (loadedMtime
  // gets re-stamped after our write, watcher's mtime check finds equality
  // and skips).
  const { save } = await import('../dist/server/state.js');
  save();
  await waitForWatcherTick();

  assert(selfReloadEvent === null, 'self-save did NOT fire document-reloaded');

  unsub2();

  // ==========================================================================
  // Case 3: pending overlay re-attaches by nodeId after external reload
  // ==========================================================================
  console.log('\nCase 3: pending overlay survives external write');

  // Stash a pending insert in the sidecar — it should re-attach by
  // anchoring to the reloaded canonical tree.
  saveOverlay('wat00001', [
    {
      nodeId: 'p_pending_new',
      status: 'insert',
      afterNodeId: 'end',
      newContent: {
        type: 'paragraph',
        attrs: { id: 'p_pending_new' },
        content: [{ type: 'text', text: 'Pending insert content.' }],
      },
    },
  ]);

  let case3ReloadEvent = null;
  const unsub3 = onDocumentReloaded((event) => { case3ReloadEvent = event; });

  // External writer updates the file again
  const externalMd2 = '---\n{"title":"Watch Test","docId":"wat00001"}\n---\n\nSecond external write.\n\n';
  await sleep(50); // mtime tick
  writeFileSync(filePath, externalMd2, 'utf-8');

  await waitForWatcherTick();

  assert(case3ReloadEvent !== null, 'reload fired on second external write');
  const reloadedContent = case3ReloadEvent?.document?.content || [];
  const hasPending = reloadedContent.some((n) => n.attrs?.pendingStatus === 'insert');
  assert(hasPending, `pending insert re-attached to reloaded doc (got ${reloadedContent.length} nodes)`);

  unsub3();

  // ==========================================================================
  // Case 4: setActiveDocument swaps watcher to a new file
  // ==========================================================================
  console.log('\nCase 4: switching active doc moves the watcher');

  const otherPath = join(TEST_PROFILE_DIR, 'other-doc.md');
  const otherMd = '---\n{"title":"Other","docId":"oth00001"}\n---\n\nOther content.\n\n';
  writeFileSync(otherPath, otherMd, 'utf-8');
  await sleep(50);

  let case4ReloadEvent = null;
  const unsub4 = onDocumentReloaded((event) => { case4ReloadEvent = event; });

  setActiveDocument(
    {
      type: 'doc',
      content: [{ type: 'paragraph', attrs: { id: 'p_oth_1' }, content: [{ type: 'text', text: 'Other content.' }] }],
    },
    'Other',
    otherPath,
    false,
    undefined,
    { title: 'Other', docId: 'oth00001' },
  );

  // External write on the OLD path — should NOT fire reload (watcher
  // moved away).
  await sleep(50);
  writeFileSync(filePath, '---\n{"title":"Watch Test","docId":"wat00001"}\n---\n\nShould not trigger reload.\n\n', 'utf-8');
  await waitForWatcherTick();

  assert(case4ReloadEvent === null, 'external write on previous active doc did NOT fire reload');

  // External write on the NEW path — should fire reload
  await sleep(50);
  writeFileSync(otherPath, '---\n{"title":"Other","docId":"oth00001"}\n---\n\nUpdated other content.\n\n', 'utf-8');
  await waitForWatcherTick();

  assert(case4ReloadEvent !== null, 'external write on new active doc fired reload');
  assert(case4ReloadEvent?.filename === 'other-doc.md', `reload event for correct file: got ${case4ReloadEvent?.filename}`);

  unsub4();

  // ==========================================================================
  // Case 5: burst writes coalesce into a single reload
  // ==========================================================================
  console.log('\nCase 5: burst writes debounced into single reload');

  let burstCount = 0;
  const unsub5 = onDocumentReloaded(() => { burstCount++; });

  // Fire 5 rapid writes — debouncer (80ms) should coalesce
  for (let i = 0; i < 5; i++) {
    writeFileSync(otherPath, `---\n{"title":"Other","docId":"oth00001"}\n---\n\nBurst ${i}.\n\n`, 'utf-8');
    await sleep(10); // shorter than debounce window
  }
  await waitForWatcherTick();

  assert(burstCount === 1, `5 burst writes produced 1 reload event (got ${burstCount})`);

  unsub5();

} finally {
  console.log(`\n${passed} passed, ${failed} failed`);
  cancelDebouncedSave();
  clearAllCaches();
  await sleep(150); // let any pending watcher events drain before cleanup
  process.exit(failed > 0 ? 1 : 0);
}
