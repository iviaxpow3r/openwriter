/**
 * Verify the save-time matcher (Option B): writeToDisk reads previousNodes +
 * graveyard from disk frontmatter, runs the matcher against the current
 * in-memory TipTap tree, and writes back IDs that survive content edits.
 *
 * No in-memory cache, no parallel state — disk is the source of truth.
 *
 * Run from packages/openwriter: `node scripts/test-save-time-matcher.mjs`
 */

import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import matter from 'gray-matter';
import {
  markdownToTiptap,
  tiptapToMarkdown,
  markdownToNodes,
} from '../dist/server/markdown.js';
import { matchNodes } from '../dist/server/node-matcher.js';
import { resolvePreviousNodes, resolveGraveyard } from '../dist/server/markdown-parse.js';
import { enrichEntry } from '../dist/server/node-fingerprint.js';
import { tiptapToBlocks, applyIdsToTiptap } from '../dist/server/node-blocks.js';

/** Test helper: read a slim disk entry as a rich {id, fp} object the way
 *  assertions like to consume it. Mirrors production load semantics. */
function readDiskEntry(slim, blocks) {
  if (!slim) return null;
  if (Array.isArray(slim)) {
    const enriched = enrichEntry(slim, blocks?.[slim._idx] ?? null, blocks || []);
    return enriched ? { id: enriched.id, fp: enriched.fingerprint } : null;
  }
  // legacy verbose-object form (shouldn't occur post-migration, but tolerate it)
  return { id: slim.id, fp: slim.fp };
}

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) { passed++; console.log(`  PASS: ${msg}`); }
  else      { failed++; console.error(`  FAIL: ${msg}`); }
}

/** Mirror writeToDisk's save-time matcher pass without the singleton state. */
function saveWithMatcher(filePath, doc, title) {
  // 1. Read disk frontmatter → previousNodes + graveyard (the on-disk identity graph)
  let previousNodes = [];
  let graveyard = [];
  try {
    const raw = readFileSync(filePath, 'utf-8');
    const { data, content } = matter(raw);
    const previousDoc = { type: 'doc', content: markdownToNodes(content) };
    const previousBlocks = tiptapToBlocks(previousDoc);
    previousNodes = resolvePreviousNodes(data.nodes, previousBlocks);
    graveyard = resolveGraveyard(data.graveyard);
  } catch { /* new file */ }

  // 2. Run matcher if there's a baseline
  let nextGraveyard = graveyard;
  if (previousNodes.length > 0) {
    const newBlocks = tiptapToBlocks(doc);
    const result = matchNodes(previousNodes, newBlocks, { graveyard });
    const pinnedByPosition = new Map();
    for (const p of result.pinned) pinnedByPosition.set(p.position, p.id);
    applyIdsToTiptap(doc, pinnedByPosition);
    nextGraveyard = result.nextGraveyard;
  }

  // 3. Serialize and write
  const meta = nextGraveyard.length > 0
    ? { title, graveyard: nextGraveyard }
    : { title };
  const markdown = tiptapToMarkdown(doc, title, meta);
  writeFileSync(filePath, markdown);
}

/** Read frontmatter from disk and project node entries as {id, fp} objects
 *  via the same enrichment path production uses. */
function readDiskNodes(filePath) {
  const raw = readFileSync(filePath, 'utf-8');
  const { data, content } = matter(raw);
  const blocks = tiptapToBlocks({ type: 'doc', content: markdownToNodes(content) });
  const rich = resolvePreviousNodes(data.nodes, blocks);
  return { all: rich.map((r) => ({ id: r.id, fp: r.fingerprint })), rawData: data };
}

const tmp = mkdtempSync(join(tmpdir(), 'ow-save-test-'));
const file = join(tmp, 'doc.md');

