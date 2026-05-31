/**
 * Regression test for the browser-write body-fidelity invariant.
 * adr: adr/browser-write-fidelity.md
 *
 * Drives the REAL state.ts production paths against an isolated test
 * profile. A browser editor surface that mounts empty (wrong view) or
 * parses the body through a narrower schema must NEVER be able to autosave
 * its empty/near-empty view over a populated body on disk. This invariant
 * lives at the browser-write boundary — all THREE functions that replace
 * canonical from a browser-sent doc — so this test exercises each one:
 *   1. updateDocument        (current-version doc-update + HTTP flush/sync)
 *   2. syncBrowserDocUpdate  (stale-version doc-update — the path the real
 *                             incident bypassed the old guard through)
 *   3. saveDocToFile         (wrong-filename race → non-active file)
 *
 * Plus positive controls: a GROWING replacement (recovery-restore shape)
 * and a small in-threshold edit must both pass.
 *
 * Run from packages/openwriter: `node scripts/test-clobber-guard.mjs`
 */

import { mkdirSync, existsSync, readFileSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import matter from 'gray-matter';
import {
  setActiveDocument,
  save,
  saveDocToFile,
  syncBrowserDocUpdate,
  updateDocument,
  getDocument,
  getDocVersion,
  cancelDebouncedSave,
} from '../dist/server/state.js';
import { markdownToNodes } from '../dist/server/markdown.js';
import { listVersions } from '../dist/server/versions.js';
import { setActiveProfile, ensureDataDir } from '../dist/server/helpers.js';

let passed = 0;
let failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log(`  PASS: ${msg}`); }
  else      { failed++; console.error(`  FAIL: ${msg}`); }
}

const TEST_PROFILE = `test-clobber-${Date.now()}`;
const TEST_PROFILE_DIR = join(homedir(), '.openwriter', 'profiles', TEST_PROFILE);

function cleanup() {
  cancelDebouncedSave();
  try { rmSync(TEST_PROFILE_DIR, { recursive: true, force: true }); } catch { /* best-effort */ }
}
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(1); });

/** Count body block nodes on disk (top-level), ignoring frontmatter. */
function diskNodeCount(filePath) {
  const raw = readFileSync(filePath, 'utf-8');
  const { content } = matter(raw);
  return markdownToNodes(content).length;
}

/** A populated doc: N paragraphs of real text. */
function bigDoc(n) {
  const content = [];
  for (let i = 0; i < n; i++) {
    content.push({ type: 'paragraph', content: [{ type: 'text', text: `Pillar paragraph number ${i} with enough words to be a real body block on disk.` }] });
  }
  return { type: 'doc', content };
}
/** The empty/near-empty surface a wrong/lossy view produces: one empty paragraph. */
function emptyDoc() {
  return { type: 'doc', content: [{ type: 'paragraph', content: [] }] };
}

setActiveProfile(TEST_PROFILE);
mkdirSync(TEST_PROFILE_DIR, { recursive: true });
ensureDataDir();

try {
  const FULL = 40;
  const docId = 'c10bbe11';
  const filePath = join(TEST_PROFILE_DIR, 'pillar.md');

  // Seed a populated blog doc on disk (content_type blog + articleContext —
  // exactly the incident shape).
  console.log('\nSetup: seed a 40-node blog body (with articleContext) to disk');
  setActiveDocument(bigDoc(FULL), 'Pillar', filePath, false, new Date(),
    { docId, content_type: 'blog', blogContext: { active: true }, articleContext: { coverImage: '/x.png' } }, undefined);
  save();
  assert(diskNodeCount(filePath) >= FULL, `seeded body has ${FULL}+ nodes on disk`);

  // ── Path 1: updateDocument (current-version doc-update / HTTP flush+sync) ──
  console.log('\nTest 1: updateDocument refuses an empty-surface collapse');
  const before1 = listVersions(docId).length;
  updateDocument(emptyDoc());
  save();
  assert(getDocument().content.length >= FULL, 'in-memory body preserved (refused)');
  assert(diskNodeCount(filePath) >= FULL, 'on-disk body NOT truncated');
  assert(listVersions(docId).length > before1, 'checkpoint snapshot was written before refusing');

  // ── Path 2: syncBrowserDocUpdate (STALE-version — the bypass the real
  //    incident clobbered through) ──
  console.log('\nTest 2: syncBrowserDocUpdate (stale version) refuses collapse');
  const staleVersion = getDocVersion() - 5; // pretend the browser was 5 versions behind
  const before2 = listVersions(docId).length;
  const res = syncBrowserDocUpdate(emptyDoc(), staleVersion);
  save();
  assert(res.preservedServerEntries === 0, 'stale-merge returned without applying');
  assert(getDocument().content.length >= FULL, 'in-memory body preserved (refused)');
  assert(diskNodeCount(filePath) >= FULL, 'on-disk body NOT truncated');
  assert(listVersions(docId).length > before2, 'checkpoint snapshot was written before refusing');

  // ── Path 3: saveDocToFile (wrong-filename race → non-active file) ──
  console.log('\nTest 3: saveDocToFile refuses collapse of a NON-active file');
  // Seed a second populated file on disk (becomes non-active after we switch back).
  const otherId = 'aa779900';
  const otherPath = join(TEST_PROFILE_DIR, 'other.md');
  setActiveDocument(bigDoc(FULL), 'Other', otherPath, false, new Date(), { docId: otherId, content_type: 'blog' }, undefined);
  save();
  // Switch active back to the pillar so 'other.md' is genuinely non-active.
  setActiveDocument(bigDoc(FULL), 'Pillar', filePath, false, new Date(),
    { docId, content_type: 'blog', blogContext: { active: true }, articleContext: { coverImage: '/x.png' } }, undefined);
  save();
  const before3 = listVersions(otherId).length;
  saveDocToFile('other.md', emptyDoc());
  assert(diskNodeCount(otherPath) >= FULL, 'non-active file body NOT truncated');
  assert(listVersions(otherId).length > before3, 'checkpoint snapshot was written for the target file');

  // ── Positive control A: a GROWING replacement (recovery-restore shape) passes ──
  console.log('\nTest 4: positive control — a growing replacement is accepted');
  // Start from a small doc, replace with a big one (incoming > current).
  setActiveDocument(bigDoc(3), 'Pillar', filePath, false, new Date(),
    { docId, content_type: 'blog' }, undefined);
  save();
  updateDocument(bigDoc(FULL));
  save();
  assert(diskNodeCount(filePath) >= FULL, 'growing replacement written through (not refused)');

  // ── Positive control B: a normal in-threshold edit passes ──
  console.log('\nTest 5: positive control — an ordinary edit (>30% retained) is accepted');
  updateDocument(bigDoc(FULL - 2)); // 38/40 = 95% retained, well above the floor
  save();
  assert(diskNodeCount(filePath) === FULL - 2, 'ordinary edit written through');

} catch (err) {
  failed++;
  console.error('  FAIL: test crashed:', err && err.stack ? err.stack : err);
}

console.log('\n============================================================');
console.log(`Clobber-guard: ${passed} passed, ${failed} failed`);
console.log('============================================================');
process.exit(failed > 0 ? 1 : 0);
