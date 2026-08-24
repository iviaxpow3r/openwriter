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
import { listManuscripts, loadManifest, safeName, saveManifestBody } from './manuscript/load.js';
import { buildManuscriptBinding, buildManuscriptStructure, manuscriptDocumentTitle, type ManuscriptStructureItem } from './manuscript/create.js';
import { flattenManifest, hasUnsupportedManifestText, parseManifest } from './manuscript/parse.js';
import { createDocument, getActiveFilename, reloadDocument, resolveDocId } from './documents.js';
import { readFrontmatter } from './backlinks.js';
import { save, setMetadata } from './state.js';
import { addDoc, getWorkspace } from './workspaces.js';

interface ManuscriptRouterBroadcasts {
  broadcastDocumentsChanged: () => void;
  broadcastWorkspacesChanged: () => void;
}

const DOC_ID_RE = /^[a-f0-9]{8}$/i;

function sourceTitle(docId: string): { title: string; filename?: string; unavailable: boolean } {
  try {
    const filename = resolveDocId(docId);
    const frontmatter = readFrontmatter(filename);
    if (!frontmatter || frontmatter.data.archivedAt || frontmatter.data.content_type === 'manuscript') {
      return { title: docId, unavailable: true };
    }
    return {
      title: String(frontmatter.data.title || filename.replace(/\.md$/, '')),
      filename,
      unavailable: false,
    };
  } catch {
    return { title: docId, unavailable: true };
  }
}

function readStructureItem(value: unknown): ManuscriptStructureItem {
  if (!value || typeof value !== 'object') throw new Error('A manuscript item is invalid.');
  const item = value as Record<string, unknown>;

  if (item.kind === 'toc') return { kind: 'toc' };

  if (item.kind === 'heading') {
    const text = typeof item.text === 'string' ? item.text.trim() : '';
    const level = typeof item.level === 'number' ? item.level : NaN;
    if (!text) throw new Error('A heading needs text.');
    if (!Number.isInteger(level) || level < 1 || level > 6) throw new Error('A heading level must be between 1 and 6.');
    return { kind: 'heading', text, level };
  }

  if (item.kind === 'doc') {
    const docId = typeof item.docId === 'string' ? item.docId.toLowerCase() : '';
    if (!DOC_ID_RE.test(docId)) throw new Error('A manuscript source is invalid.');
    const source = sourceTitle(docId);
    if (source.unavailable) throw new Error('A manuscript source is no longer available. Remove it before saving.');
    return { kind: 'doc', docId, title: source.title };
  }

  throw new Error('A manuscript item is invalid.');
}

export function createManuscriptRouter(broadcasts: ManuscriptRouterBroadcasts): Router {
  const router = Router();

  // Always-on launcher list for the right rail — every manuscript in the profile.
  router.get('/api/manuscripts', (_req, res) => {
    res.json({ manuscripts: listManuscripts() });
  });

  /**
   * The manifest editor is intentionally constrained to source-document
   * pointers, headings, and a table of contents. Keeping this structure as a
   * small API makes it impossible for the generic rich-text save path to leave
   * prose in a binding that exports would silently omit.
   */
  router.get('/api/manuscript/structure', (req, res) => {
    const manuscript = loadManifest(String(req.query.docId || ''));
    if (!manuscript) return res.status(404).json({ error: 'Manuscript not found.' });

    const items = flattenManifest(parseManifest(manuscript.body)).map((item) => {
      if (item.kind !== 'doc') return item;
      const source = sourceTitle(item.docId);
      return {
        kind: 'doc' as const,
        docId: item.docId,
        title: source.unavailable ? item.text : source.title,
        filename: source.filename,
        unavailable: source.unavailable,
      };
    });
    return res.json({ items, hasUnsupportedText: hasUnsupportedManifestText(manuscript.body) });
  });

  router.put('/api/manuscript/structure', (req, res) => {
    try {
      const docId = typeof req.body?.docId === 'string' ? req.body.docId.toLowerCase() : '';
      if (!DOC_ID_RE.test(docId)) return res.status(400).json({ error: 'A manuscript is required.' });
      if (!Array.isArray(req.body?.items)) return res.status(400).json({ error: 'Manuscript contents must be a list.' });

      const items: ManuscriptStructureItem[] = (req.body.items as unknown[]).map(readStructureItem);
      if (items.filter((item) => item.kind === 'toc').length > 1) {
        return res.status(400).json({ error: 'A manuscript can contain one table of contents.' });
      }

      const saved = saveManifestBody(docId, buildManuscriptStructure(items));
      if (!saved) return res.status(404).json({ error: 'Manuscript not found.' });
      // The normal switch path saves the active rich-text state first. Refresh
      // that state now so a fast click into a source document cannot write an
      // older manifest snapshot over the builder's direct save.
      if (getActiveFilename() === saved.filename) reloadDocument();
      broadcasts.broadcastDocumentsChanged();
      const presentation = items.map((item) => {
        if (item.kind !== 'doc') return item;
        const source = sourceTitle(item.docId);
        return { ...item, title: source.title, filename: source.filename, unavailable: source.unavailable };
      });
      return res.json({
        items: presentation,
        hasUnsupportedText: false,
      });
    } catch (err: any) {
      return res.status(400).json({ error: err?.message || 'Could not save manuscript contents.' });
    }
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
      if (docIds.some((docId: unknown) => typeof docId !== 'string' || !DOC_ID_RE.test(docId))) {
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
