/**
 * Regression: external-write reload must refresh disk frontmatter.
 *
 * Without this, `reloadActiveDocFromDisk` updated in-memory body but left
 * disk frontmatter at the previous save's fingerprints. A subsequent
 * cut/delete graveyarded the block with the stale fingerprint, breaking
 * paste-back graveyard-restore (only exact fingerprint matches restore).
 *
 * adr: adr/node-identity-matcher.md
 *
 * Run: `node scripts/test-reload-refreshes-frontmatter.mjs`
 */

import { mkdirSync, rmSync, readFileSync, writeFileSync, statSync, utimesSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import matter from 'gray-matter';
import {
  setActiveDocument,
  save,
  cancelDebouncedSave,
  getDocument,
  updateDocument,
  reloadActiveDocFromDisk,
} from '../dist/server/state.js';
import { markdownToTiptap } from '../dist/server/markdown.js';
import { markdownToNodes, resolvePreviousNodes, resolveGraveyard } from '../dist/server/markdown-parse.js';
import { tiptapToBlocks } from '../dist/server/node-blocks.js';
import { setActiveProfile, ensureDataDir } from '../dist/server/helpers.js';

let passed = 0;
let failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log(`  PASS: ${msg}`); }
  else      { failed++; console.error(`  FAIL: ${msg}`); }
}

const TEST_PROFILE = `test-reload-refresh-${Date.now()}`;
const TEST_PROFILE_DIR = join(homedir(), '.openwriter', 'profiles', TEST_PROFILE);

function cleanup() {
  cancelDebouncedSave();
  try { rmSync(TEST_PROFILE_DIR, { recursive: true, force: true }); } catch { /* best-effort */ }
}
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(1); });

function readSlim(filePath) {
  const raw = readFileSync(filePath, 'utf-8');
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  return JSON.parse(m[1]);
}

/** Force the file mtime forward so the watcher (and our internal mtime guards)
 *  always see a strictly-newer disk timestamp than our last loadedMtime stamp. */
function externalWrite(filePath, contents) {
  writeFileSync(filePath, contents);
  const now = Date.now() / 1000;
  utimesSync(filePath, now + 1, now + 1);
}

setActiveProfile(TEST_PROFILE);
mkdirSync(TEST_PROFILE_DIR, { recursive: true });
ensureDataDir();

const filePath = join(TEST_PROFILE_DIR, 'reload-refresh.md');

