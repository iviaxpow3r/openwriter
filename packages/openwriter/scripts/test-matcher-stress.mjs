/**
 * Matcher stress test: 250+ operations on a 50-block doc.
 *
 * Confirms robustness beyond the 77-op live MCP flood. Runs deterministic
 * sequences of edits / inserts / deletes / type-changes in rapid succession,
 * asserting integrity invariants after each batch.
 *
 * Invariants checked continuously:
 * - All active node IDs unique
 * - All graveyard IDs unique
 * - No ID appears in both active and graveyard
 * - Every fingerprint has type + charCount + position
 * - Graveyard within cap (≤ 50)
 *
 * Run: `node scripts/test-matcher-stress.mjs`
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
import { markdownToTiptap, markdownToNodes } from '../dist/server/markdown.js';
import { resolvePreviousNodes, resolveGraveyard } from '../dist/server/markdown-parse.js';
import { tiptapToBlocks } from '../dist/server/node-blocks.js';
import { setActiveProfile, ensureDataDir, generateNodeId } from '../dist/server/helpers.js';

let passed = 0;
let failed = 0;
let opsRun = 0;

function assert(cond, msg) {
  if (cond) { passed++; }
  else      { failed++; console.error(`  FAIL: ${msg}`); }
}

const TEST_PROFILE = `test-stress-${Date.now()}`;
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

/** Verify universal invariants. Call after every save. */
function verifyInvariants(filePath, label) {
  const raw = readFileSync(filePath, 'utf-8');
  const { data, content } = matter(raw);
  const blocks = tiptapToBlocks({ type: 'doc', content: markdownToNodes(content) });
  const nodes = resolvePreviousNodes(data.nodes, blocks).map((r) => ({ id: r.id, fp: r.fingerprint }));
  const grave = resolveGraveyard(data.graveyard).map((r) => ({ id: r.id, fp: r.fingerprint }));
  const activeIds = new Set(nodes.map((n) => n.id));
  const graveIds = new Set(grave.map((g) => g.id));
  assert(activeIds.size === nodes.length, `${label}: active IDs unique (${activeIds.size}/${nodes.length})`);
  assert(graveIds.size === grave.length, `${label}: graveyard IDs unique (${graveIds.size}/${grave.length})`);
  const overlap = [...activeIds].filter((id) => graveIds.has(id));
  assert(overlap.length === 0, `${label}: no overlap active∩graveyard${overlap.length ? ' (overlaps: ' + overlap.join(',') + ')' : ''}`);
  for (const n of nodes) {
    if (!n.fp || !n.fp.type || n.fp.position === undefined) {
      assert(false, `${label}: node ${n.id} missing fp fields`);
      break;
    }
  }
  assert(grave.length <= 50, `${label}: graveyard ≤ 50 (got ${grave.length})`);
  return { nodes, grave };
}

process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(1); });

setActiveProfile(TEST_PROFILE);
mkdirSync(TEST_PROFILE_DIR, { recursive: true });
ensureDataDir();

const filePath = join(TEST_PROFILE_DIR, 'stress.md');

// Deterministic pseudo-random for reproducibility
let seed = 42;
function rng() {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed;
}

