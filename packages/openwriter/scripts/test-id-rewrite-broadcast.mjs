/**
 * id-rewrite broadcast regression test.
 *
 * The v0.14.0 silent-data-loss bug was rooted in server↔browser ID divergence
 * after a save-time matcher reassignment. The hotfix narrowed the cases where
 * the matcher rewrites IDs, but couldn't eliminate them entirely — transient
 * editor-minted IDs at slots with unclaimed orphans still get reassigned via
 * slot-continuity (Test 12 in test-state-integration.mjs documents this as
 * intentional matcher behavior).
 *
 * The architectural fix is bidirectional sync: any time the matcher reassigns
 * an ID at save time, the server broadcasts an `id-rewrites` message so the
 * browser can update its in-memory TipTap doc. Server and browser converge
 * after every save.
 *
 * This test exercises the full pipeline:
 *   1. setActiveDocument with a doc carrying transient IDs at slots that will
 *      slot-continuity-pair with previousNodes orphans
 *   2. save() runs writeToDisk's matcher
 *   3. Subscribed listener receives the {oldId, newId}[] rewrite list
 *   4. The listed rewrites match what landed in the frontmatter
 *
 * Also verifies the no-op path: a save with no matcher rewrites fires no
 * listener (avoids noise in steady-state).
 *
 * Run: `node scripts/test-id-rewrite-broadcast.mjs`
 */

import { mkdirSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import matter from 'gray-matter';
import {
  setActiveDocument,
  save,
  cancelDebouncedSave,
  getDocument,
  updateDocument,
  onIdRewrites,
} from '../dist/server/state.js';
import { markdownToTiptap } from '../dist/server/markdown.js';
import { markdownToNodes, resolvePreviousNodes, resolveGraveyard } from '../dist/server/markdown-parse.js';
import { tiptapToBlocks } from '../dist/server/node-blocks.js';
import { setActiveProfile, ensureDataDir } from '../dist/server/helpers.js';

/** Read frontmatter and project slim-tuple nodes/graveyard to legacy
 *  {id, fp} objects for assertions. Returns a new object — never mutates
 *  gray-matter's cached data. */
function readFrontmatter(filePath) {
  const raw = readFileSync(filePath, 'utf-8');
  const { data, content } = matter(raw);
  const blocks = tiptapToBlocks({ type: 'doc', content: markdownToNodes(content) });
  return {
    ...data,
    nodes: Array.isArray(data.nodes)
      ? resolvePreviousNodes(data.nodes, blocks).map((r) => ({ id: r.id, fp: r.fingerprint }))
      : data.nodes,
    graveyard: Array.isArray(data.graveyard)
      ? resolveGraveyard(data.graveyard).map((r) => ({ id: r.id, fp: r.fingerprint }))
      : data.graveyard,
  };
}

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) { passed++; console.log(`  PASS: ${msg}`); }
  else      { failed++; console.error(`  FAIL: ${msg}`); }
}

const TEST_PROFILE = `test-rewrite-${Date.now()}`;
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

// Subscribe to rewrites across the whole test run.
const captured = [];
const unsubscribe = onIdRewrites((rewrites) => {
  captured.push(rewrites);
});

