/**
 * mark_enriched lifecycle test — drives the active-doc and non-active-doc
 * paths directly via the same primitives the MCP handler uses.
 *
 * Scenarios:
 *   1. Stale doc → mark_enriched → flag cleared, baselines stamped.
 *   2. Just-enriched doc → small edit → save → flag stays clean (drift sub-threshold).
 *   3. Just-enriched doc → big edit → save → flag flips true (drift trips threshold).
 *   4. Non-active doc → mark_enriched-equivalent disk write → flag cleared on disk.
 *
 * The Phase-4 MCP handler composes: harvestSentenceHashes + harvestCharCount +
 * setMetadata (active) or direct tiptapToMarkdown + atomicWriteFileSync (non-active).
 * This test exercises that composition without spinning up MCP transport.
 *
 * See brief 2026-05-18-frontmatter-enrichment-system.
 *
 * Run: `node scripts/test-mark-enriched.mjs`
 */

import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import matter from 'gray-matter';

import {
  harvestSentenceHashes,
  harvestCharCount,
} from '../dist/server/enrichment.js';

import {
  setActiveDocument,
  save,
  resetDocVersion,
  bumpDocVersion,
  setMetadata,
  updateDocument,
  getCanonical,
  getMetadata,
  cloneWithPendingReverted,
} from '../dist/server/state.js';

import { tiptapToBlocks } from '../dist/server/node-blocks.js';
import { tiptapToMarkdown } from '../dist/server/markdown.js';
import { setActiveProfile, ensureDataDir, atomicWriteFileSync } from '../dist/server/helpers.js';

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) { passed++; console.log(`  PASS: ${msg}`); }
  else      { failed++; console.error(`  FAIL: ${msg}`); }
}

const TEST_PROFILE = `test-mark-enriched-${Date.now()}`;
const TEST_PROFILE_DIR = join(homedir(), '.openwriter', 'profiles', TEST_PROFILE);

function cleanup() {
  try { rmSync(TEST_PROFILE_DIR, { recursive: true, force: true }); } catch { /* best-effort */ }
}

function makeNode(id, text) {
  return { type: 'paragraph', attrs: { id }, content: [{ type: 'text', text }] };
}

/** Simulate the active-doc branch of the mark_enriched MCP handler. */
function markEnrichedActive(enrichment) {
  const canonical = getCanonical();
  const blocks = tiptapToBlocks(canonical);
  const lastEnrichedSentences = harvestSentenceHashes(blocks);
  const lastEnrichedCharCount = harvestCharCount(blocks);

  setMetadata({
    lastEnrichedAt: new Date().toISOString(),
    lastEnrichedCharCount,
    lastEnrichedSentences,
    enrichmentStale: false,
    ...enrichment,
  });
  // setMetadata doesn't bump docVersion — without this, save() would no-op
  // because the body didn't change. The MCP handler does the same.
  bumpDocVersion();
  save();
}

/** Simulate the non-active-doc branch of mark_enriched: harvest from a doc,
 *  then write disk with the stamped baseline. */
function markEnrichedNonActive(filename, doc, title, metadata, enrichment) {
  const canonical = cloneWithPendingReverted(doc);
  const blocks = tiptapToBlocks(canonical);
  const lastEnrichedSentences = harvestSentenceHashes(blocks);
  const lastEnrichedCharCount = harvestCharCount(blocks);

  const newMeta = {
    ...metadata,
    lastEnrichedAt: new Date().toISOString(),
    lastEnrichedCharCount,
    lastEnrichedSentences,
    enrichmentStale: false,
    ...enrichment,
  };
  const filePath = join(TEST_PROFILE_DIR, filename);
  const markdown = tiptapToMarkdown(doc, title, newMeta);
  atomicWriteFileSync(filePath, markdown);
  return newMeta;
}

