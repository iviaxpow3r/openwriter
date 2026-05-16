/**
 * Pending changes survival across the save-time matcher.
 *
 * Background: when auto-accept is off, agent writes are decorated as
 * "pending" — the block's body has the new content, but the node carries
 * `pendingStatus`, `pendingOriginalContent`, etc. attrs. On save, these
 * attrs collect into a frontmatter `pending: {n: {s, o, t}}` map keyed by
 * ordinal position with text fingerprint backup. On load, the parser
 * rehydrates pending state onto the matching block.
 *
 * The matcher's ID assignment is independent of pending state — pending
 * lives on the node's attrs alongside `attrs.id`, and the matcher mutates
 * `attrs.id` without touching anything else. This test verifies that
 * pending state survives matcher-triggered ID re-assignments.
 *
 * Run: `node scripts/test-pending-integration.mjs`
 */

import { mkdirSync, readFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import matter from 'gray-matter';
import {
  setActiveDocument,
  save,
  cancelDebouncedSave,
  getDocument,
  updateDocument,
} from '../dist/server/state.js';
import { markdownToTiptap } from '../dist/server/markdown.js';
import { setActiveProfile, ensureDataDir } from '../dist/server/helpers.js';

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) { passed++; console.log(`  PASS: ${msg}`); }
  else      { failed++; console.error(`  FAIL: ${msg}`); }
}

const TEST_PROFILE = `test-pending-${Date.now()}`;
const TEST_PROFILE_DIR = join(homedir(), '.openwriter', 'profiles', TEST_PROFILE);

function cleanup() {
  cancelDebouncedSave();
  try { rmSync(TEST_PROFILE_DIR, { recursive: true, force: true }); } catch { /* best-effort */ }
}

function readFrontmatter(filePath) {
  return matter(readFileSync(filePath, 'utf-8')).data;
}

function setDocContent(content) {
  updateDocument({ type: 'doc', content });
}

process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(1); });

setActiveProfile(TEST_PROFILE);
mkdirSync(TEST_PROFILE_DIR, { recursive: true });
ensureDataDir();

const filePath = join(TEST_PROFILE_DIR, 'pending.md');

