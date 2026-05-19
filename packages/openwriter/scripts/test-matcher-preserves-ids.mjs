/**
 * Regression test for the v0.14.0 silent-data-loss bug.
 *
 * Bug: The save-time matcher's applyInsertRule minted a fresh ID for every
 * unmatched block, ignoring any `attrs.id` the block already carried. That
 * was the root cause of a browser↔server ID divergence after MCP writes:
 *
 *   1. MCP write_to_pad → applyChangesToDocument stamps the new block with
 *      a fresh ID (say `p9999999`) and broadcasts it to the browser via
 *      `node-changes`. Browser's TipTap doc gets a paragraph with id=p9999999.
 *   2. writeToDisk runs the save-time matcher. The matcher sees p9999999 as
 *      an unmatched insert and (BUG) overwrites it with a brand-new id
 *      (say `pAAAAAAA`). The server's in-memory state.document and the
 *      on-disk frontmatter both now hold pAAAAAAA.
 *   3. Browser still holds p9999999. Subsequent server→browser updates that
 *      target pAAAAAAA can't be resolved by the browser (silent skip), and
 *      the browser's next autosave ships a `doc-update` with the old
 *      content + p9999999, overwriting fresh server state.
 *
 * Fix: applyInsertRule preserves `candidate.block.id` if present.
 *
 * This test fails on the BAD code (pre-fix) and passes on the GOOD code
 * (post-fix). The harness mirrors the production save path: read prev
 * nodes/graveyard from disk → run matcher → applyIdsToTiptap → write back.
 *
 * Run: `node scripts/test-matcher-preserves-ids.mjs`
 */

import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import matter from 'gray-matter';
import {
  markdownToTiptap,
  tiptapToMarkdown,
  markdownToNodes,
} from '../dist/server/markdown.js';
import { matchNodes } from '../dist/server/node-matcher.js';
import { resolvePreviousNodes, resolveGraveyard } from '../dist/server/markdown-parse.js';
import { tiptapToBlocks, applyIdsToTiptap } from '../dist/server/node-blocks.js';

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) { passed++; console.log(`  PASS: ${msg}`); }
  else      { failed++; console.error(`  FAIL: ${msg}`); }
}

/** Read frontmatter, return rich {id, fp} entries via the production
 *  enrichment path so tests can assert on legacy-shaped fields. */
function readDiskNodes(filePath) {
  const raw = readFileSync(filePath, 'utf-8');
  const { data, content } = matter(raw);
  const blocks = tiptapToBlocks({ type: 'doc', content: markdownToNodes(content) });
  const nodes = resolvePreviousNodes(data.nodes, blocks).map((r) => ({ id: r.id, fp: r.fingerprint }));
  const grave = resolveGraveyard(data.graveyard).map((r) => ({ id: r.id, fp: r.fingerprint }));
  return { nodes, graveyard: grave, rawData: data };
}

/** Mirror writeToDisk's save-time matcher pass. */
function saveWithMatcher(filePath, doc, title) {
  let previousNodes = [];
  let graveyard = [];
  try {
    const raw = readFileSync(filePath, 'utf-8');
    const { data, content } = matter(raw);
    const previousBlocks = tiptapToBlocks({ type: 'doc', content: markdownToNodes(content) });
    previousNodes = resolvePreviousNodes(data.nodes, previousBlocks);
    graveyard = resolveGraveyard(data.graveyard);
  } catch { /* new file */ }

  let nextGraveyard = graveyard;
  if (previousNodes.length > 0) {
    const newBlocks = tiptapToBlocks(doc);
    const result = matchNodes(previousNodes, newBlocks, { graveyard });
    const pinnedByPosition = new Map();
    for (const p of result.pinned) pinnedByPosition.set(p.position, p.id);
    applyIdsToTiptap(doc, pinnedByPosition);
    nextGraveyard = result.nextGraveyard;
  }

  const meta = nextGraveyard.length > 0
    ? { title, graveyard: nextGraveyard }
    : { title };
  const markdown = tiptapToMarkdown(doc, title, meta);
  writeFileSync(filePath, markdown);
}

