/**
 * Document lifecycle ↔ pending-overlay sidecar invariant.
 *
 * The sidecar `_pending/{docId}.json` lifecycle is bound to the docId's
 * existence in the workspace, not to the .md file's filesystem path or
 * active/archived flag:
 *
 *   - delete retires the docId → sidecar must be removed
 *   - archive hides the docId but does not retire it → sidecar must persist
 *   - unarchive restores it → sidecar must still be readable
 *   - promote (temp-file rename) is a .md rename with a stable docId →
 *     sidecar follows naturally (docId-keyed, not filename-keyed)
 *
 * Pre-fix behavior: deleteDocument left the sidecar orphaned. The fix is
 * narrow — only delete retires the docId. The other three paths must
 * preserve the sidecar; tests below lock that in so a future "tidy up
 * the sidecar on every lifecycle event" refactor doesn't silently
 * destroy review state.
 *
 * adr: adr/pending-overlay-model.md
 *
 * Run: `node scripts/test-lifecycle-overlay.mjs`
 */

import { mkdirSync, readFileSync, rmSync, existsSync, writeFileSync as fsWriteFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import {
  setActiveDocument,
} from '../dist/server/state.js';
import {
  archiveDocument,
  unarchiveDocument,
  deleteDocument,
  promoteTempFile,
} from '../dist/server/documents.js';
import { markdownToTiptap } from '../dist/server/markdown.js';
import { loadOverlay } from '../dist/server/pending-overlay.js';
import { setActiveProfile, ensureDataDir, getDataDir, TEMP_PREFIX } from '../dist/server/helpers.js';

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) { passed++; console.log(`  PASS: ${msg}`); }
  else      { failed++; console.error(`  FAIL: ${msg}`); }
}

const TEST_PROFILE = `test-lifecycle-overlay-${Date.now()}`;
const TEST_PROFILE_DIR = join(homedir(), '.openwriter', 'profiles', TEST_PROFILE);

function cleanup() {
  try { rmSync(TEST_PROFILE_DIR, { recursive: true, force: true }); } catch { /* best-effort */ }
}

function sidecarPath(docId) {
  return join(TEST_PROFILE_DIR, '_pending', `${docId}.json`);
}

function seedSidecar(docId, entries) {
  mkdirSync(join(TEST_PROFILE_DIR, '_pending'), { recursive: true });
  fsWriteFileSync(sidecarPath(docId), JSON.stringify({
    version: 1,
    entries,
  }), 'utf-8');
}

function seedMd(filename, docId, title, body = 'Body text.') {
  const path = join(TEST_PROFILE_DIR, filename);
  const fm = `---\ntitle: ${title}\ndocId: ${docId}\n---\n\n${body}\n`;
  fsWriteFileSync(path, fm, 'utf-8');
  return path;
}

process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(1); });

setActiveProfile(TEST_PROFILE);
mkdirSync(TEST_PROFILE_DIR, { recursive: true });
ensureDataDir();

// Set up a placeholder active doc so the singleton is occupied with
// something that ISN'T our test target for most cases.
const placeholderPath = seedMd('placeholder.md', 'plc00001', 'Placeholder');
{
  const parsed = markdownToTiptap(readFileSync(placeholderPath, 'utf-8'));
  setActiveDocument(parsed.document, parsed.title, placeholderPath, false, undefined, parsed.metadata);
}

