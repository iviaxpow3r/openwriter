/**
 * Round-trip invariant: splitMergedDoc(applyOverlayPure(canonical, entries))
 * must return canonical content that matches the ORIGINAL canonical, not the
 * post-merge state with rewrite text baked in.
 *
 * Before fix: stripPendingFromDoc stripped pending attrs but left rewrite
 * text in node.content. splitMergedDoc returned a "canonical" that contained
 * the rewrite text. The next applyOverlayPure compared canonical-as-rewrite
 * to baseline-as-original, flagged staleBaseline, and the dotted-underline
 * indicator fired even though nothing had drifted.
 *
 * After fix: stripPendingFromDoc restores rewrite nodes from
 * pendingOriginalContent before stripping markers. Canonical stays canonical
 * across any number of split/apply round-trips.
 *
 * adr: adr/pending-overlay-model.md
 *
 * Run: `node scripts/test-split-merged-roundtrip.mjs`
 */

import { applyOverlayPure, splitMergedDoc } from '../dist/server/pending-overlay.js';

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) { passed++; console.log(`  PASS: ${msg}`); }
  else      { failed++; console.error(`  FAIL: ${msg}`); }
}

function makeNode(id, text) {
  return { type: 'paragraph', attrs: { id }, content: [{ type: 'text', text }] };
}

function findNodeById(doc, id) {
  return (doc.content || []).find((n) => n?.attrs?.id === id);
}

function textOf(node) {
  return node?.content?.[0]?.text ?? '';
}

// --- Scenario 1: rewrite round-trip preserves canonical text ---
console.log('\nScenario 1: rewrite — canonical text survives split/apply');

const canonical = {
  type: 'doc',
  content: [
    makeNode('p1', 'Original paragraph one.'),
    makeNode('p2', 'Original paragraph two.'),
    makeNode('p3', 'Original paragraph three.'),
  ],
};

const rewriteEntry = {
  nodeId: 'p2',
  status: 'rewrite',
  newContent: { type: 'paragraph', attrs: { id: 'p2' }, content: [{ type: 'text', text: 'REWRITTEN paragraph two.' }] },
  originalBaseline: { type: 'paragraph', attrs: { id: 'p2' }, content: [{ type: 'text', text: 'Original paragraph two.' }] },
};

const merged1 = applyOverlayPure(canonical, [rewriteEntry]);
assert(textOf(findNodeById(merged1, 'p2')) === 'REWRITTEN paragraph two.', 'merged shows rewrite text');

const split1 = splitMergedDoc(merged1);
assert(textOf(findNodeById(split1.canonical, 'p2')) === 'Original paragraph two.',
  `split.canonical p2 reverts to original (got "${textOf(findNodeById(split1.canonical, 'p2'))}")`);
assert(textOf(findNodeById(split1.canonical, 'p1')) === 'Original paragraph one.',
  'split.canonical p1 unchanged');
assert(textOf(findNodeById(split1.canonical, 'p3')) === 'Original paragraph three.',
  'split.canonical p3 unchanged');
assert(split1.overlayEntries.length === 1, `extracted 1 overlay entry (got ${split1.overlayEntries.length})`);
assert(split1.overlayEntries[0].nodeId === 'p2', 'overlay entry attaches to p2');
assert(split1.overlayEntries[0].status === 'rewrite', 'overlay entry is a rewrite');

// --- Scenario 2: idempotent round-trip (split → apply → split → apply) ---
console.log('\nScenario 2: round-trip idempotency — split/apply twice converges');

const merged2 = applyOverlayPure(split1.canonical, split1.overlayEntries);
assert(textOf(findNodeById(merged2, 'p2')) === 'REWRITTEN paragraph two.',
  'merged2 reapplies rewrite text from canonical+overlay');

const split2 = splitMergedDoc(merged2);
assert(textOf(findNodeById(split2.canonical, 'p2')) === 'Original paragraph two.',
  'split2.canonical still original (no drift)');

// Crucial: staleBaseline must NOT fire on the second merge — canonical matches
// the baseline because we restored properly.
const node2 = findNodeById(merged2, 'p2');
assert(node2?.attrs?.pendingStaleBaseline !== true,
  `pendingStaleBaseline NOT set on round-tripped rewrite (got ${node2?.attrs?.pendingStaleBaseline})`);

// --- Scenario 3: delete survives split — node kept, marker cleared ---
console.log('\nScenario 3: delete — node stays in canonical, marker stripped');

