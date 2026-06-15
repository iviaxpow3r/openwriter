/**
 * DOCX render — reuses @turbodocx/html-to-docx (already a dependency, same lib
 * the single-doc export uses). The whole master markdown renders to one HTML
 * fragment, then to a .docx. adr: adr/manuscript-engine.md
 */
import type { ManifestMeta } from '../parse.js';
import { renderBodyHtml } from './md.js';

export async function renderDocx(markdown: string, meta: ManifestMeta): Promise<Buffer> {
  const bodyHtml = renderBodyHtml(markdown, false);
  const { default: HtmlToDocx } = await import('@turbodocx/html-to-docx');
  const docx = await HtmlToDocx(bodyHtml, undefined, {
    title: meta.title || 'Untitled',
    margins: { top: 1440, right: 1440, bottom: 1440, left: 1440 },
  });
  return Buffer.from(docx as ArrayBuffer);
}
