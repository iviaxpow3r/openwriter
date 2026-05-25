/**
 * Outline + peek primitives for node-level doc navigation.
 *
 * The "orient by content, pick by node" architectural rule lives here.
 *
 * - outline returns the heading skeleton (and optional drill-down into one
 *   section) so an agent can see what a doc IS without reading bodies.
 * - peek returns a windowed slice of nodes (around an anchor, by range, by
 *   position, by explicit IDs) once the agent has a node ID to orient on.
 *
 * Neither tool initiates by node — node IDs are byproducts of content
 * orientation (search hit, outline pick, deep-link click, prior peek).
 */

import type { PadDocument } from './state.js';

interface TipTapNode {
  type: string;
  attrs?: Record<string, any>;
  content?: TipTapNode[];
  text?: string;
}

// ============================================================================
// OUTLINE
// ============================================================================

export interface OutlineOptions {
  /** Restrict the outline to a single section (the named heading's nodeId
   *  and everything beneath it, up to the next same-or-shallower heading). */
  underHeading?: string;
  /** Cap on heading levels shown. 1 = only h1, 2 = h1+h2, etc. Default 3.
   *  Ignored when underHeading is set (drill-down always shows full content). */
  depth?: number;
  /** Pagination — start index into the rendered line array. Default 0. */
  offset?: number;
  /** Pagination — max lines to return. Default 200. */
  limit?: number;
}

/** Render the outline for a doc.
 *
 *  Default behavior: heading tree only (filtered by depth).
 *  underHeading set: full block list inside that section, with one-line
 *    previews per block (~10–15 tokens each).
 *  No headings present: falls back to top-level block previews.
 */
export function outline(doc: PadDocument, opts: OutlineOptions = {}): string {
  const depth = Math.max(1, Math.min(6, opts.depth ?? 3));
  const content = doc.content || [];
  let lines: string[];

  if (opts.underHeading) {
    lines = renderSection(content, opts.underHeading);
  } else {
    const headings = collectHeadings(content, depth);
    // In OpenWriter convention the first h1 IS the doc title (already
    // surfaced by every other read tool — read_pad header, search_docs,
    // browse_docs). Drop it from the outline so we don't waste a line
    // restating what the caller already knows. Subsequent h1s (rare —
    // would be a multi-chapter doc) are kept; they're real structure.
    const filtered = headings.length > 0 && headings[0].level === 1
      ? headings.slice(1)
      : headings;
    if (filtered.length > 0) {
      lines = filtered.map(renderHeading);
    } else if (headings.length === 0) {
      // Doc has no headings — fall back to block previews so the agent
      // still gets a structural read.
      lines = collectTopLevelPreviews(content);
    } else {
      // Doc has ONLY the title h1 (no body headings). Fall back to
      // top-level block previews so the agent has something to navigate.
      lines = collectTopLevelPreviews(content);
    }
  }

  // Pagination — applied to rendered lines so the agent can walk a
  // huge skeleton incrementally without re-fetching the whole thing.
  const offset = Math.max(0, opts.offset ?? 0);
  const limit = Math.max(1, opts.limit ?? 200);
  const total = lines.length;
  const slice = lines.slice(offset, offset + limit);
  const header = opts.underHeading
    ? `outline (section ${opts.underHeading}):`
    : `outline (depth ${depth}):`;
  const footer = total > offset + limit
    ? `\n[showing ${slice.length} of ${total} lines — call again with offset=${offset + limit} for more]`
    : '';
  return `${header}\n${slice.join('\n')}${footer}`;
}

interface HeadingEntry {
  level: number;
  text: string;
  id?: string;
}

function collectHeadings(content: TipTapNode[], maxDepth: number): HeadingEntry[] {
  const out: HeadingEntry[] = [];
  function walk(nodes: TipTapNode[]): void {
    for (const n of nodes) {
      if (n.type === 'heading') {
        const level = n.attrs?.level ?? 1;
        if (level <= maxDepth) {
          out.push({ level, text: extractText(n), id: n.attrs?.id });
        }
      }
      // Headings can only legally appear at top level in OpenWriter docs,
      // but recurse defensively so we don't miss any author-malformed trees.
      if (n.content) walk(n.content);
    }
  }
  walk(content);
  return out;
}