try {
  const filePath = join(TEST_PROFILE_DIR, 'rewrite.md');

  // ==========================================================================
  // CASE 1: seed a doc — first save mints IDs from attrs, no previousNodes,
  //          matcher doesn't run, listener doesn't fire
  // ==========================================================================
  console.log('Case 1: first save (no previousNodes) — listener fires no rewrites');
  {
    captured.length = 0;
    const doc = {
      type: 'doc',
      content: [
        { type: 'heading', attrs: { id: 'hh000001', level: 2 }, content: [{ type: 'text', text: 'Test Heading' }] },
        { type: 'paragraph', attrs: { id: 'pa000001' }, content: [{ type: 'text', text: 'First paragraph.' }] },
        { type: 'paragraph', attrs: { id: 'pa000002' }, content: [{ type: 'text', text: 'Second paragraph.' }] },
      ],
    };
    setActiveDocument(doc, 'Rewrite', filePath, false, undefined, { title: 'Rewrite', docId: 'rrrrrrrr' });
    save();
    assert(captured.length === 0, `no listener call on first save (got ${captured.length})`);
  }

  // ==========================================================================
  // CASE 2: edit text in place — matcher fingerprint-matches by existing ID,
  //          no rewrite needed (the block's existing ID already matches)
  // ==========================================================================
  console.log('\nCase 2: in-place edit with preserved id — listener fires no rewrites');
  {
    captured.length = 0;
    const reloaded = markdownToTiptap(readFileSync(filePath, 'utf-8'));
    setActiveDocument(reloaded.document, reloaded.title, filePath, false, undefined, reloaded.metadata);
    // Edit pa000001's text but keep its attrs.id
    updateDocument({
      type: 'doc',
      content: [
        getDocument().content[0],
        {
          ...getDocument().content[1],
          content: [{ type: 'text', text: 'First paragraph (edited).' }],
        },
        getDocument().content[2],
      ],
    });
    save();
    assert(captured.length === 0, `no rewrite for in-place edit (got ${captured.length} rewrite batches)`);
  }

  // ==========================================================================
  // CASE 3: replace a block with new content carrying a TRANSIENT id.
  //          The matcher's slot-continuity rule will pair the transient id
  //          with the previousNodes orphan (sp000002 in our seed). That's a
  //          rewrite — listener must fire with the {oldId, newId} mapping.
  // ==========================================================================
  console.log('\nCase 3: in-place replacement with transient id — rewrite broadcast');
  {
    captured.length = 0;
    const reloaded = markdownToTiptap(readFileSync(filePath, 'utf-8'));
    setActiveDocument(reloaded.document, reloaded.title, filePath, false, undefined, reloaded.metadata);
    // Replace pa000002 with new content carrying a TRANSIENT id (not in prev/grave)
    const doc = getDocument();
    updateDocument({
      type: 'doc',
      content: [
        doc.content[0],
        doc.content[1],
        {
          type: 'paragraph',
          attrs: { id: 'transXXX' }, // transient — slot-continuity will overwrite
          content: [{ type: 'text', text: 'Completely different content here.' }],
        },
      ],
    });
    save();
    assert(captured.length === 1, `listener fired exactly once (got ${captured.length})`);
    if (captured.length === 1) {
      const rewrites = captured[0];
      const transBatch = rewrites.find((r) => r.oldId === 'transXXX');
      assert(!!transBatch, `rewrite contains transXXX as oldId (got ${JSON.stringify(rewrites)})`);
      // newId should be pa000002 (the slot-continuity-preserved id from previousNodes)
      assert(transBatch?.newId === 'pa000002',
        `rewrite newId is pa000002 (got ${transBatch?.newId})`);
      // Frontmatter should confirm the matcher pinned pa000002 at position 2
      const fm = readFrontmatter(filePath);
      const ids = fm.nodes.map((n) => n.id);
      assert(ids[2] === 'pa000002', `frontmatter pos 2 is pa000002 (got ${ids[2]})`);
    }
  }

  // ==========================================================================
  // CASE 4: agent-style insert at end (the v0.14.0 production-bug path).
  //          With the hotfix matcher guard, the agent's stamped id should NOT
  //          be rewritten — meaning the listener fires NO rewrites for this
  //          insert. This is the convergence-by-default case.
  // ==========================================================================
  console.log('\nCase 4: agent-stamped insert at end — no rewrite broadcast');
  {
    captured.length = 0;
    const reloaded = markdownToTiptap(readFileSync(filePath, 'utf-8'));
    setActiveDocument(reloaded.document, reloaded.title, filePath, false, undefined, reloaded.metadata);
    const doc = getDocument();
    updateDocument({
      type: 'doc',
      content: [
        ...doc.content,
        {
          type: 'paragraph',
          attrs: { id: 'agentNEW' }, // simulating applyChangesToDocument stamping a fresh id
          content: [{ type: 'text', text: 'New tail paragraph added by agent.' }],
        },
      ],
    });
    save();
    assert(captured.length === 0,
      `no rewrite for end-of-doc insert with agent-stamped id (got ${captured.length} batches)`);
    // Verify the id survived to disk
    const fm = readFrontmatter(filePath);
    const ids = fm.nodes.map((n) => n.id);
    assert(ids.includes('agentNEW'),
      `agent-stamped id agentNEW landed in frontmatter (got ${JSON.stringify(ids)})`);
  }

  // ==========================================================================
  // CASE 5: snapshot-restore-like scenario where browser ships stale IDs.
  //          Simulate: server has nodes=[hh, pa1, pa2-rewritten], browser
  //          ships a doc-update with old pa2 (id=pa000002, original text).
  //          After save, the matcher uses graveyard-restore... actually wait,
  //          this case is more complex. Instead, test that re-applying the
  //          rewrites from Case 3 to a fresh TipTap-style doc keeps the IDs
  //          stable (idempotent re-save).
  // ==========================================================================
  console.log('\nCase 5: re-save with already-aligned ids — no rewrite');
  {
    captured.length = 0;
    const reloaded = markdownToTiptap(readFileSync(filePath, 'utf-8'));
    setActiveDocument(reloaded.document, reloaded.title, filePath, false, undefined, reloaded.metadata);
    save();
    assert(captured.length === 0,
      `idempotent re-save fires no rewrite (got ${captured.length} batches)`);
  }

  // ==========================================================================
  // CASE 6: the v0.14.0 divergence scenario, end to end.
  //          1. Doc has [hh, pa1, pa2]. Server "broadcasts" pa3 with id=p9999.
  //          2. Save's matcher runs. With the hotfix, p9999 is preserved.
  //          3. The architectural fix: even if a matcher rule HAD rewritten
  //             p9999, the listener would receive the rewrite and we'd be
  //             able to update the simulated "browser state" to match.
  //
  //          Verify the closed loop: capture rewrites, apply them to a copy
  //          of the broadcasted state, assert convergence with the server's
  //          in-memory document attrs.
  // ==========================================================================
  console.log('\nCase 6: closed-loop simulation — apply rewrites to "browser" doc, assert convergence');
  {
    captured.length = 0;
    const reloaded = markdownToTiptap(readFileSync(filePath, 'utf-8'));
    setActiveDocument(reloaded.document, reloaded.title, filePath, false, undefined, reloaded.metadata);
    const doc = getDocument();
    // Simulate applyChangesToDocument stamping a fresh id, then broadcasting:
    const newBlock = {
      type: 'paragraph',
      attrs: { id: 'sim99999' },
      content: [{ type: 'text', text: 'Simulated MCP-broadcast paragraph.' }],
    };
    // "Broadcast" snapshot (simulated browser receives this state, sets attrs.id locally)
    const browserSimulated = JSON.parse(JSON.stringify({
      type: 'doc',
      content: [...doc.content, newBlock],
    }));
    // Server applies and saves
    updateDocument({ type: 'doc', content: [...doc.content, newBlock] });
    save();
    // Apply any rewrites the server emitted to the simulated browser state
    if (captured.length > 0) {
      const rewriteMap = new Map();
      for (const batch of captured) {
        for (const { oldId, newId } of batch) rewriteMap.set(oldId, newId);
      }
      for (const block of browserSimulated.content) {
        const oldId = block.attrs?.id;
        if (oldId && rewriteMap.has(oldId)) {
          block.attrs.id = rewriteMap.get(oldId);
        }
      }
    }
    // Now assert: server's in-memory doc attrs.id matches the (possibly-rewritten) browser state
    const serverDoc = getDocument();
    const serverIds = serverDoc.content.map((b) => b.attrs?.id);
    const browserIds = browserSimulated.content.map((b) => b.attrs?.id);
    assert(JSON.stringify(serverIds) === JSON.stringify(browserIds),
      `server ids ${JSON.stringify(serverIds)} match browser ids ${JSON.stringify(browserIds)} after rewrite application`);
  }

} finally {
  unsubscribe();
  cancelDebouncedSave();
}

console.log('\n' + '='.repeat(60));
console.log(`id-rewrite broadcast: ${passed} passed, ${failed} failed`);
console.log('='.repeat(60));
process.exit(failed > 0 ? 1 : 0);