try {
  // ==========================================================================
  // SETUP: save a doc with a multi-sentence paragraph
  // ==========================================================================
  console.log('Setup: save doc with multi-sentence paragraph');
  {
    const doc = {
      type: 'doc',
      content: [
        { type: 'heading', attrs: { id: 'hh000001', level: 1 }, content: [{ type: 'text', text: 'Reload Test' }] },
        { type: 'paragraph', attrs: { id: 'pp000001' }, content: [{ type: 'text', text: 'First sentence. Second sentence. Third sentence.' }] },
      ],
    };
    setActiveDocument(doc, 'reload-refresh', filePath, false);
    save();
    const fm = readSlim(filePath);
    const entry = fm.nodes.find(n => n[0] === 'pp000001');
    assert(!!entry, `pp000001 in slim nodes after first save`);
    assert(entry[1].length === 3, `pp000001 has 3 sentence hashes initially (got ${entry[1].length})`);
  }

  // ==========================================================================
  // PHASE 1: external write adds a 4th sentence-equivalent fragment
  // ==========================================================================
  console.log('\nPhase 1: external write extends the paragraph');
  {
    const reloaded = markdownToTiptap(readFileSync(filePath, 'utf-8'));
    setActiveDocument(reloaded.document, reloaded.title, filePath, false, undefined, reloaded.metadata);

    const raw = readFileSync(filePath, 'utf-8');
    const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n\r?\n/);
    const fmPart = m[0];
    const body = raw.slice(m[0].length);
    const newBody = body.replace(
      'First sentence. Second sentence. Third sentence.',
      'First sentence. Second sentence. Third sentence. EXTRAFRAGMENT',
    );
    externalWrite(filePath, fmPart + newBody);

    // Confirm disk state before reload: body changed, frontmatter unchanged.
    const beforeReload = readSlim(filePath);
    const beforeEntry = beforeReload.nodes.find(n => n[0] === 'pp000001');
    assert(beforeEntry[1].length === 3,
      `BEFORE reload: disk fm still shows 3 sentences (stale relative to body) (got ${beforeEntry[1].length})`);

    // Reload should refresh disk frontmatter to match new body.
    reloadActiveDocFromDisk();

    const afterReload = readSlim(filePath);
    const afterEntry = afterReload.nodes.find(n => n[0] === 'pp000001');
    assert(!!afterEntry, `AFTER reload: pp000001 still in active nodes (id preserved via edit rule)`);
    assert(afterEntry && afterEntry[1].length === 4,
      `AFTER reload: disk fm now reflects 4 sentences (refreshed by reload) (got ${afterEntry?.[1]?.length})`);
  }

  // ==========================================================================
  // PHASE 2: external write removes the marker — fm should refresh again
  // ==========================================================================
  console.log('\nPhase 2: external write removes the marker, fm refreshes');
  {
    const raw = readFileSync(filePath, 'utf-8');
    const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n\r?\n/);
    const fmPart = m[0];
    const body = raw.slice(m[0].length);
    const cleanedBody = body.replace(
      'First sentence. Second sentence. Third sentence. EXTRAFRAGMENT',
      'First sentence. Second sentence. Third sentence.',
    );
    externalWrite(filePath, fmPart + cleanedBody);

    reloadActiveDocFromDisk();

    const fm = readSlim(filePath);
    const entry = fm.nodes.find(n => n[0] === 'pp000001');
    assert(!!entry, `pp000001 preserved (edit rule pinned ID across content shrink)`);
    assert(entry && entry[1].length === 3,
      `fm fingerprint resynced to 3 sentences after external removal (got ${entry?.[1]?.length})`);
  }

  // ==========================================================================
  // PHASE 3: delete the paragraph in-memory → graveyard uses CURRENT fingerprint
  // ==========================================================================
  console.log('\nPhase 3: delete in-memory, graveyard captures fresh fingerprint');
  {
    const doc = getDocument();
    updateDocument({
      type: 'doc',
      content: doc.content.filter(b => b.attrs?.id !== 'pp000001'),
    });
    save();

    const fm = readSlim(filePath);
    const graveEntry = fm.graveyard?.find(g => g[0] === 'pp000001');
    assert(!!graveEntry, `pp000001 moved to graveyard after delete`);
    assert(graveEntry && graveEntry[1].length === 3,
      `graveyard fingerprint has 3 sentences (matches body at delete time) (got ${graveEntry?.[1]?.length})`);
  }

  // ==========================================================================
  // PHASE 4: paste-back with matching content → graveyard-restore fires
  // ==========================================================================
  console.log('\nPhase 4: paste-back triggers graveyard-restore');
  {
    const doc = getDocument();
    updateDocument({
      type: 'doc',
      content: [
        ...doc.content,
        { type: 'paragraph', content: [{ type: 'text', text: 'First sentence. Second sentence. Third sentence.' }] },
      ],
    });
    save();

    const fm = readSlim(filePath);
    const restored = fm.nodes.find(n => n[0] === 'pp000001');
    const stillInGrave = fm.graveyard?.find(g => g[0] === 'pp000001');
    assert(!!restored, `pp000001 restored to active nodes via graveyard-restore`);
    assert(!stillInGrave, `pp000001 removed from graveyard after restore`);
  }

} finally {
  cleanup();
}

console.log('\n' + '='.repeat(60));
console.log(`Reload-refresh: ${passed} passed, ${failed} failed`);
console.log('='.repeat(60));
process.exit(failed > 0 ? 1 : 0);
