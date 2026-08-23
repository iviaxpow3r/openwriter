/**
 * Unit test for sidebar-created manuscript bindings.
 * Run after `npm run build` from packages/openwriter.
 */
import { buildManuscriptBinding, manuscriptDocumentTitle } from '../dist/server/manuscript/create.js';
import { parseManifest } from '../dist/server/manuscript/parse.js';

let failures = 0;
function assert(condition, message) {
  if (condition) console.log(`  ✓ ${message}`);
  else { console.error(`  ✗ ${message}`); failures += 1; }
}

console.log('Manuscript selection binding');
const body = buildManuscriptBinding([
  { docId: '11111111', title: 'Opening [revised]' },
  { docId: '22222222', title: 'Chapter Two' },
]);
const manifest = parseManifest(body);

assert(manifest.sections.length === 1, 'creates one unheaded section that preserves source document structure');
assert(manifest.sections[0].items.length === 2, 'includes every selected document');
assert(manifest.sections[0].items[0].docId === '11111111' && manifest.sections[0].items[1].docId === '22222222', 'preserves sidebar order');
assert(manifest.sections[0].items[0].text === 'Opening [revised]', 'round-trips a title with markdown brackets');
assert(manuscriptDocumentTitle('A Promise of Prophecy') === 'A Promise of Prophecy — Manuscript', 'labels the binding in navigation');
assert(manuscriptDocumentTitle('A Promise of Prophecy — Manuscript') === 'A Promise of Prophecy — Manuscript', 'does not duplicate the manuscript suffix');

if (failures > 0) process.exit(1);
