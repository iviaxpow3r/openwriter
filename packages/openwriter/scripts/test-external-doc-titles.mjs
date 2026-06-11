/**
 * Regression test: externally-added markdown files (dropped on disk, no
 * frontmatter) must resolve a real title in listings instead of "Untitled".
 *
 * Fallback chain under test (server/title-resolve.ts):
 *   frontmatter title → workspace JSON entry title → first h1 → filename stem
 *
 * Exercised through listDocuments, searchDocuments, and getDocTitle so the
 * sidebar, MCP list_documents, and workspace structure all stay covered.
 *
 * Run: `node scripts/test-external-doc-titles.mjs`
 */

import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

import { setActiveProfile, ensureDataDir, ensureWorkspacesDir, getDataDir, getWorkspacesDir } from '../dist/server/helpers.js';
import { listDocuments, searchDocuments } from '../dist/server/documents.js';
import { getDocTitle } from '../dist/server/workspaces.js';
import { resolveListingTitle, firstH1 } from '../dist/server/title-resolve.js';

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) { passed++; console.log(`  PASS: ${msg}`); }
  else      { failed++; console.error(`  FAIL: ${msg}`); }
}

const TEST_PROFILE = `test-ext-titles-${Date.now()}`;
const TEST_PROFILE_DIR = join(homedir(), '.openwriter', 'profiles', TEST_PROFILE);

function cleanup() {
  try { rmSync(TEST_PROFILE_DIR, { recursive: true, force: true }); } catch { /* best-effort */ }
}

try {
  setActiveProfile(TEST_PROFILE);
  ensureDataDir();
  ensureWorkspacesDir();

  // --- Fixtures: external files dropped straight on disk, no frontmatter ---

  // 1. Plain h1 body — should title from the heading
  writeFileSync(join(getDataDir(), 'dropped-h1.md'), '# My Title\n\nSome body text here.\n', 'utf-8');

  // 2. No h1, no frontmatter — but referenced from a workspace JSON whose
  //    doc entry carries the title (the original bug's failing case)
  writeFileSync(join(getDataDir(), 'dropped-ws.md'), 'Just prose, no heading at all.\n', 'utf-8');
  writeFileSync(join(getWorkspacesDir(), 'test-ws.json'), JSON.stringify({
    version: 2,
    title: 'Test Workspace',
    root: [
      { type: 'container', id: 'c1', name: 'Notes', items: [
        { type: 'doc', file: 'dropped-ws.md', title: 'Workspace Knows Best' },
      ]},
    ],
  }, null, 2), 'utf-8');

  // 3. No h1, no frontmatter, no workspace entry — falls to filename stem
  writeFileSync(join(getDataDir(), 'lone-notes.md'), 'Loose thoughts without structure.\n', 'utf-8');

  // 4. Frontmatter title present — must win over everything
  writeFileSync(join(getDataDir(), 'fm-doc.md'), '---\ntitle: Frontmatter Wins\n---\n\n# Not This H1\n', 'utf-8');

  // --- listDocuments (sidebar + MCP list_documents) ---
  const docs = listDocuments();
  const byFile = new Map(docs.map(d => [d.filename, d.title]));

  assert(byFile.get('dropped-h1.md') === 'My Title', `h1 fallback: got "${byFile.get('dropped-h1.md')}"`);
  assert(byFile.get('dropped-ws.md') === 'Workspace Knows Best', `workspace-entry fallback: got "${byFile.get('dropped-ws.md')}"`);
  assert(byFile.get('lone-notes.md') === 'lone-notes', `filename-stem fallback: got "${byFile.get('lone-notes.md')}"`);
  assert(byFile.get('fm-doc.md') === 'Frontmatter Wins', `frontmatter precedence: got "${byFile.get('fm-doc.md')}"`);
  assert(![...byFile.values()].includes('Untitled'), 'no doc in the listing shows as Untitled');

  // --- Listing must not have mutated the dropped files (fallback-only, no injection) ---
  const { readFileSync } = await import('fs');
  assert(readFileSync(join(getDataDir(), 'dropped-h1.md'), 'utf-8') === '# My Title\n\nSome body text here.\n',
    'listing does not inject frontmatter into external files');

  // --- searchDocuments uses the same resolution ---
  const hits = searchDocuments('My Title');
  assert(hits.some(h => h.filename === 'dropped-h1.md' && h.matchType === 'title'),
    'search finds external doc by its resolved h1 title');

  // --- getDocTitle (workspace structure path) ---
  assert(getDocTitle('dropped-h1.md') === 'My Title', `getDocTitle h1 fallback: got "${getDocTitle('dropped-h1.md')}"`);
  assert(getDocTitle('lone-notes.md') === 'lone-notes', `getDocTitle stem fallback: got "${getDocTitle('lone-notes.md')}"`);

  // --- Unit edges on the resolver itself ---
  assert(firstH1('intro\n\n# Real Heading ##\nmore') === 'Real Heading', 'firstH1 strips closing hashes');
  assert(firstH1('no headings here') === null, 'firstH1 null when absent');
  assert(resolveListingTitle({ fmTitle: 'Untitled', content: '# Better\n' }) === 'Better',
    'literal "Untitled" frontmatter is treated as no title');
  assert(resolveListingTitle({ filename: '_untitled-abc123.md', content: 'no heading' }) === 'Untitled',
    'temp files keep "Untitled" so auto-titling still owns them');

  console.log(`\n${passed} passed, ${failed} failed`);
  cleanup();
  process.exit(failed > 0 ? 1 : 0);
} catch (err) {
  cleanup();
  console.error('Test crashed:', err);
  process.exit(1);
}
