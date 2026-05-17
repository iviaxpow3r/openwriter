/**
 * `tiptapToBlocks` and `applyIdsToTiptap` must agree on position counters.
 *
 * Pre-fix: `tiptapToBlocks` treated tables as opaque (one Block per table,
 * doesn't descend), but `applyIdsToTiptap` descended INTO tables and
 * incremented position for every tableRow / tableCell / tableHeader inside.
 * Result: the matcher's pin for "position N = the paragraph below the table"
 * got applied to whichever table-internal node `applyIdsToTiptap` happened
 * to find at its descended position N. Top-level paragraph ended up with a
 * fresh ID; a table row ended up wearing the paragraph's stable ID.
 *
 * Verified on the real Beat Sheet doc: a write_to_pad batch that rewrote
 * the table + the target-total paragraph + a heading produced a doc where
 * the first table row's ID was the target-total paragraph's old ID. Next
 * read placed `[tr:3141ee2a]` inside the table instead of `[p:3141ee2a]`
 * at top level. From there, any subsequent rewrite targeting `3141ee2a`
 * would resolve INTO the table (pre-findNode-fix) and corrupt it.
 *
 * Post-fix: `applyIdsToTiptap` mirrors `tiptapToBlocks`'s descent rule
 * exactly — descends ONLY into `bulletList`, `orderedList`, `taskList`,
 * `listItem`, `taskItem`, `blockquote`. Tables are opaque. Counters align.
 *
 * Run: `node scripts/test-applyids-position-alignment.mjs`
 */

import { tiptapToBlocks, applyIdsToTiptap } from '../dist/server/node-blocks.js';
import { matchNodes } from '../dist/server/node-matcher.js';
import { fingerprintAll } from '../dist/server/node-fingerprint.js';

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) { passed++; console.log(`  PASS: ${msg}`); }
  else      { failed++; console.error(`  FAIL: ${msg}`); }
}

// Build a doc structurally identical to the Beat Sheet failure:
// [h1, p, p, h2, table (multi-row), p (target-total), h2, ...]
function buildDoc(targetTotalText) {
  return {
    type: 'doc',
    content: [
      { type: 'heading', attrs: { id: 'h1000001', level: 1 }, content: [{ type: 'text', text: 'Beat Sheet' }] },
      { type: 'paragraph', attrs: { id: 'p0000001' }, content: [{ type: 'text', text: 'Intro paragraph one.' }] },
      { type: 'paragraph', attrs: { id: 'p0000002' }, content: [{ type: 'text', text: 'Intro paragraph two.' }] },
      { type: 'heading', attrs: { id: 'h2000001', level: 2 }, content: [{ type: 'text', text: 'Chapter mapping' }] },
      {
        type: 'table',
        attrs: { id: 'tbl00001' },
        content: [
          {
            type: 'tableRow',
            attrs: { id: 'tr000001' },
            content: [
              { type: 'tableHeader', attrs: { id: 'th000001' }, content: [{ type: 'paragraph', attrs: { id: 'tp000001' }, content: [{ type: 'text', text: 'Ch' }] }] },
              { type: 'tableHeader', attrs: { id: 'th000002' }, content: [{ type: 'paragraph', attrs: { id: 'tp000002' }, content: [{ type: 'text', text: 'Title' }] }] },
            ],
          },
          {
            type: 'tableRow',
            attrs: { id: 'tr000002' },
            content: [
              { type: 'tableCell', attrs: { id: 'tc000001' }, content: [{ type: 'paragraph', attrs: { id: 'tp000003' }, content: [{ type: 'text', text: '1' }] }] },
              { type: 'tableCell', attrs: { id: 'tc000002' }, content: [{ type: 'paragraph', attrs: { id: 'tp000004' }, content: [{ type: 'text', text: 'The Missing Manual' }] }] },
            ],
          },
        ],
      },
      { type: 'paragraph', attrs: { id: 'p0000003' }, content: [{ type: 'text', text: targetTotalText }] },
      { type: 'heading', attrs: { id: 'h2000002', level: 2 }, content: [{ type: 'text', text: 'Chapter 1' }] },
    ],
  };
}

