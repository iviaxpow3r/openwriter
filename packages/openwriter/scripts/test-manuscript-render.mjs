/**
 * Render-layer test for the manuscript engine. Pure: feeds a fixed master
 * markdown (the kind assemble() produces) into each render adapter — no disk,
 * no server, no resolve.
 *
 *   - renderBookHtml → one styled standalone HTML doc, footnotes rendered
 *   - renderEpub     → a valid EPUB3 zip (mimetype first/stored, container,
 *                      opf with chapter spine, nav, per-chapter xhtml)
 *   - renderDocx     → a non-empty .docx (zip) buffer
 *
 * Build first (`npm run build` or `tsc -p tsconfig.server.json`), then
 * `node scripts/test-manuscript-render.mjs` from packages/openwriter.
 *
 * adr: adr/manuscript-engine.md
 */
import JSZip from 'jszip';
import { renderBookHtml } from '../dist/server/manuscript/render/html.js';
import { renderEpub } from '../dist/server/manuscript/render/epub.js';
import { renderDocx } from '../dist/server/manuscript/render/docx.js';

let passed = 0;
let failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log(`  PASS: ${msg}`); }
  else { failed++; console.error(`  FAIL: ${msg}`); }
}
function test(name, fn) { console.log(`\n${name}`); return fn(); }

// Fictional book — worked examples never use the operator's real work.
const META = { title: 'The Restful Mind', author: 'Jordan Avery', output: 'epub' };
const MASTER = `## Contents

- Chapter 1 — Sleep Architecture
- Chapter 2 — Circadian Rhythms

# Chapter 1 — Sleep Architecture

Sleep is the brain's nightly maintenance cycle[^fn1-1].

## A subsection

More prose.

[^fn1-1]: Avery 2019.

# Chapter 2 — Circadian Rhythms

The body clock runs the schedule[^fn3-1].

[^fn3-1]: Hale 2021.
`;

await test('Test 1: renderBookHtml', () => {
  const html = renderBookHtml(MASTER, META);
  assert(html.startsWith('<!DOCTYPE html>'), 'is a full HTML document');
  assert(html.includes('The Restful Mind'), 'book title present');
  assert(html.includes('Jordan Avery'), 'author byline present');
  assert(html.includes("Sleep is the brain's nightly"), 'chapter 1 prose present');
  assert(html.includes('The body clock runs the schedule'), 'chapter 2 prose present');
  assert(/class="footnotes"/.test(html) || /footnote/.test(html), 'footnotes rendered');
});

await test('Test 2: renderEpub produces a valid EPUB3 container', async () => {
  const buf = await renderEpub(MASTER, META);
  assert(Buffer.isBuffer(buf) && buf.length > 0, 'returns a non-empty Buffer');

  const zip = await JSZip.loadAsync(buf);
  const names = Object.keys(zip.files);

  // mimetype must be the first entry and exactly the epub media type.
  assert(names[0] === 'mimetype', `mimetype is the first zip entry (got ${names[0]})`);
  const mimetype = await zip.file('mimetype').async('string');
  assert(mimetype === 'application/epub+zip', 'mimetype content correct');

  assert(!!zip.file('META-INF/container.xml'), 'container.xml present');
  const opf = await zip.file('OEBPS/content.opf')?.async('string');
  assert(!!opf, 'content.opf present');
  assert(opf.includes('<dc:title>The Restful Mind</dc:title>'), 'opf has title');
  assert(opf.includes('<dc:creator>Jordan Avery</dc:creator>'), 'opf has creator');
  assert(opf.includes('dcterms:modified'), 'opf has required modified timestamp');

  const nav = await zip.file('OEBPS/nav.xhtml')?.async('string');
  assert(!!nav && nav.includes('epub:type="toc"'), 'nav.xhtml is an epub toc');
  assert(nav.includes('Chapter 1 — Sleep Architecture') && nav.includes('Chapter 2 — Circadian Rhythms'), 'nav lists both chapters');

  // Chapters: front matter (Contents) + Ch1 + Ch2 = 3 spine docs.
  const chapterFiles = names.filter((n) => /^OEBPS\/ch\d+\.xhtml$/.test(n));
  assert(chapterFiles.length === 3, `3 chapter xhtml files (front matter + 2 chapters), got ${chapterFiles.length}`);
  const spineCount = (opf.match(/<itemref /g) || []).length;
  assert(spineCount === 3, `spine has 3 itemrefs (got ${spineCount})`);

  // A chapter file is well-formed XHTML carrying its prose.
  const ch2 = await zip.file('OEBPS/ch003.xhtml')?.async('string');
  assert(!!ch2 && ch2.includes('The body clock runs the schedule'), 'chapter xhtml carries its prose');
  assert(!!ch2 && ch2.includes('xmlns="http://www.w3.org/1999/xhtml"'), 'chapter is XHTML');
  assert(!!zip.file('OEBPS/style.css'), 'stylesheet bundled');
});

await test('Test 3: renderDocx', async () => {
  const buf = await renderDocx(MASTER, META);
  assert(Buffer.isBuffer(buf) && buf.length > 0, 'returns a non-empty Buffer');
  assert(buf[0] === 0x50 && buf[1] === 0x4b, 'docx is a zip (PK magic)');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