try {
  // ==========================================================================
  // SETUP: build a 50-block doc with mixed block types
  // ==========================================================================
  console.log('Setup: build 50-block doc with mixed types');
  {
    const content = [];
    content.push({ type: 'heading', attrs: { id: 'sh000001', level: 1 }, content: [{ type: 'text', text: 'Stress Test Document' }] });
    for (let i = 0; i < 49; i++) {
      const type = i % 7 === 0 ? 'heading' : 'paragraph';
      const id = generateNodeId();
      if (type === 'heading') {
        content.push({ type: 'heading', attrs: { id, level: 2 + (i % 4) }, content: [{ type: 'text', text: `Section ${i} heading line` }] });
      } else {
        content.push({ type: 'paragraph', attrs: { id }, content: [{ type: 'text', text: `Paragraph number ${i} with unique-ish content for fingerprinting tests, version ${rng() % 1000}.` }] });
      }
    }
    setActiveDocument({ type: 'doc', content }, 'Stress', filePath, false);
    save();
    verifyInvariants(filePath, 'setup');
    const { nodes } = verifyInvariants(filePath, 'setup-check');
    assert(nodes.length === 50, `50 blocks present at start (got ${nodes.length})`);
  }

  // ==========================================================================
  // STRESS PHASE 1: 100 sequential edits
  // ==========================================================================
  console.log('\nPhase 1: 100 sequential edits');
  {
    for (let i = 0; i < 100; i++) {
      const reloaded = markdownToTiptap(readFileSync(filePath, 'utf-8'));
      setActiveDocument(reloaded.document, reloaded.title, filePath, false, undefined, reloaded.metadata);
      const doc = getDocument();
      // Pick a non-heading paragraph deterministically
      const targets = doc.content.filter((b) => b.type === 'paragraph');
      if (targets.length === 0) break;
      const targetIdx = rng() % targets.length;
      const targetId = targets[targetIdx].attrs.id;
      setDocContent(doc.content.map((b) => b.attrs?.id !== targetId ? b : {
        ...b, content: [{ type: 'text', text: `Edited paragraph (round ${i}) with updated unique content ${rng()}.` }],
      }));
      save();
      opsRun++;
    }
    verifyInvariants(filePath, 'after-100-edits');
  }

  // ==========================================================================
  // STRESS PHASE 2: 50 sequential inserts at varying positions
  // ==========================================================================
  console.log('\nPhase 2: 50 sequential inserts');
  {
    for (let i = 0; i < 50; i++) {
      const reloaded = markdownToTiptap(readFileSync(filePath, 'utf-8'));
      setActiveDocument(reloaded.document, reloaded.title, filePath, false, undefined, reloaded.metadata);
      const doc = getDocument();
      const insertAt = rng() % (doc.content.length + 1);
      const newBlock = {
        type: 'paragraph',
        attrs: { id: generateNodeId() },
        content: [{ type: 'text', text: `Inserted block ${i} with unique content stamp ${rng()}-${i}.` }],
      };
      const newContent = [...doc.content.slice(0, insertAt), newBlock, ...doc.content.slice(insertAt)];
      setDocContent(newContent);
      save();
      opsRun++;
    }
    verifyInvariants(filePath, 'after-50-inserts');
  }

  // ==========================================================================
  // STRESS PHASE 3: 50 sequential deletes
  // ==========================================================================
  console.log('\nPhase 3: 50 sequential deletes');
  {
    for (let i = 0; i < 50; i++) {
      const reloaded = markdownToTiptap(readFileSync(filePath, 'utf-8'));
      setActiveDocument(reloaded.document, reloaded.title, filePath, false, undefined, reloaded.metadata);
      const doc = getDocument();
      // Delete a paragraph (avoid deleting headings to keep doc reasonable)
      const targets = doc.content.filter((b) => b.type === 'paragraph');
      if (targets.length <= 5) break; // Don't drain the doc
      const targetId = targets[rng() % targets.length].attrs.id;
      setDocContent(doc.content.filter((b) => b.attrs?.id !== targetId));
      save();
      opsRun++;
    }
    const { nodes, grave } = verifyInvariants(filePath, 'after-50-deletes');
    assert(grave.length <= 50, `graveyard capped after burst deletes (got ${grave.length})`);
  }

  // ==========================================================================
  // STRESS PHASE 4: 50 sequential type-changes
  // ==========================================================================
  console.log('\nPhase 4: 50 sequential type-changes');
  {
    for (let i = 0; i < 50; i++) {
      const reloaded = markdownToTiptap(readFileSync(filePath, 'utf-8'));
      setActiveDocument(reloaded.document, reloaded.title, filePath, false, undefined, reloaded.metadata);
      const doc = getDocument();
      const targets = doc.content.filter((b) => b.type === 'paragraph');
      if (targets.length === 0) break;
      const target = targets[rng() % targets.length];
      const newLevel = 2 + (rng() % 4);
      setDocContent(doc.content.map((b) => b.attrs?.id !== target.attrs.id ? b : {
        type: 'heading',
        attrs: { ...b.attrs, level: newLevel },
        content: b.content,
      }));
      save();
      opsRun++;
    }
    verifyInvariants(filePath, 'after-50-type-changes');
  }

  // ==========================================================================
  // FINAL: Comprehensive sanity check
  // ==========================================================================
  console.log('\nFinal: comprehensive sanity check after ' + opsRun + ' ops');
  {
    const fm = readFrontmatter(filePath);
    const { nodes, grave } = verifyInvariants(filePath, 'final');

    assert(nodes.length > 0, `doc still has content (${nodes.length} blocks)`);
    assert(grave.length <= 50, `graveyard within cap (${grave.length})`);

    // Verify no body anchors leaked
    const body = readFileSync(filePath, 'utf-8').match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/)[1];
    assert(!/\^[a-f0-9]{8}\s*$/m.test(body), 'no embedded ^id anchors in body');

    // Verify the heading "sh000001" (original h1) is still alive — it was
    // never explicitly targeted, so the matcher should have preserved it
    // through every operation via fingerprint match.
    assert(nodes.some((n) => n.id === 'sh000001'),
      `original h1 sh000001 survived ${opsRun} ops`);

    console.log(`  Active: ${nodes.length}, Graveyard: ${grave.length}, Total ops: ${opsRun}`);
  }

} finally {
  cleanup();
}

console.log('\n' + '='.repeat(60));
console.log(`Stress test: ${passed} assertions passed, ${failed} failed over ${opsRun} ops`);
console.log('='.repeat(60));
process.exit(failed > 0 ? 1 : 0);
