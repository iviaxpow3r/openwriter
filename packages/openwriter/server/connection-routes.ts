/**
 * Connection routes — proxy all requests to the platform API.
 * Local app no longer stores connections.
 */

import { Router } from 'express';
import { readFileSync, existsSync } from 'fs';
import { join, extname } from 'path';
import { platformFetch, isAuthenticated } from './connections.js';
import { getDocument, getTitle, getMetadata } from './state.js';
import { getDataDir } from './helpers.js';
import { tiptapToDraftjs } from './tiptap-draftjs.js';

export function createConnectionRouter(): Router {
  const router = Router();

  // Unified connections list (OAuth + newsletter domains)
  router.get('/api/connections', async (req, res) => {
    try {
      if (!isAuthenticated()) {
        res.json({ connections: [], authenticated: false });
        return;
      }
      const upstream = await platformFetch('/connections/unified');
      const data = await upstream.json();
      if (!upstream.ok) { res.status(upstream.status).json(data); return; }
      res.json(data);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Start OAuth flow — get authorization URL
  router.post('/api/connections/oauth/:provider/start', async (req, res) => {
    try {
      const { provider } = req.params;
      const upstream = await platformFetch(`/connections/oauth/${provider}/url`);
      const data = await upstream.json();
      if (!upstream.ok) { res.status(upstream.status).json(data); return; }
      res.json(data);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Poll OAuth flow status
  router.get('/api/connections/oauth/:provider/status/:state', async (req, res) => {
    try {
      const { provider, state } = req.params;
      const upstream = await platformFetch(`/connections/oauth/${provider}/status/${state}`);
      const data = await upstream.json();
      if (!upstream.ok) { res.status(upstream.status).json(data); return; }
      res.json(data);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Delete / disconnect
  router.delete('/api/connections/:id', async (req, res) => {
    try {
      const upstream = await platformFetch(`/connections/${req.params.id}`, { method: 'DELETE' });
      const text = await upstream.text();
      let data;
      try { data = JSON.parse(text); } catch { data = { error: text }; }
      if (!upstream.ok) { res.status(upstream.status).json(data); return; }
      res.json(data);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // --- Categories ---

  router.get('/api/connections/categories', async (req, res) => {
    try {
      if (!isAuthenticated()) { res.json({ categories: [] }); return; }
      const upstream = await platformFetch('/connections/categories');
      const data = await upstream.json();
      if (!upstream.ok) { res.status(upstream.status).json(data); return; }
      res.json(data);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/api/connections/categories', async (req, res) => {
    try {
      const upstream = await platformFetch('/connections/categories', {
        method: 'POST',
        body: JSON.stringify(req.body),
      });
      const data = await upstream.json();
      if (!upstream.ok) { res.status(upstream.status).json(data); return; }
      res.json(data);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  router.patch('/api/connections/categories/:id', async (req, res) => {
    try {
      const upstream = await platformFetch(`/connections/categories/${req.params.id}`, {
        method: 'PATCH',
        body: JSON.stringify(req.body),
      });
      const data = await upstream.json();
      if (!upstream.ok) { res.status(upstream.status).json(data); return; }
      res.json(data);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  router.delete('/api/connections/categories/:id', async (req, res) => {
    try {
      const upstream = await platformFetch(`/connections/categories/${req.params.id}`, { method: 'DELETE' });
      const data = await upstream.json();
      if (!upstream.ok) { res.status(upstream.status).json(data); return; }
      res.json(data);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Assign connection to category
  router.patch('/api/connections/:id/category', async (req, res) => {
    try {
      const upstream = await platformFetch(`/connections/${req.params.id}/category`, {
        method: 'PATCH',
        body: JSON.stringify(req.body),
      });
      const data = await upstream.json();
      if (!upstream.ok) { res.status(upstream.status).json(data); return; }
      res.json(data);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Profile scoping
  router.get('/api/connections/profile-scoping', async (req, res) => {
    try {
      if (!isAuthenticated()) { res.json({ categories: [], connections: [] }); return; }
      const upstream = await platformFetch('/connections/profile-scoping');
      const data = await upstream.json();
      if (!upstream.ok) { res.status(upstream.status).json(data); return; }
      res.json(data);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/api/connections/profile-scoping', async (req, res) => {
    try {
      const upstream = await platformFetch('/connections/profile-scoping', {
        method: 'POST',
        body: JSON.stringify(req.body),
      });
      const data = await upstream.json();
      if (!upstream.ok) { res.status(upstream.status).json(data); return; }
      res.json(data);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Available connections for current profile
  router.get('/api/connections/available', async (req, res) => {
    try {
      if (!isAuthenticated()) { res.json({ connections: [] }); return; }
      const upstream = await platformFetch('/connections/available');
      const data = await upstream.json();
      if (!upstream.ok) { res.status(upstream.status).json(data); return; }
      res.json(data);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Get connection config
  router.get('/api/connections/:id/config', async (req, res) => {
    try {
      const upstream = await platformFetch(`/connections/${req.params.id}/config`);
      const data = await upstream.json();
      if (!upstream.ok) { res.status(upstream.status).json(data); return; }
      res.json(data);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Update connection config
  router.patch('/api/connections/:id/config', async (req, res) => {
    try {
      const upstream = await platformFetch(`/connections/${req.params.id}/config`, {
        method: 'PATCH',
        body: JSON.stringify(req.body),
      });
      const data = await upstream.json();
      if (!upstream.ok) { res.status(upstream.status).json(data); return; }
      res.json(data);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Post via connection
  router.post('/api/connections/:id/post', async (req, res) => {
    try {
      const upstream = await platformFetch(`/connections/${req.params.id}/post`, {
        method: 'POST',
        body: JSON.stringify(req.body),
      });
      const data = await upstream.json();
      if (!upstream.ok) { res.status(upstream.status).json(data); return; }
      res.json(data);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Post thread via connection
  router.post('/api/connections/:id/post-thread', async (req, res) => {
    try {
      const upstream = await platformFetch(`/connections/${req.params.id}/post-thread`, {
        method: 'POST',
        body: JSON.stringify(req.body),
      });
      const data = await upstream.json();
      if (!upstream.ok) { res.status(upstream.status).json(data); return; }
      res.json(data);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---- Platform-first X posting routes ----
  // These intercept /api/x/* and try platform connection first.
  // If no platform X connection exists, next() falls through to plugin routes.

  /** Find the first active X connection on the platform */
  async function getFirstXConnection(): Promise<{ id: string; display_name: string } | null> {
    if (!isAuthenticated()) return null;
    try {
      const upstream = await platformFetch('/connections/unified');
      if (!upstream.ok) return null;
      const data = await upstream.json() as { connections: any[] };
      const xConn = data.connections.find((c: any) => c.provider === 'x' && c.status === 'active');
      return xConn ? { id: xConn.id, display_name: xConn.display_name } : null;
    } catch {
      return null;
    }
  }

  // GET /api/x/status — platform connection first, then plugin
  router.get('/api/x/status', async (req, res, next) => {
    const conn = await getFirstXConnection();
    if (conn) {
      const username = (conn.display_name || '').replace('@', '');
      res.json({ connected: true, username, source: 'platform' });
      return;
    }
    next(); // Fall through to plugin
  });

  // POST /api/x/post — platform connection first, then plugin
  // If mediaIds present, skip platform — media was uploaded via plugin's X app
  // and media IDs aren't transferable between X API apps.
  router.post('/api/x/post', async (req, res, next) => {
    if (req.body?.mediaIds?.length) { next(); return; }
    const conn = await getFirstXConnection();
    if (!conn) { next(); return; }

    try {
      const upstream = await platformFetch(`/connections/${conn.id}/post`, {
        method: 'POST',
        body: JSON.stringify(req.body),
      });
      const data = await upstream.json();
      if (!upstream.ok) { res.status(upstream.status).json(data); return; }
      res.json(data);
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // POST /api/x/post-thread — platform connection first, then plugin
  // If any tweet has mediaIds, skip platform — media was uploaded via plugin's X app
  // and media IDs aren't transferable between X API apps.
  router.post('/api/x/post-thread', async (req, res, next) => {
    const hasMedia = req.body?.tweets?.some((t: any) => t.mediaIds?.length);
    if (hasMedia) { next(); return; }
    const conn = await getFirstXConnection();
    if (!conn) { next(); return; }

    try {
      const upstream = await platformFetch(`/connections/${conn.id}/post-thread`, {
        method: 'POST',
        body: JSON.stringify(req.body),
      });
      const data = await upstream.json();
      if (!upstream.ok) { res.status(upstream.status).json(data); return; }
      res.json(data);
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // POST /api/x/post-article — publish the active doc as a native X Article.
  // Platform connection first (managed path), then fall through to the x-api
  // plugin (direct OAuth1). Mirrors the /api/x/post routing. The article body
  // is read from the active server doc and converted to X content_state here;
  // the cover image (articleContext.coverImage) is uploaded via the platform.
  router.post('/api/x/post-article', async (req, res, next) => {
    const conn = await getFirstXConnection();
    if (!conn) { next(); return; } // No platform connection → direct plugin path

    try {
      const title = (getTitle() || '').trim();
      if (!title || title === 'Untitled') {
        res.status(400).json({ success: false, error: 'Article needs a title before posting.' });
        return;
      }

      const contentState = tiptapToDraftjs(getDocument());
      if (!contentState.blocks.some((b: any) => (b.text || '').trim().length > 0)) {
        res.status(400).json({ success: false, error: 'Article body is empty.' });
        return;
      }

      // Optional cover — upload through the platform, attach by media id.
      let coverMediaId: string | undefined;
      const coverSrc = getMetadata()?.articleContext?.coverImage;
      if (coverSrc && typeof coverSrc === 'string' && /^\/_images\/[^/\\]+$/.test(coverSrc)) {
        const filename = coverSrc.replace('/_images/', '');
        const filePath = join(getDataDir(), '_images', filename);
        if (existsSync(filePath)) {
          const ext = extname(filename).toLowerCase();
          const mimeMap: Record<string, string> = {
            '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
            '.png': 'image/png', '.webp': 'image/webp',
            '.gif': 'image/gif', '.bmp': 'image/bmp',
          };
          const uploadRes = await platformFetch(`/connections/${conn.id}/upload-media`, {
            method: 'POST',
            body: JSON.stringify({ media_base64: readFileSync(filePath).toString('base64'), media_type: mimeMap[ext] || 'image/jpeg' }),
          });
          if (uploadRes.ok) {
            const data = await uploadRes.json() as any;
            if (data.mediaId) coverMediaId = data.mediaId;
          }
        }
      }

      const upstream = await platformFetch(`/connections/${conn.id}/post-article`, {
        method: 'POST',
        body: JSON.stringify({ title, content_state: contentState, cover_media_id: coverMediaId }),
      });
      const data = await upstream.json() as any;
      if (!upstream.ok || !data.success) {
        res.status(upstream.status || 500).json({ success: false, error: data.error || 'Article publish failed' });
        return;
      }
      res.json({ success: true, articleId: data.articleId, postId: data.postId, articleUrl: data.post_url });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  return router;
}
