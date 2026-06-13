/**
 * Document author-attribution — the capture core.
 *
 * One system, folded from three that already exist (versions + activity log +
 * the node-identity matcher's per-sentence fingerprints). See
 * adr/document-history-attribution.md and chip-notes/author-attribution-design.md.
 *
 * THE LOAD-BEARING DECISION: blame is anchored to `sentenceHash`, never to a
 * nodeId or a matcher mutation label. A sentence's author follows its content
 * hash — the SAME `simpleHash(text + terminator)` the fingerprint/enrichment
 * path already computes every save (see node-fingerprint.ts / enrichment.ts).
 * Because the anchor is content-addressed, attribution survives split, merge,
 * type-change, heavy-rewrite-that-re-mints-an-id, and paste-back without any
 * dependence on node-id lineage:
 *   - a sentence whose hash is unchanged keeps its author (it didn't change);
 *   - a sentence whose hash is new is attributed to the current actor;
 *   - a removed sentence's author is retained in `retired` so paste-back revives it.
 *
 * Tiers (adr invariant 4):
 *   Tier C = .versions/{docId}/{ts}.md   — commit / restore (versions.ts)
 *   Tier B = _history/{docId}.jsonl      — append-only attributed EditEvents
 *   Tier A = _blame/{docId}.json         — materialized current blame (this module)
 *
 * This file holds the PURE core (`computeBlame`, `summarizeBlame`) plus the
 * per-doc sidecar IO. It is intentionally free of any state.ts coupling so it
 * unit-tests in isolation (scripts/test-attribution.mjs).
 */

import { existsSync, mkdirSync, readFileSync, appendFileSync, statSync, renameSync, unlinkSync } from 'fs';
import { join } from 'path';
import { getDataDir, atomicWriteFileSync } from './helpers.js';
import { splitSentences, simpleHash, type Block } from './node-fingerprint.js';

export type Actor = 'human' | 'agent' | 'unknown';

/** Per-sentence blame. firstBy/firstTs = original author; lastBy/lastTs = most recent. */
export interface SentenceBlame {
  firstBy: Actor;
  lastBy: Actor;
  firstTs: number;
  lastTs: number;
}

export interface NodeBlame {
  sentences: Record<string, SentenceBlame>; // keyed by sentenceHash
}

/** Tier A — the materialized current-blame sidecar. */
export interface DocBlame {
  /** Snapshot cut this blame state was frozen at (binds to a version). */
  versionTs: number;
  /** ts of the first attributed save; content older than this reads `unknown`. */
  attributionSince: number;
  /** Monotonic per-doc edit-event counter (survives restart via this field). */
  lastSeq: number;
  nodes: Record<string, NodeBlame>; // keyed by nodeId
  /** Removed sentences kept for paste-back inheritance (bounded). */
  retired: Record<string, SentenceBlame>;
}

/** One change to one sentence — the Tier B replayable unit. */
export interface SpanDelta {
  nodeId: string;
  sentenceHash: string;
  op: 'add' | 'edit' | 'remove';
  actor: Actor;
}

/** Tier B — one attributed edit-event per save (appended to _history/{docId}.jsonl). */
export interface EditEvent {
  ts: number;
  docId: string;
  actor: Actor;
  seq: number;
  /** The snapshot cut this event folds into (cross-reference, not embed). */
  versionTs: number;
  via?: { tool?: string; model?: string };
  spans: SpanDelta[];
}

const RETIRED_CAP = 1000; // bound paste-back memory per doc
// Bound the append-only edit log. At rotation, the live file is rolled to
// `.1` (overwriting any prior `.1`) and a fresh file started — so the log
// never grows past ~2x the cap. Old per-event detail ages out; commit
// SUMMARIES live in the (tiny, never-rotated) commit manifest, so the
// human-readable history survives rotation. Recent detail (the useful part)
// always stays. adr: adr/document-history-attribution.md
const MAX_HISTORY_BYTES = 5 * 1024 * 1024;

function blameDir(): string { return join(getDataDir(), '_blame'); }
function historyDir(): string { return join(getDataDir(), '_history'); }
function blamePath(docId: string): string { return join(blameDir(), `${docId}.json`); }
function historyPath(docId: string): string { return join(historyDir(), `${docId}.jsonl`); }

/** Per-block ordered sentence hashes — the same hashing the fingerprint path uses. */
export function blockSentenceHashes(block: Block): string[] {
  const out: string[] = [];
  for (const s of splitSentences(block.text || '')) {
    out.push(simpleHash(s.text + s.terminator));
  }
  return out;
}

/**
 * PURE: given the prior blame (or null on first save), the current blocks, the
 * acting party, and a timestamp, produce the next blame state + the list of
 * sentence-level changes this save introduced.
 *
 * No IO, no globals — every input is a parameter.
 */
