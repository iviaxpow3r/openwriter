/**
 * Pending overlay — the in-memory + sidecar layer that holds proposed
 * changes to a document. The disk `.md` file is canonical only; the
 * overlay is the agent's proposed mutations that the user hasn't
 * accepted or rejected yet.
 *
 * Architectural model:
 *   - Disk = canonical content. Clean markdown. External editors see
 *     what the user sees as "the doc," no pending decoration metadata.
 *   - Overlay = in-memory `Map<docId, PendingEntry[]>` mirrored to a
 *     sidecar JSON at `_pending/{docId}.json` so pending state survives
 *     graceful restarts. Sidecar is keyed by docId because filenames
 *     can change (renames) but docIds are stable.
 *   - Live state = canonical merged with overlay. Browser and MCP see
 *     this merged view — TipTap nodes with `pendingStatus` attrs.
 *
 * Pending entries are keyed by `nodeId` (the stable per-block ID the
 * matcher maintains). This is the load-bearing decision — position
 * keying fails when canonical content shifts (external edit,
 * restore_version), node IDs survive content changes by design.
 *
 * Reload flow:
 *   1. Canonical reloaded from disk.
 *   2. Matcher pairs old in-memory nodes to new canonical nodes via
 *      fingerprint, returning nodeId continuity.
 *   3. Overlay re-applied to new canonical by nodeId. Entries whose
 *      anchor nodeId no longer exists become "orphan" (rewrite→insert,
 *      delete→discarded). Entries whose target node exists but the
 *      content drifted from `originalBaseline` become "staleBaseline"
 *      (surfaced for review).
 *
 * adr: adr/pending-overlay-model.md
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, readdirSync, rmSync } from 'fs';
import { join } from 'path';
import { getDataDir, atomicWriteFileSync } from './helpers.js';

// ============================================================================
// TYPES
// ============================================================================

export type PendingStatus = 'insert' | 'rewrite' | 'delete';

export interface PendingEntry {
  /** Stable per-block ID, set by the matcher. The key under which the
   *  overlay attaches to the canonical doc. For inserts, this is the
   *  nodeId of the inserted node itself (does not exist in canonical). */
  nodeId: string;
  status: PendingStatus;

  // ---- Anchor info (inserts only) ----
  /** The nodeId of the sibling immediately before this insert in
   *  canonical, or null if the insert goes at the start of its parent. */
  afterNodeId?: string | null;
  /** The nodeId of the parent in canonical (listItem, blockquote, etc.),
   *  or null if the insert goes at the document root. */
  parentNodeId?: string | null;

  // ---- Proposed content (inserts and rewrites) ----
  /** The new TipTap node the agent proposed. For inserts this is the
   *  node to add; for rewrites this is what the node becomes. */
  newContent?: any;

  // ---- Stale-baseline detection (rewrites only) ----
  /** Snapshot of the canonical node's content at the time the rewrite
   *  was proposed. On reload, if canonical's current node content
   *  differs from this baseline, the rewrite is `staleBaseline` —
   *  someone else edited the very thing the agent was trying to rewrite. */
  originalBaseline?: any;

  // ---- Sub-paragraph enhance fields ----
  pendingGroupId?: string;
  pendingTextEdits?: any;
  pendingSelectionFrom?: number;
  pendingSelectionTo?: number;
  pendingOriginalFrom?: number;
  pendingOriginalTo?: number;
}

/** Result of applying an overlay to a canonical doc. */
export interface ApplyResult {
  /** Entries whose anchor nodeId no longer exists in canonical. Rewrites
   *  in this list have been auto-converted to inserts (creative content
   *  preserved). Deletes have been discarded. Inserts are still inserts
   *  (their afterNodeId/parentNodeId is gone, so they land at end of
   *  doc or last-known parent). */
  orphans: PendingEntry[];
  /** Rewrite entries whose target node exists but whose content has
   *  drifted from `originalBaseline`. The pending still applies (visible
   *  in the doc with pendingStatus='rewrite') but is flagged via
   *  `pendingStaleBaseline: true` on the node attrs. */
  staleBaseline: PendingEntry[];
}

