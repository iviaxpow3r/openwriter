/**
 * Connections engine (v0.20.0): doc-to-doc connections are structural data,
 * stored as `references: [docId, ...]` arrays in each source's frontmatter.
 * The inbound list on any target is computed live as the inverse of every
 * doc's references — there is no stored derived field on disk.
 *
 * Design:
 *   - `references:` in frontmatter = source of truth (this doc connects to these).
 *   - Backlinks = computed live (scan all docs' references, return those listing
 *     us). Cached in memory for query-time speed; invalidated on any references
 *     write.
 *   - Legacy `doc:` prose links in body keep rendering (TipTap PadLink) AND
 *     auto-populate `references` on save — backward compat.
 *   - Legacy stored `backlinks:` frontmatter field is dropped on any save
 *     (lazy migration). One-off `rebuildAllReferences()` does the bulk migrate.
 *
 * The pre-v0.20 incremental backlinks pipeline (updateBacklinksForSource) is
 * gone — it had a race that meant on-save updates didn't fire reliably (the
 * test session that motivated this refactor caught it). Computing live
 * removes the entire class of incremental-update bugs.
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

/**
 * Backlink: one inbound connection from a source doc that references this one.
 * v0.20.0 dropped the node-level granularity (from_node, to_node) and the
 * anchor `text` — connections are doc-to-doc, not paragraph-to-paragraph.
 * Legacy stored backlinks may include those fields when reading old frontmatter
 * during migration; they're ignored.
 */
