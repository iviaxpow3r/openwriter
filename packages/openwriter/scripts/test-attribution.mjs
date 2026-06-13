/**
 * Unit tests for the author-attribution capture core (server/attribution.ts).
 *
 * Verifies the load-bearing decision: blame is anchored to sentenceHash, so it
 * survives node-id changes (split/move), and paste-back inherits the ORIGINAL
 * author rather than the paster. Plus char-weighted rollup + sidecar roundtrip.
 *
 * Run: `node scripts/test-attribution.mjs`  (after `npm run build`)
 */

import { mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import {
  computeBlame, summarizeBlame, blockSentenceHashes,
  captureAttribution, readBlame, readHistory,
} from '../dist/server/attribution.js';
import { setActiveProfile, ensureDataDir, getDataDir } from '../dist/server/helpers.js';

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; } else { fail++; console.error('  FAIL:', msg); } }
function block(id, text, position = 0) { return { position, type: 'paragraph', text, parentPosition: null, id }; }

// ---------------------------------------------------------------------------
// PURE CORE
// ---------------------------------------------------------------------------

// 1. First save — human authors two sentences.
const t0 = 1000;
let r = computeBlame(null, [block('n1', 'Alpha one. Beta two.')], 'human', t0);
const h1 = blockSentenceHashes(block('n1', 'Alpha one. Beta two.'));
ok(Object.keys(r.blame.nodes.n1.sentences).length === 2, 'first save records 2 sentences');
ok(r.spans.length === 2 && r.spans.every(s => s.op === 'add' && s.actor === 'human'), 'first save: 2 human adds');
ok(r.blame.nodes.n1.sentences[h1[0]].firstBy === 'human', 'sentence firstBy=human');
ok(r.blame.attributionSince === t0, 'attributionSince set on first save');

// 2. Agent appends a third sentence to the same node.
let r2 = computeBlame(r.blame, [block('n1', 'Alpha one. Beta two. Gamma three.')], 'agent', 2000);
const h2 = blockSentenceHashes(block('n1', 'Alpha one. Beta two. Gamma three.'));
ok(r2.blame.nodes.n1.sentences[h2[0]].lastBy === 'human', 'unchanged sentence keeps human');
ok(r2.blame.nodes.n1.sentences[h2[2]].lastBy === 'agent', 'new sentence attributed to agent');
ok(r2.spans.length === 1 && r2.spans[0].op === 'edit' && r2.spans[0].actor === 'agent', 'append to existing node = 1 agent edit');

// 3. Human edits sentence 1 (new hash); old hash retires.
const editedText = 'Alpha ONE edited. Beta two. Gamma three.';
let r3 = computeBlame(r2.blame, [block('n1', editedText)], 'human', 3000);
const h3 = blockSentenceHashes(block('n1', editedText));
ok(r3.blame.nodes.n1.sentences[h3[0]].lastBy === 'human', 'edited sentence is human');
ok(!!r3.blame.retired[h2[0]], 'old sentence hash moved to retired');
ok(r3.spans.some(s => s.op === 'remove'), 'edit produced a remove span for the old hash');

// 4. PASTE-BACK durability: re-introduce the retired (original human) sentence,
//    this time during an AGENT save. It must inherit the ORIGINAL author (human),
//    not the paster (agent).
let r4 = computeBlame(r3.blame, [block('n1', 'Alpha one. Beta two. Gamma three.')], 'agent', 4000);
ok(r4.blame.nodes.n1.sentences[h2[0]].firstBy === 'human', 'PASTE-BACK inherits original human author, not paster');
ok(r4.blame.nodes.n1.sentences[h2[0]].lastBy === 'human', 'paste-back lastBy stays human');

// 5. SPLIT/MOVE durability: the same sentences relocate to a DIFFERENT nodeId.
//    Content-addressing means authorship survives the node-id change.
let r5 = computeBlame(r.blame, [block('n9', 'Alpha one.'), block('n10', 'Beta two.')], 'agent', 5000);
const ha = blockSentenceHashes(block('n9', 'Alpha one.'))[0];
ok(r5.blame.nodes.n9.sentences[ha].lastBy === 'human', 'SPLIT/MOVE: sentence keeps human author under a new nodeId');
ok(r5.spans.length === 0, 'pure relocation introduces no new authored spans');

// 6. Char-weighted rollup + mixed node origin.
const mixedBlocks = [block('n1', 'Short. ' + 'word '.repeat(40) + 'agentlong.')];
let rm = computeBlame(null, [block('n1', 'Human short.')], 'human', 100);
rm = computeBlame(rm.blame, [block('n1', 'Human short. ' + 'x'.repeat(200) + ' agenttail.')], 'agent', 200);
const sum = summarizeBlame(rm.blame, [block('n1', 'Human short. ' + 'x'.repeat(200) + ' agenttail.')]);
ok(sum.nodes.n1 === 'mixed', 'node with both authors is mixed');
ok(sum.chars.agent > sum.chars.human, 'char-weighting: long agent sentence outweighs short human one');
ok(sum.percent.human + sum.percent.agent + sum.percent.unknown >= 99, 'percentages sum to ~100');

// 7. unknown default for content with no blame.
const sumUnknown = summarizeBlame(null, [block('nX', 'Legacy sentence.')]);
ok(sumUnknown.nodes.nX === 'unknown', 'no-blame content reads unknown');

// ---------------------------------------------------------------------------
// SIDECAR IO ROUNDTRIP
// ---------------------------------------------------------------------------
const testProfile = 'test-attribution-' + process.pid;
setActiveProfile(testProfile);
ensureDataDir();
const dataDir = getDataDir();
try {
  const docId = 'abc12345';
  const s1 = captureAttribution(docId, [block('n1', 'One sentence here.')], 'human', 10000);
  ok(s1 !== null && s1.percent.human === 100, 'captureAttribution returns 100% human summary');
  ok(existsSync(join(dataDir, '_blame', docId + '.json')), 'Tier A _blame sidecar written');
  ok(existsSync(join(dataDir, '_history', docId + '.jsonl')), 'Tier B _history log written');

  captureAttribution(docId, [block('n1', 'One sentence here. Agent added this.')], 'agent', 11000);
  const reread = readBlame(docId);
  const hh = blockSentenceHashes(block('n1', 'One sentence here. Agent added this.'));
  ok(reread.nodes.n1.sentences[hh[0]].lastBy === 'human', 'roundtrip: first sentence still human');
  ok(reread.nodes.n1.sentences[hh[1]].lastBy === 'agent', 'roundtrip: second sentence agent');
  const hist = readHistory(docId);
  ok(hist.length === 2, 'history has 2 edit-events');
  ok(hist[1].seq === 2 && hist[1].actor === 'agent', 'second event seq=2 actor=agent');
} finally {
  try { rmSync(dataDir, { recursive: true, force: true }); } catch {}
}

console.log(`\nattribution: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
