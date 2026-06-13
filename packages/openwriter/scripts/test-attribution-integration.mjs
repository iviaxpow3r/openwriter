/**
 * Integration test for attribution capture through the REAL save path.
 *
 * Drives state.ts's active-doc writeToDisk() with save('human') / save('agent')
 * and asserts the sidecar blame reflects who wrote what. Covers the load-bearing
 * guarantees that unit tests can't reach because they bypass the save pipeline:
 *   - agent vs human content separated by the save-scoped actor
 *   - agent's PENDING proposal is attributed to the agent at write time
 *   - a human ACCEPT of that proposal does NOT launder it to human
 *     (the sentence hash is unchanged, so origin holds)
 *   - char-weighted composition + get_attribution-equivalent readback
 *
 * Run: `node scripts/test-attribution-integration.mjs`  (after `npm run build`)
 */

import { mkdirSync, rmSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

import { setActiveProfile, ensureDataDir, getDataDir } from '../dist/server/helpers.js';
import { setActiveDocument, updateDocument, save, getDocument } from '../dist/server/state.js';
import { readBlame, summarizeBlame, blockSentenceHashes } from '../dist/server/attribution.js';
import { tiptapToBlocks } from '../dist/server/node-blocks.js';

const TEST_PROFILE = `test-attr-int-${process.pid}`;
const TEST_PROFILE_DIR = join(homedir(), '.openwriter', 'profiles', TEST_PROFILE);
setActiveProfile(TEST_PROFILE);
ensureDataDir();

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log('  PASS:', msg); } else { fail++; console.error('  FAIL:', msg); } }

const DOC_ID = 'attr0001';
const filePath = join(getDataDir(), 'AttrDoc.md');
const para = (id, text, extra = {}) => ({ type: 'paragraph', attrs: { id, ...extra }, content: [{ type: 'text', text }] });
function hashOf(text) {
  // hash of a single-sentence paragraph's only sentence
  return blockSentenceHashes({ position: 0, type: 'paragraph', text, parentPosition: null, id: 'x' })[0];
}
// Blame is HASH-anchored (it survives node-id reassignment by the matcher's
// slot-continuity rule), so look a sentence's authorship up by its content
// hash across every node + the retired set — exactly what a blame consumer does.
function authorOf(blame, text) {
  if (!blame) return null;
  const h = hashOf(text);
  for (const nodeId of Object.keys(blame.nodes)) {
    if (blame.nodes[nodeId].sentences[h]) return blame.nodes[nodeId].sentences[h];
  }
  return blame.retired[h] ?? null;
}

try {
  // Stub on disk + load as active doc.
  writeFileSync(filePath, `---\n${JSON.stringify({ title: 'AttrDoc', docId: DOC_ID, nodes: [['seed0001']] })}\n---\n\nSeed paragraph.\n`, 'utf-8');
  setActiveDocument({ type: 'doc', content: [para('seed0001', 'Seed paragraph.')] }, 'AttrDoc', filePath, false, undefined, { title: 'AttrDoc', docId: DOC_ID, nodes: [['seed0001']] });

  // --- 1. HUMAN writes two paragraphs.
  updateDocument({ type: 'doc', content: [
    para('h1', 'Human wrote this first line.'),
    para('h2', 'And a human second line.'),
  ] });
  save('human');
  let blame = readBlame(DOC_ID);
  ok(blame !== null, 'blame sidecar created after human save');
  ok(authorOf(blame, 'Human wrote this first line.')?.lastBy === 'human', 'human paragraph attributed to human');

  // --- 2. AGENT appends a paragraph (committed, not pending).
  updateDocument({ type: 'doc', content: [
    para('h1', 'Human wrote this first line.'),
    para('h2', 'And a human second line.'),
    para('a1', 'Agent synthesized this addition.'),
  ] });
  save('agent');
  blame = readBlame(DOC_ID);
  ok(authorOf(blame, 'Agent synthesized this addition.')?.lastBy === 'agent', 'agent paragraph attributed to agent');
  ok(authorOf(blame, 'Human wrote this first line.')?.lastBy === 'human', 'human paragraphs untouched by agent save');

  // --- 3. NO-LAUNDER: agent proposes a PENDING insert, then human ACCEPTS it.
  // Agent proposes (pendingStatus:insert) — present in merged, absent from canonical.
  updateDocument({ type: 'doc', content: [
    para('h1', 'Human wrote this first line.'),
    para('h2', 'And a human second line.'),
    para('a1', 'Agent synthesized this addition.'),
    para('a2', 'Agent proposed pending insert.', { pendingStatus: 'insert' }),
  ] });
  save('agent');
  blame = readBlame(DOC_ID);
  ok(authorOf(blame, 'Agent proposed pending insert.')?.lastBy === 'agent', 'agent PENDING proposal attributed to agent at write time');

  // Human accepts: same node, pendingStatus cleared (now canonical). Human save.
  updateDocument({ type: 'doc', content: [
    para('h1', 'Human wrote this first line.'),
    para('h2', 'And a human second line.'),
    para('a1', 'Agent synthesized this addition.'),
    para('a2', 'Agent proposed pending insert.'),
  ] });
  save('human');
  blame = readBlame(DOC_ID);
  ok(authorOf(blame, 'Agent proposed pending insert.')?.firstBy === 'agent',
     'NO-LAUNDER: human ACCEPT of agent content keeps agent origin');
  ok(authorOf(blame, 'Agent proposed pending insert.')?.lastBy === 'agent',
     'NO-LAUNDER: lastBy stays agent after human accept');

  // --- 4. Composition readback (get_attribution equivalent). Use the LIVE doc
  // blocks so node-ids match the matcher's stable ids (what the heatmap sees).
  const liveBlocks = tiptapToBlocks(getDocument());
  const summary = summarizeBlame(blame, liveBlocks);
  ok(summary.chars.human > 0 && summary.chars.agent > 0, 'composition has both human and agent chars');
  ok(summary.percent.human + summary.percent.agent + summary.percent.unknown >= 99, 'percentages sum ~100');
  ok(summary.chars.unknown === 0, 'every live sentence is attributed (no unknown leakage)');
  const byText = Object.fromEntries(liveBlocks.map((b) => [b.text, summary.nodes[b.id]]));
  ok(byText['Human wrote this first line.'] === 'human' && byText['Agent synthesized this addition.'] === 'agent', 'per-node origins correct');
  console.log(`  composition: ${summary.percent.human}% human / ${summary.percent.agent}% agent / ${summary.percent.unknown}% unknown`);
} finally {
  try { rmSync(TEST_PROFILE_DIR, { recursive: true, force: true }); } catch {}
}

console.log(`\nattribution-integration: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