const deleteEntry = { nodeId: 'p3', status: 'delete' };
const merged3 = applyOverlayPure(canonical, [deleteEntry]);
const p3InMerged = findNodeById(merged3, 'p3');
assert(p3InMerged?.attrs?.pendingStatus === 'delete', 'p3 marked delete in merged');

const split3 = splitMergedDoc(merged3);
const p3InCanonical = findNodeById(split3.canonical, 'p3');
assert(p3InCanonical != null, 'p3 still present in canonical (delete only marks; canonical keeps the node)');
assert(p3InCanonical?.attrs?.pendingStatus === undefined, 'pendingStatus stripped from canonical');
assert(textOf(p3InCanonical) === 'Original paragraph three.', 'p3 text unchanged');
assert(split3.overlayEntries.some((e) => e.nodeId === 'p3' && e.status === 'delete'),
  'delete entry extracted to overlay');

// --- Scenario 4: insert is dropped from canonical, kept in overlay ---
console.log('\nScenario 4: insert — node dropped from canonical, kept in overlay');

const insertEntry = {
  nodeId: 'pNew',
  status: 'insert',
  afterNodeId: 'p1',
  parentNodeId: null,
  newContent: { type: 'paragraph', attrs: { id: 'pNew' }, content: [{ type: 'text', text: 'NEW inserted paragraph.' }] },
};
const merged4 = applyOverlayPure(canonical, [insertEntry]);
assert(findNodeById(merged4, 'pNew') != null, 'insert appears in merged');

const split4 = splitMergedDoc(merged4);
assert(findNodeById(split4.canonical, 'pNew') == null, 'insert dropped from canonical');
assert(split4.canonical.content.length === 3, `canonical has 3 original nodes (got ${split4.canonical.content.length})`);
assert(split4.overlayEntries.some((e) => e.nodeId === 'pNew' && e.status === 'insert'),
  'insert entry preserved in overlay');

// --- Scenario 5: rewrite without baseline (legacy) — best-effort, no crash ---
console.log('\nScenario 5: rewrite without originalBaseline — best-effort, current content stays');

const legacyRewrite = {
  nodeId: 'p1',
  status: 'rewrite',
  newContent: { type: 'paragraph', attrs: { id: 'p1' }, content: [{ type: 'text', text: 'LEGACY rewrite (no baseline).' }] },
  // No originalBaseline — older entries from before baseline-capture
};

const merged5 = applyOverlayPure(canonical, [legacyRewrite]);
const split5 = splitMergedDoc(merged5);
// Without baseline, canonical can't be properly restored — best-effort means
// the rewrite text stays in canonical. We just verify no crash and the merge
// is still extractable.
const p1Canonical = findNodeById(split5.canonical, 'p1');
assert(p1Canonical != null, 'p1 still in canonical (no crash on missing baseline)');
assert(split5.overlayEntries.some((e) => e.nodeId === 'p1' && e.status === 'rewrite'),
  'rewrite entry still extracted');

// --- Scenario 6: mixed overlay (rewrite + delete + insert) ---
console.log('\nScenario 6: mixed overlay — all three statuses round-trip');

const mixedEntries = [
  rewriteEntry,
  deleteEntry,
  insertEntry,
];
const mergedMix = applyOverlayPure(canonical, mixedEntries);
const splitMix = splitMergedDoc(mergedMix);

assert(textOf(findNodeById(splitMix.canonical, 'p1')) === 'Original paragraph one.', 'mixed: p1 canonical preserved');
assert(textOf(findNodeById(splitMix.canonical, 'p2')) === 'Original paragraph two.', 'mixed: p2 reverted from rewrite');
assert(textOf(findNodeById(splitMix.canonical, 'p3')) === 'Original paragraph three.', 'mixed: p3 kept (delete marker stripped)');
assert(findNodeById(splitMix.canonical, 'pNew') == null, 'mixed: insert dropped from canonical');
assert(splitMix.overlayEntries.length === 3, `mixed: 3 overlay entries (got ${splitMix.overlayEntries.length})`);

// Re-apply and verify the second merge equals the first (true idempotency)
const mergedMix2 = applyOverlayPure(splitMix.canonical, splitMix.overlayEntries);
const node2Mix = findNodeById(mergedMix2, 'p2');
assert(node2Mix?.attrs?.pendingStaleBaseline !== true,
  `mixed: p2 NOT flagged stale on re-merge (got ${node2Mix?.attrs?.pendingStaleBaseline})`);

console.log('\n============================================================');
console.log(`Split/merged round-trip: ${passed} passed, ${failed} failed`);
console.log('============================================================');

if (failed > 0) process.exit(1);
