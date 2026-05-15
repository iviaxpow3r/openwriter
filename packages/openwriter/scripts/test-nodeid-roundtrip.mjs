/**
 * Round-trip test for nodeId persistence.
 * Builds a TipTap doc with known ids, serializes to markdown,
 * parses back, verifies ids survive intact.
 *
 * Run from packages/openwriter: `node scripts/test-nodeid-roundtrip.mjs`
 */

import { tiptapToMarkdown } from '../dist/server/markdown-serialize.js';
import { markdownToTiptap } from '../dist/server/markdown-parse.js';

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
// Test 1: Simple paragraph roundtrip
// ============================================================================
test('Test 1: simple paragraph keeps id', () => {
  const original = {
    type: 'doc',
    content: [
      { type: 'paragraph', attrs: { id: 'aabbccdd' }, content: [{ type: 'text', text: 'Hello world.' }] },
    ],
  };
  const md = tiptapToMarkdown(original, 'Test');
  console.log('  Serialized:\n' + md.split('\n').map(l => '    ' + l).join('\n'));
  const reparsed = markdownToTiptap(md);
  assert(reparsed.document.content[0].attrs.id === 'aabbccdd', `paragraph id preserved (got ${reparsed.document.content[0].attrs.id})`);
  assert(reparsed.document.content[0].content[0].text === 'Hello world.', 'text content preserved');
});

// ============================================================================
// Test 2: Heading roundtrip
// ============================================================================
test('Test 2: heading keeps id', () => {
  const original = {
    type: 'doc',
    content: [
      { type: 'heading', attrs: { id: '11223344', level: 2 }, content: [{ type: 'text', text: 'My Heading' }] },
    ],
  };
  const md = tiptapToMarkdown(original, 'Test');
  console.log('  Serialized:\n' + md.split('\n').map(l => '    ' + l).join('\n'));
  const reparsed = markdownToTiptap(md);
  assert(reparsed.document.content[0].attrs.id === '11223344', `heading id preserved (got ${reparsed.document.content[0].attrs.id})`);
  assert(reparsed.document.content[0].attrs.level === 2, 'heading level preserved');
});

// ============================================================================
// Test 3: Multiple blocks, mixed types
// ============================================================================
test('Test 3: multiple blocks with marks', () => {
  const original = {
    type: 'doc',
    content: [
      { type: 'heading', attrs: { id: 'aaaa1111', level: 1 }, content: [{ type: 'text', text: 'Title' }] },
      { type: 'paragraph', attrs: { id: 'bbbb2222' }, content: [
        { type: 'text', text: 'Some ', },
        { type: 'text', text: 'bold', marks: [{ type: 'bold' }] },
        { type: 'text', text: ' and ' },
        { type: 'text', text: 'italic', marks: [{ type: 'italic' }] },
        { type: 'text', text: ' text.' },
      ]},
      { type: 'paragraph', attrs: { id: 'cccc3333' }, content: [{ type: 'text', text: 'Second paragraph.' }] },
    ],
  };
  const md = tiptapToMarkdown(original, 'Test');
  console.log('  Serialized:\n' + md.split('\n').map(l => '    ' + l).join('\n'));
  const reparsed = markdownToTiptap(md);
  assert(reparsed.document.content[0].attrs.id === 'aaaa1111', 'heading id');
  assert(reparsed.document.content[1].attrs.id === 'bbbb2222', 'first paragraph id');
  assert(reparsed.document.content[2].attrs.id === 'cccc3333', 'second paragraph id');
  // Verify the bold/italic content survives
  const p1content = reparsed.document.content[1].content;
  const hasBold = p1content.some(n => n.text === 'bold' && n.marks?.some(m => m.type === 'bold'));
  const hasItalic = p1content.some(n => n.text === 'italic' && n.marks?.some(m => m.type === 'italic'));
  assert(hasBold, 'bold mark survives');
  assert(hasItalic, 'italic mark survives');
});

// ============================================================================
// Test 4: Empty paragraph keeps id
// ============================================================================
test('Test 4: empty paragraph keeps id', () => {
  const original = {
    type: 'doc',
    content: [
      { type: 'paragraph', attrs: { id: 'eeee1111' }, content: [] },
      { type: 'paragraph', attrs: { id: 'fff22222' }, content: [{ type: 'text', text: 'After empty.' }] },
    ],
  };
  const md = tiptapToMarkdown(original, 'Test');
  console.log('  Serialized:\n' + md.split('\n').map(l => '    ' + l).join('\n'));
  const reparsed = markdownToTiptap(md);
  assert(reparsed.document.content[0].attrs.id === 'eeee1111', `empty paragraph id (got ${reparsed.document.content[0].attrs.id})`);
  assert(reparsed.document.content[1].attrs.id === 'fff22222', `next paragraph id (got ${reparsed.document.content[1]?.attrs?.id})`);
});

