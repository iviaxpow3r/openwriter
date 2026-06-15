/**
 * Manuscript assembler — pure transform.
 *
 * Walks the parsed manifest and concatenates each referenced doc's body, in
 * order, under its chapter heading, into one master markdown document. Three
 * pure transforms keep the result book-coherent:
 *
 *   - footnote namespacing — each doc's `[^n]` labels are made globally unique
 *     so they don't collide once concatenated. Display numbering is the
 *     renderer's job (markdown-it-footnote / pandoc renumber sequentially by
 *     encounter order); this only guarantees ref↔def matching survives the
 *     merge. This is the cross-chapter renumbering docs/footnotes.md deferred
 *     to "book-export time". adr: adr/footnote-system.md
 *   - manifest-driven headings — the manifest owns the book's whole heading
 *     hierarchy. Each manifest heading renders at book level (its level − 1):
 *     `## chapter` → h1, `### section` → h2, etc. Headings with no beats under
 *     them still render (structural dividers). A beat's own headings are demoted
 *     to nest just below its enclosing manifest heading. Beats stay pure prose —
 *     section structure lives in the binding, never tacked onto the atom.
 *   - {{toc}} — a contents list of the top-level (book-h1) chapter headings.
 *
 * Pure: takes a body map (docId → {title, body}); does no disk I/O. Disk
 * resolution lives in resolve.ts, so this core is unit-testable without a server.
 *
 * adr: adr/manuscript-engine.md
 */
import type { Manifest } from './parse.js';

export interface ResolvedBody {
  title: string;
  body: string;
}

export interface AssembleResult {
  markdown: string;
  warnings: string[];
}

/** Book heading level for a manifest heading. The manifest owns the book's whole
 *  heading hierarchy: `## chapter` → book h1, `### section` → h2, `#### ` → h3,
 *  etc. (level − 1, clamped ≥1). `## = chapter` keeps the existing convention, so
 *  any current `##`-only manifest renders byte-identically; deeper levels are
 *  purely additive. A `#` and a `##` both map to h1 (clamp). */
function bookLevel(manifestLevel: number): number {
  return Math.max(1, manifestLevel - 1);
}

export function assemble(manifest: Manifest, bodyMap: Map<string, ResolvedBody>): AssembleResult {
  const warnings: string[] = [];

  // Chapters-only navigation: TOC + tick-rail list book-h1 headings (manifest
  // level ≤ 2), in document order, so they align with md.ts's `#ch-N` anchors.
  // Sub-section headers still render in the book (and the EPUB's own nav), just
  // not in the chapter contents list.
  const tocEntries = manifest.sections
    .filter((s) => s.heading && bookLevel(s.level) === 1)
    .map((s) => s.heading as string);

  let ordinal = 0; // per-doc footnote namespace counter
  const out: string[] = [];

  for (const section of manifest.sections) {
    // Emit EVERY manifest heading at its mapped book level — including a
    // structural divider with no beats under it (a "Part" line, a section title
    // between beats). The book's heading structure is whatever the manifest says.
    if (section.heading) {
      const lvl = bookLevel(section.level);
      out.push(`${'#'.repeat(lvl)} ${section.heading}`, '');
    }

    for (const item of section.items) {
      if (item.kind === 'toc') {
        const toc = renderToc(tocEntries);
        if (toc) out.push(toc, '');
        continue;
      }

      const resolved = item.docId ? bodyMap.get(item.docId) : undefined;
      if (!resolved) {
        warnings.push(`Unresolved docId ${item.docId} (${item.text ?? ''}) — not in workspace?`);
        out.push(`> **[unresolved: ${item.text ?? item.docId}]**`, '');
        continue;
      }

      ordinal += 1;
      let body = resolved.body.trim();
      body = namespaceFootnotes(body, ordinal);
      // Nest a beat's own headings just below its enclosing manifest heading:
      // under a book-h{N} section, the beat's internal h1 becomes h{N+1}.
      // Pre-heading / front-matter beats (no enclosing heading) keep their structure.
      if (section.heading) body = demoteHeadings(body, bookLevel(section.level));
      out.push(body, '');
    }
  }

  const markdown = out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
  return { markdown, warnings };
}

function renderToc(entries: string[]): string {
  if (entries.length === 0) return '';
  // Link each entry to its chapter anchor (#ch-N). md.ts stamps the matching id
  // on the Nth h1, in the same order chapters are emitted here, so they align.
  return ['## Contents', '', ...entries.map((e, i) => `- [${e}](#ch-${i + 1})`)].join('\n');
}

/**
 * Make a doc's footnote labels globally unique by namespacing them with an
 * ordinal. Handles both references `[^x]` and definitions `[^x]:`, numeric or
 * mnemonic. Only labels that are actually DEFINED in this doc are remapped, so
 * stray `[^...]`-looking text isn't touched. Fenced code blocks are skipped.
 */
function namespaceFootnotes(body: string, ordinal: number): string {
  const defRe = /^\s*\[\^([^\]]+)\]:/;
  const labels = new Set<string>();

  forEachLineOutsideFence(body, (line) => {
    const m = line.match(defRe);
    if (m) labels.add(m[1]);
  });
  if (labels.size === 0) return body;

  return mapLinesOutsideFence(body, (line) =>
    line.replace(/\[\^([^\]]+)\]/g, (full, label: string) =>
      labels.has(label) ? `[^fn${ordinal}-${label}]` : full,
    ),
  );
}

/** Shift ATX heading levels down by `by`, clamped at h6, skipping code fences. */
function demoteHeadings(body: string, by: number): string {
  if (by <= 0) return body;
  return mapLinesOutsideFence(body, (line) => {
    const h = line.match(/^(#{1,6})(\s+)(.*)$/);
    if (!h) return line;
    const newLevel = Math.min(6, h[1].length + by);
    return '#'.repeat(newLevel) + h[2] + h[3];
  });
}

// ── fenced-code-aware line helpers ──────────────────────────────────────────

function isFenceLine(line: string): string | null {
  const m = line.match(/^\s*(```+|~~~+)/);
  return m ? m[1][0] : null;
}

function forEachLineOutsideFence(body: string, fn: (line: string) => void): void {
  let fence: string | null = null;
  for (const line of body.split('\n')) {
    const f = isFenceLine(line);
    if (f) {
      if (fence === null) fence = f;
      else if (fence === f) fence = null;
      continue;
    }
    if (fence === null) fn(line);
  }
}

function mapLinesOutsideFence(body: string, fn: (line: string) => string): string {
  let fence: string | null = null;
  const lines = body.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const f = isFenceLine(lines[i]);
    if (f) {
      if (fence === null) fence = f;
      else if (fence === f) fence = null;
      continue;
    }
    if (fence === null) lines[i] = fn(lines[i]);
  }
  return lines.join('\n');
}
