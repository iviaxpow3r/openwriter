/**
 * Markdown table round-trip integrity test.
 *
 * Verifies that multi-row tables survive every parse → serialize → reparse
 * cycle regardless of agent-formatting habits:
 *
 *   - contiguous input (well-formed CommonMark) → clean N-row table
 *   - blank-separated input (common agent mistake) → self-heals to N-row table
 *   - pipe syntax inside fenced code blocks → untouched
 *   - already-saved broken doc shape (header + orphan paragraphs) → auto-heals on next load
 *
 * Run: `node scripts/test-tables-roundtrip.mjs`
 */

import { markdownToTiptap, tiptapToMarkdown } from '../dist/server/markdown.js';

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) { passed++; console.log(`  PASS: ${msg}`); }
  else      { failed++; console.error(`  FAIL: ${msg}`); }
}

function tableRowCount(doc) {
  const tbl = doc.content.find((b) => b.type === 'table');
  if (!tbl) return 0;
  return (tbl.content || []).length;
}

function nonTableBlocks(doc) {
  return doc.content.filter((b) => b.type !== 'table');
}

function paragraphsContainingPipes(doc) {
  return doc.content.filter((b) => {
    if (b.type !== 'paragraph') return false;
    const text = b.content?.[0]?.text || '';
    return text.includes('|') && text.includes(' | ');
  });
}

// ============================================================================
// CASE 1: contiguous input
// ============================================================================
console.log('Case 1: contiguous markdown table (well-formed CommonMark)');
{
  const input = `| A | B | C |
| --- | --- | --- |
| 1 | x | y |
| 2 | x | y |
| 3 | x | y |
`;
  const parsed = markdownToTiptap(input);
  assert(tableRowCount(parsed.document) === 4, `4 rows in parsed table (got ${tableRowCount(parsed.document)})`);
  assert(paragraphsContainingPipes(parsed.document).length === 0, 'no orphan pipe-paragraphs');
  // Round-trip
  const md = tiptapToMarkdown(parsed.document, 'Test');
  const reparsed = markdownToTiptap(md);
  assert(tableRowCount(reparsed.document) === 4, `round-trip preserves 4 rows (got ${tableRowCount(reparsed.document)})`);
}

// ============================================================================
// CASE 2: blank-separated input (the agent mistake)
// ============================================================================
console.log('\nCase 2: blank-separated rows (agent mistake — self-heals via normalizer)');
{
  const input = `| A | B | C |
| --- | --- | --- |

| 1 | x | y |

| 2 | x | y |

| 3 | x | y |
`;
  const parsed = markdownToTiptap(input);
  assert(tableRowCount(parsed.document) === 4, `4 rows after normalization (got ${tableRowCount(parsed.document)})`);
  assert(paragraphsContainingPipes(parsed.document).length === 0, 'NO orphan pipe-paragraphs after fix');
  // Round-trip: serialize should write CONTIGUOUS markdown
  const md = tiptapToMarkdown(parsed.document, 'Test');
  // The body should not contain blank lines BETWEEN table rows
  const body = md.split(/---\n/).slice(2).join('---\n');
  // Find the table section and verify no double-newlines between pipe-rows
  const tableSection = body.match(/^\|.*\n(\|.*\n)+/m);
  if (tableSection) {
    assert(!tableSection[0].includes('\n\n'), 'serialized table is contiguous (no blank rows)');
  } else {
    assert(false, 'expected to find table section in serialized output');
  }
  // Reparse from serialized
  const reparsed = markdownToTiptap(md);
  assert(tableRowCount(reparsed.document) === 4, `re-parse preserves 4 rows (got ${tableRowCount(reparsed.document)})`);
}

// ============================================================================
// CASE 3: pipe syntax inside fenced code block (must NOT be normalized)
// ============================================================================
console.log('\nCase 3: pipe-syntax inside fenced code block stays untouched');
{
  const input = `\`\`\`
| not a table |

| just code |
\`\`\`

| H1 | H2 |
| --- | --- |
| 1 | 2 |
`;
  const parsed = markdownToTiptap(input);
  const cb = parsed.document.content.find((b) => b.type === 'codeBlock');
  assert(!!cb, 'code block preserved');
  const cbText = cb?.content?.[0]?.text || '';
  assert(cbText.includes('| not a table |'), 'code block contains pipe text intact');
  assert(cbText.includes('\n\n'), 'code block preserves its internal blank lines');
  // And the real table after the fence parses correctly
  assert(tableRowCount(parsed.document) === 2, `actual table after fence has 2 rows (got ${tableRowCount(parsed.document)})`);
}

