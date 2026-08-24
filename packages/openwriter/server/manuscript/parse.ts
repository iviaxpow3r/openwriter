/**
 * Manuscript manifest parser — pure.
 *
 * The engine knows nothing about books. A "manuscript" is just a doc whose body
 * is an ordered set of `doc:` pointers grouped under markdown headings, plus an
 * optional `{{toc}}` directive. This module turns that body into a structured
 * model the assembler walks. All book meaning (beats, welds, chapters-as-idea)
 * is /book-writer skill convention, never here — here it is only docs + pointers.
 *
 * IMPORTANT — parse what the editor actually STORES, not idealized markdown.
 * OpenWriter round-trips the manifest body through TipTap, which:
 *   - wraps a `doc:` href in angle brackets → `[text](<doc:ID>)`
 *   - collapses consecutive non-blank lines into one paragraph, so several
 *     pointers end up on a single line
 * So pointers are extracted GLOBALLY within each heading's section (any number
 * per line, angle-bracket tolerant), never anchored one-per-line. Title/author
 * come from the doc's frontmatter (round-trip-safe), not a body block.
 *
 * adr: adr/manuscript-engine.md
 */

export interface ManifestMeta {
  title?: string;
  author?: string;
  output?: string; // epub | docx | pdf | html
  trim?: string; // e.g. 6x9 (print only)
  /** Book paragraph style — 'spaced' (default) | 'indented'. Render-time only. */
  paragraphStyle?: string;
  [key: string]: string | undefined;
}

export interface ManifestItem {
  kind: 'doc' | 'toc';
  /** docId (8-char hex) for kind==='doc'. */
  docId?: string;
  /** human-readable link text (the [text] part) for kind==='doc'. */
  text?: string;
}

export interface ManifestSection {
  /** Heading text, or null for items before the first heading. */
  heading: string | null;
  /** Markdown heading level (1-6); 0 for the pre-heading section. */
  level: number;
  items: ManifestItem[];
}

export interface Manifest {
  meta: ManifestMeta;
  sections: ManifestSection[];
  warnings: string[];
}

/** A flat form is convenient for the human contents builder, while the nested
 * sections above remain the right model for assembly and rendering. */
export type FlatManifestItem =
  | { kind: 'doc'; docId: string; text: string }
  | { kind: 'heading'; text: string; level: number }
  | { kind: 'toc' };

const HEADING_RE = /^(#{1,6})\s+(.*\S)\s*$/;
// A pointer (`[text](doc:ID)`) OR the `{{toc}}` directive, matched anywhere.
// Tolerates the editor's angle-bracketed href and an optional #node/?query suffix.
const TOKEN_RE = /\[((?:\\.|[^\]])+)\]\(\s*<?doc:([0-9a-f]{8})[^)>]*>?\s*\)|\{\{\s*toc\s*\}\}/gi;
// A legacy `::: meta … :::` block — stripped so it never renders as stray prose.
const META_BLOCK_RE = /:::\s*meta[\s\S]*?:::/gi;

export function parseManifest(body: string): Manifest {
  const cleaned = body.replace(META_BLOCK_RE, '');
  const lines = cleaned.split('\n');

  // Headings are reliably block-level (their own line), so they define section
  // boundaries; everything between two headings is that section's raw text.
  const raw: { heading: string | null; level: number; text: string }[] = [
    { heading: null, level: 0, text: '' },
  ];
  for (const line of lines) {
    const h = line.match(HEADING_RE);
    if (h) raw.push({ heading: h[2].trim(), level: h[1].length, text: '' });
    else raw[raw.length - 1].text += line + '\n';
  }

  const sections: ManifestSection[] = [];
  for (const s of raw) {
    const items: ManifestItem[] = [];
    TOKEN_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = TOKEN_RE.exec(s.text)) !== null) {
      if (m[2]) items.push({ kind: 'doc', text: m[1].replace(/\\([\\\[\]])/g, '$1').trim(), docId: m[2].toLowerCase() });
      else items.push({ kind: 'toc' });
    }
    if (s.heading !== null || items.length > 0) {
      sections.push({ heading: s.heading, level: s.level, items });
    }
  }

  // Meta is supplied by the caller from frontmatter (see compileManuscript).
  return { meta: {}, sections, warnings: [] };
}

/** Preserve the authored order while exposing headings as ordinary builder rows. */
export function flattenManifest(manifest: Manifest): FlatManifestItem[] {
  const items: FlatManifestItem[] = [];
  for (const section of manifest.sections) {
    if (section.heading !== null) items.push({ kind: 'heading', text: section.heading, level: section.level });
    for (const item of section.items) {
      if (item.kind === 'toc') items.push({ kind: 'toc' });
      else if (item.docId) items.push({ kind: 'doc', docId: item.docId, text: item.text || item.docId });
    }
  }
  return items;
}

/**
 * The manuscript parser has always ignored arbitrary body text. Surface that
 * fact to the builder so authors can remove unsupported content deliberately
 * instead of discovering later that it never appeared in the export.
 */
export function hasUnsupportedManifestText(body: string): boolean {
  const withoutMeta = body.replace(META_BLOCK_RE, '');
  const withoutHeadings = withoutMeta
    .split('\n')
    .filter((line) => !HEADING_RE.test(line))
    .join('\n');
  TOKEN_RE.lastIndex = 0;
  const remainder = withoutHeadings.replace(TOKEN_RE, '');
  return /\S/.test(remainder);
}
