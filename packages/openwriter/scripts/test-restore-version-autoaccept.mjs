/**
 * restore_version must preserve the CURRENT autoAccept setting rather than
 * rolling it back to the snapshot-era value. autoAccept is a per-doc UI
 * preference (toggled in the sidebar) — it governs how FUTURE writes
 * behave and is not document content.
 *
 * Reproduces the bug from inbox brief
 * 2026-05-18-restore-version-resets-autoaccept-flag.md: a user toggled
 * autoAccept off, the agent restored a snapshot taken when autoAccept was
 * on, and the user's toggle silently flipped back without warning.
 *
 * Run from packages/openwriter: `node scripts/test-restore-version-autoaccept.mjs`
 *
 * adr: adr/pending-overlay-model.md
 */

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) { passed++; console.log(`  PASS: ${msg}`); }
  else      { failed++; console.error(`  FAIL: ${msg}`); }
}

function test(name, fn) {
  console.log(`\n${name}`);
  fn();
}

// Mirror the helper from server/mcp.ts. Kept in lockstep — if the
// production logic changes, this mirror needs updating too.
function applyAutoAcceptOverride(snapshotMarkdown, currentAutoAccept) {
  const fmMatch = snapshotMarkdown.match(/^---\n(.+?)\n---\n/s);
  if (!fmMatch) return snapshotMarkdown;
  try {
    const fm = JSON.parse(fmMatch[1]);
    if (currentAutoAccept) {
      fm.autoAccept = true;
    } else {
      delete fm.autoAccept;
    }
    const newFmLine = JSON.stringify(fm);
    return snapshotMarkdown.replace(/^---\n.+?\n---\n/s, `---\n${newFmLine}\n---\n`);
  } catch {
    return snapshotMarkdown;
  }
}

// ============================================================================
// Test 1: snapshot had autoAccept:true, current has autoAccept:false → strip
// ============================================================================
test('Test 1: snapshot autoAccept:true, current off → autoAccept stripped', () => {
  const snapshot = `---
{"title":"Doc","docId":"abc12345","autoAccept":true,"nodes":[["aa11"]]}
---

# Doc

Body content here.
`;
  const result = applyAutoAcceptOverride(snapshot, false);
  assert(!result.includes('"autoAccept":true'), 'autoAccept:true removed from frontmatter');
  assert(!result.includes('"autoAccept"'), 'autoAccept key gone entirely');
  assert(result.includes('"title":"Doc"'), 'other metadata preserved (title)');
  assert(result.includes('"docId":"abc12345"'), 'other metadata preserved (docId)');
  assert(result.includes('"nodes":[["aa11"]]'), 'nodes graph preserved exactly');
  assert(result.includes('# Doc\n\nBody content here.'), 'body completely untouched');
});

// ============================================================================
// Test 2: snapshot had no autoAccept, current has autoAccept:true → add
// ============================================================================
test('Test 2: snapshot no autoAccept, current on → autoAccept:true added', () => {
  const snapshot = `---
{"title":"Doc","docId":"abc12345","nodes":[["aa11"]]}
---

# Doc
`;
  const result = applyAutoAcceptOverride(snapshot, true);
  assert(result.includes('"autoAccept":true'), 'autoAccept:true added to frontmatter');
});

// ============================================================================
// Test 3: snapshot autoAccept:true, current also true → unchanged
// ============================================================================
test('Test 3: both on → idempotent', () => {
  const snapshot = `---
{"title":"Doc","docId":"abc12345","autoAccept":true}
---

# Doc
`;
  const result = applyAutoAcceptOverride(snapshot, true);
  assert(result.includes('"autoAccept":true'), 'autoAccept:true preserved');
});

// ============================================================================
// Test 4: snapshot no autoAccept, current off → still no autoAccept
// ============================================================================
test('Test 4: both off → idempotent', () => {
  const snapshot = `---
{"title":"Doc","docId":"abc12345"}
---

# Doc
`;
  const result = applyAutoAcceptOverride(snapshot, false);
  assert(!result.includes('"autoAccept"'), 'autoAccept stays absent');
});

// ============================================================================
// Test 5: malformed frontmatter → return unchanged (graceful failure)
// ============================================================================
test('Test 5: malformed frontmatter → unchanged', () => {
  const snapshot = `---
{ this is not valid JSON }
---

# Doc
`;
  const result = applyAutoAcceptOverride(snapshot, true);
  assert(result === snapshot, 'malformed frontmatter returns unchanged');
});

// ============================================================================
// Test 6: no frontmatter at all → return unchanged
// ============================================================================
test('Test 6: no frontmatter → unchanged', () => {
  const snapshot = `# Plain markdown\n\nNo frontmatter.\n`;
  const result = applyAutoAcceptOverride(snapshot, true);
  assert(result === snapshot, 'frontmatter-less input returns unchanged');
});

// ============================================================================
// Test 7: snapshot with content-derived metadata (enrichment, nodes) preserves all
// ============================================================================
test('Test 7: enrichment + nodes + graveyard all preserved through override', () => {
  const snapshot = `---
{"title":"Doc","docId":"abc12345","autoAccept":true,"enrichmentStale":false,"lastEnrichedAt":"2026-05-18T22:00:00Z","logline":"Sample logline.","domain":"Test","nodes":[["aa11","h1",["bb"]],["cc22",["dd"]]],"graveyard":[["ee33"]]}
---

# Doc

Body.
`;
  const result = applyAutoAcceptOverride(snapshot, false);
  assert(!result.includes('"autoAccept"'), 'autoAccept removed');
  assert(result.includes('"enrichmentStale":false'), 'enrichmentStale preserved');
  assert(result.includes('"lastEnrichedAt":"2026-05-18T22:00:00Z"'), 'lastEnrichedAt preserved');
  assert(result.includes('"logline":"Sample logline."'), 'logline preserved');
  assert(result.includes('"domain":"Test"'), 'domain preserved');
  assert(result.includes('"nodes":[["aa11","h1",["bb"]],["cc22",["dd"]]]'), 'nodes preserved verbatim');
  assert(result.includes('"graveyard":[["ee33"]]'), 'graveyard preserved verbatim');
});

// ============================================================================
// Summary
// ============================================================================
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
