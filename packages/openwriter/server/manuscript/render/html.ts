/**
 * HTML render — the master markdown as a single styled book page. Used for the
 * in-app Preview (dropped into an iframe) and as the source for PDF (browser
 * print). Because Preview calls the same compile() → render() path as EPUB
 * export, the preview never lies about the shipped book. adr: adr/manuscript-engine.md
 *
 * Screen light/dark follows the APP's Appearance setting (`mode`), passed in by
 * the compose view — NOT the OS and NOT an invented palette. The page colors in
 * dark mode reuse the app's own neutral tokens (#1a1a1a surface) so the preview
 * sits in the app instead of clashing. This is screen-comfort only: the EXPORTED
 * book (EPUB/HTML) is always print-light — e-readers do their own inversion, so
 * the export path never passes a mode. The book's LAYOUT (paragraph style, later
 * trim/theme) is a separate manuscript setting, independent of this UI theme.
 */
import type { ManifestMeta } from '../parse.js';
import { renderBodyHtml } from './md.js';
import { bookCss, type ParagraphStyle } from './css.js';

export type RenderMode = 'light' | 'dark';

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Screen palette for the preview surface. Light = cream paper; dark reuses the
 *  app's neutral dark tokens (never blue). Only the in-app preview uses dark. */
function palette(mode: RenderMode) {
  if (mode === 'dark') {
    return {
      bg: '#1a1a1a', // app --bg-primary (dark)
      text: '#d4d2cb',
      heading: '#f0f0f0',
      byline: '#9b9b95',
      blockquote: '#b3b1a8',
      hr: '#3a3a3a',
      pre: '#242424',
      footnote: '#a9a79f',
      footnoteBorder: '#3a3a3a',
    };
  }
  return {
    bg: '#faf9f6',
    text: '#1a1a1a',
    heading: '#1a1a1a',
    byline: '#666',
    blockquote: '#444',
    hr: '#bbb',
    pre: '#f5f5f5',
    footnote: '#444',
    footnoteBorder: '#ccc',
  };
}

/** Full standalone HTML document for the whole manuscript (preview / PDF). */
export function renderBookHtml(markdown: string, meta: ManifestMeta, mode: RenderMode = 'light'): string {
  const body = renderBodyHtml(markdown, false);
  const title = meta.title || 'Untitled';
  const byline = meta.author ? `<p class="book-byline">${escapeHtml(meta.author)}</p>` : '';
  const c = palette(mode);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)}</title>
<style>
*, *::before, *::after { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body { background: ${c.bg}; color: ${c.text}; }
.book-page {
  max-width: 38em; margin: 0 auto; padding: 3em 1.5em 6em;
}
.book-title { text-align: center; font-size: 2em; margin: 1em 0 0.3em; page-break-before: avoid; color: ${c.heading}; }
.book-byline { text-align: center; color: ${c.byline}; font-style: italic; margin: 0 0 3.5em; }
/* Title page → first chapter needs real separation. The byline (when present)
   supplies the bottom gap; with no byline the title sits right on the chapter
   heading, so give that first heading its own top air. */
.book-title + h1 { margin-top: 3em; }
${bookCss(meta.paragraphStyle as ParagraphStyle | undefined)}
body { color: ${c.text}; }
h1, h2, h3, h4, h5, h6 { color: ${c.heading}; }
blockquote { color: ${c.blockquote}; }
hr { border-top-color: ${c.hr}; }
pre { background: ${c.pre}; }
.footnotes { color: ${c.footnote}; border-top-color: ${c.footnoteBorder}; }
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