export function computeBlame(
  prev: DocBlame | null,
  blocks: Block[],
  actor: Actor,
  ts: number,
): { blame: DocBlame; spans: SpanDelta[] } {
  // Flat prior author lookup by content hash: live sentences first, then
  // retired (paste-back). Live wins when a hash appears in both.
  const priorByHash = new Map<string, SentenceBlame>();
  if (prev) {
    for (const hash of Object.keys(prev.retired)) priorByHash.set(hash, prev.retired[hash]);
    for (const nodeId of Object.keys(prev.nodes)) {
      const sents = prev.nodes[nodeId].sentences;
      for (const hash of Object.keys(sents)) priorByHash.set(hash, sents[hash]);
    }
  }
  const liveBefore = new Set<string>();
  if (prev) for (const nodeId of Object.keys(prev.nodes)) {
    for (const hash of Object.keys(prev.nodes[nodeId].sentences)) liveBefore.add(hash);
  }

  const nodes: Record<string, NodeBlame> = {};
  const spans: SpanDelta[] = [];
  const currentHashes = new Set<string>();

  for (const block of blocks) {
    const nodeId = block.id;
    if (!nodeId) continue; // post-matcher every real block has an id; guard anyway
    const hashes = blockSentenceHashes(block);
    if (hashes.length === 0) continue; // containers / empty blocks carry no prose
    const nodeExistedBefore = !!(prev && prev.nodes[nodeId]);
    const nodeBlame: NodeBlame = nodes[nodeId] || { sentences: {} };
    for (const hash of hashes) {
      currentHashes.add(hash);
      const prior = priorByHash.get(hash);
      if (prior) {
        // Unchanged content — author unchanged. (Includes paste-back: a hash
        // resurfacing from `retired` inherits its original author, not the paster.)
        nodeBlame.sentences[hash] = { ...prior };
      } else {
        // New content — attributed to the current actor.
        nodeBlame.sentences[hash] = { firstBy: actor, lastBy: actor, firstTs: ts, lastTs: ts };
        spans.push({ nodeId, sentenceHash: hash, op: nodeExistedBefore ? 'edit' : 'add', actor });
      }
    }
    nodes[nodeId] = nodeBlame;
  }

  // Removed = previously-live hashes now absent. Retire them (bounded) so a
  // later paste-back revives the original author.
  const retired: Record<string, SentenceBlame> = {};
  if (prev) for (const hash of Object.keys(prev.retired)) {
    if (!currentHashes.has(hash)) retired[hash] = prev.retired[hash];
  }
  for (const hash of liveBefore) {
    if (!currentHashes.has(hash)) {
      const sb = priorByHash.get(hash);
      if (sb) {
        retired[hash] = sb;
        spans.push({ nodeId: '', sentenceHash: hash, op: 'remove', actor });
      }
    }
  }
  capRetired(retired);

  const seq = (prev?.lastSeq ?? 0) + (spans.length > 0 ? 1 : 0);
  const blame: DocBlame = {
    versionTs: prev?.versionTs ?? 0,
    attributionSince: prev?.attributionSince ?? ts,
    lastSeq: seq,
    nodes,
    retired,
  };
  return { blame, spans };
}

/** Drop oldest retired entries (by lastTs) past the cap. */
function capRetired(retired: Record<string, SentenceBlame>): void {
  const keys = Object.keys(retired);
  if (keys.length <= RETIRED_CAP) return;
  keys.sort((a, b) => retired[a].lastTs - retired[b].lastTs);
  for (const k of keys.slice(0, keys.length - RETIRED_CAP)) delete retired[k];
}

export interface BlameSummary {
  /** char-weighted composition of the current doc */
  chars: { human: number; agent: number; unknown: number };
  percent: { human: number; agent: number; unknown: number };
  /** per-node coarse origin for the heatmap */
  nodes: Record<string, Actor | 'mixed'>;
}

/**
 * PURE rollup for the heatmap + doc-header %. Weighted by character count so a
 * one-line agent heading does not count the same as a 300-word human paragraph.
 */
export function summarizeBlame(blame: DocBlame | null, blocks: Block[]): BlameSummary {
  const chars = { human: 0, agent: 0, unknown: 0 };
  const nodeOrigin: Record<string, Actor | 'mixed'> = {};
  for (const block of blocks) {
    const nodeId = block.id;
    if (!nodeId) continue;
    const sents = splitSentences(block.text || '');
    if (sents.length === 0) continue;
    const nb = blame?.nodes[nodeId];
    let sawHuman = false, sawAgent = false, sawUnknown = false;
    for (const s of sents) {
      const hash = simpleHash(s.text + s.terminator);
      const by: Actor = nb?.sentences[hash]?.lastBy ?? 'unknown';
      const len = s.text.length + s.terminator.length;
      chars[by] += len;
      if (by === 'human') sawHuman = true;
      else if (by === 'agent') sawAgent = true;
      else sawUnknown = true;
    }
    nodeOrigin[nodeId] = sawHuman && sawAgent ? 'mixed'
      : sawAgent ? 'agent' : sawHuman ? 'human' : 'unknown';
  }
  const total = chars.human + chars.agent + chars.unknown || 1;
  return {
    chars,
    percent: {
      human: Math.round((chars.human / total) * 100),
      agent: Math.round((chars.agent / total) * 100),
      unknown: Math.round((chars.unknown / total) * 100),
    },
    nodes: nodeOrigin,
  };
}

