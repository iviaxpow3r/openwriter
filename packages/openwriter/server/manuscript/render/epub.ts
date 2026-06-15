/**
 * EPUB3 render — pure-JS, no external binary (OpenWriter ships via npx and can't
 * assume pandoc/calibre are installed). The master markdown is split by `# `
 * chapter into per-chapter XHTML documents and packaged into a valid EPUB3
 * container with jszip. Per-chapter splitting means footnotes resolve at the end
 * of each chapter (standard ebook placement); labels were already namespaced at
 * assembly so nothing collides. adr: adr/manuscript-engine.md
 */
import JSZip from 'jszip';
import type { ManifestMeta } from '../parse.js';
import { renderBodyHtml } from './md.js';
import { DEFAULT_BOOK_CSS } from './css.js';

interface Chapter {
  id: string;
  href: string;
  title: string;
  xhtml: string;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Split master markdown into chapters at top-level `# ` headings (fence-aware). */
function splitChapters(markdown: string): { title: string; md: string }[] {
  const lines = markdown.split('\n');
  const chunks: { title: string; lines: string[] }[] = [];
  let cur: { title: string; lines: string[] } | null = null;
  let fence: string | null = null;

  const firstHeading = (ls: string[]): string => {
    for (const l of ls) {
      const m = l.match(/^#{1,6}\s+(.*\S)\s*$/);
      if (m) return m[1].trim();
    }
    return '';
  };

  for (const line of lines) {
    const f = line.match(/^\s*(```+|~~~+)/);
    if (f) {
      const mark = f[1][0];
      if (fence === null) fence = mark;
      else if (fence === mark) fence = null;
    }
    const isChapterHeading = fence === null && /^# .+/.test(line);
    if (isChapterHeading) {
      if (cur) chunks.push(cur);
      cur = { title: line.replace(/^#\s+/, '').trim(), lines: [line] };
    } else {
      if (!cur) cur = { title: '', lines: [] };
      cur.lines.push(line);
    }
  }
  if (cur) chunks.push(cur);

  return chunks
    .filter((c) => c.lines.some((l) => l.trim() !== ''))
    .map((c) => ({ title: c.title || firstHeading(c.lines) || 'Front Matter', md: c.lines.join('\n') }));
}

function chapterXhtml(title: string, bodyHtml: string): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="en">
<head>
<meta charset="utf-8"/>
<title>${escapeXml(title)}</title>
<link rel="stylesheet" type="text/css" href="style.css"/>
</head>
<body>
${bodyHtml}
</body>
</html>`;
}

export async function renderEpub(markdown: string, meta: ManifestMeta): Promise<Buffer> {
  const title = meta.title || 'Untitled';
  const author = meta.author || '';
  const lang = meta.language || 'en';
  const modified = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const bookId = 'urn:uuid:' + deterministicUuid(title + '|' + author);

  const chapters: Chapter[] = splitChapters(markdown).map((c, i) => {
    const n = String(i + 1).padStart(3, '0');
    return {
      id: `ch${n}`,
      href: `ch${n}.xhtml`,
      title: c.title,
      xhtml: chapterXhtml(c.title, renderBodyHtml(c.md, true)),
    };
  });

  const manifestItems = [
    '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>',
    '<item id="css" href="style.css" media-type="text/css"/>',
    ...chapters.map((c) => `<item id="${c.id}" href="${c.href}" media-type="application/xhtml+xml"/>`),
  ].join('\n    ');
  const spineItems = chapters.map((c) => `<itemref idref="${c.id}"/>`).join('\n    ');

  const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">${escapeXml(bookId)}</dc:identifier>
    <dc:title>${escapeXml(title)}</dc:title>
    <dc:language>${escapeXml(lang)}</dc:language>
    ${author ? `<dc:creator>${escapeXml(author)}</dc:creator>` : ''}
    <meta property="dcterms:modified">${modified}</meta>
  </metadata>
  <manifest>
    ${manifestItems}
  </manifest>
  <spine>
    ${spineItems}
  </spine>
</package>`;

  const navList = chapters.map((c) => `<li><a href="${c.href}">${escapeXml(c.title)}</a></li>`).join('\n      ');
  const nav = `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="en">
<head><meta charset="utf-8"/><title>Contents</title></head>
<body>
<nav epub:type="toc" id="toc">
  <h1>Contents</h1>
  <ol>
      ${navList}
  </ol>
</nav>
</body>
</html>`;

  const containerXml = `<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`;

  const zip = new JSZip();
  // EPUB requires `mimetype` to be the first entry and stored (uncompressed).
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  zip.file('META-INF/container.xml', containerXml);
  zip.file('OEBPS/content.opf', opf);
  zip.file('OEBPS/nav.xhtml', nav);
  zip.file('OEBPS/style.css', DEFAULT_BOOK_CSS);
  for (const c of chapters) zip.file(`OEBPS/${c.href}`, c.xhtml);

  return zip.generateAsync({ type: 'nodebuffer', mimeType: 'application/epub+zip', compression: 'DEFLATE' });
}

/** Stable uuid-shaped string from a seed (no randomness, so identical input → identical id). */
function deterministicUuid(seed: string): string {
  let h = 0x811c9dc5;
  const bytes: number[] = [];
  for (let i = 0; i < 16; i++) {
    for (let j = 0; j < seed.length; j++) {
      h ^= seed.charCodeAt(j) + i * 131;
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    bytes.push(h & 0xff);
  }
  const hex = bytes.map((b) => b.toString(16).padStart(2, '0'));
  return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10, 16).join('')}`;
}