try {
  console.log('Test 1: first save mints fresh IDs and writes nodes graph');
  {
    const doc = {
      type: 'doc',
      content: [
        { type: 'heading', attrs: { id: 'h0000001', level: 2 }, content: [{ type: 'text', text: 'Intro' }] },
        { type: 'paragraph', attrs: { id: 'p0000001' }, content: [{ type: 'text', text: 'The first paragraph.' }] },
        { type: 'paragraph', attrs: { id: 'p0000002' }, content: [{ type: 'text', text: 'The second paragraph.' }] },
      ],
    };
    saveWithMatcher(file, doc, 'Test');
    const { all: entries, rawData } = readDiskNodes(file);
    assert(Array.isArray(rawData.nodes) && rawData.nodes.length === 3, `frontmatter nodes has 3 entries (got ${rawData.nodes?.length})`);
    assert(entries[0].id === 'h0000001', `heading ID persisted (got ${entries[0].id})`);
    assert(entries[1].id === 'p0000001', `para 1 ID persisted`);
    assert(entries[2].id === 'p0000002', `para 2 ID persisted`);
  }

  console.log('\nTest 2: edit text inside an existing block — ID preserved');
  {
    const reloaded = markdownToTiptap(readFileSync(file, 'utf-8'));
    // Mutate para 1's text (simulating an in-session edit)
    const para1 = reloaded.document.content[1];
    para1.content[0].text = 'The first paragraph, slightly edited.';
    saveWithMatcher(file, reloaded.document, reloaded.title);
    const { all: entries } = readDiskNodes(file);
    const ids = entries.map((e) => e.id);
    assert(ids[0] === 'h0000001', `heading ID unchanged`);
    assert(ids[1] === 'p0000001', `edited para keeps its ID (got ${ids[1]})`);
    assert(ids[2] === 'p0000002', `untouched para keeps its ID`);
  }

  // Capture the matcher-assigned ID for the inserted block — the matcher owns
  // identity, so the editor's transient `newpara0` gets replaced on save.
  let insertedId = '';

  console.log('\nTest 3: insert a new paragraph — existing IDs stable, new one minted by matcher');
  {
    const reloaded = markdownToTiptap(readFileSync(file, 'utf-8'));
    // Insert a brand-new paragraph between the heading and para 1
    reloaded.document.content.splice(1, 0, {
      type: 'paragraph',
      attrs: { id: 'tempINS1' }, // transient — matcher will overwrite
      content: [{ type: 'text', text: 'Brand new paragraph inserted here.' }],
    });
    saveWithMatcher(file, reloaded.document, reloaded.title);
    const { all: entries } = readDiskNodes(file);
    const ids = entries.map((e) => e.id);
    assert(ids.length === 4, `now 4 blocks in frontmatter (got ${ids.length})`);
    assert(ids[0] === 'h0000001', `heading still has its ID`);
    assert(ids[1] !== 'h0000001' && ids[1] !== 'p0000001' && ids[1] !== 'p0000002',
      `new paragraph got a distinct ID (got ${ids[1]})`);
    assert(ids[2] === 'p0000001', `original para 1 ID survived insert`);
    assert(ids[3] === 'p0000002', `original para 2 ID survived insert`);
    insertedId = ids[1];
  }

  console.log('\nTest 4: delete a paragraph — survivor IDs stable, deleted enters graveyard');
  {
    const reloaded = markdownToTiptap(readFileSync(file, 'utf-8'));
    // Remove the inserted paragraph (now at index 1)
    reloaded.document.content.splice(1, 1);
    saveWithMatcher(file, reloaded.document, reloaded.title);
    const { all: entries, rawData } = readDiskNodes(file);
    const ids = entries.map((e) => e.id);
    assert(ids.length === 3, `back to 3 blocks (got ${ids.length})`);
    assert(ids[0] === 'h0000001', `heading stable through delete`);
    assert(ids[1] === 'p0000001', `para 1 stable through delete`);
    assert(ids[2] === 'p0000002', `para 2 stable through delete`);
    const grave = rawData.graveyard;
    assert(Array.isArray(grave) && grave.length >= 1, `graveyard has the deleted block (got ${grave?.length ?? 0})`);
    const firstGraveId = Array.isArray(grave?.[0]) ? grave[0][0] : grave?.[0]?.id;
    assert(firstGraveId === insertedId, `deleted block's ID landed in graveyard (got ${firstGraveId}, expected ${insertedId})`);
  }

  console.log('\nTest 5: paste-back from graveyard — original ID restored');
  {
    const reloaded = markdownToTiptap(readFileSync(file, 'utf-8'));
    // Paste back the same content that was just deleted
    reloaded.document.content.splice(1, 0, {
      type: 'paragraph',
      attrs: { id: 'tempzzzz' }, // editor mints fresh ID at insert
      content: [{ type: 'text', text: 'Brand new paragraph inserted here.' }],
    });
    saveWithMatcher(file, reloaded.document, reloaded.title);
    const { all: entries } = readDiskNodes(file);
    const ids = entries.map((e) => e.id);
    assert(ids[1] === insertedId, `graveyard restored the original ID (got ${ids[1]}, expected ${insertedId})`);
  }

  console.log('\nTest 6: type-change preserves ID (paragraph → heading)');
  {
    const reloaded = markdownToTiptap(readFileSync(file, 'utf-8'));
    // Promote para 1 (id p0000001) to a heading
    const para = reloaded.document.content[2]; // [heading, newpara0, para1, para2]
    assert(para.attrs.id === 'p0000001', `setup: index 2 is para 1`);
    para.type = 'heading';
    para.attrs = { id: para.attrs.id, level: 3 };
    saveWithMatcher(file, reloaded.document, reloaded.title);
    const { all: entries } = readDiskNodes(file);
    const promoted = entries[2];
    assert(promoted.fp.type === 'heading', `block is now a heading (got type=${promoted.fp.type})`);
    assert(promoted.id === 'p0000001', `type-change preserved the original ID (got ${promoted.id})`);
  }

} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log('\n' + '='.repeat(60));
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log('='.repeat(60));
process.exit(failed > 0 ? 1 : 0);
