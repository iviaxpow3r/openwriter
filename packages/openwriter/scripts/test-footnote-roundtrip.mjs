/**
 * Round-trip test for footnote system.
 *
 *   - References + definitions survive parse → serialize → parse cleanly
 *   - Pandoc-style scattered definitions normalize to end-of-doc on first save
 *   - Author-named labels preserved
 *   - Block IDs on section and definitions round-trip via frontmatter `nodes`
 *
 * Run from packages/openwriter: `node scripts/test-footnote-roundtrip.mjs`
 *
 * adr: adr/footnote-system.md
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
// Test 1: Disk → TipTap → Disk for a simple footnote
// ============================================================================
test('Test 1: parse Pandoc-style markdown into TipTap', () => {
  const source = `Humans run fixed action patterns[^1] too.

[^1]: Eibl-Eibesfeldt 1973, replicated and extended by Galati et al. 2003.
`;
  const parsed = markdownToTiptap(source);
  const body = parsed.document.content;

  // Find the paragraph and the section
  const para = body.find((n) => n.type === 'paragraph');
  const section = body.find((n) => n.type === 'footnoteSection');

  assert(!!para, 'parses paragraph');
  assert(!!section, 'parses footnoteSection at end of doc');
  assert(section?.content?.length === 1, `section has 1 definition (got ${section?.content?.length})`);

  // The paragraph should have a footnoteReference inline node
  const ref = para?.content?.find((c) => c.type === 'footnoteReference');
  assert(!!ref, 'paragraph contains footnoteReference inline node');
  assert(ref?.attrs?.label === '1', `reference label is "1" (got ${ref?.attrs?.label})`);

  // Definition content
  const def = section?.content?.[0];
  assert(def?.attrs?.label === '1', `definition label is "1" (got ${def?.attrs?.label})`);
  const defText = def?.content?.[0]?.content?.map((c) => c.text).join('') || '';
  assert(defText.includes('Eibl-Eibesfeldt'), `definition text preserved: "${defText}"`);
});

// ============================================================================
// Test 2: TipTap → Disk emits constrained shape
// ============================================================================
test('Test 2: serializer emits reference inline and section at end', () => {
  const doc = {
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        attrs: { id: 'aaaa0001' },
        content: [
          { type: 'text', text: 'Humans run fixed action patterns' },
          { type: 'footnoteReference', attrs: { label: '1' } },
          { type: 'text', text: ' too.' },
        ],
      },
      {
        type: 'footnoteSection',
        attrs: { id: 'bbbb0002' },
        content: [
          {
            type: 'footnoteDefinition',
            attrs: { id: 'cccc0003', label: '1' },
            content: [
              {
                type: 'paragraph',
                attrs: { id: 'dddd0004' },
                content: [{ type: 'text', text: 'Eibl-Eibesfeldt 1973.' }],
              },
            ],
          },
        ],
      },
    ],
  };

  const md = tiptapToMarkdown(doc, 'Test');
  console.log('  Serialized:\n' + md.split('\n').map((l) => '    ' + l).join('\n'));

  assert(md.includes('Humans run fixed action patterns[^1] too.'), 'reference emits inline as [^N]');
  assert(md.includes('[^1]: Eibl-Eibesfeldt 1973.'), 'definition emits at end of doc');
  // Definition should come after the paragraph in source order
  const paraIdx = md.indexOf('Humans run');
  const defIdx = md.indexOf('[^1]: Eibl');
  assert(paraIdx < defIdx, 'definition placed after prose');
});

// ============================================================================
// Test 3: Idempotent roundtrip — parse → serialize → parse → serialize stable
// ============================================================================
test('Test 3: roundtrip is byte-stable after one normalization pass', () => {
  const source = `Humans run fixed action patterns[^1] too.

[^1]: Eibl-Eibesfeldt 1973.
`;
  const parsed1 = markdownToTiptap(source);
  const md1 = tiptapToMarkdown(parsed1.document, parsed1.title, parsed1.metadata);
  const parsed2 = markdownToTiptap(md1);
  const md2 = tiptapToMarkdown(parsed2.document, parsed2.title, parsed2.metadata);

  assert(md1 === md2, 'second roundtrip produces identical output');
});

// ============================================================================
// Test 4: Multiple footnotes
// ============================================================================
test('Test 4: multiple footnotes round-trip in order', () => {
  const source = `One claim[^1] and another[^2] and a third[^3].

[^1]: First citation.
[^2]: Second citation.
[^3]: Third citation.
`;
  const parsed = markdownToTiptap(source);
  const section = parsed.document.content.find((n) => n.type === 'footnoteSection');
  assert(section?.content?.length === 3, `3 definitions in section (got ${section?.content?.length})`);

  const labels = section?.content?.map((d) => d.attrs?.label) || [];
  assert(JSON.stringify(labels) === JSON.stringify(['1', '2', '3']), `labels in order: ${labels.join(',')}`);

  // Re-serialize and check reference order in prose
  const md = tiptapToMarkdown(parsed.document, parsed.title, parsed.metadata);
  const oneIdx = md.indexOf('[^1]');
  const twoIdx = md.indexOf('[^2]');
  const threeIdx = md.indexOf('[^3]');
  assert(oneIdx < twoIdx && twoIdx < threeIdx, 'reference order preserved in prose');
});

// ============================================================================
// Test 5: Author-named (mnemonic) labels preserved on disk
// ============================================================================
test('Test 5: mnemonic labels survive roundtrip', () => {
  const source = `Per Sapolsky[^sapolsky2017], stress responses.

[^sapolsky2017]: Sapolsky, R. (2017). Behave.
`;
  const parsed = markdownToTiptap(source);
  const para = parsed.document.content.find((n) => n.type === 'paragraph');
  const ref = para?.content?.find((c) => c.type === 'footnoteReference');
  assert(ref?.attrs?.label === 'sapolsky2017', `mnemonic reference label preserved (got ${ref?.attrs?.label})`);

  const section = parsed.document.content.find((n) => n.type === 'footnoteSection');
  const def = section?.content?.[0];
  assert(def?.attrs?.label === 'sapolsky2017', `mnemonic definition label preserved (got ${def?.attrs?.label})`);

  const md = tiptapToMarkdown(parsed.document, parsed.title, parsed.metadata);
  assert(md.includes('[^sapolsky2017]'), 'mnemonic label round-trips through serializer');
});

// ============================================================================
// Test 6: Block IDs round-trip via frontmatter nodes
// ============================================================================
test('Test 6: footnoteSection and footnoteDefinition IDs persist via frontmatter', () => {
  const doc = {
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        attrs: { id: 'paraaaaa' },
        content: [
          { type: 'text', text: 'Body.' },
          { type: 'footnoteReference', attrs: { label: '1' } },
        ],
      },
      {
        type: 'footnoteSection',
        attrs: { id: 'sectabcd' },
        content: [
          {
            type: 'footnoteDefinition',
            attrs: { id: 'defabcde', label: '1' },
            content: [
              {
                type: 'paragraph',
                attrs: { id: 'defpara1' },
                content: [{ type: 'text', text: 'Footnote text.' }],
              },
            ],
          },
        ],
      },
    ],
  };

  const md = tiptapToMarkdown(doc, 'Test');
  const reparsed = markdownToTiptap(md);

  const paraR = reparsed.document.content.find((n) => n.type === 'paragraph');
  const sectionR = reparsed.document.content.find((n) => n.type === 'footnoteSection');
  const defR = sectionR?.content?.[0];

  assert(paraR?.attrs?.id === 'paraaaaa', `paragraph id survived (got ${paraR?.attrs?.id})`);
  assert(sectionR?.attrs?.id === 'sectabcd', `footnoteSection id survived (got ${sectionR?.attrs?.id})`);
  assert(defR?.attrs?.id === 'defabcde', `footnoteDefinition id survived (got ${defR?.attrs?.id})`);
});

// ============================================================================
// Test 7: Section always emitted at end even if positioned elsewhere in tree
// ============================================================================
test('Test 7: serializer enforces end-of-doc placement for footnoteSection', () => {
  // Tree with section positioned in the middle — serializer should move it last.
  const doc = {
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        attrs: { id: 'aaaa0001' },
        content: [
          { type: 'text', text: 'First para[^1].' },
        ],
      },
      // Section in WRONG position (middle) — serializer must move it
      {
        type: 'footnoteSection',
        attrs: { id: 'sect0002' },
        content: [
          {
            type: 'footnoteDefinition',
            attrs: { id: 'def00003', label: '1' },
            content: [
              {
                type: 'paragraph',
                attrs: { id: 'defp0004' },
                content: [{ type: 'text', text: 'Citation.' }],
              },
            ],
          },
        ],
      },
      {
        type: 'paragraph',
        attrs: { id: 'bbbb0005' },
        content: [
          { type: 'text', text: 'Second para after where section was.' },
        ],
      },
    ],
  };

  const md = tiptapToMarkdown(doc, 'Test');
  const firstIdx = md.indexOf('First para');
  const secondIdx = md.indexOf('Second para');
  const defIdx = md.indexOf('[^1]: Citation');

  assert(firstIdx < secondIdx && secondIdx < defIdx, 'section serialized after BOTH paragraphs regardless of tree position');
});

// ============================================================================
// Test 8: trailing empty paragraph is dropped when footnoteSection present
// ============================================================================
test('Test 8: trailing empty paragraph stripped when footnoteSection present', () => {
  // TipTap-style tree with trailing empty paragraph between body and section.
  // This is the shape produced by insertFootnoteAt when the editor had an
  // auto-trailing-paragraph at end-of-doc before the section was inserted.
  const doc = {
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        attrs: { id: 'aaaa0001' },
        content: [
          { type: 'text', text: 'Body[^1].' },
        ],
      },
      // Trailing empty paragraph — should be dropped on serialize
      {
        type: 'paragraph',
        attrs: { id: 'bbbb0002' },
        content: [],
      },
      {
        type: 'footnoteSection',
        attrs: { id: 'sect0003' },
        content: [
          {
            type: 'footnoteDefinition',
            attrs: { id: 'def00004', label: '1' },
            content: [
              {
                type: 'paragraph',
                attrs: { id: 'defp0005' },
                content: [{ type: 'text', text: 'Citation.' }],
              },
            ],
          },
        ],
      },
    ],
  };

  const md = tiptapToMarkdown(doc, 'Test');
  assert(!md.includes('<!-- -->'), `no <!-- --> marker between body and footnote section\nGot:\n${md}`);
  assert(md.includes('Body[^1].'), 'body preserved');
  assert(md.includes('[^1]: Citation.'), 'footnote definition preserved');
});

// ============================================================================
// Test 9: trailing empty paragraph dropped when section comes BEFORE it in tree
// ============================================================================
test('Test 9: trailing empty paragraph after section is also dropped', () => {
  // Tree where footnoteSection precedes the trailing empty paragraph.
  // This is the shape after insertFootnoteAt with the section appended at
  // doc.content.size (after the existing trailing empty).
  const doc = {
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        attrs: { id: 'aaaa0001' },
        content: [{ type: 'text', text: 'Body[^1].' }],
      },
      {
        type: 'footnoteSection',
        attrs: { id: 'sect0002' },
        content: [
          {
            type: 'footnoteDefinition',
            attrs: { id: 'def00003', label: '1' },
            content: [
              {
                type: 'paragraph',
                attrs: { id: 'defp0004' },
                content: [{ type: 'text', text: 'Citation.' }],
              },
            ],
          },
        ],
      },
      // Trailing empty paragraph after section
      {
        type: 'paragraph',
        attrs: { id: 'bbbb0005' },
        content: [],
      },
    ],
  };

  const md = tiptapToMarkdown(doc, 'Test');
  assert(!md.includes('<!-- -->'), `no <!-- --> marker anywhere\nGot:\n${md}`);
  assert(md.includes('Body[^1].'), 'body preserved');
  assert(md.includes('[^1]: Citation.'), 'footnote definition preserved');
});

// ============================================================================
// Summary
// ============================================================================
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