function renderHeading(h: HeadingEntry): string {
  const indent = '  '.repeat(Math.max(0, h.level - 1));
  const idTag = h.id ? `[h${h.level}:${h.id}] ` : `[h${h.level}] `;
  return `${indent}${idTag}${h.text}`;
}

/** Return preview lines for every top-level block in the doc — used when
 *  there are no headings to anchor an outline on. */
function collectTopLevelPreviews(content: TipTapNode[]): string[] {
  return content.map((node) => previewLine(node));
}

/** Walk the doc and return preview lines for every block from the named
 *  heading up to (but not including) the next heading at the same level
 *  or shallower. */
function renderSection(content: TipTapNode[], headingId: string): string[] {
  // Find the heading at top level
  let startIdx = -1;
  let startLevel = 0;
  for (let i = 0; i < content.length; i++) {
    const n = content[i];
    if (n.type === 'heading' && n.attrs?.id === headingId) {
      startIdx = i;
      startLevel = n.attrs?.level ?? 1;
      break;
    }
  }
  if (startIdx === -1) return [`(no heading with id ${headingId} found at top level)`];

  const lines: string[] = [];
  // Include the heading itself first, then walk forward until end-of-section.
  for (let i = startIdx; i < content.length; i++) {
    const n = content[i];
    if (i > startIdx && n.type === 'heading' && (n.attrs?.level ?? 1) <= startLevel) break;
    lines.push(previewLine(n));
  }
  return lines;
}

/** ~10–15 token preview of a top-level block — type tag + nodeId + first
 *  ~80 chars of inner text. Lists collapse to their item-count summary. */
function previewLine(node: TipTapNode): string {
  const id = node.attrs?.id ? `:${node.attrs.id}` : '';
  if (node.type === 'heading') {
    const level = node.attrs?.level ?? 1;
    return `[h${level}${id}] ${extractText(node)}`;
  }
  if (node.type === 'paragraph') {
    const txt = extractText(node);
    return `[p${id}] ${truncate(txt, 80)}`;
  }
  if (node.type === 'bulletList' || node.type === 'orderedList' || node.type === 'taskList') {
    const count = (node.content ?? []).length;
    const shortType = node.type === 'bulletList' ? 'ul' : node.type === 'orderedList' ? 'ol' : 'tl';
    return `[${shortType}${id}] (${count} item${count === 1 ? '' : 's'})`;
  }
  if (node.type === 'blockquote') {
    return `[bq${id}] ${truncate(firstChildText(node), 80)}`;
  }
  if (node.type === 'codeBlock') {
    const lang = node.attrs?.language || '';
    return `[code${id}${lang ? ' ' + lang : ''}] ${truncate(extractText(node), 60)}`;
  }
  if (node.type === 'horizontalRule') {
    return `[hr${id}] ---`;
  }
  if (node.type === 'table') {
    const rows = (node.content ?? []).length;
    return `[table${id}] (${rows} row${rows === 1 ? '' : 's'})`;
  }
  if (node.type === 'image') {
    return `[img${id}] ${node.attrs?.alt || node.attrs?.src || ''}`;
  }
  if (node.type === 'footnoteSection' || node.type === 'footnoteDefinition') {
    return `[${node.type}${id}] ${truncate(firstChildText(node), 60)}`;
  }
  return `[${node.type}${id}]`;
}

function firstChildText(node: TipTapNode): string {
  if (!node.content) return '';
  for (const c of node.content) {
    const t = extractText(c);
    if (t) return t;
  }
  return '';
}

function extractText(node: TipTapNode): string {
  if (node.type === 'text' && typeof node.text === 'string') return node.text;
  if (!node.content) return '';
  return node.content.map(extractText).join('');
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max).trimEnd() + '…';
}

// ============================================================================
// PEEK
// ============================================================================

export type PeekTarget =
  | { node: string }
  | { nodes: string[] }
  | { around: string; before?: number; after?: number }
  | { from: string; to: string }
  | { first: number }
  | { last: number }
  | { position: number; span?: number };

/** Return a windowed slice of TipTap nodes from a doc per the target spec.
 *  The caller renders via compactNodes — this function returns raw nodes
 *  so the rendering pipeline stays uniform with read_pad / get_nodes. */
