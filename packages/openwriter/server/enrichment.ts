/**
 * Frontmatter enrichment staleness detection.
 *
 * The matcher already splits every block into sentences and hashes each one on
 * every save (see node-fingerprint.ts). We reuse that machinery here — no new
 * algorithm, no new splitter. Save-time staleness is a small tag-on after the
 * matcher: harvest the current sentence-hash set + char count, compare against
 * the at-enrichment baseline stored in frontmatter, set `enrichmentStale: true`
 * when either threshold trips.
 *
 * Volume ratio captures growth and shrinkage symmetrically. Jaccard distance
 * over the sentence-hash set captures rewrites at constant length. Either
 * tripping flags the doc.
 *
 * OpenWriter owns "is this doc stale". The agent clears the flag via
 * mark_enriched (Phase 4). Both sides read the same field, never compute it
 * independently.
 *
 * See brief: 2026-05-18-frontmatter-enrichment-system.
 */

import { splitSentences, simpleHash, type Block } from './node-fingerprint.js';

/** Volume-ratio threshold above which a doc is flagged stale by size delta. */
export const DEFAULT_ENRICHMENT_VOLUME_THRESHOLD = 1.5;
/** Jaccard-distance threshold above which a doc is flagged stale by drift. */
export const DEFAULT_ENRICHMENT_DRIFT_THRESHOLD = 0.3;

/**
 * Flatten every block's per-sentence hashes into one sorted unique set.
 * Sorted so the on-disk representation is stable across saves (no spurious
 * frontmatter diffs from set-order drift). Unique so duplicate sentences
 * in the same doc don't double-count in the Jaccard math.
 */
export function harvestSentenceHashes(blocks: Block[]): string[] {
  const set = new Set<string>();
  for (const block of blocks) {
    const sentences = splitSentences(block.text || '');
    for (const s of sentences) {
      set.add(simpleHash(s.text + s.terminator));
    }
  }
  return Array.from(set).sort();
}

/** Total char count across all blocks' text — the volume signal. */
export function harvestCharCount(blocks: Block[]): number {
  let n = 0;
  for (const b of blocks) n += (b.text || '').length;
  return n;
}

/**
 * Symmetric size delta. Returns 1 when sizes match, grows toward infinity as
 * they diverge in either direction. Handles zero-size docs safely.
 */
export function volumeRatio(current: number, baseline: number): number {
  if (current === 0 && baseline === 0) return 1;
  if (current === 0 || baseline === 0) return Infinity;
  return Math.max(current, baseline) / Math.min(current, baseline);
}

/**
 * Jaccard distance over two sentence-hash sets. 0 = identical, 1 = disjoint.
 * (union - intersection) / union. Empty-vs-empty returns 0.
 */
export function jaccardDistance(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let intersection = 0;
  for (const x of setA) if (setB.has(x)) intersection++;
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : (union - intersection) / union;
}

/**
 * Compute staleness for a single doc given current matcher-derived signals
 * and the at-enrichment baseline stored in its frontmatter.
 *
 * Returns true when:
 *   - the doc has never been enriched (no lastEnrichedAt) — brief: "absent flag = stale"
 *   - volumeRatio trips its threshold
 *   - Jaccard drift trips its threshold
 *
 * Thresholds: doc-level overrides first, then global defaults. Workspace-level
 * overrides (per the brief) will be layered in when the surfacing handlers
 * (Phase 6) get a workspace pointer — for now the doc carries no workspace
 * reference in writeToDisk's scope.
 */
export function isEnrichmentStale(
  currentSentenceHashes: string[],
  currentCharCount: number,
  metadata: Record<string, any>,
  workspaceOverrides?: { volume?: number; drift?: number },
): boolean {
  // Never enriched → stale by default. New docs land here.
  if (!metadata.lastEnrichedAt) return true;

  const baselineHashes: string[] = Array.isArray(metadata.lastEnrichedSentences)
    ? (metadata.lastEnrichedSentences as string[])
    : [];
  const baselineChars: number = typeof metadata.lastEnrichedCharCount === 'number'
    ? metadata.lastEnrichedCharCount
    : 0;

  const volTh = pickThreshold(
    metadata.enrichmentVolumeThreshold,
    workspaceOverrides?.volume,
    DEFAULT_ENRICHMENT_VOLUME_THRESHOLD,
  );
  const driftTh = pickThreshold(
    metadata.enrichmentDriftThreshold,
    workspaceOverrides?.drift,
    DEFAULT_ENRICHMENT_DRIFT_THRESHOLD,
  );

  if (volumeRatio(currentCharCount, baselineChars) >= volTh) return true;
  if (jaccardDistance(currentSentenceHashes, baselineHashes) >= driftTh) return true;
  return false;
}

function pickThreshold(docLevel: any, wsLevel: number | undefined, fallback: number): number {
  if (typeof docLevel === 'number' && docLevel > 0) return docLevel;
  if (typeof wsLevel === 'number' && wsLevel > 0) return wsLevel;
  return fallback;
}
