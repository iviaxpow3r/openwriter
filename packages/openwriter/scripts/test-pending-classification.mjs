/**
 * Regression test for pending-overlay applyOverlay classification:
 * orphan handling (rewrite→insert, insert at end, delete discarded) and
 * stale-baseline detection.
 *
 * Why this matters:
 *   - External edits, restore_version, and matcher graveyarding can all
 *     remove canonical nodes that an overlay entry is anchored to.
 *   - Without classification, those orphan entries would silently fail
 *     to apply (rewrite: target gone → no decoration; insert: anchor
 *     gone → entry dropped), losing the agent's proposed content.
 *   - With classification:
 *       rewrite-orphan → orphan-insert at end of doc (creative content
 *         preserved, user can accept-or-reject as if it were a fresh
 *         insert), flagged `pendingOrphan: true`.
 *       insert-orphan → kept as insert at end of doc, flagged
 *         `pendingOrphan: true`.
 *       delete-orphan → silently discarded (the target was already gone).
 *   - Stale-baseline (rewrite target exists but content drifted from the
 *     baseline captured at proposal time): pending still applies, but
 *     flagged `pendingStaleBaseline: true` so the UI can warn the user
 *     that the rewrite was built against stale content.
 *
 * Run: `node scripts/test-pending-classification.mjs`
 */

import { applyOverlay } from '../dist/server/pending-overlay.js';

let passed = 0;
let failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log(`  PASS: ${msg}`); }
  else      { failed++; console.error(`  FAIL: ${msg}`); }
}

function makeDoc(nodes) {
  return { type: 'doc', content: nodes };
}

function paragraph(id, text) {
  return {
    type: 'paragraph',
    attrs: { id },
    content: [{ type: 'text', text }],
  };
}

// ============================================================================
// Case 1: rewrite-orphan converts to orphan-insert at end
// ============================================================================
console.log('Case 1: rewrite-orphan → orphan-insert at end');
{
  // Canonical has p1, p2. Pending wants to rewrite p3 (gone).
  const canonical = makeDoc([paragraph('p1', 'First.'), paragraph('p2', 'Second.')]);
  const entries = [
    {
      nodeId: 'p3',
      status: 'rewrite',
      newContent: paragraph('p3', 'Rewritten content.'),
      originalBaseline: paragraph('p3', 'Original content.'),
    },
  ];

  const result = applyOverlay(canonical, entries);
  assert(result.orphans.length === 1, `1 orphan classified (got ${result.orphans.length})`);
  assert(result.orphans[0].status === 'rewrite', `orphan original status preserved: ${result.orphans[0].status}`);
  assert(canonical.content.length === 3, `canonical has 3 nodes after orphan-insert (got ${canonical.content.length})`);

  const orphanNode = canonical.content[2];
  assert(orphanNode.attrs.id === 'p3', `orphan node has original nodeId: got ${orphanNode.attrs.id}`);
  assert(orphanNode.attrs.pendingStatus === 'insert', `orphan node converted to insert: got ${orphanNode.attrs.pendingStatus}`);
  assert(orphanNode.attrs.pendingOrphan === true, `pendingOrphan flag set: got ${orphanNode.attrs.pendingOrphan}`);
  assert(orphanNode.content?.[0]?.text === 'Rewritten content.', `orphan node carries rewrite content (creative content preserved)`);
}

// ============================================================================
// Case 2: insert-orphan (anchor gone) → orphan-insert at end
// ============================================================================
console.log('\nCase 2: insert-orphan (anchor gone) → orphan-insert at end');
{
  const canonical = makeDoc([paragraph('p1', 'First.')]);
  const entries = [
    {
      nodeId: 'p_new',
      status: 'insert',
      afterNodeId: 'p_gone', // anchor doesn't exist
      parentNodeId: null,
      newContent: paragraph('p_new', 'New insert prose.'),
    },
  ];

  const result = applyOverlay(canonical, entries);
  assert(result.orphans.length === 1, `1 orphan classified (got ${result.orphans.length})`);
  assert(canonical.content.length === 2, `canonical has 2 nodes after orphan-insert (got ${canonical.content.length})`);

  const orphanNode = canonical.content[1];
  assert(orphanNode.attrs.id === 'p_new', `orphan node has insert nodeId`);
  assert(orphanNode.attrs.pendingStatus === 'insert', `still insert after fallback placement`);
  assert(orphanNode.attrs.pendingOrphan === true, `pendingOrphan flag set`);
}

// ============================================================================
// Case 3: delete-orphan silently discarded (no UI noise)
// ============================================================================
console.log('\nCase 3: delete-orphan silently discarded');
{
  const canonical = makeDoc([paragraph('p1', 'First.'), paragraph('p2', 'Second.')]);
  const entries = [
    { nodeId: 'p_gone', status: 'delete' },
    { nodeId: 'p2', status: 'delete' }, // valid — should apply
  ];

  const result = applyOverlay(canonical, entries);
  assert(result.orphans.length === 0, `delete-orphan NOT in orphans list (it's silently dropped, got ${result.orphans.length})`);
  assert(canonical.content.length === 2, `canonical content count unchanged (got ${canonical.content.length})`);
  assert(canonical.content[1].attrs.pendingStatus === 'delete', `valid delete pending applied`);
  assert(canonical.content[1].attrs.id === 'p2', `valid delete targeted correct node`);
}

