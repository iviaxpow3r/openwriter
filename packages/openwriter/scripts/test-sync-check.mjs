/**
 * Verify the sync observer catches drift and reports OK on clean roundtrips.
 *
 * Run from packages/openwriter: `node scripts/test-sync-check.mjs`
 */

import { tiptapToMarkdownChecked, markdownToTiptap } from '../dist/server/markdown.js';
import { readFileSync } from 'fs';

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

console.log('Test 1: clean round-trip on synthetic doc');
{
  const doc = {
    type: 'doc',
    content: [
      { type: 'heading', attrs: { id: 'a1', level: 2 }, content: [{ type: 'text', text: 'Section One' }] },
      { type: 'paragraph', attrs: { id: 'a2' }, content: [{ type: 'text', text: 'A normal paragraph sits here.' }] },
      { type: 'bulletList', attrs: { id: 'a3' }, content: [
        { type: 'listItem', attrs: { id: 'a4' }, content: [
          { type: 'paragraph', attrs: { id: 'a5' }, content: [{ type: 'text', text: 'Item one' }] },
        ]},
        { type: 'listItem', attrs: { id: 'a6' }, content: [
          { type: 'paragraph', attrs: { id: 'a7' }, content: [{ type: 'text', text: 'Item two' }] },
        ]},
      ]},
      { type: 'codeBlock', attrs: { id: 'a8', language: 'js' }, content: [{ type: 'text', text: 'console.log(1);' }] },
    ],
  };

  const { markdown, syncReport } = tiptapToMarkdownChecked(doc, 'Test');
  assert(syncReport.ok, `sync-check OK (${syncReport.expectedLength} blocks aligned)`);
  if (!syncReport.ok) {
    console.error('  mismatches:', JSON.stringify(syncReport.mismatches, null, 2));
  }
}

console.log('\nTest 2: round-trip the live Matcher Integration Test doc from disk');
{
  const path = process.env.USERPROFILE
    ? `${process.env.USERPROFILE}/.openwriter/profiles/Default/Matcher Integration Test.md`
    : `${process.env.HOME}/.openwriter/profiles/Default/Matcher Integration Test.md`;
  try {
    const raw = readFileSync(path, 'utf-8');
    const parsed = markdownToTiptap(raw);
    const { syncReport } = tiptapToMarkdownChecked(parsed.document, parsed.title, parsed.metadata);
    assert(syncReport.ok, `sync-check OK on live doc (${syncReport.expectedLength} blocks aligned)`);
    if (!syncReport.ok) {
      console.error('  mismatches:', JSON.stringify(syncReport.mismatches, null, 2));
    }
  } catch (e) {
    console.log(`  SKIP: live doc not found at ${path}`);
  }
}

console.log('\nTest 3: observer DOES catch deliberate drift');
{
  // Build two TipTap docs with different shapes and compare their shapes directly.
  // This verifies the comparison logic actually flags mismatches.
  const { shapeOfTiptap, compareShapes } = await import('../dist/server/markdown.js');

  const docA = {
    type: 'doc',
    content: [
      { type: 'paragraph', attrs: { id: 'x1' }, content: [{ type: 'text', text: 'Same text.' }] },
      { type: 'paragraph', attrs: { id: 'x2' }, content: [{ type: 'text', text: 'Second paragraph.' }] },
    ],
  };
  const docB = {
    type: 'doc',
    content: [
      { type: 'heading', attrs: { id: 'y1', level: 2 }, content: [{ type: 'text', text: 'Same text.' }] }, // type changed
      { type: 'paragraph', attrs: { id: 'y2' }, content: [{ type: 'text', text: 'Second paragraph.' }] },
    ],
  };
  const report = compareShapes(shapeOfTiptap(docA), shapeOfTiptap(docB));
  assert(!report.ok, 'observer flagged type mismatch');
  assert(report.mismatches.length > 0, `mismatches reported (${report.mismatches.length})`);
  if (report.mismatches[0]) {
    assert(report.mismatches[0].position === 0, `first mismatch at position 0 (got ${report.mismatches[0].position})`);
    assert(report.mismatches[0].reason.includes('type mismatch'), `reason mentions type (got "${report.mismatches[0].reason}")`);
  }

  // Now a charCount drift
  const docC = {
    type: 'doc',
    content: [
      { type: 'paragraph', attrs: { id: 'z1' }, content: [{ type: 'text', text: 'Same text.' }] },
      { type: 'paragraph', attrs: { id: 'z2' }, content: [{ type: 'text', text: 'Different second paragraph entirely with more chars.' }] },
    ],
  };
  const report2 = compareShapes(shapeOfTiptap(docA), shapeOfTiptap(docC));
  assert(!report2.ok, 'observer flagged charCount mismatch');
  if (report2.mismatches[0]) {
    assert(report2.mismatches[0].position === 1, `charCount mismatch at position 1 (got ${report2.mismatches[0].position})`);
    assert(report2.mismatches[0].reason.includes('charCount'), `reason mentions charCount (got "${report2.mismatches[0].reason}")`);
  }
}

console.log('\n' + '='.repeat(60));
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log('='.repeat(60));
process.exit(failed > 0 ? 1 : 0);
