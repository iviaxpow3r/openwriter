/**
 * Shared markdown-it instance for manuscript rendering — matches the
 * configuration in export-routes.ts (the single-doc export path) so manuscript
 * output is consistent with OpenWriter's existing exports: same flavor, same
 * footnote plugin. `xhtml` mode self-closes void elements for EPUB's XHTML.
 *
 * adr: adr/manuscript-engine.md
 */
import MarkdownIt from 'markdown-it';
import markdownItIns from 'markdown-it-ins';
import markdownItMark from 'markdown-it-mark';
import markdownItSub from 'markdown-it-sub';
import markdownItSup from 'markdown-it-sup';
import markdownItFootnote from 'markdown-it-footnote';

export function createMd(xhtml = false): MarkdownIt {
  const md = new MarkdownIt({ linkify: false, html: true, xhtmlOut: xhtml });
  md.enable('strikethrough');
  md.use(markdownItIns);
  md.use(markdownItMark);
  md.use(markdownItSub);
  md.use(markdownItSup);
  md.use(markdownItFootnote);
  return md;
}

/** Render a markdown string to an HTML fragment. */
export function renderBodyHtml(markdown: string, xhtml = false): string {
  return createMd(xhtml).render(markdown);
}
