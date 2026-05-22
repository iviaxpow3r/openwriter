/**
 * test-references.mjs — v0.20.0 references + computed backlinks
 *
 * Covers:
 *   - computeBacklinksFor scans all docs' references and returns inbound list
 *   - Cache invalidation clears stale results after writes
 *   - rebuildAllReferences merges prose doc: links into references field
 *   - rebuildAllReferences strips legacy backlinks field
 *   - syncReferencesFromProse merges new prose targets idempotently
 */

import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

import { setActiveProfile, ensureDataDir, getDataDir } from '../dist/server/helpers.js';
import { computeBacklinksFor, invalidateBacklinksCache, rebuildAllReferences, syncReferencesFromProse } from '../dist/server/backlinks.js';

const TEST_PROFILE = `test-references-${Date.now()}`;
const TEST_PROFILE_DIR = join(homedir(), '.openwriter', 'profiles', TEST_PROFILE);
setActiveProfile(TEST_PROFILE);
ensureDataDir();

let passed = 0;
let failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log(`  PASS: ${msg}`); }
  else      { failed++; console.error(`  FAIL: ${msg}`); }
}

function cleanup() {
  try { rmSync(TEST_PROFILE_DIR, { recursive: true, force: true }); } catch { /* best-effort */ }
}

function writeDoc(filename, metadata, body) {
  writeFileSync(join(getDataDir(), filename), `---\n${JSON.stringify(metadata)}\n---\n\n${body}`, 'utf-8');
}

function readMetadata(filename) {
  const raw = readFileSync(join(getDataDir(), filename), 'utf-8');
  const m = raw.match(/^---\n(.+?)\n---\n/);
  return JSON.parse(m[1]);
}

try {
  // --- Test 1: computeBacklinksFor finds inbound references ---
  console.log('Test 1: computeBacklinksFor returns inbound docs');
  writeDoc('A.md', { title: 'A', docId: 'aaaaaaaa' }, '# A\n\nNothing.\n');
  writeDoc('B.md', { title: 'B', docId: 'bbbbbbbb', references: ['aaaaaaaa'] }, '# B\n');
  writeDoc('C.md', { title: 'C', docId: 'cccccccc', references: ['aaaaaaaa'] }, '# C\n');
  writeDoc('D.md', { title: 'D', docId: 'dddddddd' }, '# D\n');
  invalidateBacklinksCache();
  const inboundA = computeBacklinksFor('aaaaaaaa');
  assert(inboundA.length === 2, `A has 2 backlinks (got ${inboundA.length})`);
  const ids = inboundA.map((b) => b.from_doc).sort();
  assert(JSON.stringify(ids) === '["bbbbbbbb","cccccccc"]', `A inbound = [B, C] (got ${JSON.stringify(ids)})`);
  const inboundD = computeBacklinksFor('dddddddd');
  assert(inboundD.length === 0, `D has 0 backlinks (got ${inboundD.length})`);

  // --- Test 2: cache invalidation picks up new references ---
  console.log('Test 2: invalidateBacklinksCache forces re-scan');
  writeDoc('E.md', { title: 'E', docId: 'eeeeeeee', references: ['aaaaaaaa', 'dddddddd'] }, '# E\n');
  invalidateBacklinksCache();
  const inboundA2 = computeBacklinksFor('aaaaaaaa');
  assert(inboundA2.length === 3, `A now has 3 backlinks (got ${inboundA2.length})`);
  const inboundD2 = computeBacklinksFor('dddddddd');
  assert(inboundD2.length === 1 && inboundD2[0].from_doc === 'eeeeeeee', `D has E as backlink`);

  // --- Test 3: rebuildAllReferences merges prose links into references ---
  console.log('Test 3: rebuildAllReferences merges prose links into references');
  writeDoc('F.md', { title: 'F', docId: 'ffffffff' }, '# F\n\nMention of [phrase](doc:aaaaaaaa) in prose.\n');
  const result = rebuildAllReferences();
  assert(result.scanned >= 6, `rebuild scanned all docs (scanned=${result.scanned})`);
  assert(result.updated >= 1, `rebuild touched at least F (updated=${result.updated})`);
  const Ffm = readMetadata('F.md');
  assert(Array.isArray(Ffm.references) && Ffm.references.includes('aaaaaaaa'),
    `F has aaaaaaaa in references after rebuild (got ${JSON.stringify(Ffm.references)})`);

  // --- Test 4: rebuildAllReferences strips legacy backlinks field ---
  console.log('Test 4: rebuildAllReferences strips legacy backlinks');
  writeDoc('G.md',
    { title: 'G', docId: 'gggggggg', backlinks: [{ text: 'stale', from_doc: 'xxxxxxxx', from_node: 'yyyyyyyy' }] },
    '# G\n');
  rebuildAllReferences();
  const Gfm = readMetadata('G.md');
  assert(!('backlinks' in Gfm), `G no longer has backlinks field (got ${JSON.stringify(Gfm)})`);

  // --- Test 5: syncReferencesFromProse merges prose targets idempotently ---
  console.log('Test 5: syncReferencesFromProse merges new prose targets');
  const docWithProseLink = {
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        attrs: { id: 'p0000001' },
        content: [
          { type: 'text', text: 'See ' },
          { type: 'text', text: 'A', marks: [{ type: 'link', attrs: { href: 'doc:aaaaaaaa' } }] },
          { type: 'text', text: '.' },
        ],
      },
    ],
  };
  const sync = syncReferencesFromProse('sourceId', docWithProseLink, { references: ['bbbbbbbb'] });
  assert(sync !== null, 'sync returned non-null');
  if (sync) {
    assert(sync.added.includes('aaaaaaaa'), `sync added aaaaaaaa (added=${JSON.stringify(sync.added)})`);
    assert(sync.newReferences.includes('aaaaaaaa') && sync.newReferences.includes('bbbbbbbb'),
      'new refs include both old and new');
  }
  const syncAgain = syncReferencesFromProse('sourceId', docWithProseLink, { references: ['aaaaaaaa', 'bbbbbbbb'] });
  assert(syncAgain === null, 'sync is idempotent when no new prose targets');

} finally {
  cleanup();
}

console.log('');
console.log('============================================================');
console.log(`References model: ${passed} passed, ${failed} failed`);
console.log('============================================================');
process.exit(failed > 0 ? 1 : 0);