// ============================================================================
// CASE 1: position counters align between tiptapToBlocks and applyIdsToTiptap.
//          The flat block list has 7 entries (one for the table). applyIds
//          must use those same 7 positions, NOT descend into the table.
// ============================================================================
console.log('Case 1: tiptapToBlocks and applyIdsToTiptap agree on position counters');
{
  const doc = buildDoc('Target total: 74-82k words.');
  const blocks = tiptapToBlocks(doc);
  assert(blocks.length === 7, `7 top-level blocks (got ${blocks.length})`);
  assert(blocks.map((b) => b.type).join(',') === 'heading,paragraph,paragraph,heading,table,paragraph,heading',
    `block sequence matches structure (got ${blocks.map((b) => b.type).join(',')})`);

  // Pin a known ID to position 5 (the target-total paragraph at top level).
  const pinnedByPosition = new Map();
  pinnedByPosition.set(5, 'targetID');
  applyIdsToTiptap(doc, pinnedByPosition);

  // Top-level paragraph at position 5 must have the new id.
  const targetPara = doc.content[5];
  assert(targetPara.type === 'paragraph', `position 5 is a paragraph`);
  assert(targetPara.attrs?.id === 'targetID',
    `position 5 paragraph gets the pin (got ${targetPara.attrs?.id})`);

  // No table internal should have been touched by the pin.
  const table = doc.content[4];
  const row1 = table.content[0];
  const row2 = table.content[1];
  assert(row1.attrs?.id === 'tr000001', `table row 1 id unchanged (got ${row1.attrs?.id})`);
  assert(row2.attrs?.id === 'tr000002', `table row 2 id unchanged`);
  const row1cell1Para = row1.content[0].content[0];
  assert(row1cell1Para.attrs?.id === 'tp000001',
    `table cell paragraph id unchanged (got ${row1cell1Para.attrs?.id})`);
}

// ============================================================================
// CASE 2: full matcher round-trip on a doc-with-table — the Beat Sheet shape.
//          The matcher's pins must land on the correct top-level blocks.
// ============================================================================
console.log('\nCase 2: full matcher round-trip preserves top-level ids past the table');
{
  // Previous: doc with the OLD target-total text, frontmatter ids stable.
  const prevDoc = buildDoc('Target total: 74-82k words (old version).');
  const prevBlocks = tiptapToBlocks(prevDoc);
  const prevFps = fingerprintAll(prevBlocks);
  const previousNodes = prevBlocks.map((b, i) => ({ id: b.id, fingerprint: prevFps[i] }));

  // Now: agent rewrote the target-total paragraph in place (same id, new text).
  const newDoc = buildDoc('Target total: 74-82k words (new revised version).');
  const newBlocks = tiptapToBlocks(newDoc);
  const result = matchNodes(previousNodes, newBlocks, { graveyard: [] });

  const pinnedByPosition = new Map();
  for (const p of result.pinned) pinnedByPosition.set(p.position, p.id);
  applyIdsToTiptap(newDoc, pinnedByPosition);

  // The target-total paragraph (top-level position 5) should keep p0000003.
  assert(newDoc.content[5].attrs?.id === 'p0000003',
    `top-level target-total paragraph keeps p0000003 (got ${newDoc.content[5].attrs?.id})`);

  // The trailing h2 (position 6) should keep h2000002.
  assert(newDoc.content[6].attrs?.id === 'h2000002',
    `top-level trailing h2 keeps h2000002 (got ${newDoc.content[6].attrs?.id})`);

  // The table's first row must NOT have stolen p0000003 (the bug pattern).
  const tableRows = newDoc.content[4].content;
  for (const row of tableRows) {
    assert(row.attrs?.id !== 'p0000003',
      `table row ${row.attrs?.id} did NOT steal p0000003`);
    assert(row.attrs?.id !== 'h2000002',
      `table row ${row.attrs?.id} did NOT steal h2000002`);
  }

  // And the original table internal IDs should be preserved.
  assert(tableRows[0].attrs?.id === 'tr000001', `row 1 id unchanged`);
  assert(tableRows[1].attrs?.id === 'tr000002', `row 2 id unchanged`);
}

// ============================================================================
// CASE 3: tightening — after the round-trip, every block's `attrs.id` is
//          unique across the entire doc (no ID appears in two places).
// ============================================================================
console.log('\nCase 3: every attrs.id is unique across the doc post-matcher');
{
  const prevDoc = buildDoc('Target total: 74-82k words (baseline).');
  const prevBlocks = tiptapToBlocks(prevDoc);
  const prevFps = fingerprintAll(prevBlocks);
  const previousNodes = prevBlocks.map((b, i) => ({ id: b.id, fingerprint: prevFps[i] }));

  const newDoc = buildDoc('Target total: 74-82k words (changed slightly).');
  const newBlocks = tiptapToBlocks(newDoc);
  const result = matchNodes(previousNodes, newBlocks, { graveyard: [] });

  const pinnedByPosition = new Map();
  for (const p of result.pinned) pinnedByPosition.set(p.position, p.id);
  applyIdsToTiptap(newDoc, pinnedByPosition);

  const seenIds = new Map(); // id -> count
  function walk(nodes) {
    for (const node of nodes) {
      const id = node.attrs?.id;
      if (id) seenIds.set(id, (seenIds.get(id) || 0) + 1);
      if (node.content) walk(node.content);
    }
  }
  walk(newDoc.content);

  const duplicates = [...seenIds.entries()].filter(([, count]) => count > 1);
  assert(duplicates.length === 0,
    `no id appears twice in the doc (got duplicates: ${JSON.stringify(duplicates)})`);
}

console.log('\n' + '='.repeat(60));
console.log(`applyIds position alignment: ${passed} passed, ${failed} failed`);
console.log('='.repeat(60));
process.exit(failed > 0 ? 1 : 0);