// ============================================================================
// Case 4: stale-baseline flagged when content drifted
// ============================================================================
console.log('\nCase 4: stale-baseline detection on rewrite');
{
  // p1 is in canonical with text 'Edited externally.', but the pending
  // entry's originalBaseline says it was 'Original.' when proposed.
  const canonical = makeDoc([paragraph('p1', 'Edited externally.')]);
  const entries = [
    {
      nodeId: 'p1',
      status: 'rewrite',
      newContent: paragraph('p1', 'Agent rewrite.'),
      originalBaseline: paragraph('p1', 'Original.'), // drift!
    },
  ];

  const result = applyOverlay(canonical, entries);
  assert(result.staleBaseline.length === 1, `1 entry flagged stale-baseline (got ${result.staleBaseline.length})`);
  assert(result.orphans.length === 0, `not classified as orphan (target exists)`);

  const targetNode = canonical.content[0];
  assert(targetNode.attrs.pendingStatus === 'rewrite', `rewrite still applies`);
  assert(targetNode.attrs.pendingStaleBaseline === true, `pendingStaleBaseline flag set on target node`);
  assert(targetNode.content?.[0]?.text === 'Agent rewrite.', `target carries proposed rewrite content`);
}

// ============================================================================
// Case 5: stale-baseline NOT flagged when content matches baseline
// ============================================================================
console.log('\nCase 5: matching baseline does NOT trigger stale flag');
{
  const canonical = makeDoc([paragraph('p1', 'Original.')]);
  const entries = [
    {
      nodeId: 'p1',
      status: 'rewrite',
      newContent: paragraph('p1', 'Rewritten.'),
      originalBaseline: paragraph('p1', 'Original.'), // matches!
    },
  ];

  const result = applyOverlay(canonical, entries);
  assert(result.staleBaseline.length === 0, `0 stale-baseline (baseline matches canonical, got ${result.staleBaseline.length})`);

  const targetNode = canonical.content[0];
  assert(targetNode.attrs.pendingStaleBaseline !== true, `pendingStaleBaseline NOT set`);
  assert(targetNode.attrs.pendingStatus === 'rewrite', `rewrite applies normally`);
}

// ============================================================================
// Case 6: missing baseline (legacy entry) → synthesize from current canonical
// ============================================================================
console.log('\nCase 6: missing baseline synthesizes from current canonical');
{
  const canonical = makeDoc([paragraph('p1', 'Current text.')]);
  const entries = [
    {
      nodeId: 'p1',
      status: 'rewrite',
      newContent: paragraph('p1', 'Replacement.'),
      // no originalBaseline — legacy/older overlay entry
    },
  ];

  const result = applyOverlay(canonical, entries);
  assert(result.staleBaseline.length === 0, `0 stale-baseline (synthesized, can't detect drift on legacy entries)`);
  const targetNode = canonical.content[0];
  assert(targetNode.attrs.pendingOriginalContent != null, `pendingOriginalContent synthesized from canonical`);
  assert(targetNode.attrs.pendingStatus === 'rewrite', `rewrite applies`);
}

// ============================================================================
// Case 7: mixed entries (orphan + stale + valid) classify independently
// ============================================================================
console.log('\nCase 7: mixed-bag classification');
{
  const canonical = makeDoc([
    paragraph('p1', 'Drifted text.'),
    paragraph('p2', 'Untouched.'),
  ]);
  const entries = [
    // Valid rewrite, no drift
    {
      nodeId: 'p2',
      status: 'rewrite',
      newContent: paragraph('p2', 'New p2.'),
      originalBaseline: paragraph('p2', 'Untouched.'),
    },
    // Stale-baseline rewrite (p1 content drifted)
    {
      nodeId: 'p1',
      status: 'rewrite',
      newContent: paragraph('p1', 'New p1.'),
      originalBaseline: paragraph('p1', 'Old p1.'),
    },
    // Orphan rewrite (target gone)
    {
      nodeId: 'p_gone',
      status: 'rewrite',
      newContent: paragraph('p_gone', 'Orphaned content.'),
      originalBaseline: paragraph('p_gone', 'Was gone.'),
    },
    // Orphan delete (target gone, silently discarded)
    { nodeId: 'p_also_gone', status: 'delete' },
  ];

  const result = applyOverlay(canonical, entries);
  assert(result.orphans.length === 1, `1 orphan (rewrite only, delete-orphan discarded): got ${result.orphans.length}`);
  assert(result.staleBaseline.length === 1, `1 stale-baseline (the drifted p1): got ${result.staleBaseline.length}`);
  assert(canonical.content.length === 3, `canonical has 3 nodes (p1, p2, orphan): got ${canonical.content.length}`);

  // Find the orphan-insert at the end
  const orphanNode = canonical.content[2];
  assert(orphanNode.attrs.pendingOrphan === true, `tail node is orphan-insert`);
  assert(orphanNode.attrs.pendingStatus === 'insert', `tail node status: insert`);

  // p1 is stale-baseline
  const p1 = canonical.content[0];
  assert(p1.attrs.pendingStaleBaseline === true, `p1 flagged stale-baseline`);
  assert(p1.attrs.pendingStatus === 'rewrite', `p1 still rewrite`);

  // p2 is valid (no flags)
  const p2 = canonical.content[1];
  assert(p2.attrs.pendingStaleBaseline !== true, `p2 NOT stale-baseline`);
  assert(p2.attrs.pendingOrphan !== true, `p2 NOT orphan`);
  assert(p2.attrs.pendingStatus === 'rewrite', `p2 rewrite applies`);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
