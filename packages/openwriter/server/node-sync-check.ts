/**
 * Sync observer — detects when TipTap state and markdown body have drifted
 * out of structural alignment.
 *
 * The two views of a document MUST describe the same shape:
 *   - The TipTap tree (what the editor renders and the agent operates on)
 *   - The markdown body (what gets persisted to disk)
 *
 * If a save/load cycle produces a different shape than it started with,
 * a node has been misapplied — content ended up attached to the wrong
 * block, or a structural element was added/dropped during the round-trip.
 *
 * The shape is a flat ordered list of (type, charCount, sentenceCount)
 * per block. Comparing two shapes by position immediately localizes any
 * drift to the exact block where the round-trip broke.
 *
 * Wire points:
 *   - Save-time: after serialize, re-parse and confirm shape preserved.
 *   - Load-time: after parse, compare body shape to TipTap-tree shape.
 *
 * Output is logged (not thrown) so saves and loads still complete; the
 * report tells the consumer / operator exactly where to look.
 *
 * adr: adr/node-identity-matcher.md
 */

import type { Block } from './node-fingerprint.js';
import { splitSentences } from './node-fingerprint.js';
import { tiptapToBlocks } from './node-blocks.js';

export interface ShapeEntry {
  type: string;
  charCount: number;
  sentenceCount: number;
}

export interface ShapeMismatch {
  position: number;
  expected: ShapeEntry | null;
  actual: ShapeEntry | null;
  reason: string;
}

export interface SyncReport {
  ok: boolean;
  expectedLength: number;
  actualLength: number;
  mismatches: ShapeMismatch[];
}

/** Reduce a block list to its structural signature. */
export function computeShape(blocks: Block[]): ShapeEntry[] {
  return blocks.map((b) => ({
    type: b.type,
    charCount: (b.text || '').length,
    sentenceCount: splitSentences(b.text || '').length,
  }));
}

/** Compute the shape signature of a TipTap document. */
export function shapeOfTiptap(doc: { content?: any[] }): ShapeEntry[] {
  return computeShape(tiptapToBlocks(doc));
}

/**
 * Compare two shapes. Returns ok=true if every position aligns.
 * mismatches[] lists every position where the shapes disagree — the first
 * entry is typically the root cause; the rest are downstream consequences.
 */
export function compareShapes(expected: ShapeEntry[], actual: ShapeEntry[]): SyncReport {
  const mismatches: ShapeMismatch[] = [];
  const maxLen = Math.max(expected.length, actual.length);

  for (let i = 0; i < maxLen; i++) {
    const e = expected[i] ?? null;
    const a = actual[i] ?? null;
    if (!e || !a) {
      mismatches.push({
        position: i,
        expected: e,
        actual: a,
        reason: !e ? 'extra block in actual' : 'missing block in actual',
      });
      continue;
    }
    if (e.type !== a.type) {
      mismatches.push({
        position: i,
        expected: e,
        actual: a,
        reason: `type mismatch: expected ${e.type}, got ${a.type}`,
      });
    } else if (e.charCount !== a.charCount) {
      mismatches.push({
        position: i,
        expected: e,
        actual: a,
        reason: `charCount mismatch: expected ${e.charCount}, got ${a.charCount}`,
      });
    } else if (e.sentenceCount !== a.sentenceCount) {
      mismatches.push({
        position: i,
        expected: e,
        actual: a,
        reason: `sentenceCount mismatch: expected ${e.sentenceCount}, got ${a.sentenceCount}`,
      });
    }
  }

  return {
    ok: mismatches.length === 0,
    expectedLength: expected.length,
    actualLength: actual.length,
    mismatches,
  };
}

/**
 * Format a sync report for human-readable logging. Returns a multi-line string
 * pointing at the first mismatch and counting any cascade.
 */
export function formatSyncReport(report: SyncReport, context: string): string {
  if (report.ok) return `[sync-check ${context}] OK (${report.expectedLength} blocks aligned)`;
  const first = report.mismatches[0];
  const lines = [
    `[sync-check ${context}] FAIL: ${report.mismatches.length} mismatch(es) across ${report.expectedLength}/${report.actualLength} blocks`,
    `  first mismatch at position ${first.position}: ${first.reason}`,
    `    expected: ${first.expected ? JSON.stringify(first.expected) : 'none'}`,
    `    actual:   ${first.actual ? JSON.stringify(first.actual) : 'none'}`,
  ];
  if (report.mismatches.length > 1) {
    lines.push(`  (${report.mismatches.length - 1} more mismatch(es) — likely cascade from first)`);
  }
  return lines.join('\n');
}
