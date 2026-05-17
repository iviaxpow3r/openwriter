/**
 * Regression test for path canonicalization at identity boundaries.
 *
 * Bug pattern this protects against:
 *   1. User opens `C:/Users/.../SKILL.md` via open_file.
 *   2. Later, something opens `C:\Users\...\SKILL.md` (backslashes —
 *      same physical file).
 *   3. Without canonicalization: two openwriter documents are created,
 *      each with their own in-memory state, fs.watch subscription, and
 *      pending overlay. They can clobber each other through the same
 *      disk file.
 *
 * Fix verified by this test:
 *   - canonicalizePath produces one identity string per physical file.
 *   - isExternalDoc compares canonicalized paths (was: raw startsWith,
 *     which let mixed-separator paths inside the data dir classify as
 *     external on Windows).
 *   - registerExternalDoc + loadExternalDocs canonicalize on add and
 *     dedupe on load — so legacy registry entries with mixed forms
 *     collapse to one on first read.
 *
 * Run: `node scripts/test-path-canonicalization.mjs`
 */

import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import {
  canonicalizePath,
  canonicalizeIdentifier,
  isExternalDoc,
  getDataDir,
} from '../dist/server/helpers.js';
import {
  registerExternalDoc,
  unregisterExternalDoc,
  getExternalDocs,
  clearAllCaches,
} from '../dist/server/state.js';
import { setActiveProfile, ensureDataDir } from '../dist/server/helpers.js';

let passed = 0;
let failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log(`  PASS: ${msg}`); }
  else      { failed++; console.error(`  FAIL: ${msg}`); }
}

const TEST_PROFILE = `test-canon-${Date.now()}`;
const TEST_PROFILE_DIR = join(homedir(), '.openwriter', 'profiles', TEST_PROFILE);
function cleanup() {
  clearAllCaches();
  try { rmSync(TEST_PROFILE_DIR, { recursive: true, force: true }); } catch { /* best-effort */ }
}
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(1); });

setActiveProfile(TEST_PROFILE);
mkdirSync(TEST_PROFILE_DIR, { recursive: true });
ensureDataDir();

// Create a real file to canonicalize against (realpathSync requires existence)
const testFile = join(TEST_PROFILE_DIR, 'canon-target.md');
writeFileSync(testFile, '# canonicalization test\n', 'utf-8');

try {
  // ==========================================================================
  // Case 1: same file via different separators → same canonical string
  // ==========================================================================
  console.log('\nCase 1: separator variants converge');

  const forwardSlash = testFile.replace(/\\/g, '/');
  const backSlash = testFile.replace(/\//g, '\\');
  const mixed = forwardSlash.replace(/\//, '\\'); // first slash backwards

  const canonForward = canonicalizePath(forwardSlash);
  const canonBack = canonicalizePath(backSlash);
  const canonMixed = canonicalizePath(mixed);

  assert(canonForward === canonBack, `forward-slash and back-slash converge: ${canonForward} === ${canonBack}`);
  assert(canonForward === canonMixed, `forward-slash and mixed converge: ${canonForward} === ${canonMixed}`);
  assert(canonForward.length > 0, 'canonical form is non-empty');

  // ==========================================================================
  // Case 2: idempotence — canon(canon(p)) === canon(p)
  // ==========================================================================
  console.log('\nCase 2: idempotence');

  const once = canonicalizePath(testFile);
  const twice = canonicalizePath(once);
  const thrice = canonicalizePath(twice);
  assert(once === twice, `canon(p) === canon(canon(p)): ${once} === ${twice}`);
  assert(twice === thrice, `canon(canon(p)) === canon(canon(canon(p)))`);

  // ==========================================================================
  // Case 3: non-existent file falls back to path.resolve (no throw)
  // ==========================================================================
  console.log('\nCase 3: non-existent file fallback');

  const ghostPath = join(TEST_PROFILE_DIR, 'does-not-exist.md');
  let didNotThrow = true;
  let ghostCanon = '';
  try {
    ghostCanon = canonicalizePath(ghostPath);
  } catch {
    didNotThrow = false;
  }
  assert(didNotThrow, 'canonicalizePath does not throw for non-existent file');
  assert(ghostCanon.length > 0, 'fallback produces non-empty canonical string');

  // ==========================================================================
  // Case 4: empty input returns empty
  // ==========================================================================
  console.log('\nCase 4: empty input');

  assert(canonicalizePath('') === '', 'empty string returns empty');
  // @ts-ignore — test runtime nulls
  assert(canonicalizePath(null) === null, 'null returns null (no crash)');

  // ==========================================================================
  // Case 5: isExternalDoc — same-file-different-separator no longer
  // mis-classifies as external when the file is inside data dir
  // ==========================================================================
  console.log('\nCase 5: isExternalDoc separator robustness');

  // The test file IS inside getDataDir(), so it should NOT be external.
  // Pre-canonicalization, mixed separators caused mis-classification.
  assert(!isExternalDoc(testFile), `internal file (platform separators) classifies as internal`);
  assert(!isExternalDoc(forwardSlash), `internal file (forward slashes) classifies as internal`);
  assert(!isExternalDoc(backSlash), `internal file (backslashes) classifies as internal`);

  // A file outside the data dir IS external
  const outsidePath = join(homedir(), '.claude', 'skills', 'openwriter-testing', 'SKILL.md');
  assert(isExternalDoc(outsidePath), `file outside data dir classifies as external (${outsidePath})`);

  // ==========================================================================
  // Case 6: registerExternalDoc canonicalizes on add — same file via
  // different separators creates ONE entry, not two
  // ==========================================================================
  console.log('\nCase 6: registerExternalDoc dedupes by canonical form');

  // Use a file outside the data dir (must be a real file for realpath)
  const extFile = join(TEST_PROFILE_DIR, '..', 'canon-ext.md');
  writeFileSync(extFile, '# external test\n', 'utf-8');

  registerExternalDoc(extFile);
  registerExternalDoc(extFile.replace(/\\/g, '/'));
  registerExternalDoc(extFile.replace(/\//g, '\\'));

  const registered = getExternalDocs();
  const matching = registered.filter((p) => canonicalizePath(p) === canonicalizePath(extFile));
  assert(matching.length === 1, `three registrations of same file produce one entry (got ${matching.length})`);

  unregisterExternalDoc(extFile);
  const afterUnregister = getExternalDocs();
  const stillThere = afterUnregister.filter((p) => canonicalizePath(p) === canonicalizePath(extFile));
  assert(stillThere.length === 0, `unregister with one spelling removes the canonical entry (got ${stillThere.length})`);

  try { rmSync(extFile); } catch { /* best-effort */ }

  // ==========================================================================
  // Case 7: canonicalizeIdentifier — basenames pass through,
  // absolute paths canonicalize
  // ==========================================================================
  console.log('\nCase 7: canonicalizeIdentifier handles both shapes');

  assert(canonicalizeIdentifier('Chapter 2.md') === 'Chapter 2.md', 'basename pass-through');
  assert(canonicalizeIdentifier('') === '', 'empty pass-through');
  assert(canonicalizeIdentifier(forwardSlash) === canonicalizeIdentifier(backSlash),
    'absolute paths canonicalize the same regardless of separator');

} finally {
  console.log(`\n${passed} passed, ${failed} failed`);
  clearAllCaches();
  process.exit(failed > 0 ? 1 : 0);
}
