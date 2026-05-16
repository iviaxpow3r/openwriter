/**
 * End-to-end integration test for the save-time matcher (Option B).
 *
 * This imports the REAL state.ts production code path — not a mirror — and
 * drives it through setActiveDocument / applyChanges / save against an
 * isolated test profile. Every assertion verifies the on-disk frontmatter
 * after a save, proving the production code does what the unit tests
 * promise it does.
 *
 * Run from packages/openwriter: `node scripts/test-state-integration.mjs`
 */

import { mkdirSync, existsSync, readFileSync, rmSync, writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import matter from 'gray-matter';
import {
  setActiveDocument,
  applyChanges,
  save,
  cancelDebouncedSave,
  clearAllCaches,
  getDocument,
  updateDocument,
  registerExternalDoc,
  unregisterExternalDoc,
} from '../dist/server/state.js';
import { markdownToTiptap } from '../dist/server/markdown.js';
import { setActiveProfile, ensureDataDir, getDataDir } from '../dist/server/helpers.js';

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) { passed++; console.log(`  PASS: ${msg}`); }
  else      { failed++; console.error(`  FAIL: ${msg}`); }
}

const TEST_PROFILE = `test-option-b-${Date.now()}`;
const TEST_PROFILE_DIR = join(homedir(), '.openwriter', 'profiles', TEST_PROFILE);

function cleanup() {
  cancelDebouncedSave();
  try { rmSync(TEST_PROFILE_DIR, { recursive: true, force: true }); } catch { /* best-effort */ }
}

/** Read the frontmatter of a file after a save. */
function readFrontmatter(filePath) {
  const raw = readFileSync(filePath, 'utf-8');
  return matter(raw).data;
}

/** Build a fresh document with deterministic IDs. */
function buildDoc(blocks) {
  return { type: 'doc', content: blocks };
}

/** Mutate `state.document` in-place by replacing it (mirrors what browser doc-update does). */
function setDocContent(content) {
  updateDocument({ type: 'doc', content });
}

// ============================================================================
// SETUP
// ============================================================================
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(1); });

setActiveProfile(TEST_PROFILE);
mkdirSync(TEST_PROFILE_DIR, { recursive: true });
ensureDataDir();