async function main() {
try {
  // ==========================================================================
  // T1: deleteDocument retires the docId → sidecar must be removed.
  // This is the regression that motivated the fix.
  // ==========================================================================
  console.log('T1: deleteDocument removes the orphan sidecar');
  {
    const filename = 'delete-target.md';
    const docId = 'del00001';
    seedMd(filename, docId, 'Delete Target');
    seedSidecar(docId, [{
      nodeId: 'aa000001',
      status: 'rewrite',
      originalBaseline: { type: 'paragraph', attrs: { id: 'aa000001' }, content: [{ type: 'text', text: 'Old.' }] },
      newContent: { type: 'paragraph', attrs: { id: 'aa000001' }, content: [{ type: 'text', text: 'New.' }] },
    }]);
    assert(existsSync(sidecarPath(docId)), 'sidecar exists before delete');

    await deleteDocument(filename);

    assert(!existsSync(sidecarPath(docId)),
      'sidecar removed after deleteDocument (docId is retired)');
  }

  // ==========================================================================
  // T2: archiveDocument hides the docId but does NOT retire it → sidecar
  // must persist so unarchive can resume the review queue.
  // ==========================================================================
  console.log('\nT2: archiveDocument preserves the sidecar (docId not retired)');
  {
    const filename = 'archive-target.md';
    const docId = 'arc00001';
    seedMd(filename, docId, 'Archive Target');
    seedSidecar(docId, [{
      nodeId: 'bb000001',
      status: 'rewrite',
      originalBaseline: { type: 'paragraph', attrs: { id: 'bb000001' }, content: [{ type: 'text', text: 'Pre-archive baseline.' }] },
      newContent: { type: 'paragraph', attrs: { id: 'bb000001' }, content: [{ type: 'text', text: 'Pending review on archive.' }] },
    }]);
    assert(existsSync(sidecarPath(docId)), 'sidecar exists before archive');

    archiveDocument(filename);

    assert(existsSync(sidecarPath(docId)),
      'sidecar persists after archiveDocument (docId still in workspace)');

    // The sidecar contents must be intact and readable.
    const overlay = loadOverlay(docId);
    assert(overlay.length === 1, `overlay readable after archive (got ${overlay.length} entries)`);
    const entry = overlay[0];
    assert(entry.status === 'rewrite' && entry.nodeId === 'bb000001',
      'entry shape intact after archive (rewrite on bb000001)');
    assert(entry.originalBaseline?.content?.[0]?.text === 'Pre-archive baseline.',
      'originalBaseline intact after archive');
  }

  // ==========================================================================
  // T3: unarchiveDocument restores the doc → sidecar from before archive
  // still readable. Same docId means same sidecar — no special wiring
  // needed in unarchive, but the invariant must hold across the round trip.
  // ==========================================================================
  console.log('\nT3: unarchiveDocument round-trip — sidecar survives archive→unarchive');
  {
    const filename = 'roundtrip-target.md';
    const docId = 'rt000001';
    seedMd(filename, docId, 'Roundtrip Target');
    seedSidecar(docId, [{
      nodeId: 'cc000001',
      status: 'insert',
      afterNodeId: null,
      parentNodeId: null,
      newContent: { type: 'paragraph', attrs: { id: 'cc000001' }, content: [{ type: 'text', text: 'Inserted block awaiting review.' }] },
    }]);

    archiveDocument(filename);
    assert(existsSync(sidecarPath(docId)), 'sidecar present mid-archive');

    const result = unarchiveDocument(filename);
    assert(result.filename === filename, 'unarchive returns the same filename');
    assert(existsSync(sidecarPath(docId)),
      'sidecar still present after unarchive');

    const overlay = loadOverlay(docId);
    assert(overlay.length === 1, `overlay still has 1 entry after unarchive (got ${overlay.length})`);
    assert(overlay[0].status === 'insert' && overlay[0].nodeId === 'cc000001',
      'insert entry intact after unarchive');
  }

  // ==========================================================================
  // T4: promoteTempFile renames the .md but the docId is stable → sidecar
  // path is unchanged. Lock in the docId-keyed invariant so a future
  // "rename the sidecar too" patch doesn't silently break it.
  // ==========================================================================
  console.log('\nT4: promoteTempFile preserves sidecar (docId-keyed, not filename-keyed)');
  {
    // Need a temp file as the ACTIVE doc — promoteTempFile only runs on the
    // active doc when it's flagged isTemp.
    const tempFilename = `${TEMP_PREFIX}lifecycle-1234.md`;
    const docId = 'pr000001';
    const tempPath = seedMd(tempFilename, docId, 'Untitled');
    seedSidecar(docId, [{
      nodeId: 'dd000001',
      status: 'rewrite',
      originalBaseline: { type: 'paragraph', attrs: { id: 'dd000001' }, content: [{ type: 'text', text: 'Original.' }] },
      newContent: { type: 'paragraph', attrs: { id: 'dd000001' }, content: [{ type: 'text', text: 'Rewritten.' }] },
    }]);

    const parsed = markdownToTiptap(readFileSync(tempPath, 'utf-8'));
    setActiveDocument(parsed.document, parsed.title, tempPath, true, undefined, parsed.metadata);

    const newFilename = promoteTempFile('Promoted Title');
    assert(newFilename !== null, `promoteTempFile returned a new filename (got ${newFilename})`);
    assert(!existsSync(tempPath), 'old temp file is gone after promote');
    assert(existsSync(join(TEST_PROFILE_DIR, newFilename)), 'new named file exists after promote');

    // Sidecar path is keyed by docId, which is stable across the rename.
    assert(existsSync(sidecarPath(docId)),
      'sidecar still at original docId path after promote (docId-keyed)');
    const overlay = loadOverlay(docId);
    assert(overlay.length === 1, `overlay still has 1 entry after promote (got ${overlay.length})`);
    assert(overlay[0].nodeId === 'dd000001',
      'overlay entry survived the .md rename');
  }

  // ==========================================================================
  // T5: deleteDocument with NO sidecar present is a no-op (defensive).
  // The docId might exist on the .md but there's no review queue to retire.
  // ==========================================================================
  console.log('\nT5: deleteDocument with no sidecar is a clean no-op');
  {
    const filename = 'no-sidecar.md';
    const docId = 'ns000001';
    seedMd(filename, docId, 'No Sidecar');
    assert(!existsSync(sidecarPath(docId)), 'no sidecar at start');

    await deleteDocument(filename);

    assert(!existsSync(sidecarPath(docId)), 'still no sidecar after delete (no-op clean)');
  }

} catch (err) {
  console.error('TEST CRASH:', err);
  process.exitCode = 1;
} finally {
  cleanup();
}

console.log('\n' + '='.repeat(60));
console.log(`Lifecycle ↔ overlay: ${passed} passed, ${failed} failed`);
console.log('='.repeat(60));
process.exit(failed > 0 ? 1 : 0);
}

main();
