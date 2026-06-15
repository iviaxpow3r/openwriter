/**
 * Manuscript manifest parser — pure.
 *
 * The engine knows nothing about books. A "manuscript" is just a doc whose body
 * is an ordered list of `doc:` pointers grouped under markdown headings, plus an
 * optional `::: meta` render-config block and a `{{toc}}` directive. This module
 * turns that body into a structured model the assembler walks. All book meaning
 * (beats, welds, chapters-as-idea) is /book-writer skill convention, never here —
 * here it is only docs and pointers.
 *
 * adr: adr/manuscript-engine.md
 */

export interface ManifestMeta {
  title?: string;
  author?: string;
  output?: string; // epub | docx | pdf | html
  trim?: string; // e.g. 6x9 (print only)
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

// A pointer line: `[Some Title](doc:9bee893b)`. The docId is the only thing
// resolution uses (rename-safe); an optional #node / ?query suffix is ignored
// because a manifest always includes the whole referenced doc.
const DOC_LINK_RE = /^\s*\[([^\]]+)\]\(doc:([0-9a-f]{8})(?:[#?][^)]*)?\)\s*$/;
const HEADING_RE = /^(#{1,6})\s+(.*\S)\s*$/;
const TOC_RE = /^\s*\{\{\s*toc\s*\}\}\s*$/i;
const META_OPEN_RE = /^:::\s*meta\s*$/i;
const FENCE_CLOSE_RE = /^:::\s*$/;
const META_KV_RE = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/;

export function parseManifest(body: string): Manifest {
  const lines = body.split('\n');
  const meta: ManifestMeta = {};
  const sections: ManifestSection[] = [];
  const warnings: string[] = [];

  let current: ManifestSection = { heading: null, level: 0, items: [] };
  sections.push(current);

  let inMeta = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (inMeta) {
      if (FENCE_CLOSE_RE.test(line)) {
        inMeta = false;
        continue;
      }
      const kv = trimmed.match(META_KV_RE);
      if (kv) meta[kv[1].toLowerCase()] = kv[2].trim();
      continue;
    }
    if (META_OPEN_RE.test(line)) {
      inMeta = true;
      continue;
    }

    if (trimmed === '') continue;

    const heading = line.match(HEADING_RE);
    if (heading) {
      current = { heading: heading[2].trim(), level: heading[1].length, items: [] };
      sections.push(current);
      continue;
    }

    if (TOC_RE.test(line)) {
      current.items.push({ kind: 'toc' });
      continue;
    }

    const doc = line.match(DOC_LINK_RE);
    if (doc) {
      current.items.push({ kind: 'doc', text: doc[1].trim(), docId: doc[2] });
      continue;
    }

    warnings.push(`Unrecognized manifest line ${i + 1}: "${trimmed.slice(0, 80)}"`);
  }

  // Drop the leading pre-heading section when it carried nothing.
  if (sections[0].heading === null && sections[0].items.length === 0) {
    sections.shift();
  }

  return { meta, sections, warnings };
}
