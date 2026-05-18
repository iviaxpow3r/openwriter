/**
 * Regression test: populate_document on a fresh doc containing nested
 * content (lists, blockquotes) must produce overlay entries for the
 * container wrappers, not just the inner leaves.
 *
 * Before the fix, markAllNodesAsPending only tagged LEAF block types
 * (paragraph, heading, codeBlock, etc.) and skipped container types
 * (bulletList, listItem, blockquote). The wrappers vanished from disk
 * during serialize because empty containers have no markdown
 * representation. On reload, the leaves' parentNodeId references
 * pointed at containers that no longer existed → applyOverlay
 * classified them as orphans and dumped them at the end of the doc
 * with the purple `pendingOrphan: true` flag.
 *
 * The fix: extend the populate-path marker to cover container block
 * types so they become first-class overlay entries placed in walk
 * order, ensuring child entries' parent references always resolve.
 *
 * adr: adr/pending-overlay-model.md
 *
 * Run: `node scripts/test-populate-container-overlay.mjs`
 */

import { mkdirSync, readFileSync, rmSync, existsSync, writeFileSync as fsWriteFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import {
  setActiveDocument,
  populateDocumentFile,
} from '../dist/server/state.js';
import { markdownToTiptap } from '../dist/server/markdown.js';
import { applyOverlayPure } from '../dist/server/pending-overlay.js';
import { setActiveProfile, ensureDataDir } from '../dist/server/helpers.js';

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) { passed++; console.log(`  PASS: ${msg}`); }
  else      { failed++; console.error(`  FAIL: ${msg}`); }
}

const TEST_PROFILE = `test-populate-containers-${Date.now()}`;
const TEST_PROFILE_DIR = join(homedir(), '.openwriter', 'profiles', TEST_PROFILE);

function cleanup() {
  try { rmSync(TEST_PROFILE_DIR, { recursive: true, force: true }); } catch { /* best-effort */ }
}

function sidecarEntries(docId) {
  const p = join(TEST_PROFILE_DIR, '_pending', `${docId}.json`);
  if (!existsSync(p)) return [];
  return JSON.parse(readFileSync(p, 'utf-8'))?.entries || [];
}

function findNode(nodes, id) {
  if (!Array.isArray(nodes)) return null;
  for (const n of nodes) {
    if (n.attrs?.id === id) return n;
    const child = findNode(n.content, id);
    if (child) return child;
  }
  return null;
}

function countIds(nodes, counts = {}) {
  if (!Array.isArray(nodes)) return counts;
  for (const n of nodes) {
    const id = n.attrs?.id;
    if (id) counts[id] = (counts[id] || 0) + 1;
    if (n.content) countIds(n.content, counts);
  }
  return counts;
}

function findDuplicates(nodes) {
  const counts = countIds(nodes);
  return Object.entries(counts).filter(([, c]) => c > 1).map(([id, c]) => `${id}×${c}`);
}

process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(1); });

setActiveProfile(TEST_PROFILE);
mkdirSync(TEST_PROFILE_DIR, { recursive: true });
ensureDataDir();

// Set up an unrelated active doc so the singleton is occupied.
const activeFilePath = join(TEST_PROFILE_DIR, 'active.md');
fsWriteFileSync(activeFilePath, `---\ntitle: Active\ndocId: active001\n---\n\nActive doc placeholder.\n`, 'utf-8');
{
  const parsed = markdownToTiptap(readFileSync(activeFilePath, 'utf-8'));
  setActiveDocument(parsed.document, parsed.title, activeFilePath, false, undefined, parsed.metadata);
}