export interface Backlink {
  from_doc: string;
  /** @deprecated v0.20 — kept optional only for migration reads. */
  text?: string;
  /** @deprecated v0.20 — kept optional only for migration reads. */
  from_node?: string;
  /** @deprecated v0.20 — kept optional only for migration reads. */
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
export function readFrontmatter(filename: string): { data: Record<string, any>; content: string; rawMatter: string } | null {
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
export function writeFrontmatter(filename: string, newData: Record<string, any>): void {
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

// ============================================================================
// COMPUTE-LIVE BACKLINKS — the new v0.20 surface
// ============================================================================
//
// `computeBacklinksFor(targetDocId)` returns every doc that lists targetDocId
// in its `references:` frontmatter array. Cached in an inverse-index map keyed
// by target docId. Any write that touches a source's references calls
// `invalidateBacklinksCache(sourceDocId)` to wipe affected entries; the next
// read rebuilds them lazily.

/** Inverse index: target docId → Set of source docIds that reference it. */
let backlinksCache: Map<string, Set<string>> | null = null;

/** Build (or rebuild) the entire inverse index by scanning every .md in the
 *  data dir. Runs O(N) over the corpus; called once on first read after an
 *  invalidation. Personal corpora ≤ a few hundred docs make this trivial. */
function buildBacklinksCache(): Map<string, Set<string>> {
  const cache = new Map<string, Set<string>>();
  let files: string[] = [];
  try {
    files = readdirSync(getDataDir()).filter((f) => f.endsWith('.md'));
  } catch {
    return cache;
  }
  for (const f of files) {
    try {
      const raw = readFileSync(join(getDataDir(), f), 'utf-8');
      const parsed = matter(raw);
      const sourceDocId = parsed.data?.docId;
      if (!sourceDocId || typeof sourceDocId !== 'string') continue;
      const refs = parsed.data?.references;
      if (!Array.isArray(refs)) continue;
      for (const targetDocId of refs) {
        if (typeof targetDocId !== 'string') continue;
        if (!cache.has(targetDocId)) cache.set(targetDocId, new Set());
        cache.get(targetDocId)!.add(sourceDocId);
      }
    } catch {
      // skip unreadable
    }
  }
  return cache;
}

/** Drop the in-memory cache. Next read rebuilds from disk. Called from
 *  state.ts:writeToDisk after a save that may have changed references. */
export function invalidateBacklinksCache(): void {
  backlinksCache = null;
}

/**
 * Return every source doc that references targetDocId. Pure read; the
 * frontmatter `references:` arrays across the workspace are the only data
 * consulted. Cached in memory.
 */
export function computeBacklinksFor(targetDocId: string): Backlink[] {
  if (!backlinksCache) backlinksCache = buildBacklinksCache();
  const sources = backlinksCache.get(targetDocId);
  if (!sources) return [];
  return Array.from(sources)
    .sort()
    .map((from_doc) => ({ from_doc }));
}

// ============================================================================
// PROSE-LINK AUTO-SYNC — backward compat for legacy [text](doc:id) prose links
// ============================================================================

/**
 * Scan a TipTap doc for prose `doc:` links and merge their target docIds
 * into the source's `references:` frontmatter. Idempotent — only writes
 * when there are new docIds to add.
 *
 * Called from state.ts:writeToDisk after the markdown body is persisted, so
 * existing prose links (which still render as click-through internal links
 * via the PadLink TipTap extension) automatically appear in `references:`
 * for graph/crawl/backlinks-panel consumption.
 */
export function syncReferencesFromProse(
  sourceDocId: string,
  sourceDoc: any,
  currentMetadata: Record<string, any>,
): { added: string[]; newReferences: string[] } | null {
  const links = extractForwardLinks(sourceDoc, sourceDocId);
  if (links.length === 0) return null;
  const proseTargets = new Set<string>();
  for (const l of links) proseTargets.add(l.to_doc);
  const existing: string[] = Array.isArray(currentMetadata.references) ? currentMetadata.references : [];
  const merged = new Set<string>(existing);
  const added: string[] = [];
  for (const t of proseTargets) {
    if (!merged.has(t)) {
      merged.add(t);
      added.push(t);
    }
  }
  if (added.length === 0) return null;
  return { added, newReferences: Array.from(merged) };
}

// ============================================================================
// MIGRATION — bulk backfill from prose links + strip stored backlinks
// ============================================================================

/**
 * Read all docs in the data dir, return their parsed frontmatter + tiptap doc.
 * Used by the migration rebuild.
 */
function loadAllDocsForRebuild(): Array<{ docId: string; filename: string; doc: any; metadata: Record<string, any> }> {
  const out: Array<{ docId: string; filename: string; doc: any; metadata: Record<string, any> }> = [];
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
      out.push({ docId, filename: f, doc: parsed.document, metadata: parsed.metadata });
    } catch {
      // skip unreadable
    }
  }
  return out;
}

/**
 * Full rescan: for every doc, extract prose `doc:` links from body and merge
 * their targets into `references:` frontmatter. Also strip any legacy
 * `backlinks:` field. Idempotent — re-running produces no changes if the
 * corpus is already migrated.
 *
 * Replaces the v0.19 `rebuildAllBacklinks` which built the (now-removed)
 * derived backlinks projection. The new rescue path is `/api/rebuild-references`
 * (with `/api/rebuild-backlinks` kept as a 308 redirect for one release cycle).
 */
export function rebuildAllReferences(): { scanned: number; updated: number } {
  const allDocs = loadAllDocsForRebuild();
  let updated = 0;

  for (const d of allDocs) {
    const fm = readFrontmatter(d.filename);
    if (!fm) continue;

    // Extract prose links → docIds
    const proseLinks = extractForwardLinks(d.doc, d.docId);
    const proseTargets = new Set(proseLinks.map((l) => l.to_doc));

    // Merge with existing references (dedup)
    const existing: string[] = Array.isArray(fm.data.references) ? fm.data.references : [];
    const merged = Array.from(new Set([...existing, ...proseTargets])).sort();

    // Decide whether anything changed
    const referencesChanged = JSON.stringify(existing.slice().sort()) !== JSON.stringify(merged);
    const hadLegacyBacklinks = 'backlinks' in fm.data;
    if (!referencesChanged && !hadLegacyBacklinks) continue;

    const newData = { ...fm.data };
    if (merged.length > 0) newData.references = merged;
    else delete newData.references;
    delete newData.backlinks; // lazy migration

    try {
      writeFrontmatter(d.filename, newData);
      updated++;
    } catch {
      // skip
    }
  }

  invalidateBacklinksCache();
  return { scanned: allDocs.length, updated };
}

/**
 * @deprecated v0.20 — kept as a no-op shim so any caller imports still work.
 * The incremental backlinks pipeline is gone; backlinks compute live. State's
 * writeToDisk no longer calls this.
 */
export function updateBacklinksForSource(): { touched: string[] } {
  return { touched: [] };
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
