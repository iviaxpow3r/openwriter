/**
 * Barrel re-export for markdown serialization and parsing.
 * All existing imports from './markdown.js' continue to work unchanged.
 *
 * Also exposes `tiptapToMarkdownChecked` — a sync-observed wrapper that
 * verifies the TipTap → markdown → TipTap round-trip preserves document
 * shape. Use this when you want to catch silent drift; the unchecked
 * `tiptapToMarkdown` stays the cheap path for hot loops.
 */

import { tiptapToMarkdown } from './markdown-serialize.js';
import { markdownToTiptap } from './markdown-parse.js';
import {
  shapeOfTiptap,
  compareShapes,
  formatSyncReport,
  type SyncReport,
} from './node-sync-check.js';

export { tiptapToMarkdown, tiptapToBody, nodeText, inlineToMarkdown } from './markdown-serialize.js';
export { markdownToTiptap, markdownToNodes, splitFusedParagraphs } from './markdown-parse.js';
export {
  shapeOfTiptap,
  computeShape,
  compareShapes,
  formatSyncReport,
  type ShapeEntry,
  type SyncReport,
  type ShapeMismatch,
} from './node-sync-check.js';

/**
 * Serialize TipTap to markdown, then re-parse and verify that the round-trip
 * preserved document shape. If the shapes diverge, a node was misapplied —
 * content ended up in the wrong block on save, or the parse interpreted
 * something differently than the serialize emitted.
 *
 * Returns the markdown AND the sync report. Callers decide whether a failed
 * report should block the save (throw) or just log and continue.
 *
 * Cost: one extra parse + two shape computations per save. Acceptable for
 * any user-driven save; consider the unchecked path inside tight loops.
 */
export function tiptapToMarkdownChecked(
  doc: any,
  title: string,
  metadata?: Record<string, any>,
): { markdown: string; syncReport: SyncReport } {
  const markdown = tiptapToMarkdown(doc, title, metadata);
  const expectedShape = shapeOfTiptap(doc);
  const reparsed = markdownToTiptap(markdown);
  const actualShape = shapeOfTiptap(reparsed.document);
  const syncReport = compareShapes(expectedShape, actualShape);
  if (!syncReport.ok) {
    console.error(formatSyncReport(syncReport, `serialize:${title}`));
  }
  return { markdown, syncReport };
}
