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
import {
  compileManuscript,
  renderBookHtml,
  renderEpub,
  renderDocx,
} from './manuscript/index.js';
import { listManuscripts, loadManifest, safeName } from './manuscript/load.js';
import { buildManuscriptBinding, manuscriptDocumentTitle } from './manuscript/create.js';
import { createDocument, resolveDocId } from './documents.js';
import { readFrontmatter } from './backlinks.js';
import { save, setMetadata } from './state.js';
import { addDoc, getWorkspace } from './workspaces.js';

interface ManuscriptRouterBroadcasts {
  broadcastDocumentsChanged: () => void;
  broadcastWorkspacesChanged: () => void;
}

export function createManuscriptRouter(broadcasts: ManuscriptRouterBroadcasts): Router {
  const router = Router();

  // Always-on launcher list for the right rail — every manuscript in the profile.
  router.get('/api/manuscripts', (_req, res) => {
    res.json({ manuscripts: listManuscripts() });
  });

  /**
   * Create the same normal manuscript binding that an author could write by
   * hand, but from an ordered sidebar selection. It stores no copy of source
   * prose: the binding is only stable `doc:` pointers.
   */
  router.post('/api/manuscripts', (req, res) => {
    try {
      const requestedTitle = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
      const docIds = Array.isArray(req.body?.docIds) ? req.body.docIds : [];
      const workspaceFile = typeof req.body?.workspaceFile === 'string' ? req.body.workspaceFile : undefined;

      if (!requestedTitle) return res.status(400).json({ error: 'A manuscript title is required.' });
      if (docIds.length === 0) return res.status(400).json({ error: 'Select at least one document.' });
      if (docIds.some((docId: unknown) => typeof docId !== 'string' || !/^[a-f0-9]{8}$/i.test(docId))) {
        return res.status(400).json({ error: 'The selection contains an invalid document.' });
      }
      if (new Set(docIds).size !== docIds.length) {
        return res.status(400).json({ error: 'A document can appear only once in a new manuscript.' });
      }
      // Validate the destination before creating the binding, so a stale
      // workspace selection can never leave an unexpected unassigned file.
      if (workspaceFile) getWorkspace(workspaceFile);

      const sources = docIds.map((docId: string) => {
        const filename = resolveDocId(docId.toLowerCase());
        const frontmatter = readFrontmatter(filename);
        if (!frontmatter || frontmatter.data.archivedAt) throw new Error('A selected document is no longer available.');
        if (frontmatter.data.content_type === 'manuscript') throw new Error('A manuscript cannot be included in another manuscript.');
        return { docId: docId.toLowerCase(), title: String(frontmatter.data.title || filename.replace(/\.md$/, '')) };
      });

      const title = requestedTitle.replace(/\s*[—–-]\s*manuscript\s*$/i, '').trim();
      const documentTitle = manuscriptDocumentTitle(title);
      const result = createDocument(documentTitle, buildManuscriptBinding(sources));
      setMetadata({
        content_type: 'manuscript',
        manuscriptContext: { active: true, title },
      });
      save();

      if (workspaceFile) {
        addDoc(workspaceFile, null, result.filename, result.title);
        broadcasts.broadcastWorkspacesChanged();
      }
      broadcasts.broadcastDocumentsChanged();
      return res.status(201).json({ filename: result.filename, title: result.title });
    } catch (err: any) {
      return res.status(400).json({ error: err?.message || 'Could not create manuscript.' });
    }
  });

  router.get('/api/manuscript/preview', (req, res) => {
    const ms = loadManifest(String(req.query.docId || ''));
    if (!ms) return res.status(404).json({ error: 'manuscript doc not found' });
    const { markdown, meta } = compileManuscript(ms.body, ms.meta);
    // The manuscript compose view frames this preview SAME-ORIGIN. The global
    // security gate sends X-Frame-Options: DENY + frame-ancestors 'none', which
    // blocks the iframe entirely. Relax BOTH to same-origin for this route only —
    // a self-contained book page, framed by the app itself, nothing external.
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; img-src 'self' data: blob: https:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; frame-ancestors 'self'",
    );
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    // Screen light/dark follows the app's Appearance setting, passed by the
    // compose view. Export (below) never does — the book ships print-light.
    const mode = req.query.mode === 'dark' ? 'dark' : 'light';
    res.send(renderBookHtml(markdown, meta, mode));
  });

  router.get('/api/manuscript/export', async (req, res) => {
    const ms = loadManifest(String(req.query.docId || ''));
    if (!ms) return res.status(404).json({ error: 'manuscript doc not found' });

    const format = String(req.query.format || 'epub').toLowerCase();
    const result = compileManuscript(ms.body, ms.meta);
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
