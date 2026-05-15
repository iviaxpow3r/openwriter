/**
 * Internal-link href format for doc: links.
 *
 * Supported forms:
 *   doc:DOCID                     — whole doc by stable docId (8-char hex)
 *   doc:DOCID#NODEID              — paragraph-level by stable nodeId
 *   doc:DOCID#NODEID?q=quote      — paragraph-level + scroll-to-text fallback
 *   doc:DOCID?q=quote             — whole doc + scroll-to-text
 *   doc:filename.md               — LEGACY: pre-docId-format link, still resolved
 *
 * The resolver tries selectors in order:
 *   1. docId → filename via /api/documents lookup
 *   2. filename → direct WebSocket switch
 *   3. (after switch) nodeId → scroll to that paragraph
 *   4. (after switch) quote → fuzzy search and scroll
 */

export interface ParsedLinkHref {
  /** Stable 8-char hex docId, or null if href is in legacy filename format. */
  docId: string | null;
  /** Filename (legacy form), or null if href uses docId. */
  filename: string | null;
  /** Optional 8-char hex nodeId for paragraph-level scroll. */
  nodeId: string | null;
  /** Optional decoded text snippet for scroll-to-text fallback. */
  quote: string | null;
}

const HEX8 = /^[a-f0-9]{8}$/;

/** Parse a doc: link href into its components. Returns null for non-doc hrefs. */
export function parseLinkHref(href: string): ParsedLinkHref | null {
  if (!href.startsWith('doc:')) return null;
  const body = href.slice(4);

  // Split off query string (?q=quote)
  let target = body;
  let quote: string | null = null;
  const qIdx = body.indexOf('?q=');
  if (qIdx >= 0) {
    target = body.slice(0, qIdx);
    try {
      quote = decodeURIComponent(body.slice(qIdx + 3));
    } catch {
      quote = body.slice(qIdx + 3); // malformed encoding — use raw
    }
  }

  // Split off fragment (#nodeId)
  let nodeId: string | null = null;
  const hashIdx = target.indexOf('#');
  if (hashIdx >= 0) {
    const frag = target.slice(hashIdx + 1);
    nodeId = HEX8.test(frag) ? frag : null;
    target = target.slice(0, hashIdx);
  }

  // Distinguish docId (8 hex chars) from filename (anything else)
  const isDocId = HEX8.test(target);
  return {
    docId: isDocId ? target : null,
    filename: isDocId ? null : target,
    nodeId,
    quote,
  };
}

/** Build a doc: href from components. Pass docId for the new format, filename for legacy. */
export function formatLinkHref(opts: {
  docId?: string;
  filename?: string;
  nodeId?: string;
  quote?: string;
}): string {
  const target = opts.docId || opts.filename;
  if (!target) throw new Error('formatLinkHref: docId or filename required');
  let href = `doc:${target}`;
  if (opts.nodeId) href += `#${opts.nodeId}`;
  if (opts.quote) href += `?q=${encodeURIComponent(opts.quote)}`;
  return href;
}

/** Extract a comparable identifier from a doc: href for "is this already linked?" checks. */
export function linkHrefIdentifier(href: string): string | null {
  const parsed = parseLinkHref(href);
  if (!parsed) return null;
  return parsed.docId || parsed.filename;
}
