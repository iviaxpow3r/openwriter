/**
 * mark_enriched lifecycle test — drives the active-doc and non-active-doc
 * paths directly via the same primitives the MCP handler uses.
 *
 * Scenarios:
 *   1. Stale doc → mark_enriched → flag cleared, baselines stamped,
 *      logline persisted, legacy fields retired.
 *   2. Just-enriched doc → small edit → save → flag stays clean (drift sub-threshold).
 *   3. Just-enriched doc → big edit → save → flag flips true (drift trips threshold).
 *   4. Non-active doc → mark_enriched-equivalent disk write → flag cleared on disk,
 *      logline persisted, legacy fields retired.
 *   5. Doc with status field → mark_enriched preserves agent-owned status.
 *
 * v0.19.0 schema: the mark_enriched payload is { docId, logline } only.
 * domain / concepts / docRole are explicitly deleted from frontmatter on
 * every mark_enriched (lazy migration path). status is agent-owned and
 * preserved through the call.
 *
 * See brief 2026-05-21-simplify-enrichment-schema-three-fields.
 *
 * Run: `node scripts/test-mark-enriched.mjs`
 */

import { mkdirSync, rmSync, readFileSync, writeFileSync } from 'fs';
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
  getMetadata,
  updateDocument,
  getCanonical,
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

// Mirror the MCP handler's LEGACY_FIELDS_TO_RETIRE list — these get deleted
// from frontmatter on every mark_enriched so disk converges to the v0.19.0
// three-field schema over time.
const LEGACY_FIELDS_TO_RETIRE = ['domain', 'concepts', 'docRole'];

function cleanup() {
  try { rmSync(TEST_PROFILE_DIR, { recursive: true, force: true }); } catch { /* best-effort */ }
}

function makeNode(id, text) {
  return { type: 'paragraph', attrs: { id }, content: [{ type: 'text', text }] };
}

/** Simulate the active-doc branch of the mark_enriched MCP handler.
 *  v0.19.0: payload is { logline } only; legacy fields are deleted from
 *  the live metadata after the merge. */
function markEnrichedActive(logline) {
  const canonical = getCanonical();
  const blocks = tiptapToBlocks(canonical);
  const lastEnrichedSentences = harvestSentenceHashes(blocks);
  const lastEnrichedCharCount = harvestCharCount(blocks);

  setMetadata({
    lastEnrichedAt: new Date().toISOString(),
    lastEnrichedCharCount,
    lastEnrichedSentences,
    enrichmentStale: false,
    logline,
  });
  const liveMeta = getMetadata();
  for (const k of LEGACY_FIELDS_TO_RETIRE) delete liveMeta[k];
  // setMetadata doesn't bump docVersion — without this, save() would no-op
  // because the body didn't change. The MCP handler does the same.
  bumpDocVersion();
  save();
}

/** Simulate the non-active-doc branch of mark_enriched: harvest from a doc,
 *  then write disk with the stamped baseline and legacy fields stripped. */
