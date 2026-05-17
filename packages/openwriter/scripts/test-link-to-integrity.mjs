/**
 * Regression test for the v0.14.1 link_to bugs.
 *
 * Inbox brief 2026-05-17-link-to-second-occurrence-bug.md reported four
 * independent failures:
 *
 *   Bug 1 (active-doc dependency): `link_to` operated on whichever doc was
 *     foregrounded in the browser. User clicks in the UI silently changed the
 *     target doc; agent had no way to know.
 *   Bug 2 (duplicate-paragraph creation): a successful link_to left the
 *     original paragraph in place AND created a new paragraph with the
 *     wrapped link. Cumulative duplication across a session.
 *   Bug 3 (doc-level link scrolls to bottom): browser UX; lives in App.tsx.
 *   Bug 4 (repeat-call semantics): no defined behavior for calling link_to
 *     twice with the same anchor text.
 *
 * Fix shipped:
 *   - link_to schema now requires `source_doc_id`; handler dispatches active
 *     vs non-active doc explicitly (applyTextEdits vs applyTextEditsToFile).
 *   - Repeat calls skip occurrences already wrapped with the same href and
 *     find the next unlinked one.
 *   - applyTextEdits returns descriptive error including actual node text
 *     when no edit matched (helps agent diff unicode/whitespace).
 *
 * This test exercises the source_doc_id dispatch + the in-place wrap
 * invariant + the skip-already-linked semantics via direct calls to the
 * underlying functions (the MCP layer is a thin wrapper). The scroll
 * behavior (bug 3) lives in the browser App.tsx and is verified separately.
 *
 * Run: `node scripts/test-link-to-integrity.mjs`
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import matter from 'gray-matter';
import {
  setActiveDocument,
  applyTextEdits,
  applyTextEditsToFile,
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

const TEST_PROFILE = `test-linkto-${Date.now()}`;
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

const filePath = join(TEST_PROFILE_DIR, 'linkto-source.md');

try {
  // ==========================================================================
  // SETUP: a source doc with two paragraphs each mentioning "alpha". Active
  //         doc starts as the source.
  // ==========================================================================
  console.log('Setup: source doc with two "alpha" paragraphs');
  {
    const doc = {
      type: 'doc',
      content: [
        { type: 'heading', attrs: { id: 'h0000001', level: 1 }, content: [{ type: 'text', text: 'Source' }] },
        { type: 'paragraph', attrs: { id: 'p0000001' }, content: [{ type: 'text', text: 'First mention of alpha here.' }] },
        { type: 'paragraph', attrs: { id: 'p0000002' }, content: [{ type: 'text', text: 'Second mention of alpha later.' }] },
        { type: 'paragraph', attrs: { id: 'p0000003' }, content: [{ type: 'text', text: 'Unrelated paragraph.' }] },
      ],
    };
    setActiveDocument(doc, 'Source', filePath, false, undefined, {
      title: 'Source', docId: 'src00001', autoAccept: true,
    });
    save();
    cancelDebouncedSave();
    const active = getDocument();
    assert(active.content.length === 4, `seeded 4 blocks (got ${active.content.length})`);
  }

  // ==========================================================================
  // CASE 1: applyTextEdits wraps text IN PLACE on the matching paragraph.
  //          No duplicate paragraph is created; the original node's id is
  //          preserved; only the matched text gets the link mark.
  // ==========================================================================
  console.log('\nCase 1: in-place wrap, no duplicate paragraph');
  {
    const href = 'doc:dst00001#node0001?q=Some%20quote';
    const result = applyTextEdits('p0000001', [{
      find: 'alpha',
      addMark: { type: 'link', attrs: { href } },
    }]);
    assert(result.success, `apply succeeded (got ${JSON.stringify(result)})`);

    const doc = getDocument();
    // Top-level still has exactly 4 blocks — no duplicate insertion.
    assert(doc.content.length === 4, `still 4 blocks, no duplicate (got ${doc.content.length})`);
    // p0000001 still exists at index 1.
    assert(doc.content[1].attrs?.id === 'p0000001', `p0000001 still at index 1`);
    // Its content now has 3 text nodes: "First mention of ", "alpha" (with link), " here."
    const inline = doc.content[1].content;
    const linkedNode = inline.find((n) => n.text === 'alpha');
    assert(!!linkedNode, `the "alpha" text node exists in p0000001`);
    const linkMark = linkedNode?.marks?.find((m) => m.type === 'link');
    assert(!!linkMark, `link mark attached to "alpha"`);
    assert(linkMark?.attrs?.href === href, `link href matches (got ${linkMark?.attrs?.href})`);
    // The second paragraph (p0000002) is unchanged.
    const p2Inline = doc.content[2].content;
    const p2Linked = p2Inline.find((n) => n.marks?.some((m) => m.type === 'link'));
    assert(!p2Linked, `p0000002's "alpha" is NOT yet linked (untouched)`);
  }

  // ==========================================================================
  // CASE 2: a second call with the same anchor + same href would wrap the
  //          SECOND occurrence (in p0000002), not the already-linked one in
  //          p0000001. We simulate the link_to handler's walk logic here.
  // ==========================================================================
  console.log('\nCase 2: repeat-call skips already-linked occurrence, wraps next');
  {
    const href = 'doc:dst00001#node0001?q=Some%20quote';
    // Manually emulate the link_to walker: find first block where "alpha"
    // appears in plain text (not already wrapped with this href).
    function isAlreadyLinked(nodeContent, anchor, target) {
      let linkedText = '';
      for (const child of nodeContent) {
        if (child.type !== 'text' || !child.text) continue;
        const marks = child.marks || [];
        const hit = marks.some((m) => m.type === 'link' && m.attrs?.href === target);
        if (hit) linkedText += child.text;
      }
      return linkedText.includes(anchor);
    }
    const doc = getDocument();
    let pickedId = null;
    for (const node of doc.content) {
      if (!Array.isArray(node.content)) continue;
      const flat = node.content.map((c) => c.text || '').join('');
      if (!flat.includes('alpha')) continue;
      if (isAlreadyLinked(node.content, 'alpha', href)) continue;
      pickedId = node.attrs?.id;
      break;
    }
    assert(pickedId === 'p0000002', `walker picks p0000002 (got ${pickedId})`);

    const result = applyTextEdits(pickedId, [{
      find: 'alpha',
      addMark: { type: 'link', attrs: { href } },
    }]);
    assert(result.success, `wrap on p0000002 succeeded`);

    const docAfter = getDocument();
    assert(docAfter.content.length === 4, `still 4 blocks (got ${docAfter.content.length})`);
    const p2 = docAfter.content[2];
    const p2Linked = p2.content.find((n) => n.text === 'alpha' && n.marks?.some((m) => m.type === 'link'));
    assert(!!p2Linked, `p0000002's "alpha" is now linked`);
  }

  // ==========================================================================
  // CASE 3: applyTextEdits with text that doesn't exist returns descriptive
  //          error (includes node text excerpt for unicode/whitespace diff).
  // ==========================================================================
  console.log('\nCase 3: clear diagnostic when match fails');
  {
    const result = applyTextEdits('p0000003', [{
      find: 'this exact phrase is not in the doc',
      addMark: { type: 'link', attrs: { href: 'doc:dst00001' } },
    }]);
    assert(!result.success, `apply failed as expected`);
    assert(result.error?.includes('No edits matched'),
      `error mentions "No edits matched" (got "${result.error}")`);
    assert(result.error?.includes('Node text starts:'),
      `error includes the actual node text excerpt for debug (got "${result.error}")`);
    assert(result.error?.includes('Unrelated paragraph'),
      `error excerpt contains the real node text "Unrelated paragraph" (got "${result.error}")`);
  }

  // ==========================================================================
  // CASE 4: applyTextEditsToFile path — wrap a node in a NON-active doc.
  //          The agent's link_to handler dispatches here when source_doc_id
  //          doesn't match the active doc. Use full openwriter setup: write a
  //          doc via setActiveDocument+save (which produces canonical
  //          frontmatter), then switch active back to the source doc, then
  //          call applyTextEditsToFile on the FIRST doc by filename.
  // ==========================================================================
  console.log('\nCase 4: non-active doc dispatch — wrap on a file directly');
  {
    const secondPath = join(TEST_PROFILE_DIR, 'linkto-other.md');
    // Build via the canonical save path so frontmatter `nodes:` is populated
    // and load-time matcher resolves IDs correctly on read.
    setActiveDocument({
      type: 'doc',
      content: [
        { type: 'heading', attrs: { id: 'px000010', level: 1 }, content: [{ type: 'text', text: 'Other' }] },
        { type: 'paragraph', attrs: { id: 'px000001' }, content: [{ type: 'text', text: 'Lone mention of beta lives here in another doc.' }] },
        { type: 'paragraph', attrs: { id: 'px000002' }, content: [{ type: 'text', text: 'Trailing prose with no anchor.' }] },
      ],
    }, 'Other', secondPath, false, undefined, { title: 'Other', docId: 'oth00001', autoAccept: true });
    save();
    cancelDebouncedSave();

    // Switch active back to the source doc by re-pointing state.filePath there.
    // For applyTextEditsToFile dispatch we just need the active filename to differ.
    setActiveDocument({
      type: 'doc',
      content: [{ type: 'paragraph', attrs: { id: 'plchldr1' }, content: [{ type: 'text', text: 'placeholder' }] }],
    }, 'Placeholder', join(TEST_PROFILE_DIR, '_other-active.md'), false, undefined, {
      title: 'Placeholder', docId: 'plc00001', autoAccept: true,
    });

    // Now px000001 lives only in the non-active file. applyTextEditsToFile
    // should reach into the disk file and wrap.
    const result = applyTextEditsToFile('linkto-other.md', 'px000001', [{
      find: 'beta',
      addMark: { type: 'link', attrs: { href: 'doc:src00001' } },
    }]);
    assert(result.success, `apply on non-active file succeeded (got ${JSON.stringify(result)})`);

    // Read back and confirm the link mark made it to disk.
    const raw = readFileSync(secondPath, 'utf-8');
    // Serializer may wrap href in `<...>` (CommonMark style) — match either form.
    const linkCount = (raw.match(/\[beta\]\(<?doc:src00001>?\)/g) || []).length;
    assert(linkCount === 1,
      `disk markdown has exactly one [beta](doc:src00001) link (got ${linkCount}, body excerpt: ${raw.slice(raw.indexOf('# Other'), raw.indexOf('# Other') + 200)})`);
    assert(raw.includes('Trailing prose with no anchor'),
      `trailing paragraph still on disk (no collateral damage)`);
    assert(raw.includes('Lone mention of'),
      `original paragraph still on disk (no duplicate-removal)`);
  }

  // ==========================================================================
  // CASE 5: in-place wrap preserves the node id (the key invariant from the
  //          brief — Bug 2 was that the node id changed and a new node was
  //          created with the wrap). Use a fresh filePath so the disk has no
  //          prior nodes graph (avoids the load-time matcher rewriting our
  //          fresh id on save).
  // ==========================================================================
  console.log('\nCase 5: node id stable across wrap');
  {
    const stablePath = join(TEST_PROFILE_DIR, 'linkto-stable.md');
    const doc = {
      type: 'doc',
      content: [
        { type: 'paragraph', attrs: { id: 'staBLE01' }, content: [{ type: 'text', text: 'The phrase to wrap is right here.' }] },
      ],
    };
    setActiveDocument(doc, 'Stable', stablePath, false, undefined, {
      title: 'Stable', docId: 'stb00001', autoAccept: true,
    });
    // Do NOT call save() here — the matcher's slot-continuity could rewrite
    // staBLE01 against any prior disk state. applyTextEdits operates on the
    // in-memory state.document directly, which is what we're testing.

    const result = applyTextEdits('staBLE01', [{
      find: 'phrase to wrap',
      addMark: { type: 'link', attrs: { href: 'doc:dst00002' } },
    }]);
    assert(result.success, `wrap succeeded (got ${JSON.stringify(result)})`);

    const after = getDocument();
    assert(after.content.length === 1, `still 1 block (got ${after.content.length})`);
    assert(after.content[0].attrs?.id === 'staBLE01',
      `node id preserved (got ${after.content[0].attrs?.id})`);
    const linkedSpan = after.content[0].content.find((n) => n.text === 'phrase to wrap');
    assert(!!linkedSpan, `the matched phrase exists as a text node`);
    assert(linkedSpan?.marks?.some((m) => m.type === 'link'),
      `it has a link mark`);
  }

} finally {
  cancelDebouncedSave();
}

console.log('\n' + '='.repeat(60));
console.log(`link_to integrity: ${passed} passed, ${failed} failed`);
console.log('='.repeat(60));
process.exit(failed > 0 ? 1 : 0);
