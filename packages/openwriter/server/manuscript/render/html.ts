/**
 * HTML render — the master markdown as a single styled book page. Used for the
 * in-app Preview (dropped into an iframe) and as the source for PDF (browser
 * print). Because Preview calls the same compile() → render() path as EPUB
 * export, the preview never lies about the shipped book. adr: adr/manuscript-engine.md
 */
import type { ManifestMeta } from '../parse.js';
import { renderBodyHtml } from './md.js';
import { bookCss, type ParagraphStyle } from './css.js';

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Full standalone HTML document for the whole manuscript (preview / PDF). */
export function renderBookHtml(markdown: string, meta: ManifestMeta): string {
  const body = renderBodyHtml(markdown, false);
  const title = meta.title || 'Untitled';
  const byline = meta.author ? `<p class="book-byline">${escapeHtml(meta.author)}</p>` : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)}</title>
<style>
*, *::before, *::after { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body { background: #faf9f6; color: #1a1a1a; }
.book-page {
  max-width: 38em; margin: 0 auto; padding: 3em 1.5em 6em;
}
.book-title { text-align: center; font-size: 2em; margin: 1em 0 0.3em; page-break-before: avoid; }
.book-byline { text-align: center; color: #666; font-style: italic; margin: 0 0 3.5em; }
/* Title page → first chapter needs real separation. The byline (when present)
   supplies the bottom gap; with no byline the title sits right on the chapter
   heading, so give that first heading its own top air. */
.book-title + h1 { margin-top: 3em; }
${bookCss(meta.paragraphStyle as ParagraphStyle | undefined)}
.book-page h1:first-of-type { page-break-before: avoid; }

/* The PREVIEW follows the reader's OS theme so it's comfortable on screen. The
   EPUB itself stays print-light — e-readers handle their own dark inversion, so
   dark CSS belongs only here, in the screen preview, never in the book. */
@media (prefers-color-scheme: dark) {
  body { background: #15171a; color: #d8d6cf; }
  h1, h2, h3, h4, h5, h6, .book-title { color: #efeee9; }
  .book-byline { color: #9b9b95; }
  blockquote { color: #b3b1a8; }
  a { color: inherit; }
  hr { border-color: #3a3d42; }
  pre { background: #1e2024; }
  .footnotes { color: #a9a79f; border-color: #3a3d42; }
}
</style>
</head>
<body>
<div class="book-page">
<h1 class="book-title">${escapeHtml(title)}</h1>
${byline}
${body}
</div>
</body>
</html>`;
}