// ============================================================================
// Test 5: Multi-pass round-trip (parse -> serialize -> parse -> serialize -> parse)
// ============================================================================
test('Test 5: multiple round-trips are stable', () => {
  const original = {
    type: 'doc',
    content: [
      { type: 'heading', attrs: { id: 'abc12345', level: 1 }, content: [{ type: 'text', text: 'Stable' }] },
      { type: 'paragraph', attrs: { id: 'def67890' }, content: [{ type: 'text', text: 'Round trip me twice.' }] },
    ],
  };
  const md1 = tiptapToMarkdown(original, 'Test');
  const parsed1 = markdownToTiptap(md1);
  const md2 = tiptapToMarkdown(parsed1.document, 'Test', parsed1.metadata);
  const parsed2 = markdownToTiptap(md2);
  const md3 = tiptapToMarkdown(parsed2.document, 'Test', parsed2.metadata);
  assert(md1 === md2, 'serialized markdown identical after first round-trip');
  assert(md2 === md3, 'serialized markdown identical after second round-trip');
  assert(parsed2.document.content[0].attrs.id === 'abc12345', 'heading id stable through 2 round-trips');
  assert(parsed2.document.content[1].attrs.id === 'def67890', 'paragraph id stable through 2 round-trips');
});

// ============================================================================
// Test 6: Lazy migration — paragraph without ^id gets a fresh id
// ============================================================================
test('Test 6: legacy markdown without anchors gets fresh ids', () => {
  const legacyMd = `---\n${JSON.stringify({ title: 'Legacy' })}\n---\n\n# Old heading\n\nOld paragraph with no anchor.\n\n`;
  const parsed = markdownToTiptap(legacyMd);
  assert(parsed.document.content[0].attrs.id?.match(/^[a-f0-9]{8}$/), `heading got fresh id (${parsed.document.content[0].attrs.id})`);
  assert(parsed.document.content[1].attrs.id?.match(/^[a-f0-9]{8}$/), `paragraph got fresh id (${parsed.document.content[1].attrs.id})`);
  // After save, the ids should now be in the markdown
  const saved = tiptapToMarkdown(parsed.document, 'Legacy', parsed.metadata);
  const reparsed = markdownToTiptap(saved);
  assert(reparsed.document.content[0].attrs.id === parsed.document.content[0].attrs.id, 'heading id stable on subsequent reads');
  assert(reparsed.document.content[1].attrs.id === parsed.document.content[1].attrs.id, 'paragraph id stable on subsequent reads');
});

// ============================================================================
// Test 7: Paragraph with link preserves both link and id
// ============================================================================
test('Test 7: paragraph with link mark preserves id', () => {
  const original = {
    type: 'doc',
    content: [
      { type: 'paragraph', attrs: { id: '0123abcd' }, content: [
        { type: 'text', text: 'See ' },
        { type: 'text', text: 'this doc', marks: [{ type: 'link', attrs: { href: 'doc:abc12345' } }] },
        { type: 'text', text: ' for more.' },
      ]},
    ],
  };
  const md = tiptapToMarkdown(original, 'Test');
  console.log('  Serialized:\n' + md.split('\n').map(l => '    ' + l).join('\n'));
  const reparsed = markdownToTiptap(md);
  assert(reparsed.document.content[0].attrs.id === '0123abcd', `paragraph id with link preserved (got ${reparsed.document.content[0].attrs.id})`);
  const linkedNode = reparsed.document.content[0].content.find(n => n.marks?.some(m => m.type === 'link'));
  assert(linkedNode?.text === 'this doc', 'link text preserved');
  assert(linkedNode?.marks?.[0]?.attrs?.href === 'doc:abc12345', `link href preserved (got ${linkedNode?.marks?.[0]?.attrs?.href})`);
});

// ============================================================================
// Summary
// ============================================================================
console.log(`\n${'='.repeat(60)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log('='.repeat(60));
process.exit(failed > 0 ? 1 : 0);
