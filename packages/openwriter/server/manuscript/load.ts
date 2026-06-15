/**
 * Manifest loaders — shared by the HTTP routes (preview/export) and the MCP
 * tools (compile_manuscript / export_manuscript). Resolving a manuscript doc by
 * stable docId, listing manuscripts in the profile, and the export filename
 * helper all live here so both surfaces read identical data.
 *
 * adr: adr/manuscript-engine.md
 */
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import matter from 'gray-matter';
import { filenameByDocId } from '../documents.js';
import { readFrontmatter } from '../backlinks.js';
import { getDataDir } from '../helpers.js';
import type { ManifestMeta } from './index.js';

/** Every manuscript doc in the active profile (content_type === 'manuscript',
 *  not archived). Powers the always-on Manuscripts launcher + MCP listing. */
export function listManuscripts(): { docId: string; title: string; filename: string }[] {
  const dir = getDataDir();
  const out: { docId: string; title: string; filename: string }[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.md') || f.startsWith('_')) continue;
    try {
      const { data } = matter(readFileSync(join(dir, f), 'utf-8'));
      if (data.content_type === 'manuscript' && !data.archivedAt) {
        out.push({ docId: data.docId, title: data.title || f.replace(/\.md$/, ''), filename: f });
      }
    } catch { /* skip unreadable */ }
  }
  return out.sort((a, b) => a.title.localeCompare(b.title));
}

/** Load a manifest doc by docId: its body (ordered pointer list) + render meta.
 *  Meta comes from the doc's frontmatter (round-trip-safe): the book title
 *  defaults to the doc title minus a trailing "— Manuscript"; author/output/trim
 *  come from manuscriptContext (set via the Settings panel, later). */
export function loadManifest(docId: string): { body: string; meta: ManifestMeta } | null {
  if (!docId) return null;
  const filename = filenameByDocId(docId);
  if (!filename) return null;
  const fm = readFrontmatter(filename);
  if (!fm) return null;
  const ctx = (fm.data.manuscriptContext || {}) as Record<string, any>;
  const title =
    (typeof ctx.title === 'string' && ctx.title) ||
    String(fm.data.title || '').replace(/\s*[—–-]\s*manuscript\s*$/i, '') ||
    'Untitled';
  return {
    body: fm.content,
    meta: {
      title,
      author: typeof ctx.author === 'string' ? ctx.author : undefined,
      output: typeof ctx.output === 'string' ? ctx.output : undefined,
      trim: typeof ctx.trim === 'string' ? ctx.trim : undefined,
      // Render-time book style; defaults to 'spaced' downstream in bookCss().
      paragraphStyle: ctx.paragraphStyle === 'indented' ? 'indented' : 'spaced',
    },
  };
}

/** Filesystem-safe filename stem from a book title. */
export function safeName(title: string): string {
  return (title || 'manuscript').replace(/[<>:"/\\|?*]/g, '_').replace(/\s+/g, '_').slice(0, 100);
}
