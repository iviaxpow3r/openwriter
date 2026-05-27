/**
 * Verify the import-side healing of `<br><br>` paragraph fusion.
 *
 * Legacy tweet docs (pre-6d0a75e) serialized multi-paragraph content as a
 * single paragraph with `<br><br>` between visual chunks. On import that
 * lands as one TipTap `<p>` containing consecutive hardBreaks — which
 * breaks triple-click selection, per-paragraph review, and Author's Voice
 * scope. This test exercises the heal at the parse boundary.
 *
 * Run from packages/openwriter: `node scripts/test-paragraph-fusion-heal.mjs`
 */

import { markdownToTiptap, markdownToNodes } from '../dist/server/markdown-parse.js';
import { tiptapToMarkdown } from '../dist/server/markdown-serialize.js';

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) {
    passed++;
    console.log(`  PASS: ${msg}`);
  } else {
    failed++;
    console.error(`  FAIL: ${msg}`);
  }
}

function test(name, fn) {
  console.log(`\n${name}`);
  fn();
}

// ============================================================================
// Test 1: <br><br> fuses paragraphs visually -> import splits them
// ============================================================================
test('Test 1: import splits on <br><br>', () => {
  const md = 'First paragraph.<br><br>Second paragraph.\n';
  const nodes = markdownToNodes(md);
  assert(nodes.length === 2, `produces 2 paragraphs (got ${nodes.length})`);
  assert(nodes[0].type === 'paragraph', 'first node is paragraph');
  assert(nodes[1].type === 'paragraph', 'second node is paragraph');
  assert(nodes[0].content?.[0]?.text === 'First paragraph.', `first text: ${JSON.stringify(nodes[0].content)}`);
  assert(nodes[1].content?.[0]?.text === 'Second paragraph.', `second text: ${JSON.stringify(nodes[1].content)}`);
  const hardBreaks = JSON.stringify(nodes).match(/hardBreak/g) || [];
  assert(hardBreaks.length === 0, `no hardBreaks remain (found ${hardBreaks.length})`);
});

// ============================================================================
// Test 2: Single <br> stays as inline hardBreak (legitimate soft break)
// ============================================================================
test('Test 2: single <br> stays inline', () => {
  const md = 'Line one.<br>Line two.\n';
  const nodes = markdownToNodes(md);
  assert(nodes.length === 1, `stays as 1 paragraph (got ${nodes.length})`);
  const content = nodes[0].content || [];
  assert(content.some((c) => c.type === 'hardBreak'), 'preserves hardBreak');
  assert(content[0]?.text === 'Line one.', `text 0: ${JSON.stringify(content)}`);
  assert(content[2]?.text === 'Line two.', `text 2: ${JSON.stringify(content)}`);
});

// ============================================================================
// Test 3: <br><br><br> (3+) still splits as one boundary
// ============================================================================
test('Test 3: three consecutive <br>s split once', () => {
  const md = 'A.<br><br><br>B.\n';
  const nodes = markdownToNodes(md);
  assert(nodes.length === 2, `produces 2 paragraphs (got ${nodes.length})`);
  assert(nodes[0].content?.[0]?.text === 'A.', `first: ${JSON.stringify(nodes[0])}`);
  assert(nodes[1].content?.[0]?.text === 'B.', `second: ${JSON.stringify(nodes[1])}`);
});

