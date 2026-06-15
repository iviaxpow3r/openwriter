/**
 * Unit test for the manuscript compiler core (pure parse + assemble).
 *
 * Exercises the pure transforms with an injected body map — no disk, no server:
 *   - manifest parse (meta block, headings, doc: pointers, {{toc}}, bad lines)
 *   - assembly order (chapters + items concatenated in manifest order)
 *   - footnote namespacing (colliding [^1] across docs made unique)
 *   - heading demotion (a doc's own headings nest under the chapter h1)
 *   - unresolved docId surfaces a warning + visible marker
 *   - {{toc}} generated from chapter headings
 *
 * Build first: `npm run build` (or `tsc -p tsconfig.server.json`), then
 * `node scripts/test-manuscript-assemble.mjs` from packages/openwriter.
 *
 * adr: adr/manuscript-engine.md
 */
import { parseManifest, assemble } from '../dist/server/manuscript/index.js';

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

const MANIFEST = `# The Tournament Male — Manuscript

::: meta
title: The Tournament Male
author: Travis Steward
output: epub
:::

## Front Matter
{{toc}}

## Chapter 1 — Ethology
[Ch 1 — B1: Ethology defined](doc:9bee893b)
[Ch 1 — B2: Control vs Design](doc:1a2b3c4d)

## Chapter 2 — Dimorphism
[Ch 2 — B1: Selection is the engine](doc:11223344)
[Ch 2 — B-missing: a deleted beat](doc:deadbeef)

this is a stray line that should warn
`;

test('Test 1: parse — meta, sections, pointers, toc, warnings', () => {
  const m = parseManifest(MANIFEST);
  assert(m.meta.title === 'The Tournament Male', `meta.title parsed (got "${m.meta.title}")`);
  assert(m.meta.author === 'Travis Steward', 'meta.author parsed');
  assert(m.meta.output === 'epub', 'meta.output parsed');

  const chapters = m.sections.filter((s) => s.items.some((it) => it.kind === 'doc'));
  assert(chapters.length === 2, `2 chapters with doc pointers (got ${chapters.length})`);

  const ch1 = m.sections.find((s) => s.heading === 'Chapter 1 — Ethology');
  assert(ch1?.items.length === 2, `Ch1 has 2 pointers (got ${ch1?.items.length})`);
  assert(ch1?.items[0].docId === '9bee893b', `first pointer docId parsed (got ${ch1?.items[0].docId})`);
  assert(ch1?.items[0].text === 'Ch 1 — B1: Ethology defined', 'pointer link text parsed');

  const front = m.sections.find((s) => s.heading === 'Front Matter');
  assert(front?.items.some((it) => it.kind === 'toc'), '{{toc}} captured as an item');

  assert(m.warnings.some((w) => w.includes('stray line')), `stray line warned (warnings: ${m.warnings.length})`);
  // The manifest's own `# … Manuscript` title line has no doc items → not a chapter.
  assert(!chapters.some((s) => s.heading?.includes('Manuscript')), 'manifest title line is not a chapter');
});

test('Test 2: assemble — order + chapter headings + footnote namespacing', () => {
  const m = parseManifest(MANIFEST);
  const bodyMap = new Map([
    ['9bee893b', { title: 'B1', body: 'Ethology is the science of evolved behavior[^1].\n\n[^1]: Tinbergen 1963.' }],
    ['1a2b3c4d', { title: 'B2', body: 'Control versus design.' }],
    ['11223344', { title: 'C2B1', body: 'Selection is the engine[^1].\n\n[^1]: Darwin 1859.' }],
  ]);
  const { markdown, warnings } = assemble(m, bodyMap);

  // Order: Ch1 heading → B1 → B2 → Ch2 heading → C2B1
  const iCh1 = markdown.indexOf('# Chapter 1 — Ethology');
  const iB1 = markdown.indexOf('Ethology is the science');
  const iB2 = markdown.indexOf('Control versus design');
  const iCh2 = markdown.indexOf('# Chapter 2 — Dimorphism');
  const iC2 = markdown.indexOf('Selection is the engine');
  assert(iCh1 >= 0 && iB1 > iCh1 && iB2 > iB1 && iCh2 > iB2 && iC2 > iCh2, 'content assembled in manifest order');

  // Footnote namespacing: both docs had [^1]; must become unique, no collision.
  assert(markdown.includes('[^fn1-1]'), 'doc 1 footnote namespaced to [^fn1-1]');
  assert(markdown.includes('[^fn1-1]: Tinbergen'), 'doc 1 footnote DEFINITION namespaced');
  assert(markdown.includes('[^fn3-1]'), 'doc 3 footnote namespaced to a distinct label [^fn3-1]');
  assert(markdown.includes('[^fn3-1]: Darwin'), 'doc 3 footnote definition namespaced');
  assert(!/\[\^1\]/.test(markdown), 'no bare [^1] survives the merge (no collision)');

  // Unresolved docId (deadbeef) → warning + visible marker.
  assert(warnings.some((w) => w.includes('deadbeef')), 'unresolved docId warned');
  assert(markdown.includes('[unresolved:'), 'unresolved pointer left a visible marker');
});

test('Test 3: heading demotion — doc headings nest under chapter h1', () => {
  const m = parseManifest(`## Chapter 1 — X
[A](doc:aaaaaaaa)
`);
  const bodyMap = new Map([
    ['aaaaaaaa', { title: 'A', body: '# Internal Title\n\nText.\n\n## Sub\n\nMore.' }],
  ]);
  const { markdown } = assemble(m, bodyMap);
  assert(markdown.includes('# Chapter 1 — X'), 'chapter renders at h1');
  assert(markdown.includes('## Internal Title'), 'doc h1 demoted to h2');
  assert(markdown.includes('### Sub'), 'doc h2 demoted to h3');
  assert(!/^# Internal Title/m.test(markdown), 'no un-demoted doc h1 remains');
});

test('Test 4: code fences are not mangled', () => {
  const m = parseManifest(`## C
[A](doc:aaaaaaaa)
`);
  const bodyMap = new Map([
    ['aaaaaaaa', { title: 'A', body: 'Prose.\n\n```\n# not a heading\n[^1] not a footnote\n```\n' }],
  ]);
  const { markdown } = assemble(m, bodyMap);
  assert(markdown.includes('# not a heading'), 'heading-like line inside a code fence is untouched');
  assert(markdown.includes('[^1] not a footnote'), 'footnote-like text inside a code fence is untouched');
});

test('Test 5: {{toc}} renders a contents list from chapter headings', () => {
  const m = parseManifest(MANIFEST);
  const bodyMap = new Map([
    ['9bee893b', { title: 'B1', body: 'a' }],
    ['1a2b3c4d', { title: 'B2', body: 'b' }],
    ['11223344', { title: 'C2B1', body: 'c' }],
  ]);
  const { markdown } = assemble(m, bodyMap);
  assert(markdown.includes('## Contents'), 'contents heading rendered');
  assert(markdown.includes('- Chapter 1 — Ethology'), 'Ch1 in contents');
  assert(markdown.includes('- Chapter 2 — Dimorphism'), 'Ch2 in contents');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
