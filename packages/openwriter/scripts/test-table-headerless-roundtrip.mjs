/**
 * Regression test for header-less table round-trip data loss.
 *
 * Live log evidence (Beat Sheet doc, 2026-05-17 session):
 *   [sync-check serialize:Beat Sheet] FAIL: 1 mismatch(es) across 294/294 blocks
 *     first mismatch at position 4: type mismatch: expected table, got paragraph
 *       expected: {"type":"table","charCount":678,"sentenceCount":3}
 *       actual:   {"type":"paragraph","charCount":418,"sentenceCount":1}
 *
 * Root cause: GFM markdown table syntax REQUIRES the `| --- | --- |` header
 * separator row. Our serializer was only emitting it when at least one cell
 * in the first row was a `tableHeader`. For tables whose first row is all
 * `tableCell` (a normal TipTap default), the serializer wrote pipe-rows
 * with NO separator. markdown-it on the re-parse pass doesn't recognize
 * those as a table — it treats each `| ... |` line as a paragraph — so the
 * entire table is silently lost on round-trip, with the sync observer
 * shouting from the rooftops on every save.
 *
 * Also covered: pipe-escaping inside cell content, and multi-paragraph cell
 * content collapsing into <br>-joined inline text. Both were prior silent
 * data-loss paths.
 *
 * Run: `node scripts/test-table-headerless-roundtrip.mjs`
 */

import { tiptapToMarkdown } from '../dist/server/markdown.js';
import { markdownToTiptap } from '../dist/server/markdown.js';

let passed = 0;
let failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log(`  PASS: ${msg}`); }
  else      { failed++; console.error(`  FAIL: ${msg}`); }
}

function mkParagraph(text, id = 'pid') {
  return {
    type: 'paragraph',
    attrs: { id },
    content: text ? [{ type: 'text', text }] : [],
  };
}

function mkCell(text, type = 'tableCell', id = 'cid') {
  return {
    type,
    attrs: { id },
    content: [mkParagraph(text, id + '_p')],
  };
}

function mkRow(cells, id = 'rid') {
  return { type: 'tableRow', attrs: { id }, content: cells };
}

