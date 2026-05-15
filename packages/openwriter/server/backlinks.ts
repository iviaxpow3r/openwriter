/**
 * Backlinks engine: keeps each doc's frontmatter `backlinks` field in sync
 * with the forward links pointing at it from other docs.
 *
 * Design:
 *   - Forward links in prose = source of truth (link mark with `doc:` href).
 *   - Backlinks frontmatter = derived projection, eventually consistent.
 *   - Incremental on save: when a doc's forward links change, only the
 *     affected target docs get their backlinks refreshed.
 *   - Full rebuild via /api/rebuild-backlinks (idempotent rescue path).
 *
 * Frontmatter schema (lean — anchor text + refs only, no snippet/context):
 *   backlinks:
 *     - text: "the territorial imperative"
 *       from_doc: a3f2c1d4         # source docId
 *       from_node: f6c3830d        # source nodeId where link mark lives
 *       to_node: 1a2b3c4d          # optional: target nodeId being linked to
 */

import { readFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import matter from 'gray-matter';
import { getDataDir, atomicWriteFileSync, resolveDocPath, isExternalDoc } from './helpers.js';
import { filenameByDocId } from './documents.js';
import { markdownToTiptap } from './markdown-parse.js';

const HEX8 = /^[a-f0-9]{8}$/;
const ANCHOR_TEXT_MAX = 80; // truncate long anchor text in backlinks frontmatter

export interface ForwardLink {
  text: string;           // anchor text (truncated)
  from_doc: string;       // source docId
  from_node: string;      // source nodeId (the block containing the link mark)
  to_doc: string;         // target docId
  to_node?: string;       // target nodeId (optional, only when href is doc:DOCID#NODEID)
}

export interface Backlink {
  text: string;
  from_doc: string;
  from_node: string;
  to_node?: string;
}

/** Parse the post-`doc:` portion of an href into {docId, nodeId}. Mirrors src/editor/link-href.ts. */
function parseDocHref(href: string): { docId: string | null; nodeId: string | null } {
  if (!href.startsWith('doc:')) return { docId: null, nodeId: null };
  let body = href.slice(4);
  // Strip query string (?q=...) — only needed for client-side scroll
  const qIdx = body.indexOf('?q=');
  if (qIdx >= 0) body = body.slice(0, qIdx);
  // Split fragment
  let target = body, nodeId: string | null = null;
  const hashIdx = body.indexOf('#');
  if (hashIdx >= 0) {
    const frag = body.slice(hashIdx + 1);
    nodeId = HEX8.test(frag) ? frag : null;
    target = body.slice(0, hashIdx);
  }
  return {
    docId: HEX8.test(target) ? target : null,
    nodeId,
  };
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + '…';
}

/**
 * Walk a TipTap doc, return every `doc:` link found.
 * Each entry includes the enclosing block's nodeId (from_node) and the
 * anchor text (the text wrapped by the link mark).
 */
export function extractForwardLinks(doc: any, sourceDocId: string): ForwardLink[] {
  const links: ForwardLink[] = [];

  function walkBlock(block: any): void {
    if (!block) return;
    const blockId: string | undefined = block.attrs?.id;
    if (Array.isArray(block.content)) {
      // Inline pass: collect contiguous text runs with same link mark
      // (a mark may span multiple text nodes if other marks toggle inside)
      let currentHref: string | null = null;
      let currentText: string[] = [];
      const flush = () => {
        if (currentHref && currentText.length > 0 && blockId) {
          const parsed = parseDocHref(currentHref);
          if (parsed.docId) {
            links.push({
              text: truncate(currentText.join(''), ANCHOR_TEXT_MAX),
              from_doc: sourceDocId,
              from_node: blockId,
              to_doc: parsed.docId,
              ...(parsed.nodeId ? { to_node: parsed.nodeId } : {}),
            });
          }
        }
        currentText = [];
      };

      for (const child of block.content) {
        if (child.type === 'text') {
          const linkMark = (child.marks || []).find((m: any) => m.type === 'link');
          const href: string | null = linkMark?.attrs?.href || null;
          if (href !== currentHref) {
            flush();
            currentHref = href;
          }
          if (href && child.text) currentText.push(child.text);
        } else {
          flush();
          currentHref = null;
          // Recurse into nested block-level content (e.g., listItem -> paragraph)
          walkBlock(child);
        }
      }
      flush();

      // Also recurse for blocks whose content is sub-blocks (list, blockquote)
      for (const child of block.content) {
        if (child.type && child.type !== 'text' && Array.isArray(child.content)) {
          // Already handled above via flush() recursion guard — skip duplicate
          // (We need to recurse into blocks that contain block-level content,
          //  but not the text children we already iterated.)
        }
      }
    }
  }

  if (doc?.content) {
    for (const node of doc.content) walkBlock(node);
  }
  return links;
}

/**
 * Read a doc's frontmatter from disk and parse it.
 * Returns null if the file doesn't exist or can't be parsed.
 */
function readFrontmatter(filename: string): { data: Record<string, any>; content: string; rawMatter: string } | null {
  try {
    const filePath = resolveDocPath(filename);
    if (!existsSync(filePath)) return null;
    const raw = readFileSync(filePath, 'utf-8');
    const parsed = matter(raw);
    return { data: parsed.data, content: parsed.content, rawMatter: parsed.matter };
  } catch {
    return null;
  }
}

/**
 * Write a doc's file with updated frontmatter (preserves body verbatim).
 * Only touches the frontmatter — does NOT re-serialize the body, which would
 * lose nodeIds and reformat. This is safe to call on non-active docs.
 */
function writeFrontmatter(filename: string, newData: Record<string, any>): void {
  const filePath = resolveDocPath(filename);
  const raw = readFileSync(filePath, 'utf-8');
  const parsed = matter(raw);

  // Clean up: drop null/undefined fields
  for (const key of Object.keys(newData)) {
    if (newData[key] === undefined || newData[key] === null) delete newData[key];
    else if (Array.isArray(newData[key]) && newData[key].length === 0) delete newData[key];
  }

  // Match the project convention: JSON-encoded YAML frontmatter
  const newFrontmatter = `---\n${JSON.stringify(newData)}\n---\n\n${parsed.content.trimStart()}`;
  // Avoid no-op writes
  if (newFrontmatter === raw) return;
  atomicWriteFileSync(filePath, newFrontmatter);
}

/** Convert ForwardLinks targeting a given doc into Backlink entries for its frontmatter. */
function toBacklinks(targetDocId: string, allLinks: ForwardLink[]): Backlink[] {
  return allLinks
    .filter((l) => l.to_doc === targetDocId)
    .map((l) => {
      const entry: Backlink = {
        text: l.text,
        from_doc: l.from_doc,
        from_node: l.from_node,
      };
      if (l.to_node) entry.to_node = l.to_node;
      return entry;
    });
}

/**
 * Incremental update: source doc's forward links changed from oldLinks to newLinks.
 * Update each affected target doc's backlinks frontmatter.
 *
 * If `currentDocMetadata` is provided, it's the live in-memory metadata for the
 * source doc (the active doc). The caller is responsible for persisting it.
 * For OTHER target docs we touch their files directly.
 */
export function updateBacklinksForSource(
  sourceDocId: string,
  newLinks: ForwardLink[],
  oldLinks: ForwardLink[],
): { touched: string[] } {
  const oldTargets = new Set(oldLinks.map((l) => l.to_doc));
  const newTargets = new Set(newLinks.map((l) => l.to_doc));
  const affected = new Set<string>([...oldTargets, ...newTargets]);
  const touched: string[] = [];

  for (const targetDocId of affected) {
    if (targetDocId === sourceDocId) continue; // Skip self-links (rare; if any, handled by caller)

    const targetFilename = filenameByDocId(targetDocId);
    if (!targetFilename) {
      // Target doc not found anywhere — broken link, source-side surface added in a follow-up
      continue;
    }

    const fm = readFrontmatter(targetFilename);
    if (!fm) continue;

    // Pull all existing backlinks, drop ones from this source, then add new
    const existing: Backlink[] = Array.isArray(fm.data.backlinks) ? fm.data.backlinks : [];
    const kept = existing.filter((b) => b.from_doc !== sourceDocId);
    const fromThisSource: Backlink[] = newLinks
      .filter((l) => l.to_doc === targetDocId)
      .map((l) => {
        const entry: Backlink = {
          text: l.text,
          from_doc: l.from_doc,
          from_node: l.from_node,
        };
        if (l.to_node) entry.to_node = l.to_node;
        return entry;
      });

    const updated = [...kept, ...fromThisSource];

    // Stable ordering for diff-friendliness: by from_doc, from_node
    updated.sort((a, b) => {
      if (a.from_doc !== b.from_doc) return a.from_doc < b.from_doc ? -1 : 1;
      return a.from_node < b.from_node ? -1 : 1;
    });

    const newData = { ...fm.data };
    if (updated.length > 0) newData.backlinks = updated;
    else delete newData.backlinks;

    try {
      writeFrontmatter(targetFilename, newData);
      touched.push(targetDocId);
    } catch {
      // Best-effort — skip on error
    }
  }

  return { touched };
}

/**
 * Read all docs in the data dir, return their parsed frontmatter + tiptap doc.
 * Used by full rebuild.
 */
function loadAllDocsForRebuild(): Array<{ docId: string; filename: string; doc: any }> {
  const out: Array<{ docId: string; filename: string; doc: any }> = [];
  let files: string[] = [];
  try {
    files = readdirSync(getDataDir()).filter((f) => f.endsWith('.md'));
  } catch {
    return out;
  }
  for (const f of files) {
    try {
      const raw = readFileSync(join(getDataDir(), f), 'utf-8');
      const parsed = markdownToTiptap(raw);
      const docId = parsed.metadata?.docId;
      if (!docId) continue;
      out.push({ docId, filename: f, doc: parsed.document });
    } catch {
      // skip unreadable
    }
  }
  return out;
}

/**
 * Full rebuild: scan all docs, compute backlinks for each from scratch,
 * write updated frontmatter to docs whose backlinks changed.
 * Idempotent. Run via /api/rebuild-backlinks.
 */
export function rebuildAllBacklinks(): { scanned: number; updated: number } {
  const allDocs = loadAllDocsForRebuild();
  // Collect every forward link in the workspace
  const allLinks: ForwardLink[] = [];
  for (const d of allDocs) {
    allLinks.push(...extractForwardLinks(d.doc, d.docId));
  }

  // For each doc, compute its inbound = backlinks, write if changed
  let updated = 0;
  for (const d of allDocs) {
    const newBacklinks = toBacklinks(d.docId, allLinks);
    newBacklinks.sort((a, b) => {
      if (a.from_doc !== b.from_doc) return a.from_doc < b.from_doc ? -1 : 1;
      return a.from_node < b.from_node ? -1 : 1;
    });

    const fm = readFrontmatter(d.filename);
    if (!fm) continue;

    const existing: Backlink[] = Array.isArray(fm.data.backlinks) ? fm.data.backlinks : [];
    if (JSON.stringify(existing) === JSON.stringify(newBacklinks)) continue;

    const newData = { ...fm.data };
    if (newBacklinks.length > 0) newData.backlinks = newBacklinks;
    else delete newData.backlinks;

    try {
      writeFrontmatter(d.filename, newData);
      updated++;
    } catch {
      // skip
    }
  }
  return { scanned: allDocs.length, updated };
}

/**
 * Read previously-saved markdown from disk for a given source filename
 * and extract its forward links. Used by the save hook to compute the
 * "old" link set before the new write lands.
 */
export function extractForwardLinksFromDisk(filename: string, sourceDocId: string): ForwardLink[] {
  try {
    const filePath = resolveDocPath(filename);
    if (isExternalDoc(filename) || !existsSync(filePath)) return [];
    const raw = readFileSync(filePath, 'utf-8');
    const parsed = markdownToTiptap(raw);
    return extractForwardLinks(parsed.document, sourceDocId);
  } catch {
    return [];
  }
}
