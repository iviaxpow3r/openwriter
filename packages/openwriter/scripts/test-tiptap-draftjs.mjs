/**
 * Unit tests for the shared TipTap -> X Articles DraftJS content_state
 * converter (server/tiptap-draftjs.ts). Pure function, no I/O.
 *
 * Run from packages/openwriter: `node scripts/test-tiptap-draftjs.mjs`
 */

import { tiptapToDraftjs } from '../dist/server/tiptap-draftjs.js';

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.error(`  FAIL: ${msg}`);
  }
}

function eq(a, b, msg) {
  const ja = JSON.stringify(a);
  const jb = JSON.stringify(b);
  assert(ja === jb, `${msg}\n    expected: ${jb}\n    actual:   ${ja}`);
}

const doc = (content) => ({ type: 'doc', content });
const para = (content) => ({ type: 'paragraph', content });
const text = (t, marks) => (marks ? { type: 'text', text: t, marks } : { type: 'text', text: t });

// ── Minimal / empty ─────────────────────────────────────────────
{
  const out = tiptapToDraftjs(doc([para([text('hi')])]));
  eq(out.blocks[0].text, 'hi', 'minimal: text');
  eq(out.blocks[0].type, 'unstyled', 'minimal: paragraph -> unstyled');
  eq(out.entities, [], 'minimal: no entities');
  assert(out.blocks[0].inline_style_ranges === undefined, 'minimal: no style ranges emitted');

  const empty = tiptapToDraftjs(doc([]));
  eq(empty.blocks.length, 1, 'empty doc still yields one block');
  eq(empty.blocks[0].type, 'unstyled', 'empty doc block is unstyled');
  eq(empty.blocks[0].text, '', 'empty doc block has empty text');

  const nullish = tiptapToDraftjs(null);
  eq(nullish.blocks.length, 1, 'null doc is handled, yields one block');
}

// ── Headings ────────────────────────────────────────────────────
{
  const out = tiptapToDraftjs(doc([
    { type: 'heading', attrs: { level: 1 }, content: [text('Title')] },
    { type: 'heading', attrs: { level: 3 }, content: [text('Sub')] },
    { type: 'heading', attrs: { level: 9 }, content: [text('Clamped')] },
  ]));
  eq(out.blocks[0].type, 'header-one', 'h1 -> header-one');
  eq(out.blocks[1].type, 'header-three', 'h3 -> header-three');
  eq(out.blocks[2].type, 'header-six', 'h9 clamps to header-six');
}

// ── Inline styles ───────────────────────────────────────────────
{
  const out = tiptapToDraftjs(doc([
    para([
      text('a'),
      text('bold', [{ type: 'bold' }]),
      text('c'),
    ]),
  ]));
  eq(out.blocks[0].text, 'aboldc', 'inline: concatenated text');
  eq(out.blocks[0].inline_style_ranges, [{ offset: 1, length: 4, style: 'bold' }], 'inline: bold range offset/length');
}

// ── Adjacent same-style ranges merge ────────────────────────────
{
  const out = tiptapToDraftjs(doc([
    para([
      text('x', [{ type: 'bold' }]),
      text('y', [{ type: 'bold' }]),
    ]),
  ]));
  eq(out.blocks[0].inline_style_ranges, [{ offset: 0, length: 2, style: 'bold' }], 'adjacent bold ranges merge into one');
}

// ── Multiple marks on one run ───────────────────────────────────
{
  const out = tiptapToDraftjs(doc([
    para([text('zz', [{ type: 'bold' }, { type: 'italic' }])]),
  ]));
  const styles = out.blocks[0].inline_style_ranges;
  assert(styles.some((s) => s.style === 'bold' && s.length === 2), 'bold+italic: bold present');
  assert(styles.some((s) => s.style === 'italic' && s.length === 2), 'bold+italic: italic present');
}

// ── Links -> entity ranges + entities ───────────────────────────
{
  const out = tiptapToDraftjs(doc([
    para([
      text('see '),
      text('X', [{ type: 'link', attrs: { href: 'https://x.com' } }]),
    ]),
  ]));
  eq(out.blocks[0].entity_ranges, [{ offset: 4, length: 1, key: 0 }], 'link: entity_range key is the integer 0');
  eq(out.entities, [{ key: '0', value: { type: 'link', mutability: 'mutable', data: { url: 'https://x.com' } } }], 'link: entity key is the string "0", lowercase type/mutability');
}

