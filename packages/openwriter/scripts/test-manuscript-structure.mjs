/**
 * Regression test for the manual manuscript contents builder.
 *
 * The builder may save only document pointers, headings, and one optional TOC.
 * Run after `npm run build` from packages/openwriter.
 */
import { buildManuscriptStructure } from '../dist/server/manuscript/create.js';
import { flattenManifest, hasUnsupportedManifestText, parseManifest } from '../dist/server/manuscript/parse.js';

let failures = 0;
function assert(condition, message) {
  if (condition) console.log(`  ✓ ${message}`);
  else { console.error(`  ✗ ${message}`); failures += 1; }
}

console.log('Manual manuscript contents');
const items = [
  { kind: 'heading', text: 'Part One', level: 2 },
  { kind: 'doc', docId: '11111111', title: 'Opening [revised]' },
  { kind: 'toc' },
  { kind: 'heading', text: 'Interlude', level: 3 },
  { kind: 'doc', docId: '22222222', title: 'Chapter Two' },
];
const body = buildManuscriptStructure(items);
const restored = flattenManifest(parseManifest(body));

assert(restored.length === items.length, 'round-trips every supported builder item');
assert(restored.map((item) => item.kind).join(',') === 'heading,doc,toc,heading,doc', 'preserves authored item order');
assert(restored[0].kind === 'heading' && restored[0].text === 'Part One' && restored[0].level === 2, 'preserves heading text and level');
assert(restored[1].kind === 'doc' && restored[1].docId === '11111111' && restored[1].text === 'Opening [revised]', 'escapes and restores document titles');
assert(restored[3].kind === 'heading' && restored[3].text === 'Interlude' && restored[3].level === 3, 'preserves later headings');
assert(!hasUnsupportedManifestText(body), 'canonical builder output contains no silently ignored prose');
assert(hasUnsupportedManifestText(`${body}\n\nA stray paragraph`), 'surfaces legacy prose that export would otherwise omit');

if (failures > 0) process.exit(1);
