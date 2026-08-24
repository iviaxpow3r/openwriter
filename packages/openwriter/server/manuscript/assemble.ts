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
import type { Manifest, ManifestItem, ManifestSection } from './parse.js';

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

  // Contents entries must map one-to-one to generated h1 anchors. A manuscript
  // heading is one entry. An unheaded source document can also be one, using the
  // source's own opening h1 (or its document title when no heading exists).
  // Older sidebar-created bindings have no `?toc=1` marker, so when none are
  // present their direct source sequence retains the same useful behavior.
  const hasToc = manifest.sections.some((section) => section.items.some((item) => item.kind === 'toc'));
  const hasExplicitTocEntries = manifest.sections.some((section) => section.items.some((item) => item.kind === 'doc' && item.tocEntry));
  const tocEntries: string[] = [];
  if (hasToc) {
    for (const section of manifest.sections) {
      if (section.heading && bookLevel(section.level) === 1) tocEntries.push(section.heading);
      for (const item of section.items) {
        if (!isChapterDocument(section, item, hasToc, hasExplicitTocEntries)) continue;
        const resolved = item.docId ? bodyMap.get(item.docId) : undefined;
        if (!resolved) continue;
        tocEntries.push(openingH1(resolved.body)?.title || resolved.title);
      }
    }
  }

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
      if (isChapterDocument(section, item, hasToc, hasExplicitTocEntries)) {
        // A source document is the chapter block. It supplies its own opening
        // title when it has one; otherwise its document title is rendered once.
        // All following source headings nest below that chapter h1.
        body = chapterDocumentBody(body, resolved.title);
      } else if (section.heading) {
        // A handwritten manifest heading can name the same chapter as the
        // linked document. Remove only that duplicate source title in compiled
        // output, then preserve the source's remaining heading hierarchy.
        body = nestedDocumentBody(body, section.heading, bookLevel(section.level));
      }
      out.push(body, '');
    }
  }

  const markdown = out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
  return { markdown, warnings };
}

function isChapterDocument(section: ManifestSection, item: ManifestItem, hasToc: boolean, hasExplicitTocEntries: boolean): item is ManifestItem & { kind: 'doc'; docId: string } {
  return hasToc
    && item.kind === 'doc'
    && !!item.docId
    && section.heading === null
    && (item.tocEntry === true || !hasExplicitTocEntries);
}

function openingH1(body: string): { title: string; line: number } | null {
  const lines = body.split('\n');
  for (let line = 0; line < lines.length; line++) {
    if (!lines[line].trim()) continue;
    const match = lines[line].match(/^#\s+(.*\S)\s*$/);
    return match ? { title: match[1].trim(), line } : null;
  }
  return null;
}

function chapterDocumentBody(body: string, documentTitle: string): string {
  const opening = openingH1(body);
  if (!opening) return `# ${documentTitle}\n\n${nestHeadingsBelowChapter(body)}`.trim();
  return nestHeadingsBelowChapter(body, opening.line + 1);
}

function nestedDocumentBody(body: string, manifestTitle: string, parentLevel: number): string {
  const opening = openingH1(body);
  if (!opening || !sameTitle(opening.title, manifestTitle)) return demoteHeadings(body, parentLevel);
  const lines = body.split('\n');
  lines.splice(opening.line, 1);
  if (!lines[opening.line]?.trim()) lines.splice(opening.line, 1);
  // The removed h1 is already represented by the manifest heading. The source
  // body was nested under its own h1, so it needs one fewer level of demotion.
  return demoteHeadings(lines.join('\n'), Math.max(0, parentLevel - 1));
}

function sameTitle(a: string, b: string): boolean {
  return a.trim().replace(/\s+/g, ' ').toLocaleLowerCase() === b.trim().replace(/\s+/g, ' ').toLocaleLowerCase();
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
  return mapLinesOutsideFence(body, (line) => demoteHeadingLine(line, by));
}

/** Keep a source document under its chapter title without deepening headings
 * that are already correctly nested. Only later h1s need normalizing to h2. */
function nestHeadingsBelowChapter(body: string, startLine = 0): string {
  const lines = body.split('\n');
  let fence: string | null = null;
  for (let line = startLine; line < lines.length; line++) {
    const f = isFenceLine(lines[line]);
    if (f) {
      if (fence === null) fence = f;
      else if (fence === f) fence = null;
      continue;
    }
    if (fence === null) lines[line] = lines[line].replace(/^#(\s+)/, '##$1');
  }
  return lines.join('\n');
}

function demoteHeadingLine(line: string, by: number): string {
  const h = line.match(/^(#{1,6})(\s+)(.*)$/);
  if (!h) return line;
  const newLevel = Math.min(6, h[1].length + by);
  return '#'.repeat(newLevel) + h[2] + h[3];
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