try {
  // ==========================================================================
  // SETUP: doc with pending state on a few blocks
  // ==========================================================================
  console.log('Setup: build doc with pending attrs on 2 blocks');
  {
    const doc = {
      type: 'doc',
      content: [
        { type: 'heading', attrs: { id: 'aa000001', level: 2 }, content: [{ type: 'text', text: 'Pending Test' }] },
        // Block with pending=rewrite
        { type: 'paragraph', attrs: {
          id: 'bb000001',
          pendingStatus: 'rewrite',
          pendingOriginalContent: 'The original paragraph text before the agent edit.',
        }, content: [{ type: 'text', text: 'The agent-edited paragraph text awaiting review.' }] },
        // Plain block, no pending
        { type: 'paragraph', attrs: { id: 'cc000001' }, content: [{ type: 'text', text: 'A paragraph without pending state.' }] },
        // Block with pending=insert
        { type: 'paragraph', attrs: {
          id: 'dd000001',
          pendingStatus: 'insert',
        }, content: [{ type: 'text', text: 'A freshly inserted paragraph awaiting accept.' }] },
      ],
    };
    setActiveDocument(doc, 'Pending', filePath, false);
    save();
    assert(existsSync(filePath), 'file written');
    const fm = readFrontmatter(filePath);
    assert(!!fm.pending && Object.keys(fm.pending).length === 2,
      `pending frontmatter has 2 entries (got ${fm.pending ? Object.keys(fm.pending).length : 0})`);
    assert(fm.pending?.['1']?.s === 'rewrite', `pending[1].s = rewrite (got ${fm.pending?.['1']?.s})`);
    assert(fm.pending?.['3']?.s === 'insert', `pending[3].s = insert (got ${fm.pending?.['3']?.s})`);
    assert(fm.pending?.['1']?.o === 'The original paragraph text before the agent edit.',
      'pending[1].o has original content');
  }

  // ==========================================================================
  // L-A: Edit a non-pending block — pending state on other blocks survives
  // ==========================================================================
  console.log('\nL-A: edit untouched block, pending state on other blocks survives');
  {
    const reloaded = markdownToTiptap(readFileSync(filePath, 'utf-8'));
    setActiveDocument(reloaded.document, reloaded.title, filePath, false, undefined, reloaded.metadata);
    const doc = getDocument();
    // Verify pending attrs were rehydrated correctly on load
    const bb = doc.content.find((b) => b.attrs?.id === 'bb000001');
    const dd = doc.content.find((b) => b.attrs?.id === 'dd000001');
    assert(bb?.attrs?.pendingStatus === 'rewrite', `bb000001 has pendingStatus=rewrite (got ${bb?.attrs?.pendingStatus})`);
    assert(dd?.attrs?.pendingStatus === 'insert', `dd000001 has pendingStatus=insert (got ${dd?.attrs?.pendingStatus})`);

    // Edit the un-pending block (cc000001)
    setDocContent(doc.content.map((b) => b.attrs?.id !== 'cc000001' ? b : {
      ...b, content: [{ type: 'text', text: 'Edited paragraph that has no pending state.' }],
    }));
    save();
    const fm = readFrontmatter(filePath);
    assert(Object.keys(fm.pending ?? {}).length === 2, `pending count still 2 after unrelated edit (got ${Object.keys(fm.pending ?? {}).length})`);
    assert(fm.pending?.['1']?.s === 'rewrite', 'bb000001 pending still rewrite');
    assert(fm.pending?.['3']?.s === 'insert', 'dd000001 pending still insert');
  }

  // ==========================================================================
  // L-B: Edit a pending block's text — pending state travels with it
  // ==========================================================================
  console.log('\nL-B: edit a pending block, pending attrs travel with the block');
  {
    const reloaded = markdownToTiptap(readFileSync(filePath, 'utf-8'));
    setActiveDocument(reloaded.document, reloaded.title, filePath, false, undefined, reloaded.metadata);
    const doc = getDocument();
    setDocContent(doc.content.map((b) => b.attrs?.id !== 'bb000001' ? b : {
      ...b, content: [{ type: 'text', text: 'The agent-edited paragraph, now lightly revised by user.' }],
    }));
    save();
    const fm = readFrontmatter(filePath);
    assert(fm.pending?.['1']?.s === 'rewrite', `bb000001 pending status survived edit (got ${fm.pending?.['1']?.s})`);
    assert(fm.pending?.['1']?.o === 'The original paragraph text before the agent edit.',
      'pending originalContent intact');
    assert(fm.pending?.['1']?.t?.includes('lightly revised'),
      `pending text fingerprint updated to new text (got ${fm.pending?.['1']?.t})`);
  }

  // ==========================================================================
  // L-C: Insert a new block — pending positions shift correctly
  // ==========================================================================
  console.log('\nL-C: insert a block, pending ordinal positions shift to new layout');
  {
    const reloaded = markdownToTiptap(readFileSync(filePath, 'utf-8'));
    setActiveDocument(reloaded.document, reloaded.title, filePath, false, undefined, reloaded.metadata);
    const doc = getDocument();
    // Insert a new paragraph at the top (after heading)
    setDocContent([
      doc.content[0], // heading
      { type: 'paragraph', attrs: { id: 'ee000001' }, content: [{ type: 'text', text: 'A freshly inserted block at position 1.' }] },
      ...doc.content.slice(1),
    ]);
    save();
    const fm = readFrontmatter(filePath);
    // Now bb000001 is at index 2, dd000001 is at index 4
    assert(fm.pending?.['2']?.s === 'rewrite', `bb000001 pending now at index 2 (got ${fm.pending?.['2']?.s})`);
    assert(fm.pending?.['4']?.s === 'insert', `dd000001 pending now at index 4 (got ${fm.pending?.['4']?.s})`);
    assert(!fm.pending?.['1'] || fm.pending?.['1']?.s !== 'rewrite',
      'index 1 no longer has rewrite pending (shifted)');
  }

  // ==========================================================================
  // L-D: Delete a pending block — its pending entry disappears
  // ==========================================================================
  console.log('\nL-D: delete a pending block, its pending entry is gone');
  {
    const reloaded = markdownToTiptap(readFileSync(filePath, 'utf-8'));
    setActiveDocument(reloaded.document, reloaded.title, filePath, false, undefined, reloaded.metadata);
    const doc = getDocument();
    setDocContent(doc.content.filter((b) => b.attrs?.id !== 'dd000001'));
    save();
    const fm = readFrontmatter(filePath);
    const pendingCount = Object.keys(fm.pending ?? {}).length;
    assert(pendingCount === 1, `pending count down to 1 (got ${pendingCount})`);
    const remainingStatuses = Object.values(fm.pending ?? {}).map((p) => p.s);
    assert(!remainingStatuses.includes('insert'),
      `insert-pending entry removed when its block deleted (statuses: ${remainingStatuses.join(',')})`);
  }

  // ==========================================================================
  // L-E: Type-change a pending block — pending attrs survive on the new type
  // ==========================================================================
  console.log('\nL-E: type-change a pending block, pending attrs survive');
  {
    const reloaded = markdownToTiptap(readFileSync(filePath, 'utf-8'));
    setActiveDocument(reloaded.document, reloaded.title, filePath, false, undefined, reloaded.metadata);
    const doc = getDocument();
    // Find bb000001 and convert to heading, keep pending attrs
    setDocContent(doc.content.map((b) => b.attrs?.id !== 'bb000001' ? b : {
      type: 'heading',
      attrs: { ...b.attrs, level: 3 },
      content: b.content,
    }));
    save();
    const fm = readFrontmatter(filePath);
    // The pending entry's position depends on layout — find by status
    const rewriteEntry = Object.values(fm.pending ?? {}).find((p) => p.s === 'rewrite');
    assert(!!rewriteEntry, `pending rewrite entry still present after type-change`);
    const bbNode = fm.nodes?.find((n) => n.id === 'bb000001');
    assert(bbNode?.fp?.type === 'heading', `bb000001 is now a heading (got ${bbNode?.fp?.type})`);
  }

} finally {
  cleanup();
}

console.log('\n' + '='.repeat(60));
console.log(`Pending integration: ${passed} passed, ${failed} failed`);
console.log('='.repeat(60));
process.exit(failed > 0 ? 1 : 0);
