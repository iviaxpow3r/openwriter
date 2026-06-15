/**
 * Default book stylesheet — the built-in "default theme".
 *
 * The SAME CSS is embedded in the HTML preview and written into the EPUB, so
 * what you see in preview is what the EPUB ships (WYSIWYG by construction). When
 * the theme system lands (post-engine layer), this becomes one of several
 * swappable themes stored in `manuscriptContext`; presentation is applied here,
 * at render, never in the editor. adr: adr/manuscript-engine.md
 */
export const DEFAULT_BOOK_CSS = `
body {
  font-family: Georgia, 'Times New Roman', serif;
  font-size: 1em;
  line-height: 1.6;
  color: #1a1a1a;
}
h1, h2, h3, h4, h5, h6 { font-weight: 600; line-height: 1.25; }
h1 { font-size: 1.7em; margin: 0 0 1em; page-break-before: always; break-before: page; }
h2 { font-size: 1.35em; margin: 1.6em 0 0.5em; }
h3 { font-size: 1.15em; margin: 1.3em 0 0.4em; }
p { margin: 0 0 1.1em; }
blockquote p, li p { margin-bottom: 0.5em; }
blockquote { margin: 1em 1.6em; font-style: italic; color: #444; }
ul, ol { margin: 1em 0; padding-left: 1.6em; }
li { margin: 0.2em 0; }
hr { border: none; border-top: 1px solid #bbb; width: 28%; margin: 2em auto; }
a { color: inherit; text-decoration: none; }
img { max-width: 100%; height: auto; }
code { font-family: Consolas, Menlo, monospace; font-size: 0.9em; }
pre { background: #f5f5f5; padding: 0.8em 1em; overflow-x: auto; font-size: 0.85em; }
sup.footnote-ref { font-size: 0.7em; }
.footnotes {
  font-size: 0.85em; color: #444;
  border-top: 1px solid #ccc; margin-top: 2.5em; padding-top: 0.5em;
}
.footnotes ol { padding-left: 1.4em; }
`;
