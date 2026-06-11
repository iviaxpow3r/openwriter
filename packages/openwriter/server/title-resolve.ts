/**
 * Listing-time title resolution for documents that haven't been opened yet.
 *
 * Markdown files dropped into the profile directory externally (no
 * frontmatter) used to render as "Untitled" in the sidebar and in MCP
 * list_documents until first opened — opening injects the frontmatter title
 * that listing relied on exclusively. This module fixes the class: title
 * resolution at read time falls back through
 *
 *   frontmatter title → workspace JSON entry title → first h1 in body → filename stem
 *
 * This is deliberately fallback-only — no lazy frontmatter injection on the
 * listing path. Listing is a read; writing to every titleless file on index
 * would mutate user-dropped files behind their back (surprising for git and
 * external editors, and racy against an editor mid-write). Frontmatter is
 * still injected on first open/save, exactly as before — at which point the
 * resolved title is what gets persisted.
 */

import { readFileSync, readdirSync } from 'fs';
import { join, basename } from 'path';
import { getWorkspacesDir, TEMP_PREFIX } from './helpers.js';

export interface TitleSources {
  /** Frontmatter `title:` value, if any. */
  fmTitle?: unknown;
  /** Title carried by this doc's workspace JSON entry, if the doc is in one. */
  workspaceTitle?: string;
  /** Markdown body (frontmatter already stripped). */
  content?: string;
  /** Filename or full path — the stem is the last-resort title. */
  filename?: string;
}

function isRealTitle(t: unknown): t is string {
  return typeof t === 'string' && t.trim() !== '' && t !== 'Untitled';
}

/** First ATX h1 in the body, with trailing closing hashes stripped. */
export function firstH1(content: string): string | null {
  const m = content.match(/^#[ \t]+(.+?)[ \t]*#*[ \t]*$/m);
  return m ? m[1].trim() || null : null;
}

export function resolveListingTitle(src: TitleSources): string {
  if (isRealTitle(src.fmTitle)) return src.fmTitle;
  if (isRealTitle(src.workspaceTitle)) return src.workspaceTitle;
  if (src.content) {
    const h1 = firstH1(src.content);
    if (h1) return h1;
  }
  if (src.filename) {
    const stem = basename(src.filename).replace(/\.md$/i, '');
    // Temp files are genuinely new/unnamed docs — their generated stem is
    // not a title; keep them "Untitled" so auto-titling still owns them.
    if (stem && !basename(src.filename).startsWith(TEMP_PREFIX)) return stem;
  }
  return 'Untitled';
}

/**
 * Map of doc file identifier → title from workspace JSON entries.
 * Read-only raw scan of _workspaces/*.json — intentionally does NOT go
 * through readWorkspace(), which performs migrations and writes back.
 * First entry wins when a doc appears in multiple workspaces.
 */
export function getWorkspaceTitleMap(): Map<string, string> {
  const map = new Map<string, string>();
  let files: string[] = [];
  try {
    files = readdirSync(getWorkspacesDir()).filter((f) => f.endsWith('.json') && !f.startsWith('_'));
  } catch {
    return map;
  }
  for (const f of files) {
    try {
      const ws = JSON.parse(readFileSync(join(getWorkspacesDir(), f), 'utf-8'));
      walkNodes(Array.isArray(ws.root) ? ws.root : [], map);
    } catch { /* skip unreadable workspace */ }
  }
  return map;
}

function walkNodes(nodes: any[], map: Map<string, string>): void {
  for (const node of nodes) {
    if (!node || typeof node !== 'object') continue;
    if (node.type === 'doc' && typeof node.file === 'string') {
      if (isRealTitle(node.title) && !map.has(node.file)) map.set(node.file, node.title);
      if (Array.isArray(node.children)) walkNodes(node.children, map);
    } else if (node.type === 'container' && Array.isArray(node.items)) {
      walkNodes(node.items, map);
    }
  }
}
