/**
 * Unit tests for backlinks engine (extractForwardLinks).
 * Run from packages/openwriter: `node scripts/test-backlinks.mjs`
 */

import { extractForwardLinks } from '../dist/server/backlinks.js';

let passed = 0, failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log(`  PASS: ${msg}`); }
  else { failed++; console.error(`  FAIL: ${msg}`); }
}

console.log('Test 1: paragraph with single doc: link');
{
  const doc = {
    type: 'doc',
    content: [
      { type: 'paragraph', attrs: { id: 'aaaaaaaa' }, content: [
        { type: 'text', text: 'See ' },
        { type: 'text', text: 'this doc', marks: [{ type: 'link', attrs: { href: 'doc:bbbbbbbb' } }] },
        { type: 'text', text: ' for more.' },
      ]},
    ],
  };
  const links = extractForwardLinks(doc, 'src11111');
  assert(links.length === 1, `count is 1 (got ${links.length})`);
  assert(links[0].text === 'this doc', `text "${links[0].text}"`);
  assert(links[0].from_doc === 'src11111', `from_doc`);
  assert(links[0].from_node === 'aaaaaaaa', `from_node`);
  assert(links[0].to_doc === 'bbbbbbbb', `to_doc`);
  assert(links[0].to_node === undefined, `to_node undefined (whole-doc link)`);
}

console.log('\nTest 2: paragraph-level link with nodeId fragment');
{
  const doc = {
    type: 'doc',
    content: [
      { type: 'paragraph', attrs: { id: 'aaaaaaaa' }, content: [
        { type: 'text', text: 'See ', marks: [{ type: 'link', attrs: { href: 'doc:bbbbbbbb#cccccccc' } }] },
      ]},
    ],
  };
  const links = extractForwardLinks(doc, 'src11111');
  assert(links.length === 1, 'count');
  assert(links[0].to_doc === 'bbbbbbbb', 'to_doc');
  assert(links[0].to_node === 'cccccccc', `to_node ${links[0].to_node}`);
}

console.log('\nTest 3: link with quote query strips for storage');
{
  const doc = {
    type: 'doc',
    content: [
      { type: 'paragraph', attrs: { id: 'aaaaaaaa' }, content: [
        { type: 'text', text: 'X', marks: [{ type: 'link', attrs: { href: 'doc:bbbbbbbb#cccccccc?q=hello' } }] },
      ]},
    ],
  };
  const links = extractForwardLinks(doc, 'src11111');
  assert(links[0].to_doc === 'bbbbbbbb', 'to_doc parsed');
  assert(links[0].to_node === 'cccccccc', 'to_node parsed');
  // quote is intentionally NOT stored in backlinks (it's just a scroll hint)
}

console.log('\nTest 4: multiple links across multiple paragraphs');
{
  const doc = {
    type: 'doc',
    content: [
      { type: 'paragraph', attrs: { id: 'aaaaaaaa' }, content: [
        { type: 'text', text: 'first', marks: [{ type: 'link', attrs: { href: 'doc:11111111' } }] },
      ]},
      { type: 'paragraph', attrs: { id: 'bbbbbbbb' }, content: [
        { type: 'text', text: 'second', marks: [{ type: 'link', attrs: { href: 'doc:22222222' } }] },
      ]},
    ],
  };
  const links = extractForwardLinks(doc, 'src11111');
  assert(links.length === 2, `count is 2 (got ${links.length})`);
  assert(links[0].from_node === 'aaaaaaaa' && links[1].from_node === 'bbbbbbbb', 'from_nodes correct');
}

console.log('\nTest 5: legacy doc:filename ignored (no docId match)');
{
  const doc = {
    type: 'doc',
    content: [
      { type: 'paragraph', attrs: { id: 'aaaaaaaa' }, content: [
        { type: 'text', text: 'x', marks: [{ type: 'link', attrs: { href: 'doc:OldFile.md' } }] },
      ]},
    ],
  };
  const links = extractForwardLinks(doc, 'src11111');
  // Legacy filename links should be skipped — backlinks only tracks docId targets
  assert(links.length === 0, `legacy filename href ignored (got ${links.length})`);
}

console.log('\nTest 6: anchor truncation at 80 chars');
{
  const longText = 'a'.repeat(120);
  const doc = {
    type: 'doc',
    content: [
      { type: 'paragraph', attrs: { id: 'aaaaaaaa' }, content: [
        { type: 'text', text: longText, marks: [{ type: 'link', attrs: { href: 'doc:bbbbbbbb' } }] },
      ]},
    ],
  };
  const links = extractForwardLinks(doc, 'src11111');
  assert(links.length === 1, 'count');
  assert(links[0].text.length <= 80, `truncated to <=80 chars (got ${links[0].text.length})`);
  assert(links[0].text.endsWith('…'), 'ellipsis added');
}

console.log('\nTest 7: link mark spanning multiple text nodes (other marks toggle inside)');
{
  const doc = {
    type: 'doc',
    content: [
      { type: 'paragraph', attrs: { id: 'aaaaaaaa' }, content: [
        { type: 'text', text: 'See ', marks: [{ type: 'link', attrs: { href: 'doc:bbbbbbbb' } }] },
        { type: 'text', text: 'bold', marks: [{ type: 'link', attrs: { href: 'doc:bbbbbbbb' } }, { type: 'bold' }] },
        { type: 'text', text: ' more', marks: [{ type: 'link', attrs: { href: 'doc:bbbbbbbb' } }] },
      ]},
    ],
  };
  const links = extractForwardLinks(doc, 'src11111');
  assert(links.length === 1, `single link recognized across marks (got ${links.length})`);
  assert(links[0].text === 'See bold more', `text concatenated "${links[0].text}"`);
}

console.log('\nTest 8: empty doc returns no links');
{
  const links = extractForwardLinks({ type: 'doc', content: [] }, 'src11111');
  assert(links.length === 0, 'empty doc');
}

console.log(`\n${'='.repeat(60)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
