/**
 * HTML render — the master markdown as a single styled book page. Used for the
 * in-app Preview (dropped into an iframe) and as the source for PDF (browser
 * print). Because Preview calls the same compile() → render() path as EPUB
 * export, the preview never lies about the shipped book. adr: adr/manuscript-engine.md
 */
import type { ManifestMeta } from '../parse.js';
import { renderBodyHtml } from './md.js';
import { DEFAULT_BOOK_CSS } from './css.js';

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
.book-page {
  max-width: 38em; margin: 0 auto; padding: 3em 1.5em 6em;
}
.book-title { text-align: center; font-size: 2em; margin: 1em 0 0.2em; page-break-before: avoid; }
.book-byline { text-align: center; color: #666; font-style: italic; margin: 0 0 2em; }
${DEFAULT_BOOK_CSS}
.book-page h1:first-of-type { page-break-before: avoid; }
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
