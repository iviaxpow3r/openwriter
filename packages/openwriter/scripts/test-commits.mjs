/**
 * Unit tests for the version-commit layer (server/commits.ts).
 *
 * Verifies a commit bundles exactly the attributed _history events since the
 * previous commit, rolls them up per-actor, chains parent->child, and refuses
 * to create empty commits.
 *
 * Run: `node scripts/test-commits.mjs`  (after build)
 */

import { rmSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { setActiveProfile, ensureDataDir, getDataDir } from '../dist/server/helpers.js';
import { captureAttribution } from '../dist/server/attribution.js';
import { commitVersion, listCommits, getCommitDetail, rollupChangeset, summaryLine } from '../dist/server/commits.js';
import { writeSnapshotMarkdown } from '../dist/server/versions.js';

const TEST_PROFILE = `test-commits-${process.pid}`;
const DIR = join(homedir(), '.openwriter', 'profiles', TEST_PROFILE);
setActiveProfile(TEST_PROFILE);
ensureDataDir();

let pass = 0, fail = 0;
function ok(c, m) { if (c) pass++; else { fail++; console.error('  FAIL:', m); } }
const para = (id, text) => ({ position: 0, type: 'paragraph', text, parentPosition: null, id });
const DOC = 'cmt00001';

try {
  // --- pure rollup
  const r = rollupChangeset([
    { ts: 1, docId: DOC, actor: 'agent', seq: 1, versionTs: 0, spans: [
      { nodeId: 'a', sentenceHash: 'h1', op: 'add', actor: 'agent' },
      { nodeId: 'a', sentenceHash: 'h2', op: 'add', actor: 'agent' },
      { nodeId: 'b', sentenceHash: 'h3', op: 'edit', actor: 'human' },
    ] },
  ]);
  ok(r.summary.added === 2 && r.summary.edited === 1, 'rollup counts adds + edits');
  ok(r.summary.byActor.agent.added === 2 && r.summary.byActor.human.edited === 1, 'rollup splits by actor');
  ok(r.actors.includes('agent') && r.actors.includes('human'), 'rollup lists actors');
  ok(summaryLine(r.summary).includes('agent') && summaryLine(r.summary).includes('you'), 'summaryLine renders both actors');

  // --- commit 1: agent writes, then agent-finished commit
  captureAttribution(DOC, [para('n1', 'Agent wrote one. Agent wrote two.')], 'agent', 1000);
  const c1 = commitVersion(DOC, '---\n{"docId":"cmt00001"}\n---\n\nAgent wrote one. Agent wrote two.\n', { trigger: 'agent-finished', actor: 'agent', nowTs: 1100 });
  ok(c1 !== null, 'commit 1 created');
  ok(c1.parent === null && c1.fromTs === 0, 'commit 1 is root (no parent)');
  ok(c1.summary.added === 2 && c1.actors.length === 1 && c1.actors[0] === 'agent', 'commit 1 = 2 agent adds');
  ok(c1.snapshotTs > 0, 'commit 1 pinned a snapshot');

  // --- empty commit refused (nothing new since c1)
  const empty = commitVersion(DOC, 'x', { trigger: 'manual', actor: 'human', nowTs: 1200 });
  ok(empty === null, 'empty commit (no new events) refused');

  // --- commit 2: human edits, then accept commit
  captureAttribution(DOC, [para('n1', 'Agent wrote one. Agent wrote two. Human added three.')], 'human', 2000);
  const c2 = commitVersion(DOC, '---\n{"docId":"cmt00001"}\n---\n\nbody\n', { trigger: 'accept', actor: 'human', nowTs: 2100, note: 'reviewed' });
  ok(c2 !== null, 'commit 2 created');
  ok(c2.parent === c1.ts && c2.fromTs === c1.ts, 'commit 2 chains to commit 1');
  // A new sentence inside an EXISTING node is an 'edit' of that node (computeBlame
  // rule), not an 'add' (which is for brand-new nodes). Either way: only the new
  // human content is counted, c1's agent sentences are NOT re-counted.
  ok(c2.summary.edited === 1 && c2.summary.added === 0 && c2.actors.length === 1 && c2.actors[0] === 'human',
     'commit 2 = only the new human sentence as a human edit (c1 not re-counted)');
  ok(c2.note === 'reviewed' && c2.trigger === 'accept', 'commit 2 carries note + trigger');

  // --- list + detail
  const list = listCommits(DOC);
  ok(list.length === 2, 'two commits listed');
  const detail = getCommitDetail(DOC, c2.ts);
  ok(detail && detail.events.length >= 1 && detail.parentSnapshotTs === c1.snapshotTs, 'detail returns events + parent snapshot ref');

  // --- snapshot dedup: identical content reuses the same snapshot ts (no dup .md)
  const DOC2 = 'cmt00002';
  const tsA = writeSnapshotMarkdown(DOC2, 'same content');
  const tsB = writeSnapshotMarkdown(DOC2, 'same content');
  ok(tsA === tsB, 'snapshot dedup: identical content reuses the same ts');
  const tsC = writeSnapshotMarkdown(DOC2, 'different content');
  ok(tsC !== tsA, 'snapshot dedup: changed content gets a fresh ts');
} finally {
  try { rmSync(DIR, { recursive: true, force: true }); } catch {}
}

console.log(`\ncommits: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
