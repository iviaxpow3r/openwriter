/**
 * findNode opacity regression test.
 *
 * Pre-fix: `findNode` recursively descended into table internals when
 * resolving an agent-provided `nodeId`. Table-internal node IDs are
 * regenerated on every `markdownToTiptap` parse and are not exposed by
 * `compactNodes`, so any ID collision between an agent's intended target
 * and a table-internal node silently routed the write into the table — the
 * target paragraph stayed untouched, an empty paragraph appeared inside the
 * table cell, and `appliedCount` falsely reported success. Exactly the
 * corruption pattern documented in the `2026-05-17 write_to_pad multi-op
 * batches unreliable` brief on the Beat Sheet doc.
 *
 * Post-fix: `findNode` skips descent into `OPAQUE_CONTAINER_TYPES`
 * (table, tableRow, tableCell, tableHeader). The matcher already treats
 * tables as opaque; `findNode` now agrees. Any agent ID either resolves
 * to a top-level / list-internal / blockquote-internal node, or it doesn't
 * resolve at all — collisions with table internals can no longer corrupt.
 *
 * This test constructs the exact collision: a top-level paragraph and a
 * table-cell paragraph deliberately share an ID. The rewrite targeting
 * that ID must hit the top-level paragraph and leave the table intact.
 *
 * Run: `node scripts/test-findnode-opaque-tables.mjs`
 */

import { mkdirSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import {
  setActiveDocument,
  applyChanges,
  getDocument,
  save,
  cancelDebouncedSave,
} from '../dist/server/state.js';
import { setActiveProfile, ensureDataDir } from '../dist/server/helpers.js';

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) { passed++; console.log(`  PASS: ${msg}`); }
  else      { failed++; console.error(`  FAIL: ${msg}`); }
}

const TEST_PROFILE = `test-opaque-${Date.now()}`;
const TEST_PROFILE_DIR = join(homedir(), '.openwriter', 'profiles', TEST_PROFILE);
function cleanup() {
  cancelDebouncedSave();
  try { rmSync(TEST_PROFILE_DIR, { recursive: true, force: true }); } catch { /* best-effort */ }
}
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(1); });

setActiveProfile(TEST_PROFILE);
mkdirSync(TEST_PROFILE_DIR, { recursive: true });
ensureDataDir();

const COLLIDING_ID = 'c0111510'; // intentionally shared between top-level + table-cell

const filePath = join(TEST_PROFILE_DIR, 'opaque.md');