try {
  // ==========================================================================
  // Case 1: header-less table round-trips as a table (not a paragraph)
  // ==========================================================================
  console.log('Case 1: header-less table (all tableCell) survives round-trip');
  {
    const doc = {
      type: 'doc',
      content: [
        { type: 'heading', attrs: { id: 'h1', level: 1 }, content: [{ type: 'text', text: 'Title' }] },
        {
          type: 'table',
          attrs: { id: 'tbl1' },
          content: [
            mkRow([mkCell('alpha', 'tableCell'), mkCell('beta', 'tableCell')], 'r1'),
            mkRow([mkCell('gamma', 'tableCell'), mkCell('delta', 'tableCell')], 'r2'),
            mkRow([mkCell('epsilon', 'tableCell'), mkCell('zeta', 'tableCell')], 'r3'),
          ],
        },
      ],
    };

    const md = tiptapToMarkdown(doc, 'T', { title: 'T', docId: 'd1' });
    assert(md.includes('| --- | --- |'), 'separator row emitted even for header-less table');

    const parsed = markdownToTiptap(md);
    const table = parsed.document.content.find((n) => n.type === 'table');
    assert(!!table, 'round-trip produced a table block (not paragraphs)');
    assert(table?.content?.length === 3, `round-trip preserved 3 rows (got ${table?.content?.length})`);

    // First row becomes header cells after GFM round-trip (one-time conversion;
    // stable thereafter). That's the intentional trade for table preservation.
    const firstRowCells = table?.content?.[0]?.content || [];
    const firstRowText = firstRowCells.map((c) => c.content?.[0]?.content?.[0]?.text).join('|');
    assert(firstRowText === 'alpha|beta', `first row text preserved (got "${firstRowText}")`);

    const secondRowCells = table?.content?.[1]?.content || [];
    const secondRowText = secondRowCells.map((c) => c.content?.[0]?.content?.[0]?.text).join('|');
    assert(secondRowText === 'gamma|delta', `second row text preserved (got "${secondRowText}")`);

    // None of the rows should have leaked into top-level paragraphs.
    const paragraphsWithPipes = parsed.document.content.filter(
      (n) => n.type === 'paragraph' && n.content?.some((c) => (c.text || '').includes('|'))
    );
    assert(paragraphsWithPipes.length === 0, 'no orphan pipe-paragraphs at top level');
  }

  // ==========================================================================
  // Case 2: pipe character inside cell content survives via escaping
  // ==========================================================================
  console.log('\nCase 2: pipes inside cell content survive via escaping');
  {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'table',
          attrs: { id: 'tbl2' },
          content: [
            mkRow([mkCell('a | b', 'tableCell'), mkCell('c', 'tableCell')], 'r1'),
            mkRow([mkCell('d', 'tableCell'), mkCell('e | f', 'tableCell')], 'r2'),
          ],
        },
      ],
    };
    const md = tiptapToMarkdown(doc, 'T2', { title: 'T2', docId: 'd2' });
    assert(md.includes('\\|'), 'serializer escapes pipes inside cells');

    const parsed = markdownToTiptap(md);
    const table = parsed.document.content.find((n) => n.type === 'table');
    assert(!!table, 'round-trip produced a table');
    assert(table?.content?.length === 2, `2 rows preserved (got ${table?.content?.length})`);

    const r0c0 = table?.content?.[0]?.content?.[0]?.content?.[0]?.content?.[0]?.text;
    assert(r0c0 === 'a | b', `cell with pipe text preserved (got "${r0c0}")`);

    const r1c1 = table?.content?.[1]?.content?.[1]?.content?.[0]?.content?.[0]?.text;
    assert(r1c1 === 'e | f', `second-cell pipe text preserved (got "${r1c1}")`);
  }

  // ==========================================================================
  // Case 3: multi-paragraph cell content collapses to <br>-joined inline
  // ==========================================================================
  console.log('\nCase 3: multi-paragraph cells round-trip as <br>-joined text');
  {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'table',
          attrs: { id: 'tbl3' },
          content: [
            mkRow([
              {
                type: 'tableCell',
                attrs: { id: 'cell_multi' },
                content: [
                  mkParagraph('first line', 'p1'),
                  mkParagraph('second line', 'p2'),
                ],
              },
              mkCell('single', 'tableCell', 'c2'),
            ], 'r1'),
            mkRow([mkCell('x', 'tableCell'), mkCell('y', 'tableCell')], 'r2'),
          ],
        },
      ],
    };
    const md = tiptapToMarkdown(doc, 'T3', { title: 'T3', docId: 'd3' });
    assert(md.includes('first line<br>second line'), 'multi-paragraph cell joined with <br>');

    const parsed = markdownToTiptap(md);
    const table = parsed.document.content.find((n) => n.type === 'table');
    assert(!!table, 'round-trip produced a table');
    assert(table?.content?.length === 2, `2 rows after round-trip (got ${table?.content?.length})`);

    // The cell text after re-parse contains both lines (possibly via hardBreak)
    const cellInline = table?.content?.[0]?.content?.[0]?.content?.[0]?.content || [];
    const cellText = cellInline.map((c) => c.text || (c.type === 'hardBreak' ? '\n' : '')).join('');
    assert(cellText.includes('first line') && cellText.includes('second line'),
      `cell text preserves both lines (got "${cellText}")`);
  }

  // ==========================================================================
  // Case 4: ragged rows (different cell counts) are padded to consistent width
  // ==========================================================================
  console.log('\nCase 4: ragged rows pad consistently and round-trip');
  {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'table',
          attrs: { id: 'tbl4' },
          content: [
            mkRow([mkCell('a'), mkCell('b'), mkCell('c')], 'r1'),
            mkRow([mkCell('d')], 'r2'), // shorter row
          ],
        },
      ],
    };
    const md = tiptapToMarkdown(doc, 'T4', { title: 'T4', docId: 'd4' });
    const parsed = markdownToTiptap(md);
    const table = parsed.document.content.find((n) => n.type === 'table');
    assert(!!table, 'ragged-row table still round-trips');
    assert(table?.content?.length === 2, `2 rows survive (got ${table?.content?.length})`);

    const row2Cells = table?.content?.[1]?.content || [];
    assert(row2Cells.length === 3, `short row padded to column count (got ${row2Cells.length})`);
  }

  // ==========================================================================
  // Case 5: idempotent — a table that already has tableHeader cells still
  //          round-trips correctly (no double-separator, no schema regress)
  // ==========================================================================
  console.log('\nCase 5: tables with tableHeader cells stay correct');
  {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'table',
          attrs: { id: 'tbl5' },
          content: [
            mkRow([
              mkCell('Name', 'tableHeader', 'th1'),
              mkCell('Value', 'tableHeader', 'th2'),
            ], 'r1'),
            mkRow([mkCell('alpha'), mkCell('1')], 'r2'),
            mkRow([mkCell('beta'), mkCell('2')], 'r3'),
          ],
        },
      ],
    };
    const md = tiptapToMarkdown(doc, 'T5', { title: 'T5', docId: 'd5' });
    // Exactly one separator row
    const separatorCount = (md.match(/\| --- \| --- \|/g) || []).length;
    assert(separatorCount === 1, `exactly one separator row emitted (got ${separatorCount})`);

    const parsed = markdownToTiptap(md);
    const table = parsed.document.content.find((n) => n.type === 'table');
    assert(table?.content?.length === 3, `3 rows preserved (got ${table?.content?.length})`);

    // Header row preserved as tableHeader cells
    const headerCells = table?.content?.[0]?.content || [];
    assert(headerCells.every((c) => c.type === 'tableHeader'),
      `header row remains tableHeader (got ${headerCells.map((c) => c.type).join(',')})`);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed > 0 ? 1 : 0;
} catch (err) {
  console.error('TEST CRASH:', err);
  process.exitCode = 1;
}