try {
  // ==========================================================================
  // T1: populate with a bulletList — wrapper and items become overlay entries
  // ==========================================================================
  console.log('T1: populate with bulletList records container entries (not just leaves)');
  {
    const target = join(TEST_PROFILE_DIR, 'pop-list.md');
    fsWriteFileSync(target, `---\ntitle: Pop List\ndocId: pop00001\n---\n\n`, 'utf-8');

    const populated = {
      type: 'doc',
      content: [
        { type: 'heading', attrs: { id: 'h0000001', level: 1 }, content: [{ type: 'text', text: 'Title' }] },
        {
          type: 'bulletList',
          attrs: { id: 'ul000001' },
          content: [
            {
              type: 'listItem',
              attrs: { id: 'li000001' },
              content: [{ type: 'paragraph', attrs: { id: 'p0000001' }, content: [{ type: 'text', text: 'Item 1' }] }],
            },
            {
              type: 'listItem',
              attrs: { id: 'li000002' },
              content: [{ type: 'paragraph', attrs: { id: 'p0000002' }, content: [{ type: 'text', text: 'Item 2' }] }],
            },
          ],
        },
      ],
    };

    populateDocumentFile(target, populated);

    const entries = sidecarEntries('pop00001');
    const ids = new Set(entries.map((e) => e.nodeId));

    assert(ids.has('h0000001'), 'sidecar has heading entry');
    assert(ids.has('ul000001'), 'sidecar has bulletList entry (NEW: container coverage)');
    assert(ids.has('li000001'), 'sidecar has listItem 1 entry (NEW: container coverage)');
    assert(ids.has('li000002'), 'sidecar has listItem 2 entry (NEW: container coverage)');
    assert(ids.has('p0000001'), 'sidecar has inner paragraph 1 entry');
    assert(ids.has('p0000002'), 'sidecar has inner paragraph 2 entry');
    assert(entries.every((e) => e.status === 'insert'), 'all entries are inserts');
  }

  // ==========================================================================
  // T2: apply the overlay to an empty canonical — no orphans, full tree restored
  // ==========================================================================
  console.log('\nT2: applyOverlayPure on empty canonical reconstructs nested tree, no orphans');
  {
    const entries = sidecarEntries('pop00001');
    const emptyCanonical = { type: 'doc', content: [] };
    const merged = applyOverlayPure(emptyCanonical, entries);

    const heading = findNode(merged.content, 'h0000001');
    const ul = findNode(merged.content, 'ul000001');
    const li1 = findNode(merged.content, 'li000001');
    const li2 = findNode(merged.content, 'li000002');
    const p1 = findNode(merged.content, 'p0000001');
    const p2 = findNode(merged.content, 'p0000002');

    assert(heading != null, 'heading present in merged doc');
    assert(ul != null, 'bulletList present');
    assert(li1 != null && li2 != null, 'both listItems present');
    assert(p1 != null && p2 != null, 'both inner paragraphs present');

    // Nesting check: paragraphs live inside listItems, listItems inside bulletList.
    assert(ul.content.some((n) => n.attrs?.id === 'li000001'), 'listItem 1 nested inside bulletList');
    assert(ul.content.some((n) => n.attrs?.id === 'li000002'), 'listItem 2 nested inside bulletList');
    assert(li1.content.some((n) => n.attrs?.id === 'p0000001'), 'paragraph 1 nested inside listItem 1');
    assert(li2.content.some((n) => n.attrs?.id === 'p0000002'), 'paragraph 2 nested inside listItem 2');

    // Orphan check: nothing should carry the pendingOrphan flag.
    function findOrphan(nodes) {
      if (!Array.isArray(nodes)) return null;
      for (const n of nodes) {
        if (n.attrs?.pendingOrphan) return n.attrs.id;
        const child = findOrphan(n.content);
        if (child) return child;
      }
      return null;
    }
    const orphan = findOrphan(merged.content);
    assert(orphan == null, `no nodes carry pendingOrphan flag (got ${orphan ?? 'none'})`);

    // Pending insert markers on every node (containers + leaves).
    assert(heading.attrs?.pendingStatus === 'insert', 'heading marked pending-insert');
    assert(ul.attrs?.pendingStatus === 'insert', 'bulletList marked pending-insert');
    assert(li1.attrs?.pendingStatus === 'insert', 'listItem 1 marked pending-insert');
    assert(p1.attrs?.pendingStatus === 'insert', 'inner paragraph 1 marked pending-insert');

    // Every ID appears exactly once — no duplicate placement. This catches the
    // bug where a container's subtree gets placed AND its child entries
    // re-place the same nodes because nodeById doesn't see the container's
    // descendants until indexSubtree runs.
    const dups = findDuplicates(merged.content);
    assert(dups.length === 0, `no duplicate node IDs in merged tree (got [${dups.join(', ')}])`);
  }

  // ==========================================================================
  // T3: blockquote container also covered
  // ==========================================================================
  console.log('\nT3: populate with blockquote records the wrapper too');
  {
    const target = join(TEST_PROFILE_DIR, 'pop-quote.md');
    fsWriteFileSync(target, `---\ntitle: Pop Quote\ndocId: pop00002\n---\n\n`, 'utf-8');

    const populated = {
      type: 'doc',
      content: [
        {
          type: 'blockquote',
          attrs: { id: 'bq000001' },
          content: [{ type: 'paragraph', attrs: { id: 'pq000001' }, content: [{ type: 'text', text: 'Quote.' }] }],
        },
      ],
    };

    populateDocumentFile(target, populated);

    const entries = sidecarEntries('pop00002');
    const ids = new Set(entries.map((e) => e.nodeId));
    assert(ids.has('bq000001'), 'sidecar has blockquote entry');
    assert(ids.has('pq000001'), 'sidecar has inner paragraph entry');

    // Reload simulation: apply to empty canonical.
    const merged = applyOverlayPure({ type: 'doc', content: [] }, entries);
    const bq = findNode(merged.content, 'bq000001');
    const pq = findNode(merged.content, 'pq000001');
    assert(bq != null && pq != null, 'blockquote and inner paragraph both placed');
    assert(bq.content.some((n) => n.attrs?.id === 'pq000001'), 'paragraph nested inside blockquote');
    assert(bq.attrs?.pendingStatus === 'insert', 'blockquote marked pending-insert');
  }

  // ==========================================================================
  // T4: taskList container also covered
  // ==========================================================================
  console.log('\nT4: populate with taskList records taskList + taskItems too');
  {
    const target = join(TEST_PROFILE_DIR, 'pop-tasks.md');
    fsWriteFileSync(target, `---\ntitle: Pop Tasks\ndocId: pop00003\n---\n\n`, 'utf-8');

    const populated = {
      type: 'doc',
      content: [
        {
          type: 'taskList',
          attrs: { id: 'tl000001' },
          content: [
            {
              type: 'taskItem',
              attrs: { id: 'ti000001', checked: false },
              content: [{ type: 'paragraph', attrs: { id: 'pt000001' }, content: [{ type: 'text', text: 'Todo.' }] }],
            },
          ],
        },
      ],
    };

    populateDocumentFile(target, populated);

    const entries = sidecarEntries('pop00003');
    const ids = new Set(entries.map((e) => e.nodeId));
    assert(ids.has('tl000001'), 'sidecar has taskList entry');
    assert(ids.has('ti000001'), 'sidecar has taskItem entry');
    assert(ids.has('pt000001'), 'sidecar has inner paragraph entry');

    const merged = applyOverlayPure({ type: 'doc', content: [] }, entries);
    const tl = findNode(merged.content, 'tl000001');
    const ti = findNode(merged.content, 'ti000001');
    assert(tl != null && ti != null, 'taskList and taskItem both placed');
    assert(tl.content.some((n) => n.attrs?.id === 'ti000001'), 'taskItem nested inside taskList');
  }

  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
} catch (err) {
  console.error('Test crashed:', err);
  cleanup();
  process.exit(1);
}