export function peek(doc: PadDocument, target: PeekTarget): TipTapNode[] {
  const content = doc.content || [];

  if ('node' in target) {
    return findById(content, [target.node]);
  }
  if ('nodes' in target) {
    return findById(content, target.nodes);
  }
  if ('around' in target) {
    const idx = findTopLevelIndex(content, target.around);
    if (idx === -1) return [];
    const before = Math.max(0, target.before ?? 1);
    const after = Math.max(0, target.after ?? 1);
    return content.slice(Math.max(0, idx - before), Math.min(content.length, idx + after + 1));
  }
  if ('from' in target) {
    const a = findTopLevelIndex(content, target.from);
    const b = findTopLevelIndex(content, target.to);
    if (a === -1 || b === -1) return [];
    const [lo, hi] = a <= b ? [a, b] : [b, a];
    return content.slice(lo, hi + 1);
  }
  if ('first' in target) {
    return content.slice(0, Math.max(1, target.first));
  }
  if ('last' in target) {
    const n = Math.max(1, target.last);
    return content.slice(Math.max(0, content.length - n));
  }
  if ('position' in target) {
    const pos = Math.max(0, Math.min(1, target.position));
    const span = Math.max(1, target.span ?? 3);
    const idx = Math.min(content.length - 1, Math.floor(content.length * pos));
    return content.slice(idx, Math.min(content.length, idx + span));
  }
  return [];
}

/** Find every node matching one of the given IDs — full-tree walk to support
 *  IDs on nested blocks (list items, table cells, etc.). Same shape as
 *  state.findNodesByIds but lives here to keep peek-outline self-contained. */
function findById(content: TipTapNode[], ids: string[]): TipTapNode[] {
  const set = new Set(ids);
  const out: TipTapNode[] = [];
  function walk(nodes: TipTapNode[]): void {
    for (const n of nodes) {
      if (n.attrs?.id && set.has(n.attrs.id)) out.push(n);
      if (n.content) walk(n.content);
    }
  }
  walk(content);
  return out;
}

/** Return the top-level doc.content index whose subtree contains nodeId.
 *  Handles nested IDs by walking each top-level subtree. */
function findTopLevelIndex(content: TipTapNode[], id: string): number {
  function contains(node: TipTapNode): boolean {
    if (node.attrs?.id === id) return true;
    if (!node.content) return false;
    for (const c of node.content) if (contains(c)) return true;
    return false;
  }
  for (let i = 0; i < content.length; i++) {
    if (contains(content[i])) return i;
  }
  return -1;
}

// ============================================================================
// SEARCH WITHIN ONE DOC (scoped search_docs)
// ============================================================================

export interface InDocMatch {
  nodeId: string;
  type: string;
  snippet: string;
}

/** Find blocks whose text matches the query inside one doc. Returns up to
 *  `limit` matches with the matched node's ID, type, and a snippet around
 *  the hit. Case-insensitive substring match, same shape as the workspace-
 *  scoped search but scoped to one doc and returning node-level handles.
 *
 *  Only nodes with an addressable `attrs.id` are emitted as matches. The
 *  walker still descends into IDless children (text runs, inline marks) so
 *  block-level matches are found, but it does NOT emit those children as
 *  their own hits — they're already represented by their parent block's
 *  entry, and emitting them duplicates results. */
export function searchInDoc(doc: PadDocument, query: string, limit = 10): InDocMatch[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const out: InDocMatch[] = [];
  function walk(nodes: TipTapNode[]): void {
    if (out.length >= limit) return;
    for (const n of nodes) {
      if (out.length >= limit) return;
      if (n.attrs?.id) {
        const text = extractText(n);
        if (text) {
          const lower = text.toLowerCase();
          const idx = lower.indexOf(q);
          if (idx !== -1) {
            const start = Math.max(0, idx - 30);
            const end = Math.min(text.length, idx + q.length + 50);
            out.push({
              nodeId: n.attrs.id,
              type: n.type,
              snippet: (start > 0 ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : ''),
            });
          }
        }
      }
      if (n.content) walk(n.content);
    }
  }
  walk(doc.content || []);
  return out;
}