try {
  // ==========================================================================
  // SETUP: a doc with a table positioned BEFORE the target paragraph, where
  //         the table contains an internal node carrying the same ID as the
  //         intended target. Pre-fix, findNode walks tree in order, descends
  //         into the table first, returns the collision match. Post-fix, the
  //         table descent is skipped and the top-level paragraph wins.
  // ==========================================================================
  console.log('Setup: build doc with table-cell paragraph + top-level paragraph sharing an ID');
  {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'heading',
          attrs: { id: 'hh000001', level: 2 },
          content: [{ type: 'text', text: 'Chapter mapping' }],
        },
        // Table BEFORE the target paragraph in document order.
        {
          type: 'table',
          attrs: { id: 'tb000001' },
          content: [
            {
              type: 'tableRow',
              attrs: { id: 'tr000001' },
              content: [
                {
                  type: 'tableCell',
                  attrs: { id: 'tc000001' },
                  // ← This cell's inner paragraph deliberately collides with
                  //   the top-level paragraph's id below.
                  content: [{
                    type: 'paragraph',
                    attrs: { id: COLLIDING_ID },
                    content: [{ type: 'text', text: 'The Migratory Birds of North America' }],
                  }],
                },
                {
                  type: 'tableCell',
                  attrs: { id: 'tc000002' },
                  content: [{
                    type: 'paragraph',
                    attrs: { id: 'tp000002' },
                    content: [{ type: 'text', text: '7-8k' }],
                  }],
                },
              ],
            },
          ],
        },
        // Top-level paragraph — the agent's intended target.
        {
          type: 'paragraph',
          attrs: { id: COLLIDING_ID }, // same id as the table-cell paragraph
          content: [{ type: 'text', text: 'Original target-total line.' }],
        },
        {
          type: 'paragraph',
          attrs: { id: 'pp000003' },
          content: [{ type: 'text', text: 'A trailing paragraph that should stay intact.' }],
        },
      ],
    };
    setActiveDocument(doc, 'Opaque', filePath, false, undefined, {
      title: 'Opaque',
      docId: 'opaqu001',
      autoAccept: true, // hard-apply so we can read the result directly
    });
    save();
    cancelDebouncedSave();

    // Sanity checks on the seeded shape.
    const active = getDocument();
    assert(active.content.length === 4, `seeded 4 top-level blocks (got ${active.content.length})`);
    assert(active.content[1].type === 'table', `block 1 is the table`);
    assert(active.content[2].attrs?.id === COLLIDING_ID,
      `block 2 is the target paragraph carrying the colliding id ${COLLIDING_ID}`);
    const cellPara = active.content[1].content?.[0]?.content?.[0]?.content?.[0];
    assert(cellPara?.attrs?.id === COLLIDING_ID,
      `table-cell inner paragraph also carries ${COLLIDING_ID} (the collision setup)`);
  }

  // ==========================================================================
  // CASE 1: rewrite the colliding ID. Top-level paragraph (position 2) must
  //          receive the new content. Table must be untouched.
  // ==========================================================================
  console.log('\nCase 1: rewrite by colliding ID lands at top level, table untouched');
  {
    const result = applyChanges([{
      operation: 'rewrite',
      nodeId: COLLIDING_ID,
      content: { type: 'paragraph', content: [{ type: 'text', text: 'Rewritten target-total line.' }] },
    }]);
    assert(result.count === 1, `applied 1 op (got ${result.count})`);

    const doc = getDocument();
    // Top-level target should have new content.
    const topLevelTarget = doc.content[2];
    assert(topLevelTarget?.attrs?.id === COLLIDING_ID,
      `top-level position 2 still has id ${COLLIDING_ID}`);
    const topLevelText = topLevelTarget?.content?.[0]?.text || '';
    assert(topLevelText === 'Rewritten target-total line.',
      `top-level paragraph received the new content (got "${topLevelText}")`);

    // Table must be structurally unchanged.
    const table = doc.content[1];
    assert(table?.type === 'table', `table still at position 1`);
    assert(table.content?.length === 1, `table still has 1 row (got ${table.content?.length})`);
    const row = table.content[0];
    assert(row.content?.length === 2, `row still has 2 cells (got ${row.content?.length})`);
    const cellParaText = row.content[0]?.content?.[0]?.content?.[0]?.text || '';
    assert(cellParaText === 'The Migratory Birds of North America',
      `table-cell paragraph unchanged (got "${cellParaText}")`);
    const cellParaInner = row.content[0]?.content?.[0];
    assert(cellParaInner?.attrs?.id === COLLIDING_ID,
      `table-cell paragraph id still ${COLLIDING_ID} (untouched)`);
  }

  // ==========================================================================
  // CASE 2: delete the colliding ID. Top-level paragraph removed.
  //          Table contents intact (cell paragraph NOT marked pending-delete).
  // ==========================================================================
  console.log('\nCase 2: delete by colliding ID removes top level, table untouched');
  {
    const beforeDoc = getDocument();
    const beforeLen = beforeDoc.content.length;

    const result = applyChanges([{ operation: 'delete', nodeId: COLLIDING_ID }]);
    assert(result.count === 1, `applied 1 delete (got ${result.count})`);

    const doc = getDocument();
    // Top-level target paragraph (was at position 2) should be removed in autoAccept mode.
    assert(doc.content.length === beforeLen - 1,
      `top-level block count dropped by 1 (got ${doc.content.length}, was ${beforeLen})`);
    const stillHasTopLevel = doc.content.some((b) => b.attrs?.id === COLLIDING_ID && b.type === 'paragraph');
    // After the delete, there should be no top-level paragraph with COLLIDING_ID.
    // The table-cell paragraph still has it, but findNode skipping into the table
    // means it's never findable from the top.
    assert(!stillHasTopLevel,
      `no top-level paragraph carries ${COLLIDING_ID} anymore`);

    // Table contents unchanged.
    const table = doc.content.find((b) => b.type === 'table');
    assert(!!table, `table still present`);
    const row = table?.content?.[0];
    const cellPara = row?.content?.[0]?.content?.[0];
    assert(cellPara?.attrs?.id === COLLIDING_ID,
      `table-cell paragraph id still ${COLLIDING_ID} (delete did not descend into table)`);
    const cellParaText = cellPara?.content?.[0]?.text || '';
    assert(cellParaText === 'The Migratory Birds of North America',
      `table-cell text unchanged after delete (got "${cellParaText}")`);
  }

  // ==========================================================================
  // CASE 3: rewrite of an ID that ONLY exists inside the table is a no-op
  //          (the agent shouldn't be able to address table internals at all).
  // ==========================================================================
  console.log('\nCase 3: rewrite by table-only id is a silent no-op (no table mutation)');
  {
    // tc000002 is the inner-paragraph id of the second cell — table-only, never
    // exposed via compactNodes.
    const result = applyChanges([{
      operation: 'rewrite',
      nodeId: 'tp000002',
      content: { type: 'paragraph', content: [{ type: 'text', text: 'should not land' }] },
    }]);
    assert(result.count === 0, `op was skipped, count is 0 (got ${result.count})`);

    const doc = getDocument();
    const table = doc.content.find((b) => b.type === 'table');
    const secondCellPara = table?.content?.[0]?.content?.[1]?.content?.[0];
    const secondCellText = secondCellPara?.content?.[0]?.text || '';
    assert(secondCellText === '7-8k',
      `table cell 2 unchanged — agent cannot reach into table internals (got "${secondCellText}")`);
  }

} finally {
  cancelDebouncedSave();
}

console.log('\n' + '='.repeat(60));
console.log(`findNode opaque-tables: ${passed} passed, ${failed} failed`);
console.log('='.repeat(60));
process.exit(failed > 0 ? 1 : 0);