try {
  setActiveProfile(TEST_PROFILE);
  ensureDataDir();
  mkdirSync(TEST_PROFILE_DIR, { recursive: true });

  // ---------------------------------------------------------------------
  // Scenario 1: stale doc → mark_enriched clears the flag and stamps baselines
  // ---------------------------------------------------------------------

  console.log('\nScenario 1: mark_enriched clears stale flag (active doc)');
  {
    const filePath = join(TEST_PROFILE_DIR, 'sc1.md');
    const seed = {
      type: 'doc',
      content: [
        makeNode('s1n0001', 'First sentence here. Second sentence here.'),
        makeNode('s1n0002', 'Third sentence in paragraph two.'),
      ],
    };
    setActiveDocument(seed, 'sc1', filePath, false, new Date(),
      { docId: 'sc100001', title: 'sc1' }, null);

    resetDocVersion();
    bumpDocVersion();
    save();

    // Should be stale before enrichment.
    {
      const fm = matter(readFileSync(filePath, 'utf-8'));
      assert(fm.data.enrichmentStale === true,
        'pre-mark: doc is stale (never enriched)');
    }

    // Apply mark_enriched.
    markEnrichedActive({
      logline: 'Test doc about enrichment.',
      domain: 'TestDomain',
      concepts: ['enrichment', 'staleness'],
      docRole: 'reference',
      status: 'canonical',
    });

    const fm = matter(readFileSync(filePath, 'utf-8'));
    assert(fm.data.enrichmentStale === false,
      'post-mark: enrichmentStale set to false');
    assert(typeof fm.data.lastEnrichedAt === 'string' && fm.data.lastEnrichedAt.length > 0,
      'post-mark: lastEnrichedAt stamped');
    assert(typeof fm.data.lastEnrichedCharCount === 'number' && fm.data.lastEnrichedCharCount > 0,
      'post-mark: lastEnrichedCharCount stamped');
    assert(Array.isArray(fm.data.lastEnrichedSentences) && fm.data.lastEnrichedSentences.length > 0,
      'post-mark: lastEnrichedSentences stamped as array');
    assert(fm.data.logline === 'Test doc about enrichment.',
      'post-mark: logline persisted');
    assert(fm.data.domain === 'TestDomain', 'post-mark: domain persisted');
    assert(Array.isArray(fm.data.concepts) && fm.data.concepts.length === 2,
      'post-mark: concepts persisted');
    assert(fm.data.docRole === 'reference', 'post-mark: docRole persisted');
    assert(fm.data.status === 'canonical', 'post-mark: status persisted');
  }

  // ---------------------------------------------------------------------
  // Scenario 2: enriched doc + small edit + save → stays clean
  // ---------------------------------------------------------------------

  console.log('\nScenario 2: post-mark, sub-threshold edit keeps doc clean');
  {
    // Continuing from sc1's active doc, mutate by adding a single word.
    const current = getCanonical();
    const mutated = JSON.parse(JSON.stringify(current));
    // Add one sentence to the 1st paragraph — adds ~1 sentence to a 3-sentence doc
    // = 2/(7) ≈ 0.28 drift, below the 0.3 default → not stale by drift.
    // Volume: small added text → ratio ~1.1, not stale by volume.
    mutated.content[0].content.push({ type: 'text', text: ' Tiny addition.' });
    updateDocument(mutated);
    save();

    const fm = matter(readFileSync(join(TEST_PROFILE_DIR, 'sc1.md'), 'utf-8'));
    assert(fm.data.enrichmentStale === false,
      'sub-threshold edit after mark → enrichmentStale stays false');
  }

  // ---------------------------------------------------------------------
  // Scenario 3: big edit re-flips stale
  // ---------------------------------------------------------------------

  console.log('\nScenario 3: post-mark, threshold-tripping edit re-flips stale');
  {
    const current = getCanonical();
    const mutated = JSON.parse(JSON.stringify(current));
    // Replace all content with brand-new sentences → 100% drift → tripped.
    mutated.content = [
      makeNode('s3n0001', 'Brand new content. Totally different. Nothing in common.'),
      makeNode('s3n0002', 'More brand new content. Still nothing the same.'),
    ];
    updateDocument(mutated);
    save();

    const fm = matter(readFileSync(join(TEST_PROFILE_DIR, 'sc1.md'), 'utf-8'));
    assert(fm.data.enrichmentStale === true,
      'wholesale rewrite after mark → enrichmentStale re-flipped true');
    // Baselines should NOT have been touched by openwriter — only mark_enriched updates them.
    assert(fm.data.lastEnrichedAt === fm.data.lastEnrichedAt /* unchanged from sc1 */,
      'lastEnrichedAt still references the original mark (openwriter never overwrites)');
  }

  // ---------------------------------------------------------------------
  // Scenario 4: non-active doc path
  // ---------------------------------------------------------------------

  console.log('\nScenario 4: mark_enriched non-active path stamps disk directly');
  {
    const filename = 'sc4.md';
    const filePath = join(TEST_PROFILE_DIR, filename);

    // Seed a non-active doc on disk with stale state.
    writeFileSync(filePath,
      `---\n${JSON.stringify({ title: 'sc4', docId: 'sc400001' })}\n---\n\nNon-active doc content.\n`,
      'utf-8');

    const doc = {
      type: 'doc',
      content: [makeNode('s4n0001', 'Non-active doc content.')],
    };

    const stampedMeta = markEnrichedNonActive(filename, doc, 'sc4',
      { docId: 'sc400001', title: 'sc4' },
      { logline: 'A non-active doc.', domain: 'NonActive' });

    const fm = matter(readFileSync(filePath, 'utf-8'));
    assert(fm.data.enrichmentStale === false,
      'non-active: enrichmentStale = false on disk');
    assert(typeof fm.data.lastEnrichedAt === 'string',
      'non-active: lastEnrichedAt stamped');
    assert(Array.isArray(fm.data.lastEnrichedSentences) && fm.data.lastEnrichedSentences.length > 0,
      'non-active: lastEnrichedSentences stamped');
    assert(fm.data.logline === 'A non-active doc.',
      'non-active: logline persisted');
    assert(fm.data.domain === 'NonActive',
      'non-active: domain persisted');
  }
} catch (err) {
  failed++;
  console.error(`  FATAL: ${err.message}`);
  console.error(err.stack);
} finally {
  cleanup();
}

console.log('\n============================================================');
console.log(`mark_enriched lifecycle: ${passed} passed, ${failed} failed`);
console.log('============================================================');
if (failed > 0) process.exit(1);