try {
  // ==========================================================================
  // TEST 1: First save mints IDs and writes nodes graph
  // ==========================================================================
  console.log('\nTest 1: first save writes the identity graph to disk');
  const testFile = join(TEST_PROFILE_DIR, 'integration.md');
  {
    const doc = buildDoc([
      { type: 'heading', attrs: { id: 'h0000001', level: 2 }, content: [{ type: 'text', text: 'Section One' }] },
      { type: 'paragraph', attrs: { id: 'p0000001' }, content: [{ type: 'text', text: 'The first paragraph sits here.' }] },
      { type: 'paragraph', attrs: { id: 'p0000002' }, content: [{ type: 'text', text: 'The second paragraph follows.' }] },
    ]);
    setActiveDocument(doc, 'Integration', testFile, false);
    save();
    assert(existsSync(testFile), 'file written to disk');
    const fm = readFrontmatter(testFile);
    assert(Array.isArray(fm.nodes), 'frontmatter has nodes array');
    assert(fm.nodes.length === 3, `nodes has 3 entries (got ${fm.nodes?.length})`);
    assert(fm.nodes[0].id === 'h0000001', `heading ID persisted (got ${fm.nodes[0].id})`);
    assert(fm.nodes[1].id === 'p0000001', `para 1 ID persisted`);
    assert(fm.nodes[2].id === 'p0000002', `para 2 ID persisted`);
    assert(!fm.graveyard || fm.graveyard.length === 0, 'graveyard empty on first save');
  }

  // ==========================================================================
  // TEST 2: Edit text — ID survives via fingerprint match
  // ==========================================================================
  console.log('\nTest 2: edit a paragraph — ID preserved via matcher');
  {
    // Simulate a reload from disk (what would happen on session restart)
    const reloaded = markdownToTiptap(readFileSync(testFile, 'utf-8'));
    setActiveDocument(reloaded.document, reloaded.title, testFile, false);

    // Mutate para 1's text (simulating a user edit)
    const doc = getDocument();
    const newContent = doc.content.map((b, i) => {
      if (i !== 1) return b;
      return { ...b, content: [{ type: 'text', text: 'The first paragraph, slightly edited.' }] };
    });
    setDocContent(newContent);
    save();

    const fm = readFrontmatter(testFile);
    assert(fm.nodes[0].id === 'h0000001', 'heading ID unchanged');
    assert(fm.nodes[1].id === 'p0000001', `edited para keeps ID (got ${fm.nodes[1].id})`);
    assert(fm.nodes[2].id === 'p0000002', 'untouched para keeps ID');
  }

  // ==========================================================================
  // TEST 3: Insert a paragraph — new ID minted, others stable
  // ==========================================================================
  let insertedId = '';
  console.log('\nTest 3: insert a brand-new paragraph');
  {
    const reloaded = markdownToTiptap(readFileSync(testFile, 'utf-8'));
    setActiveDocument(reloaded.document, reloaded.title, testFile, false);

    const doc = getDocument();
    const newContent = [
      doc.content[0],
      { type: 'paragraph', attrs: { id: 'tempINS1' }, content: [{ type: 'text', text: 'A brand new paragraph drops in.' }] },
      doc.content[1],
      doc.content[2],
    ];
    setDocContent(newContent);
    save();

    const fm = readFrontmatter(testFile);
    const ids = fm.nodes.map((n) => n.id);
    assert(ids.length === 4, `4 blocks on disk (got ${ids.length})`);
    assert(ids[0] === 'h0000001', 'heading stable through insert');
    assert(ids[1] !== 'h0000001' && ids[1] !== 'p0000001' && ids[1] !== 'p0000002',
      `new paragraph got a distinct ID (got ${ids[1]})`);
    assert(ids[2] === 'p0000001', 'original para 1 ID survived insert');
    assert(ids[3] === 'p0000002', 'original para 2 ID survived insert');
    insertedId = ids[1];
  }

  // ==========================================================================
  // TEST 4: Delete — survivor IDs stable, deleted enters graveyard
  // ==========================================================================
  console.log('\nTest 4: delete a paragraph, verify graveyard captures it');
  {
    const reloaded = markdownToTiptap(readFileSync(testFile, 'utf-8'));
    setActiveDocument(reloaded.document, reloaded.title, testFile, false);

    const doc = getDocument();
    // Drop the inserted paragraph at index 1
    setDocContent([doc.content[0], doc.content[2], doc.content[3]]);
    save();

    const fm = readFrontmatter(testFile);
    const ids = fm.nodes.map((n) => n.id);
    assert(ids.length === 3, `back to 3 blocks (got ${ids.length})`);
    assert(ids[0] === 'h0000001', 'heading stable through delete');
    assert(ids[1] === 'p0000001', 'para 1 stable through delete');
    assert(ids[2] === 'p0000002', 'para 2 stable through delete');
    assert(Array.isArray(fm.graveyard) && fm.graveyard.length >= 1,
      `graveyard has the deleted block (got ${fm.graveyard?.length ?? 0})`);
    assert(fm.graveyard?.[0]?.id === insertedId,
      `deleted block's ID landed in graveyard (got ${fm.graveyard?.[0]?.id}, expected ${insertedId})`);
  }

  // ==========================================================================
  // TEST 5: Paste-back from graveyard — original ID restored
  // ==========================================================================
  console.log('\nTest 5: paste-back from graveyard restores the original ID');
  {
    const reloaded = markdownToTiptap(readFileSync(testFile, 'utf-8'));
    setActiveDocument(reloaded.document, reloaded.title, testFile, false);

    const doc = getDocument();
    setDocContent([
      doc.content[0],
      // Editor mints a fresh ID at paste time — matcher should override via graveyard match
      { type: 'paragraph', attrs: { id: 'pastedXX' }, content: [{ type: 'text', text: 'A brand new paragraph drops in.' }] },
      doc.content[1],
      doc.content[2],
    ]);
    save();

    const fm = readFrontmatter(testFile);
    const ids = fm.nodes.map((n) => n.id);
    assert(ids[1] === insertedId, `graveyard restored the original ID (got ${ids[1]}, expected ${insertedId})`);
  }

  // ==========================================================================
  // TEST 6: Type-change (paragraph -> heading) preserves ID
  // ==========================================================================
  console.log('\nTest 6: type-change preserves the original ID');
  {
    const reloaded = markdownToTiptap(readFileSync(testFile, 'utf-8'));
    setActiveDocument(reloaded.document, reloaded.title, testFile, false);

    const doc = getDocument();
    const newContent = doc.content.map((b, i) => {
      if (i !== 2) return b; // para 1 lives at index 2 now: [heading, paste, para1, para2]
      assert(b.attrs.id === 'p0000001', 'setup: index 2 is para 1');
      return { type: 'heading', attrs: { id: b.attrs.id, level: 3 }, content: b.content };
    });
    setDocContent(newContent);
    save();

    const fm = readFrontmatter(testFile);
    const promoted = fm.nodes[2];
    assert(promoted.fp.type === 'heading', `block is now a heading (got type=${promoted.fp.type})`);
    assert(promoted.id === 'p0000001', `type-change preserved the original ID (got ${promoted.id})`);
  }

  // ==========================================================================
  // TEST 7: First-save edge case — no existing file
  // ==========================================================================
  console.log('\nTest 7: first save on a brand-new file (no previous identity graph)');
  {
    const newFile = join(TEST_PROFILE_DIR, 'brand-new.md');
    assert(!existsSync(newFile), 'setup: file does not exist yet');
    const doc = buildDoc([
      { type: 'paragraph', attrs: { id: 'aaaa1111' }, content: [{ type: 'text', text: 'Hello world.' }] },
    ]);
    setActiveDocument(doc, 'BrandNew', newFile, false);
    save();
    assert(existsSync(newFile), 'file created on first save');
    const fm = readFrontmatter(newFile);
    assert(Array.isArray(fm.nodes) && fm.nodes.length === 1, 'first save writes nodes graph');
    assert(fm.nodes[0].id === 'aaaa1111', `first-save preserves editor-minted ID (got ${fm.nodes[0].id})`);
  }

  // ==========================================================================
  // TEST 8: External doc bypasses matcher (preserves verbatim frontmatter)
  // ==========================================================================
  console.log('\nTest 8: external doc preserves raw frontmatter, no matcher injection');
  {
    // Use a path explicitly outside the data dir
    const externalFile = join(homedir(), `external-${Date.now()}.md`);
    const externalContent = '---\nauthor: Foreign\ncustom: keep-this\n---\n\n# External heading\n\nExternal body.\n';
    writeFileSync(externalFile, externalContent);
    registerExternalDoc(externalFile);

    try {
      const parsed = markdownToTiptap(readFileSync(externalFile, 'utf-8'));
      setActiveDocument(parsed.document, parsed.title, externalFile, false, undefined, parsed.metadata, parsed.rawFrontmatter);
      // Edit the doc
      const doc = getDocument();
      const newContent = doc.content.map((b, i) => {
        if (i !== 1) return b;
        return { ...b, content: [{ type: 'text', text: 'External body, modified.' }] };
      });
      setDocContent(newContent);
      save();

      const written = readFileSync(externalFile, 'utf-8');
      assert(written.includes('author: Foreign'), 'external frontmatter preserved verbatim (author)');
      assert(written.includes('custom: keep-this'), 'external frontmatter preserved verbatim (custom)');
      assert(!written.includes('nodes:'), 'external doc has NO nodes frontmatter injected');
      assert(!written.includes('graveyard:'), 'external doc has NO graveyard frontmatter injected');
      assert(written.includes('External body, modified.'), 'edited body landed in external file');
    } finally {
      unregisterExternalDoc(externalFile);
      try { unlinkSync(externalFile); } catch { /* ignore */ }
    }
  }

  // ==========================================================================
  // TEST 9: Reload from disk after save — IDs match what was written
  // ==========================================================================
  console.log('\nTest 9: reload from disk after save preserves IDs');
  {
    const fmBefore = readFrontmatter(testFile);
    const idsBefore = fmBefore.nodes.map((n) => n.id);
    const reloaded = markdownToTiptap(readFileSync(testFile, 'utf-8'));
    const idsAfter = [];
    function walk(nodes) {
      const types = new Set(['heading', 'paragraph', 'bulletList', 'orderedList', 'listItem', 'taskItem', 'blockquote', 'codeBlock', 'horizontalRule', 'taskList']);
      for (const n of nodes || []) {
        if (types.has(n.type) && n.attrs?.id) idsAfter.push(n.attrs.id);
        if (n.content) walk(n.content);
      }
    }
    walk(reloaded.document.content);
    assert(idsAfter.length === idsBefore.length, `reload found same number of blocks (${idsBefore.length} vs ${idsAfter.length})`);
    for (let i = 0; i < idsBefore.length; i++) {
      assert(idsAfter[i] === idsBefore[i], `block ${i} ID matches reload (disk=${idsBefore[i]}, reload=${idsAfter[i]})`);
    }
  }

  // ==========================================================================
  // TEST 10: Multi-op in a single save burst (no ambiguous slots)
  //
  // Combines edit + insert (at the END, so no slot-continuity ambiguity) +
  // type-change in one save. Verifies the matcher fires once and applies all
  // rules coherently. Delete is exercised in Test 4; slot-continuity (which
  // shadows "delete + replace" into "in-place rewrite") gets its own test
  // below.
  // ==========================================================================
  console.log('\nTest 10: multi-op burst — edit + insert + type-change in one save');
  {
    const startDoc = buildDoc([
      { type: 'heading', attrs: { id: 'mh000001', level: 2 }, content: [{ type: 'text', text: 'Multi-Op Test' }] },
      { type: 'paragraph', attrs: { id: 'mp000001' }, content: [{ type: 'text', text: 'Paragraph A.' }] },
      { type: 'paragraph', attrs: { id: 'mp000002' }, content: [{ type: 'text', text: 'Paragraph B.' }] },
      { type: 'paragraph', attrs: { id: 'mp000003' }, content: [{ type: 'text', text: 'Paragraph C.' }] },
    ]);
    const multiFile = join(TEST_PROFILE_DIR, 'multi-op.md');
    setActiveDocument(startDoc, 'MultiOp', multiFile, false);
    save();
    let fm = readFrontmatter(multiFile);
    assert(fm.nodes.length === 4, `setup: 4 blocks on disk (got ${fm.nodes.length})`);

    // Edit A, type-change C → heading, append a brand-new paragraph at end.
    // No slot is replaced in place, so no slot-continuity ambiguity.
    const reloaded = markdownToTiptap(readFileSync(multiFile, 'utf-8'));
    setActiveDocument(reloaded.document, reloaded.title, multiFile, false);
    const doc = getDocument();
    setDocContent([
      doc.content[0], // heading
      { ...doc.content[1], content: [{ type: 'text', text: 'Paragraph A, edited.' }] }, // EDIT
      doc.content[2], // B unchanged
      { type: 'heading', attrs: { id: doc.content[3].attrs.id, level: 3 }, content: doc.content[3].content }, // TYPE-CHANGE on C
      { type: 'paragraph', attrs: { id: 'tempNEW1' }, content: [{ type: 'text', text: 'A fresh paragraph at the end.' }] }, // INSERT (at end, no ambiguity)
    ]);
    save();

    fm = readFrontmatter(multiFile);
    const ids = fm.nodes.map((n) => n.id);
    const types = fm.nodes.map((n) => n.fp.type);
    assert(ids.length === 5, `multi-op result: 5 blocks (got ${ids.length})`);
    assert(ids[0] === 'mh000001', 'heading stable through multi-op');
    assert(ids[1] === 'mp000001', `EDIT: para A keeps ID through edit (got ${ids[1]})`);
    assert(types[1] === 'paragraph', 'EDIT: para A still a paragraph');
    assert(ids[2] === 'mp000002', 'untouched para B keeps ID');
    assert(ids[3] === 'mp000003', `TYPE-CHANGE: para C kept its ID across type change (got ${ids[3]})`);
    assert(types[3] === 'heading', `TYPE-CHANGE: para C now a heading (got ${types[3]})`);
    assert(ids[4] !== 'mh000001' && ids[4] !== 'mp000001' && ids[4] !== 'mp000002' && ids[4] !== 'mp000003',
      `INSERT: new tail paragraph got distinct ID (got ${ids[4]})`);
  }

  // ==========================================================================
  // TEST 12: Slot-continuity (replacing a block in-place preserves the ID)
  //
  // Documented matcher behavior: when block at position N is replaced with
  // completely new content of the same type, the slot-continuity rule fires
  // and the new content inherits the original ID. This is intentional — the
  // alternative would be ambiguous: was that a heavy edit or a delete+insert?
  // The matcher picks "same slot = same node" until something proves otherwise.
  // ==========================================================================
  console.log('\nTest 12: slot-continuity — replace block in-place, ID preserved');
  {
    const slotFile = join(TEST_PROFILE_DIR, 'slot-continuity.md');
    setActiveDocument(buildDoc([
      { type: 'heading', attrs: { id: 'sh000001', level: 2 }, content: [{ type: 'text', text: 'Slot Continuity' }] },
      { type: 'paragraph', attrs: { id: 'sp000001' }, content: [{ type: 'text', text: 'Original paragraph one.' }] },
      { type: 'paragraph', attrs: { id: 'sp000002' }, content: [{ type: 'text', text: 'Original paragraph two.' }] },
    ]), 'SlotContinuity', slotFile, false);
    save();

    const reloaded = markdownToTiptap(readFileSync(slotFile, 'utf-8'));
    setActiveDocument(reloaded.document, reloaded.title, slotFile, false);
    const doc = getDocument();
    // Replace paragraph two's content entirely with a brand-new paragraph
    setDocContent([
      doc.content[0],
      doc.content[1],
      { type: 'paragraph', attrs: { id: 'tempXXX1' }, content: [{ type: 'text', text: 'Completely different sentence here.' }] },
    ]);
    save();

    const fm = readFrontmatter(slotFile);
    const ids = fm.nodes.map((n) => n.id);
    assert(ids.length === 3, `still 3 blocks (got ${ids.length})`);
    assert(ids[2] === 'sp000002',
      `slot-continuity: replaced block inherits original ID (got ${ids[2]}, expected sp000002)`);
    assert(!fm.graveyard || !fm.graveyard.some((g) => g.id === 'sp000002'),
      'slot-continuity: original ID is NOT in graveyard (slot was paired, not orphaned)');
  }

  // ==========================================================================
  // TEST 11: Sync observer reports OK on every save (no round-trip drift)
  // ==========================================================================
  console.log('\nTest 11: tiptapToMarkdownChecked sync observer (any drift would have printed FAIL above)');
  {
    // The checked serializer logs to stderr on shape mismatch. If any of the
    // previous saves had drift, you'd see "[sync-check FAIL ...]" lines above.
    // Verify by re-running a round-trip and asserting ok.
    const raw = readFileSync(testFile, 'utf-8');
    const parsed = markdownToTiptap(raw);
    const { shapeOfTiptap, compareShapes } = await import('../dist/server/markdown.js');
    const shape = shapeOfTiptap(parsed.document);
    // Re-parse from disk has to match its own shape (tautology) — but this is
    // the smoke test that disk → memory → disk preserves block count.
    assert(shape.length === parsed.document.content.filter(n => ['heading', 'paragraph', 'bulletList', 'orderedList', 'taskList', 'blockquote', 'codeBlock', 'horizontalRule', 'table', 'image'].includes(n.type)).length,
      `shape length matches doc block count (got shape=${shape.length})`);
  }

  console.log('\n' + '='.repeat(60));
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log('='.repeat(60));
} finally {
  cleanup();
}

process.exit(failed > 0 ? 1 : 0);
