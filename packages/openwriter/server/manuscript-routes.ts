/**
 * Manuscript routes: compile + render a manuscript doc to a file or preview.
 *
 *   GET /api/manuscript/preview?docId=<id>            -> book HTML (iframe source)
 *   GET /api/manuscript/export?docId=<id>&format=epub -> epub | docx | html | md
 *
 * Both resolve the manifest doc by stable docId, compile it (resolve pointers +
 * assemble), then render. Preview and export share the same compile() path, so
 * the preview can never disagree with the exported book. adr: adr/manuscript-engine.md
 */
import { Router } from 'express';
import { filenameByDocId } from './documents.js';
import { readFrontmatter } from './backlinks.js';
import {
  compileManuscript,
  renderBookHtml,
  renderEpub,
  renderDocx,
} from './manuscript/index.js';

/** Load a manifest doc's body (the ordered pointer list) by docId. */
function loadManifestBody(docId: string): string | null {
  if (!docId) return null;
  const filename = filenameByDocId(docId);
  if (!filename) return null;
  const fm = readFrontmatter(filename);
  return fm ? fm.content : null;
}

function safeName(title: string): string {
  return (title || 'manuscript').replace(/[<>:"/\\|?*]/g, '_').replace(/\s+/g, '_').slice(0, 100);
}

export function createManuscriptRouter(): Router {
  const router = Router();

  router.get('/api/manuscript/preview', (req, res) => {
    const body = loadManifestBody(String(req.query.docId || ''));
    if (body === null) return res.status(404).json({ error: 'manuscript doc not found' });
    const { markdown, meta } = compileManuscript(body);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(renderBookHtml(markdown, meta));
  });

  router.get('/api/manuscript/export', async (req, res) => {
    const body = loadManifestBody(String(req.query.docId || ''));
    if (body === null) return res.status(404).json({ error: 'manuscript doc not found' });

    const format = String(req.query.format || 'epub').toLowerCase();
    const result = compileManuscript(body);
    const name = safeName(result.meta.title || '');

    try {
      switch (format) {
        case 'epub': {
          const buf = await renderEpub(result.markdown, result.meta);
          res.setHeader('Content-Type', 'application/epub+zip');
          res.setHeader('Content-Disposition', `attachment; filename="${name}.epub"`);
          return res.send(buf);
        }
        case 'docx': {
          const buf = await renderDocx(result.markdown, result.meta);
          res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
          res.setHeader('Content-Disposition', `attachment; filename="${name}.docx"`);
          return res.send(buf);
        }
        case 'html': {
          res.setHeader('Content-Type', 'text/html; charset=utf-8');
          res.setHeader('Content-Disposition', `attachment; filename="${name}.html"`);
          return res.send(renderBookHtml(result.markdown, result.meta));
        }
        case 'md': {
          res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
          res.setHeader('Content-Disposition', `attachment; filename="${name}.md"`);
          return res.send(result.markdown);
        }
        default:
          return res.status(400).json({ error: `Unknown format: ${format}. Use epub, docx, html, or md.` });
      }
    } catch (err: any) {
      console.error('[Manuscript] export error:', err?.message);
      return res.status(500).json({ error: 'Manuscript export failed' });
    }
  });

  return router;
}