const tmp = mkdtempSync(join(tmpdir(), 'ow-preserve-id-test-'));
const file = join(tmp, 'doc.md');

try {
  // ==========================================================================
  // SETUP: seed the file with two paragraphs carrying known IDs.
  // ==========================================================================
  console.log('Setup: seed doc with two paragraphs');
  {
    const doc = {
      type: 'doc',
      content: [
        { type: 'paragraph', attrs: { id: 'paraAAAA' }, content: [{ type: 'text', text: 'First.' }] },
        { type: 'paragraph', attrs: { id: 'paraBBBB' }, content: [{ type: 'text', text: 'Second.' }] },
      ],
    };
    saveWithMatcher(file, doc, 'Test');
    const { nodes: after } = readDiskNodes(file);
    assert(after.length === 2, `seeded 2 nodes (got ${after.length})`);
    assert(after[0].id === 'paraAAAA', `first seeded`);
    assert(after[1].id === 'paraBBBB', `second seeded`);
  }

  // ==========================================================================
  // CASE 1: insert a brand-new paragraph carrying an MCP-stamped ID.
  //
  // This is the exact production scenario: applyChangesToDocument has just
  // stamped a fresh ID onto the new node and broadcast it to the browser.
  // The save-time matcher MUST preserve that ID — otherwise the server's
  // state and the broadcast that just went to the browser diverge.
  // ==========================================================================
  console.log('\nCase 1: matcher preserves ID on new block (the v0.14.0 bug site)');
  {
    const reloaded = markdownToTiptap(readFileSync(file, 'utf-8'));
    // Simulate applyChangesToDocument adding a new para with a pre-assigned ID.
    reloaded.document.content.push({
      type: 'paragraph',
      attrs: { id: 'mcpADDED' },  // the agent-assigned ID
      content: [{ type: 'text', text: 'Added by MCP write_to_pad.' }],
    });
    saveWithMatcher(file, reloaded.document, reloaded.title);
    const { nodes: afterNodes } = readDiskNodes(file);
    const ids = afterNodes.map((n) => n.id);
    assert(ids.length === 3, `3 nodes after insert (got ${ids.length})`);
    assert(ids[0] === 'paraAAAA', `first ID unchanged`);
    assert(ids[1] === 'paraBBBB', `second ID unchanged`);
    // THIS IS THE REGRESSION ASSERTION. Pre-fix code would have generated a
    // fresh ID here (something like p7a3f9c1) and the test would fail.
    assert(ids[2] === 'mcpADDED', `inserted block KEEPS its agent-assigned ID (got ${ids[2]} — pre-fix would be a fresh mint)`);
  }

  // ==========================================================================
  // CASE 2: applyIdsToTiptap leaves the existing attrs.id intact post-match.
  //
  // After saveWithMatcher returns, the doc tree's attrs.id values must match
  // what's in the frontmatter. (If the matcher returned different IDs in
  // its pinned set, applyIdsToTiptap would overwrite. If the matcher honored
  // the existing IDs, attrs.id stays the same and frontmatter matches.)
  // ==========================================================================
  console.log('\nCase 2: in-memory attrs.id matches frontmatter after save');
  {
    const reloaded = markdownToTiptap(readFileSync(file, 'utf-8'));
    reloaded.document.content.push({
      type: 'paragraph',
      attrs: { id: 'mcpAGAIN' },
      content: [{ type: 'text', text: 'Another MCP-added paragraph.' }],
    });
    // Run the matcher pass and inspect in-memory tree post-pass
    const raw = readFileSync(file, 'utf-8');
    const { data, content } = matter(raw);
    const previousBlocks = tiptapToBlocks({ type: 'doc', content: markdownToNodes(content) });
    const previousNodes = resolvePreviousNodes(data.nodes, previousBlocks);
    const graveyard = resolveGraveyard(data.graveyard);
    const newBlocks = tiptapToBlocks(reloaded.document);
    const result = matchNodes(previousNodes, newBlocks, { graveyard });
    const pinnedByPosition = new Map();
    for (const p of result.pinned) pinnedByPosition.set(p.position, p.id);
    applyIdsToTiptap(reloaded.document, pinnedByPosition);
    const inMemoryIds = reloaded.document.content.map((n) => n.attrs?.id);
    assert(inMemoryIds[3] === 'mcpAGAIN', `in-memory ID of new block stays mcpAGAIN (got ${inMemoryIds[3]})`);
  }

  // ==========================================================================
  // CASE 3: edge case — block carries NO attrs.id (legacy / fresh content)
  //
  // The matcher should still mint a fresh ID when none was provided. This
  // is the genuinely-new-block fallback path the fix wants to preserve.
  // ==========================================================================
  console.log('\nCase 3: blocks without attrs.id still get fresh IDs minted');
  {
    const reloaded = markdownToTiptap(readFileSync(file, 'utf-8'));
    reloaded.document.content.push({
      type: 'paragraph',
      // No attrs.id — this should trigger the generateNodeId() branch
      content: [{ type: 'text', text: 'No id provided here.' }],
    });
    saveWithMatcher(file, reloaded.document, reloaded.title);
    const { nodes: afterNodes } = readDiskNodes(file);
    const ids = afterNodes.map((n) => n.id);
    const newId = ids[ids.length - 1];
    assert(typeof newId === 'string' && newId.length > 0, `fresh ID minted for unattributed block (got ${newId})`);
    assert(!['paraAAAA', 'paraBBBB', 'mcpADDED', 'mcpAGAIN'].includes(newId), `minted ID is distinct from all existing IDs`);
  }

  // ==========================================================================
  // CASE 3b: matcher does NOT put the same ID in both active nodes AND
  //          graveyard. The insert rule must claim the preserved ID from
  //          previousNodes/graveyard so it doesn't double-count.
  // ==========================================================================
  console.log('\nCase 3b: preserved ID is not duplicated in graveyard');
  {
    const reloaded = markdownToTiptap(readFileSync(file, 'utf-8'));
    // Append a brand-new para with an explicit ID — pre-fix this would have
    // been minted fresh; with the fix it gets preserved.
    reloaded.document.content.push({
      type: 'paragraph',
      attrs: { id: 'noDupeID' },
      content: [{ type: 'text', text: 'Another addition.' }],
    });
    saveWithMatcher(file, reloaded.document, reloaded.title);
    const { nodes: activeAll, graveyard: graveAll } = readDiskNodes(file);
    const activeIds = activeAll.map((n) => n.id);
    const graveIds = graveAll.map((g) => g.id);
    const inBoth = activeIds.filter((id) => graveIds.includes(id));
    assert(inBoth.length === 0, `no ID appears in both active and graveyard (got duplicates: ${JSON.stringify(inBoth)})`);
  }

  // ==========================================================================
  // CASE 3c: explicit IDs known to the graveyard win over slot-continuity.
  //
  // Reproduces the snapshot-restore scenario: doc currently has a block at
  // slot N. The agent (or restore) writes new content at slot N carrying an
  // ID that lives in the graveyard. The matcher should restore from
  // graveyard, not let slot-continuity claim the slot's current ID.
  // ==========================================================================
  console.log('\nCase 3c: explicit ID in graveyard wins over slot-continuity');
  {
    // Construct disk state: nodes=[hh, newPARA1], graveyard=[oldPARA1].
    // This needs delete + insert as separate save cycles so slot-continuity
    // doesn't coalesce them into a single in-place "edit" of the slot.
    const file2 = file + '.case3c';
    const seedDoc = {
      type: 'doc',
      content: [
        { type: 'heading', attrs: { id: 'hh111111', level: 2 }, content: [{ type: 'text', text: 'Heading' }] },
        { type: 'paragraph', attrs: { id: 'oldPARA1' }, content: [{ type: 'text', text: 'Old paragraph here.' }] },
      ],
    };
    saveWithMatcher(file2, seedDoc, 'Test');
    // Cycle 1: delete oldPARA1 entirely (no replacement). It enters graveyard.
    const after1 = markdownToTiptap(readFileSync(file2, 'utf-8'));
    after1.document.content = [after1.document.content[0]];
    saveWithMatcher(file2, after1.document, 'Test');
    // Cycle 2: add a brand-new paragraph with id newPARA1.
    const after2 = markdownToTiptap(readFileSync(file2, 'utf-8'));
    after2.document.content.push({
      type: 'paragraph',
      attrs: { id: 'newPARA1' },
      content: [{ type: 'text', text: 'Replacement content totally different.' }],
    });
    saveWithMatcher(file2, after2.document, 'Test');
    // Sanity: disk should now have [hh, newPARA1] in nodes and [oldPARA1] in graveyard.
    {
      const { nodes: interimNodes, graveyard: interimGraveAll } = readDiskNodes(file2);
      const interimIds = interimNodes.map((n) => n.id);
      const interimGrave = interimGraveAll.map((g) => g.id);
      assert(JSON.stringify(interimIds) === '["hh111111","newPARA1"]',
        `setup: nodes=[hh, newPARA1] (got ${JSON.stringify(interimIds)})`);
      assert(interimGrave.includes('oldPARA1'),
        `setup: oldPARA1 in graveyard (got ${JSON.stringify(interimGrave)})`);
    }
    // Cycle 3: paste back oldPARA1's content with its ID. The matcher should
    // restore oldPARA1 from graveyard rather than slot-continuity-pinning
    // newPARA1's id to the new block.
    const after3 = markdownToTiptap(readFileSync(file2, 'utf-8'));
    after3.document.content[1] = {
      type: 'paragraph',
      attrs: { id: 'oldPARA1' }, // ← ID known to graveyard
      content: [{ type: 'text', text: 'Old paragraph here.' }],
    };
    saveWithMatcher(file2, after3.document, 'Test');
    const { nodes: finalNodes, graveyard: finalGrave } = readDiskNodes(file2);
    const ids = finalNodes.map((n) => n.id);
    assert(ids[1] === 'oldPARA1',
      `slot inherits graveyard-known ID, not slot-continuity ID (got ${ids[1]}, expected oldPARA1)`);
    const graveIds = finalGrave.map((g) => g.id);
    assert(graveIds.includes('newPARA1'),
      `displaced newPARA1 goes to graveyard (got grave: ${JSON.stringify(graveIds)})`);
    rmSync(file2, { force: true });
  }

  // ==========================================================================
  // CASE 4: full-cycle — markdown→TipTap→matcher→markdown→re-parse stable
  //
  // After a save cycle, re-parsing the markdown produces a TipTap doc whose
  // block IDs match the frontmatter exactly. Any divergence here means the
  // browser would see different IDs than the disk on next load.
  // ==========================================================================
  console.log('\nCase 4: re-parse after save yields ID-stable doc');
  {
    const { nodes: fmAll } = readDiskNodes(file);
    const fmIds = fmAll.map((n) => n.id);
    const reparsed = markdownToTiptap(readFileSync(file, 'utf-8'));
    const docIds = reparsed.document.content.map((n) => n.attrs?.id);
    assert(JSON.stringify(fmIds) === JSON.stringify(docIds),
      `frontmatter IDs ${JSON.stringify(fmIds)} match parsed doc IDs ${JSON.stringify(docIds)}`);
  }

} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log('\n' + '='.repeat(60));
console.log(`Matcher preserves IDs: ${passed} passed, ${failed} failed`);
console.log('='.repeat(60));
process.exit(failed > 0 ? 1 : 0);