// ============================================================================
// SIDECAR IO  (Tier A: _blame/{docId}.json · Tier B: _history/{docId}.jsonl)
// ============================================================================

export function readBlame(docId: string): DocBlame | null {
  if (!docId) return null;
  const path = blamePath(docId);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8'));
    if (parsed && typeof parsed === 'object' && parsed.nodes) return parsed as DocBlame;
  } catch { /* corrupt sidecar — treat as absent, rebuildable from history+versions */ }
  return null;
}

export function writeBlame(docId: string, blame: DocBlame): void {
  if (!docId) return;
  const dir = blameDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  atomicWriteFileSync(blamePath(docId), JSON.stringify(blame));
}

/** Roll the history log to `.1` when it exceeds the cap, then start fresh. */
function rotateHistoryIfNeeded(path: string): void {
  try {
    if (!existsSync(path) || statSync(path).size < MAX_HISTORY_BYTES) return;
    const rolled = `${path}.1`;
    if (existsSync(rolled)) { try { unlinkSync(rolled); } catch { /* best-effort */ } }
    renameSync(path, rolled);
  } catch { /* best-effort — never block a save */ }
}

/** Append one EditEvent to the per-doc history log (Tier B). Best-effort. */
export function appendEditEvent(docId: string, event: EditEvent): void {
  if (!docId || event.spans.length === 0) return;
  try {
    const dir = historyDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const path = historyPath(docId);
    rotateHistoryIfNeeded(path);
    appendFileSync(path, JSON.stringify(event) + '\n');
  } catch { /* history is observational — never block a save */ }
}

/** Read the full per-doc edit history (Tier B), oldest-first. */
export function readHistory(docId: string): EditEvent[] {
  if (!docId) return [];
  const path = historyPath(docId);
  if (!existsSync(path)) return [];
  const out: EditEvent[] = [];
  try {
    for (const line of readFileSync(path, 'utf-8').split('\n')) {
      if (!line) continue;
      try {
        const e = JSON.parse(line);
        if (e && typeof e.ts === 'number' && Array.isArray(e.spans)) out.push(e as EditEvent);
      } catch { /* skip malformed */ }
    }
  } catch { /* ignore */ }
  return out;
}

/**
 * True when two blame states have the same node ids AND the same sentence-hash
 * set per node — i.e. the materialized blame is structurally identical. Used to
 * skip a redundant sidecar rewrite when a save produced no authorship change.
 * (Authors can't differ here: this is only consulted when spans is empty, which
 * means no sentence was added/edited/removed, so per-hash authors are unchanged.)
 */
function sameBlameShape(a: DocBlame, b: DocBlame): boolean {
  const an = Object.keys(a.nodes), bn = Object.keys(b.nodes);
  if (an.length !== bn.length) return false;
  for (const id of an) {
    const bNode = b.nodes[id];
    if (!bNode) return false;
    const ah = Object.keys(a.nodes[id].sentences), bh = Object.keys(bNode.sentences);
    if (ah.length !== bh.length) return false;
    for (const h of ah) if (!bNode.sentences[h]) return false;
  }
  return true;
}

/**
 * The single capture entry point called from writeToDisk(). Reads prior blame,
 * computes the delta, persists Tier A + Tier B. Returns the summary for callers
 * that want to broadcast it. Best-effort: never throws into the save path.
 *
 * `actor` is REQUIRED and save-scoped (adr invariant 3) — there is no default.
 */
export function captureAttribution(
  docId: string,
  blocks: Block[],
  actor: Actor,
  ts: number,
  via?: { tool?: string; model?: string },
): BlameSummary | null {
  if (!docId) return null;
  try {
    const prev = readBlame(docId);
    const { blame, spans } = computeBlame(prev, blocks, actor, ts);
    if (spans.length > 0) {
      appendEditEvent(docId, { ts, docId, actor, seq: blame.lastSeq, versionTs: blame.versionTs, via, spans });
      writeBlame(docId, blame);
    } else if (!prev || !sameBlameShape(prev, blame)) {
      // No authored change this save. Only rewrite the sidecar when the node
      // shape actually shifted (e.g. a matcher id-translation re-keyed nodes
      // with unchanged content) — otherwise the file is byte-identical and the
      // write is pure IO churn. Skips a full _blame rewrite on every keystroke-
      // debounced save that didn't change authorship.
      writeBlame(docId, blame);
    }
    return summarizeBlame(blame, blocks);
  } catch {
    return null;
  }
}

/** Stamp the version cut onto the current blame (called when a snapshot is written). */
export function bindBlameToVersion(docId: string, versionTs: number): void {
  if (!docId || !versionTs) return;
  try {
    const blame = readBlame(docId);
    if (blame && blame.versionTs !== versionTs) {
      blame.versionTs = versionTs;
      writeBlame(docId, blame);
    }
  } catch { /* best-effort */ }
}