// ============================================================================
// CASE 4: surrounding content stays intact
// ============================================================================
console.log('\nCase 4: paragraphs before and after the table survive normalization');
{
  const input = `# Heading

Intro paragraph.

| A | B |
| --- | --- |

| 1 | 2 |

| 3 | 4 |

Outro paragraph.
`;
  const parsed = markdownToTiptap(input);
  const headings = parsed.document.content.filter((b) => b.type === 'heading');
  const paras = parsed.document.content.filter((b) => b.type === 'paragraph');
  assert(headings.length === 1, `1 heading preserved (got ${headings.length})`);
  assert(paras.length === 2, `2 surrounding paragraphs preserved (got ${paras.length})`);
  assert(tableRowCount(parsed.document) === 3, `3-row table in the middle (got ${tableRowCount(parsed.document)})`);
  // Outro paragraph still present
  assert(paras.some((p) => p.content?.[0]?.text?.includes('Outro')), 'outro paragraph after table preserved');
}

// ============================================================================
// CASE 5: multiple consecutive tables with blank-separated rows
// ============================================================================
console.log('\nCase 5: two consecutive tables both heal independently');
{
  const input = `| Table1 | A |
| --- | --- |

| 1 | x |

| 2 | y |

| Table2 | B |
| --- | --- |
| 3 | z |
`;
  const parsed = markdownToTiptap(input);
  const tables = parsed.document.content.filter((b) => b.type === 'table');
  assert(tables.length === 2, `2 tables produced (got ${tables.length})`);
  if (tables.length === 2) {
    assert((tables[0].content || []).length === 3, `first table has 3 rows (got ${(tables[0].content || []).length})`);
    assert((tables[1].content || []).length === 2, `second table has 2 rows (got ${(tables[1].content || []).length})`);
  }
}

// ============================================================================
// CASE 6: doc with NO tables — normalizer is a no-op
// ============================================================================
console.log('\nCase 6: doc with no tables is untouched');
{
  const input = `# Heading

Para one.

Para two.

- list item
- another item
`;
  const parsed = markdownToTiptap(input);
  assert(tableRowCount(parsed.document) === 0, 'no table produced');
  const types = parsed.document.content.map((b) => b.type);
  assert(types.includes('heading'), 'heading preserved');
  assert(types.includes('bulletList'), 'bulletList preserved');
}

// ============================================================================
// CASE 7: Beat-Sheet-shape input (10-row table with blanks, like the real file)
// ============================================================================
console.log('\nCase 7: Beat-Sheet-shaped 10-row table heals correctly');
{
  let input = '| Ch | Arc beat | Working title | Word target |\n';
  input += '| --- | --- | --- | --- |\n';
  for (let i = 1; i <= 10; i++) {
    input += `\n| ${i} | Beat ${i} | Title ${i} | ${i}-${i+1}k |\n`;
  }
  input += '\nTarget total: 74-82k words.\n';
  const parsed = markdownToTiptap(input);
  assert(tableRowCount(parsed.document) === 11, `11 rows in healed table (got ${tableRowCount(parsed.document)})`);
  assert(paragraphsContainingPipes(parsed.document).length === 0, 'no pipe-paragraphs leaked');
  const outroPara = parsed.document.content.find((b) => b.type === 'paragraph' && b.content?.[0]?.text?.includes('Target total'));
  assert(!!outroPara, '"Target total" paragraph follows the table');
  // Round-trip
  const md = tiptapToMarkdown(parsed.document, 'Beat Sheet');
  const reparsed = markdownToTiptap(md);
  assert(tableRowCount(reparsed.document) === 11, `re-parse of round-trip: 11 rows (got ${tableRowCount(reparsed.document)})`);
}

console.log('\n' + '='.repeat(60));
console.log(`Tables roundtrip: ${passed} passed, ${failed} failed`);
console.log('='.repeat(60));
process.exit(failed > 0 ? 1 : 0);