// ============================================================================
// Test 4: Mixed single + double — single stays, double splits
// ============================================================================
test('Test 4: mix of single and double breaks', () => {
  const md = 'A.<br>B.<br><br>C.<br>D.\n';
  const nodes = markdownToNodes(md);
  assert(nodes.length === 2, `produces 2 paragraphs (got ${nodes.length})`);
  // First paragraph: A. <br> B.
  const c1 = nodes[0].content || [];
  assert(c1[0]?.text === 'A.', `p1 text 0: ${JSON.stringify(c1)}`);
  assert(c1[1]?.type === 'hardBreak', `p1 has hardBreak: ${JSON.stringify(c1)}`);
  assert(c1[2]?.text === 'B.', `p1 text 2: ${JSON.stringify(c1)}`);
  // Second paragraph: C. <br> D.
  const c2 = nodes[1].content || [];
  assert(c2[0]?.text === 'C.', `p2 text 0: ${JSON.stringify(c2)}`);
  assert(c2[1]?.type === 'hardBreak', `p2 has hardBreak: ${JSON.stringify(c2)}`);
  assert(c2[2]?.text === 'D.', `p2 text 2: ${JSON.stringify(c2)}`);
});

// ============================================================================
// Test 5: \n\n produces separate paragraphs (already correct, just guard)
// ============================================================================
test('Test 5: blank line produces separate paragraphs', () => {
  const md = 'Para one.\n\nPara two.\n\nPara three.\n';
  const nodes = markdownToNodes(md);
  assert(nodes.length === 3, `produces 3 paragraphs (got ${nodes.length})`);
});

// ============================================================================
// Test 6: Round-trip stability — split paragraphs serialize cleanly
// ============================================================================
test('Test 6: split paragraphs round-trip without <br><br>', () => {
  const md = 'First.<br><br>Second.\n';
  const parsed = markdownToTiptap(md);
  const back = tiptapToMarkdown(parsed.document, parsed.title || 'Test');
  assert(!back.includes('<br><br>'), `serialized body has no <br><br>: ${JSON.stringify(back)}`);
  // Re-parsing must remain stable (idempotent after heal)
  const reparsed = markdownToNodes(back.split(/^---\n[\s\S]*?\n---\n\n/)[1] || back);
  assert(reparsed.length === 2, `idempotent: 2 paragraphs on reparse (got ${reparsed.length})`);
});

// ============================================================================
// Test 7: All-empty edge case — `<br><br>` alone doesn't lose the paragraph
// ============================================================================
test('Test 7: lone <br><br> survives as one empty paragraph', () => {
  const md = '<br><br>\n';
  const nodes = markdownToNodes(md);
  // markdown-it may or may not pass <br><br> alone as inline content;
  // either way we should produce at least one node.
  assert(nodes.length >= 1, `at least one node (got ${nodes.length})`);
});

// ============================================================================
// Test 8: The exact on-disk Russell Crowe paragraph shape
// ============================================================================
test('Test 8: Russell Crowe doc shape splits correctly', () => {
  const md = `Russell Crowe here demonstrates the exact frame most fathers have been shamed into abandoning. It's straightforward: "I don't enjoy this, but I know it matters to you, so we'll do it." "But if we're doing it. It's on my terms.<br><br>He's not apologizing for disliking it.

Imagine a dad saying this about kids' activities.
`;
  const nodes = markdownToNodes(md);
  assert(nodes.length === 3, `produces 3 paragraphs (got ${nodes.length})`);
  assert(nodes[0].content?.[0]?.text?.startsWith('Russell Crowe'), `p1 starts with Russell: ${JSON.stringify(nodes[0].content?.[0])}`);
  assert(nodes[1].content?.[0]?.text === "He's not apologizing for disliking it.", `p2 text: ${JSON.stringify(nodes[1].content)}`);
  assert(nodes[2].content?.[0]?.text?.startsWith('Imagine a dad'), `p3 starts with Imagine: ${JSON.stringify(nodes[2].content?.[0])}`);
  // None of the resulting nodes should contain hardBreaks (no internal <br> in source)
  for (let i = 0; i < nodes.length; i++) {
    const breaks = (nodes[i].content || []).filter((c) => c.type === 'hardBreak');
    assert(breaks.length === 0, `p${i + 1} has no hardBreaks (got ${breaks.length})`);
  }
});

// ============================================================================
console.log(`\n--- ${passed} passed, ${failed} failed ---`);
process.exit(failed > 0 ? 1 : 0);
