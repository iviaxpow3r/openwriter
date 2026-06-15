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
  // Chapter anchors: every top-level heading (h1 = a chapter; beats are demoted
  // to h2+) gets a stable sequential id `ch-N`. The assembler's {{toc}} links to
  // these (#ch-N) and the preview's chapter tick-rail also keys off them, so the
  // contents page and the side navigator point at the same targets.
  md.core.ruler.push('chapter_ids', (state) => {
    let n = 0;
    for (const tok of state.tokens) {
      if (tok.type === 'heading_open' && tok.tag === 'h1') {
        n += 1;
        tok.attrSet('id', `ch-${n}`);
      }
    }
  });
  return md;
}

/** Render a markdown string to an HTML fragment. */
export function renderBodyHtml(markdown: string, xhtml = false): string {
  return createMd(xhtml).render(markdown);
}