// ── Lists (nested) ──────────────────────────────────────────────
{
  const li = (content) => ({ type: 'listItem', content });
  const out = tiptapToDraftjs(doc([
    {
      type: 'bulletList',
      content: [
        li([para([text('one')])]),
        li([
          para([text('two')]),
          { type: 'bulletList', content: [li([para([text('nested')])])] },
        ]),
      ],
    },
  ]));
  eq(out.blocks[0].type, 'unordered-list-item', 'list: item type');
  eq(out.blocks[0].text, 'one', 'list: first item text');
  assert(out.blocks[0].depth === undefined, 'list: depth 0 omitted');
  eq(out.blocks[2].text, 'nested', 'list: nested item text');
  eq(out.blocks[2].depth, 1, 'list: nested item depth=1');
}

// ── Ordered list ────────────────────────────────────────────────
{
  const li = (content) => ({ type: 'listItem', content });
  const out = tiptapToDraftjs(doc([
    { type: 'orderedList', content: [li([para([text('first')])])] },
  ]));
  eq(out.blocks[0].type, 'ordered-list-item', 'ordered list -> ordered-list-item');
}

// ── Task list -> bullet with checkbox glyph, offsets shifted ────
{
  const out = tiptapToDraftjs(doc([
    {
      type: 'taskList',
      content: [
        { type: 'taskItem', attrs: { checked: true }, content: [para([text('done', [{ type: 'bold' }])])] },
        { type: 'taskItem', attrs: { checked: false }, content: [para([text('todo')])] },
      ],
    },
  ]));
  eq(out.blocks[0].type, 'unordered-list-item', 'task: degrades to bullet');
  assert(out.blocks[0].text.startsWith('☑ '), 'task: checked glyph prefix');
  assert(out.blocks[1].text.startsWith('☐ '), 'task: unchecked glyph prefix');
  // 'done' bold range must shift right by the 2-char prefix ('☑ ').
  eq(out.blocks[0].inline_style_ranges, [{ offset: 2, length: 4, style: 'bold' }], 'task: bold range shifted past prefix');
}

// ── Blockquote ──────────────────────────────────────────────────
{
  const out = tiptapToDraftjs(doc([
    { type: 'blockquote', content: [para([text('quoted')]), para([text('second')])] },
  ]));
  eq(out.blocks[0].type, 'blockquote', 'blockquote: type');
  eq(out.blocks[1].type, 'blockquote', 'blockquote: each paragraph its own block');
  eq(out.blocks[1].text, 'second', 'blockquote: second paragraph text');
}

// ── Code block -> one code-block per line ───────────────────────
{
  const out = tiptapToDraftjs(doc([
    { type: 'codeBlock', attrs: { language: 'js' }, content: [text('line1\nline2')] },
  ]));
  eq(out.blocks[0], { key: out.blocks[0].key, text: 'line1', type: 'code-block' }, 'code: line 1');
  eq(out.blocks[1].text, 'line2', 'code: line 2');
  eq(out.blocks[1].type, 'code-block', 'code: line 2 type');
}

// ── Hard break -> newline within block text ─────────────────────
{
  const out = tiptapToDraftjs(doc([
    para([text('a'), { type: 'hardBreak' }, text('b')]),
  ]));
  eq(out.blocks[0].text, 'a\nb', 'hardBreak becomes newline in text');
}

// ── Horizontal rule -> blank separator block ────────────────────
{
  const out = tiptapToDraftjs(doc([
    para([text('before')]),
    { type: 'horizontalRule' },
    para([text('after')]),
  ]));
  eq(out.blocks[1], { key: out.blocks[1].key, text: '', type: 'unstyled' }, 'hr -> blank unstyled block');
}

// ── Body image -> alt text preserved ────────────────────────────
{
  const out = tiptapToDraftjs(doc([
    { type: 'image', attrs: { src: '/_images/x.png', alt: 'a cat' } },
  ]));
  eq(out.blocks[0].text, 'a cat', 'image: alt text preserved');
}

// ── Table -> pipe-joined rows ───────────────────────────────────
{
  const cell = (t) => ({ type: 'tableCell', content: [para([text(t)])] });
  const row = (...cells) => ({ type: 'tableRow', content: cells });
  const out = tiptapToDraftjs(doc([
    { type: 'table', content: [row(cell('A'), cell('B')), row(cell('1'), cell('2'))] },
  ]));
  eq(out.blocks[0].text, 'A | B', 'table: header row pipe-joined');
  eq(out.blocks[1].text, '1 | 2', 'table: body row pipe-joined');
}

// ── Block keys are unique ───────────────────────────────────────
{
  const out = tiptapToDraftjs(doc([para([text('a')]), para([text('b')]), para([text('c')])]));
  const keys = out.blocks.map((b) => b.key);
  eq(new Set(keys).size, keys.length, 'all block keys are unique');
}

console.log(`\n${failed === 0 ? 'OK' : 'FAIL'}: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