// ============================================================================
// SIDECAR I/O
// ============================================================================

function getPendingDir(): string { return join(getDataDir(), '_pending'); }

function getSidecarPath(docId: string): string {
  return join(getPendingDir(), `${docId}.json`);
}

function ensurePendingDir(): void {
  const dir = getPendingDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export function loadOverlay(docId: string): PendingEntry[] {
  if (!docId) return [];
  const path = getSidecarPath(docId);
  if (!existsSync(path)) return [];
  try {
    const raw = readFileSync(path, 'utf-8');
    const data = JSON.parse(raw);
    if (Array.isArray(data?.entries)) return data.entries;
    return [];
  } catch { return []; }
}

export function saveOverlay(docId: string, entries: PendingEntry[]): void {
  if (!docId) return;
  if (entries.length === 0) {
    deleteOverlay(docId);
    return;
  }
  ensurePendingDir();
  const path = getSidecarPath(docId);
  atomicWriteFileSync(path, JSON.stringify({ version: 1, entries }, null, 2));
}

export function deleteOverlay(docId: string): void {
  if (!docId) return;
  const path = getSidecarPath(docId);
  if (existsSync(path)) {
    try { unlinkSync(path); } catch { /* best-effort */ }
  }
}

/** Clear every sidecar file. Called on profile switch / clearAllCaches. */
export function clearAllOverlays(): void {
  const dir = getPendingDir();
  if (!existsSync(dir)) return;
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
}

// ============================================================================
// EXTRACT — walk a doc-with-pending-attrs and produce an overlay
// ============================================================================

/**
 * Walk a TipTap doc that has pending attrs on its nodes and extract those
 * attrs into a PendingEntry[] keyed by nodeId. Does NOT mutate the doc.
 *
 * For inserts: captures the previous-sibling nodeId (or null) and the
 * parent nodeId so the entry can be re-anchored on reload even if the
 * doc tree has changed around it.
 *
 * For rewrites: captures the node's `pendingOriginalContent` (if
 * present) as the `originalBaseline` so future reloads can detect
 * baseline drift.
 *
 * Insert-pending nodes are extracted with the `newContent` carrying
 * the node minus the pending attrs (i.e. what to insert).
 */
export function extractOverlay(doc: any): PendingEntry[] {
  const entries: PendingEntry[] = [];

  function walk(nodes: any[], parentNodeId: string | null): void {
    if (!Array.isArray(nodes)) return;
    let prevSiblingId: string | null = null;
    for (const node of nodes) {
      const nodeId: string | undefined = node?.attrs?.id;
      const status: PendingStatus | undefined = node?.attrs?.pendingStatus;

      if (nodeId && status) {
        const entry: PendingEntry = {
          nodeId,
          status,
        };

        if (status === 'insert') {
          entry.afterNodeId = prevSiblingId;
          entry.parentNodeId = parentNodeId;
          // For inserts, the node itself IS the content. Capture it as
          // newContent with pending attrs stripped (the overlay carries
          // them separately).
          entry.newContent = stripPendingAttrs(node);
        } else if (status === 'rewrite') {
          // The node's current content is the agent's proposed prose.
          // pendingOriginalContent (if present) is the snapshot baseline.
          entry.newContent = stripPendingAttrs(node);
          if (node.attrs?.pendingOriginalContent) {
            entry.originalBaseline = node.attrs.pendingOriginalContent;
          }
        }
        // status === 'delete': no newContent, no anchor (node still in canonical)

        // Sub-paragraph enhance fields
        if (node.attrs?.pendingGroupId) entry.pendingGroupId = node.attrs.pendingGroupId;
        if (node.attrs?.pendingTextEdits) entry.pendingTextEdits = node.attrs.pendingTextEdits;
        if (node.attrs?.pendingSelectionFrom != null) entry.pendingSelectionFrom = node.attrs.pendingSelectionFrom;
        if (node.attrs?.pendingSelectionTo != null) entry.pendingSelectionTo = node.attrs.pendingSelectionTo;
        if (node.attrs?.pendingOriginalFrom != null) entry.pendingOriginalFrom = node.attrs.pendingOriginalFrom;
        if (node.attrs?.pendingOriginalTo != null) entry.pendingOriginalTo = node.attrs.pendingOriginalTo;

        entries.push(entry);
      }

      // Track previous sibling for inserts (only at this level; recursion
      // resets prevSiblingId for child arrays).
      if (nodeId) prevSiblingId = nodeId;

      if (node?.content) walk(node.content, nodeId || parentNodeId);
    }
  }

  walk(doc?.content || [], null);
  return entries;
}

const PENDING_ATTR_KEYS = [
  'pendingStatus', 'pendingOriginalContent', 'pendingGroupId',
  'pendingTextEdits', 'pendingSelectionFrom', 'pendingSelectionTo',
  'pendingOriginalFrom', 'pendingOriginalTo', 'pendingOrphan', 'pendingStaleBaseline',
];

function stripPendingAttrs(node: any): any {
  const cloned = JSON.parse(JSON.stringify(node));
  if (cloned.attrs) {
    for (const k of PENDING_ATTR_KEYS) delete cloned.attrs[k];
  }
  if (cloned.content) cloned.content = cloned.content.map((c: any) => stripPendingAttrs(c));
  return cloned;
}

// ============================================================================
// APPLY — merge overlay onto a canonical doc, with orphan + stale-baseline
//          classification
// ============================================================================

/**
 * Mutate `canonical` to layer in the overlay's pending decorations.
 * Returns classification: which entries became orphan (anchor gone) and
 * which became stale-baseline (anchor present but content drifted).
 *
 * Orphan handling:
 *   - `rewrite` orphan → converted to `insert` with `pendingOrphan: true`,
 *     placed at the position of its last-known parent's tail (or end of
 *     doc if parent also gone). The agent's creative content is preserved.
 *   - `insert` orphan → kept as `insert` with `pendingOrphan: true`,
 *     placed via the same fallback positioning.
 *   - `delete` orphan → discarded (the target was already gone, the
 *     delete intent is moot).
 *
 * Stale-baseline detection (rewrites only): compare canonical node's
 * current content to `entry.originalBaseline`. If different, set
 * `pendingStaleBaseline: true` on the merged node.
 */
export function applyOverlay(canonical: any, entries: PendingEntry[]): ApplyResult {
  const orphans: PendingEntry[] = [];
  const staleBaseline: PendingEntry[] = [];

  // Build a nodeId → node map for the canonical doc (read-side lookup).
  const nodeById = new Map<string, any>();
  function indexNodes(nodes: any[]): void {
    if (!Array.isArray(nodes)) return;
    for (const node of nodes) {
      const id = node?.attrs?.id;
      if (id) nodeById.set(id, node);
      if (node?.content) indexNodes(node.content);
    }
  }
  indexNodes(canonical?.content || []);

  // Helper: find the parent array and index for a given nodeId.
  function findNodeWithParent(targetId: string): { parent: any[]; index: number } | null {
    function search(nodes: any[]): { parent: any[]; index: number } | null {
      if (!Array.isArray(nodes)) return null;
      for (let i = 0; i < nodes.length; i++) {
        if (nodes[i]?.attrs?.id === targetId) return { parent: nodes, index: i };
        if (nodes[i]?.content) {
          const r = search(nodes[i].content);
          if (r) return r;
        }
      }
      return null;
    }
    return search(canonical?.content || []);
  }

  // Process deletes and rewrites first (in-place mutations on existing nodes).
  // Then process inserts (which add new nodes that wouldn't affect lookups).
  for (const entry of entries) {
    if (entry.status === 'insert') continue;

    const target = nodeById.get(entry.nodeId);
    if (!target) {
      // Anchor gone. Delete-orphans are discarded. Rewrite-orphans get
      // converted to inserts (handled below).
      if (entry.status === 'delete') {
        // discard silently
      } else {
        orphans.push(entry);
      }
      continue;
    }

    target.attrs = target.attrs || {};
    target.attrs.pendingStatus = entry.status;

    if (entry.status === 'rewrite') {
      // Stale-baseline check: compare canonical content to baseline.
      if (entry.originalBaseline && !sameContent(target, entry.originalBaseline)) {
        target.attrs.pendingStaleBaseline = true;
        staleBaseline.push(entry);
      }
      // Stash original baseline so reject can restore it.
      if (entry.originalBaseline) {
        target.attrs.pendingOriginalContent = entry.originalBaseline;
      } else {
        // No baseline recorded — synthesize from current canonical content
        // (best-effort; reject will restore to "current state").
        target.attrs.pendingOriginalContent = sanitizeNodeForBaseline(target);
      }
      // Replace target's content with the proposed new content.
      if (entry.newContent?.content) {
        target.content = entry.newContent.content;
      }
    }
    // status === 'delete': just the pendingStatus marker; content unchanged.

    // Carry sub-paragraph enhance fields.
    if (entry.pendingGroupId) target.attrs.pendingGroupId = entry.pendingGroupId;
    if (entry.pendingTextEdits) target.attrs.pendingTextEdits = entry.pendingTextEdits;
    if (entry.pendingSelectionFrom != null) target.attrs.pendingSelectionFrom = entry.pendingSelectionFrom;
    if (entry.pendingSelectionTo != null) target.attrs.pendingSelectionTo = entry.pendingSelectionTo;
    if (entry.pendingOriginalFrom != null) target.attrs.pendingOriginalFrom = entry.pendingOriginalFrom;
    if (entry.pendingOriginalTo != null) target.attrs.pendingOriginalTo = entry.pendingOriginalTo;
  }

  // Inserts: find anchor and splice the new node in.
  for (const entry of entries) {
    if (entry.status !== 'insert') continue;
    if (!entry.newContent) continue;

    const newNode = JSON.parse(JSON.stringify(entry.newContent));
    newNode.attrs = newNode.attrs || {};
    newNode.attrs.id = entry.nodeId;
    newNode.attrs.pendingStatus = 'insert';
    if (entry.pendingGroupId) newNode.attrs.pendingGroupId = entry.pendingGroupId;

    // Try anchor: afterNodeId first, then parentNodeId.
    let placed = false;
    if (entry.afterNodeId) {
      const loc = findNodeWithParent(entry.afterNodeId);
      if (loc) {
        loc.parent.splice(loc.index + 1, 0, newNode);
        placed = true;
      }
    }
    if (!placed && entry.parentNodeId) {
      const parentLoc = findNodeWithParent(entry.parentNodeId);
      if (parentLoc) {
        const parent = parentLoc.parent[parentLoc.index];
        parent.content = parent.content || [];
        parent.content.unshift(newNode);
        placed = true;
      }
    }
    if (!placed && entry.afterNodeId === null && entry.parentNodeId === null) {
      // Originally at doc root, no previous sibling — insert at start.
      canonical.content = canonical.content || [];
      canonical.content.unshift(newNode);
      placed = true;
    }

    if (!placed) {
      // Both anchors gone. Mark as orphan and append at end of doc with
      // pendingOrphan: true so the user can see and decide.
      newNode.attrs.pendingOrphan = true;
      canonical.content = canonical.content || [];
      canonical.content.push(newNode);
      orphans.push(entry);
    }
  }

  // Convert rewrite-orphans to orphan-inserts at the end of the doc, with
  // pendingOrphan: true. Preserves the agent's proposed content.
  for (const entry of orphans) {
    if (entry.status === 'rewrite' && entry.newContent) {
      const newNode = JSON.parse(JSON.stringify(entry.newContent));
      newNode.attrs = newNode.attrs || {};
      newNode.attrs.id = entry.nodeId;
      newNode.attrs.pendingStatus = 'insert';
      newNode.attrs.pendingOrphan = true;
      if (entry.pendingGroupId) newNode.attrs.pendingGroupId = entry.pendingGroupId;
      canonical.content = canonical.content || [];
      canonical.content.push(newNode);
    }
  }

  return { orphans, staleBaseline };
}

function sameContent(a: any, b: any): boolean {
  // Cheap structural equality on the relevant subtree. Stringify is
  // fine for sub-paragraph TipTap nodes; they're typically small.
  const aClean = sanitizeNodeForBaseline(a);
  const bClean = sanitizeNodeForBaseline(b);
  return JSON.stringify(aClean) === JSON.stringify(bClean);
}

function sanitizeNodeForBaseline(node: any): any {
  // Strip volatile fields (ids, pending attrs) for content comparison.
  const cloned = JSON.parse(JSON.stringify(node));
  function strip(n: any): void {
    if (n?.attrs) {
      const a = { ...n.attrs };
      delete a.id;
      for (const k of PENDING_ATTR_KEYS) delete a[k];
      n.attrs = a;
    }
    if (n?.content) n.content.forEach(strip);
  }
  strip(cloned);
  return cloned;
}

// ============================================================================
// LEGACY MIGRATION — convert frontmatter `pending` (position-keyed) to
//   overlay format (nodeId-keyed) on first load
// ============================================================================

/**
 * Convert legacy position-keyed pending data (from `meta.pending`) into
 * nodeId-keyed PendingEntry[]. Walks the doc in the same pre-order the
 * legacy serializer used (LEAF_BLOCK_TYPES), reads each leaf block's
 * current nodeId, and pairs it with the legacy pending entry at the
 * same position.
 *
 * This runs once when an old file is loaded; the next save writes
 * canonical-only to disk and the sidecar takes over.
 */
const LEAF_BLOCK_TYPES = new Set(['paragraph', 'heading', 'codeBlock', 'horizontalRule']);

export function migrateLegacyPending(doc: any, legacyPending: Record<string, any>): PendingEntry[] {
  const entries: PendingEntry[] = [];
  let index = 0;

  function walk(nodes: any[], parentId: string | null): void {
    if (!Array.isArray(nodes)) return;
    let prevSiblingId: string | null = null;
    for (const node of nodes) {
      if (LEAF_BLOCK_TYPES.has(node.type)) {
        const legacyEntry = legacyPending[String(index)];
        if (legacyEntry && node.attrs?.id) {
          const entry: PendingEntry = {
            nodeId: node.attrs.id,
            status: legacyEntry.s,
          };
          if (legacyEntry.o) {
            // Legacy stored original as full node — use as originalBaseline.
            entry.originalBaseline = legacyEntry.o;
          }
          if (legacyEntry.g) entry.pendingGroupId = legacyEntry.g;
          if (legacyEntry.sf != null) entry.pendingSelectionFrom = legacyEntry.sf;
          if (legacyEntry.st != null) entry.pendingSelectionTo = legacyEntry.st;
          if (legacyEntry.of != null) entry.pendingOriginalFrom = legacyEntry.of;
          if (legacyEntry.ot != null) entry.pendingOriginalTo = legacyEntry.ot;
          // For rewrites: the legacy doc body already contains the new prose
          // (since the body is post-rewrite). We capture it as newContent.
          if (legacyEntry.s === 'rewrite' || legacyEntry.s === 'insert') {
            entry.newContent = stripPendingAttrs(node);
          }
          if (legacyEntry.s === 'insert') {
            entry.afterNodeId = prevSiblingId;
            entry.parentNodeId = parentId;
          }
          entries.push(entry);
        }
        index++;
      } else if (node.content) {
        walk(node.content, node.attrs?.id || parentId);
      }
      if (node.attrs?.id) prevSiblingId = node.attrs.id;
    }
  }

  walk(doc?.content || [], null);
  return entries;
}
