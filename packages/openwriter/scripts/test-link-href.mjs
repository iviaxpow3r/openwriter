/**
 * Unit tests for link-href parser/formatter.
 * Run from packages/openwriter: `node scripts/test-link-href.mjs`
 *
 * Note: link-href.ts is shipped as part of the client bundle, so we re-implement
 * the same logic here in JS for testing. (Vite doesn't emit individual module
 * files in dist/.) If link-href.ts changes, mirror the change here.
 */

const HEX8 = /^[a-f0-9]{8}$/;

function parseLinkHref(href) {
  if (!href.startsWith('doc:')) return null;
  const body = href.slice(4);
  let target = body;
  let quote = null;
  const qIdx = body.indexOf('?q=');
  if (qIdx >= 0) {
    target = body.slice(0, qIdx);
    try { quote = decodeURIComponent(body.slice(qIdx + 3)); }
    catch { quote = body.slice(qIdx + 3); }
  }
  let nodeId = null;
  const hashIdx = target.indexOf('#');
  if (hashIdx >= 0) {
    const frag = target.slice(hashIdx + 1);
    nodeId = HEX8.test(frag) ? frag : null;
    target = target.slice(0, hashIdx);
  }
  const isDocId = HEX8.test(target);
  return {
    docId: isDocId ? target : null,
    filename: isDocId ? null : target,
    nodeId,
    quote,
  };
}

function formatLinkHref(opts) {
  const target = opts.docId || opts.filename;
  if (!target) throw new Error('formatLinkHref: docId or filename required');
  let href = `doc:${target}`;
  if (opts.nodeId) href += `#${opts.nodeId}`;
  if (opts.quote) href += `?q=${encodeURIComponent(opts.quote)}`;
  return href;
}

let passed = 0, failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log(`  PASS: ${msg}`); }
  else { failed++; console.error(`  FAIL: ${msg}`); }
}

console.log('Test 1: parse docId-only href');
{
  const p = parseLinkHref('doc:a3f2c1d4');
  assert(p?.docId === 'a3f2c1d4', `docId extracted (got ${p?.docId})`);
  assert(p?.filename === null, 'filename null');
  assert(p?.nodeId === null, 'nodeId null');
  assert(p?.quote === null, 'quote null');
}

console.log('\nTest 2: parse docId + nodeId');
{
  const p = parseLinkHref('doc:a3f2c1d4#f6c3830d');
  assert(p?.docId === 'a3f2c1d4', `docId (${p?.docId})`);
  assert(p?.nodeId === 'f6c3830d', `nodeId (${p?.nodeId})`);
}

console.log('\nTest 3: parse docId + nodeId + quote');
{
  const p = parseLinkHref('doc:a3f2c1d4#f6c3830d?q=Males%20defend%20their%20patch');
  assert(p?.docId === 'a3f2c1d4', `docId`);
  assert(p?.nodeId === 'f6c3830d', `nodeId`);
  assert(p?.quote === 'Males defend their patch', `quote decoded (got ${p?.quote})`);
}

console.log('\nTest 4: parse legacy filename href');
{
  const p = parseLinkHref('doc:Architecture.md');
  assert(p?.docId === null, 'docId null for legacy');
  assert(p?.filename === 'Architecture.md', `filename (${p?.filename})`);
  assert(p?.nodeId === null, 'nodeId null');
}

console.log('\nTest 5: parse rejects non-doc hrefs');
{
  assert(parseLinkHref('https://example.com') === null, 'rejects http');
  assert(parseLinkHref('mailto:foo@bar') === null, 'rejects mailto');
  assert(parseLinkHref('') === null, 'rejects empty');
}

console.log('\nTest 6: invalid nodeId fragment dropped');
{
  // Fragment exists but isn't 8-char hex — reject it but keep the docId
  const p = parseLinkHref('doc:a3f2c1d4#not-hex');
  assert(p?.docId === 'a3f2c1d4', `docId still extracted (${p?.docId})`);
  assert(p?.nodeId === null, `invalid nodeId rejected (got ${p?.nodeId})`);
}

console.log('\nTest 7: format docId-only');
{
  const h = formatLinkHref({ docId: 'a3f2c1d4' });
  assert(h === 'doc:a3f2c1d4', `formatted (${h})`);
}

console.log('\nTest 8: format with nodeId');
{
  const h = formatLinkHref({ docId: 'a3f2c1d4', nodeId: 'f6c3830d' });
  assert(h === 'doc:a3f2c1d4#f6c3830d', `formatted (${h})`);
}

console.log('\nTest 9: format with quote (URL-encoded)');
{
  const h = formatLinkHref({ docId: 'a3f2c1d4', nodeId: 'f6c3830d', quote: 'Males defend their patch' });
  assert(h === 'doc:a3f2c1d4#f6c3830d?q=Males%20defend%20their%20patch', `formatted (${h})`);
}

console.log('\nTest 10: round-trip stability');
{
  const original = { docId: 'a3f2c1d4', nodeId: 'f6c3830d', quote: 'special chars: & ? = #' };
  const h = formatLinkHref(original);
  const parsed = parseLinkHref(h);
  assert(parsed?.docId === original.docId, 'docId round-trip');
  assert(parsed?.nodeId === original.nodeId, 'nodeId round-trip');
  assert(parsed?.quote === original.quote, `quote round-trip (got ${parsed?.quote})`);
}

console.log('\nTest 11: format legacy filename');
{
  const h = formatLinkHref({ filename: 'Architecture.md' });
  assert(h === 'doc:Architecture.md', `formatted (${h})`);
  const p = parseLinkHref(h);
  assert(p?.filename === 'Architecture.md', 'parses back');
  assert(p?.docId === null, 'no docId');
}

console.log(`\n${'='.repeat(60)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