function markEnrichedNonActive(filename, doc, title, metadata, logline) {
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
    logline,
  };
  for (const k of LEGACY_FIELDS_TO_RETIRE) delete newMeta[k];
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
  // Scenario 1: stale doc → mark_enriched stamps logline, retires legacy fields
  // ---------------------------------------------------------------------

  console.log('\nScenario 1: mark_enriched stamps logline + retires legacy fields (active doc)');
  {
    const filePath = join(TEST_PROFILE_DIR, 'sc1.md');
    // Seed with 20 distinct sentences so a single-sentence drift in Scenario 2
    // stays below the v0.17+ tightened drift threshold (0.10). With 20 baseline
    // sentences and one added, Jaccard = 1/21 ≈ 0.048, well below 0.10.
    const sentences = Array.from({ length: 20 },
      (_, i) => `Distinct sentence number ${i + 1} in the seed doc.`).join(' ');
    const seed = {
      type: 'doc',
      content: [
        makeNode('s1n0001', sentences),
        makeNode('s1n0002', 'Final standalone sentence in paragraph two.'),
      ],
    };
    // Seed with legacy fields present — they must be stripped on mark_enriched.
    setActiveDocument(seed, 'sc1', filePath, false, new Date(),
      {
        docId: 's1000001',
        title: 'sc1',
        domain: 'LegacyDomain',
        concepts: ['legacy-concept'],
        docRole: 'legacy-role',
      }, null);

    resetDocVersion();
    bumpDocVersion();
    save();

    // Should be stale before enrichment.
    {
      const fm = matter(readFileSync(filePath, 'utf-8'));
      assert(fm.data.enrichmentStale === true,
        'pre-mark: doc is stale (never enriched)');
      assert(fm.data.domain === 'LegacyDomain',
        'pre-mark: legacy domain present on disk');
    }

    // Apply mark_enriched with just logline.
    markEnrichedActive('Test doc about enrichment.');

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
    assert(fm.data.domain === undefined,
      'post-mark: legacy domain RETIRED from frontmatter');
    assert(fm.data.concepts === undefined,
      'post-mark: legacy concepts RETIRED from frontmatter');
    assert(fm.data.docRole === undefined,
      'post-mark: legacy docRole RETIRED from frontmatter');
  }

  // ---------------------------------------------------------------------
  // Scenario 2: enriched doc + small edit + save → stays clean
  // ---------------------------------------------------------------------

  console.log('\nScenario 2: post-mark, sub-threshold edit keeps doc clean');
  {
    const current = getCanonical();
    const mutated = JSON.parse(JSON.stringify(current));
    // Add one short sentence to a 20-sentence baseline. Jaccard = 1/21 ≈ 0.048,
    // below the 0.10 default drift threshold; volume ratio also stays ~1.02.
    // Neither signal trips → enrichmentStale stays false.
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
    mutated.content = [
      makeNode('s3n0001', 'Brand new content. Totally different. Nothing in common.'),
      makeNode('s3n0002', 'More brand new content. Still nothing the same.'),
    ];
    updateDocument(mutated);
    save();

    const fm = matter(readFileSync(join(TEST_PROFILE_DIR, 'sc1.md'), 'utf-8'));
    assert(fm.data.enrichmentStale === true,
      'wholesale rewrite after mark → enrichmentStale re-flipped true');
  }

  // ---------------------------------------------------------------------
  // Scenario 4: non-active doc path strips legacy + stamps logline
  // ---------------------------------------------------------------------

  console.log('\nScenario 4: mark_enriched non-active path stamps disk + retires legacy fields');
  {
    const filename = 'sc4.md';
    const filePath = join(TEST_PROFILE_DIR, filename);

    // Seed a non-active doc on disk with stale state AND legacy fields.
    writeFileSync(filePath,
      `---\n${JSON.stringify({
        title: 'sc4',
        docId: 's4000001',
        domain: 'LegacyOnDisk',
        concepts: ['legacy'],
        docRole: 'vignette',
      })}\n---\n\nNon-active doc content.\n`,
      'utf-8');

    const doc = {
      type: 'doc',
      content: [makeNode('s4n0001', 'Non-active doc content.')],
    };

    markEnrichedNonActive(filename, doc, 'sc4',
      {
        docId: 's4000001',
        title: 'sc4',
        domain: 'LegacyOnDisk',
        concepts: ['legacy'],
        docRole: 'vignette',
      },
      'A non-active doc.');

    const fm = matter(readFileSync(filePath, 'utf-8'));
    assert(fm.data.enrichmentStale === false,
      'non-active: enrichmentStale = false on disk');
    assert(typeof fm.data.lastEnrichedAt === 'string',
      'non-active: lastEnrichedAt stamped');
    assert(Array.isArray(fm.data.lastEnrichedSentences) && fm.data.lastEnrichedSentences.length > 0,
      'non-active: lastEnrichedSentences stamped');
    assert(fm.data.logline === 'A non-active doc.',
      'non-active: logline persisted');
    assert(fm.data.domain === undefined,
      'non-active: legacy domain RETIRED');
    assert(fm.data.concepts === undefined,
      'non-active: legacy concepts RETIRED');
    assert(fm.data.docRole === undefined,
      'non-active: legacy docRole RETIRED');
  }

  // ---------------------------------------------------------------------
  // Scenario 5: agent-owned status survives mark_enriched
  // ---------------------------------------------------------------------

  console.log('\nScenario 5: agent-owned status survives mark_enriched');
  {
    const filename = 'sc5.md';
    const filePath = join(TEST_PROFILE_DIR, filename);

    // Seed with agent-set status: canonical. mark_enriched must NOT touch it.
    writeFileSync(filePath,
      `---\n${JSON.stringify({
        title: 'sc5',
        docId: 's5000001',
        status: 'canonical',
      })}\n---\n\nCanonical doc content.\n`,
      'utf-8');

    const doc = {
      type: 'doc',
      content: [makeNode('s5n0001', 'Canonical doc content.')],
    };

    markEnrichedNonActive(filename, doc, 'sc5',
      { docId: 's5000001', title: 'sc5', status: 'canonical' },
      'Canonical doc.');

    const fm = matter(readFileSync(filePath, 'utf-8'));
    assert(fm.data.status === 'canonical',
      'post-mark: agent-owned status preserved (mark_enriched does NOT write status)');
    assert(fm.data.logline === 'Canonical doc.',
      'post-mark: logline persisted alongside agent status');
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
