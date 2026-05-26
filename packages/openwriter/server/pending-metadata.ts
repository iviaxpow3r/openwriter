/**
 * Pending metadata — sibling of pending-overlay.ts for frontmatter-level
 * staging. Where the overlay holds proposed BLOCK changes (insert / rewrite
 * / delete on TipTap nodes), this module holds proposed METADATA changes —
 * for now just the document title.
 *
 * Architectural model:
 *   - Pending metadata lives in the SAME sidecar file as the block overlay
 *     (_pending/{docId}.json), under a top-level `metadata:` key. The
 *     pending-overlay module owns the `entries:` key; this module owns the
 *     `metadata:` key. Each preserves the other's slot when it writes.
 *   - The canonical disk .md file's frontmatter is NEVER modified by a
 *     pending stage — the title only changes on disk after the user accepts.
 *     Reject discards the proposal; nothing on disk moves.
 *   - The active document's pending metadata is mirrored into state.ts as
 *     `state.pendingMetadata` so WS broadcasts and getters expose it without
 *     a disk read on every poll.
 *
 * Why a separate module from pending-overlay.ts:
 *   - The overlay model is keyed by nodeId and assumes a TipTap tree. Title
 *     is not in the tree — it's a YAML frontmatter field. Forcing it into a
 *     fake "node" would corrupt the overlay invariants (nodeId stability,
 *     splitMergedDoc tree-walk, applyOverlayPure idempotency).
 *   - Future metadata-staging (tags, status, custom frontmatter fields) lands
 *     here without further churn to the overlay code path.
 *
 * Scope (phase 1): document title only. tag_doc / untag_doc / set_metadata
 * for non-title fields / mark_enriched still write hot. Workspace and
 * container renames also still write hot — they live in workspace manifests,
 * not per-doc sidecars, and need a separate decision.
 *
 * adr: adr/pending-overlay-model.md
 */

import { readSidecarRaw, writeSidecarRaw, type PendingEntry } from './pending-overlay.js';
import { logger } from './logger.js';

// ============================================================================
// TYPES
// ============================================================================

export interface PendingTitle {
  /** The canonical (current on-disk) title at the moment the proposal was staged. */
  from: string;
  /** The proposed title the agent wants. */
  to: string;
  /** Server doc-version when staged, for telemetry / future concurrency work. */
  addedAtVersion: number;
}

export interface PendingMetadata {
  title?: PendingTitle;
}

// ============================================================================
// SIDECAR I/O
// ============================================================================

/** Read the pending-metadata slot from the per-doc sidecar. Returns null if
 *  the sidecar is missing or has no metadata slot. */
export function loadPendingMetadata(docId: string): PendingMetadata | null {
  if (!docId) return null;
  const raw = readSidecarRaw(docId);
  if (!raw?.metadata || Object.keys(raw.metadata).length === 0) return null;
  return raw.metadata as PendingMetadata;
}

/** Persist the pending-metadata slot. Preserves the sidecar's existing
 *  `entries:` slot. Passing null (or an empty object) clears the metadata
 *  and may delete the sidecar entirely if entries are also empty. */
export function savePendingMetadata(docId: string, meta: PendingMetadata | null): void {
  if (!docId) return;
  const raw = readSidecarRaw(docId);
  const entries: PendingEntry[] = Array.isArray(raw?.entries) ? raw.entries : [];
  const cleaned = meta && Object.keys(meta).length > 0 ? meta : null;
  writeSidecarRaw(docId, { entries, metadata: cleaned || undefined });
  if (cleaned?.title) {
    logger.info('overlay', 'meta-stage', `docId=${docId} field=title from="${cleaned.title.from}" to="${cleaned.title.to}"`);
  } else {
    logger.info('overlay', 'meta-clear', `docId=${docId}`);
  }
}
