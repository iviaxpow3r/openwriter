/**
 * GitHub Plugin for OpenWriter.
 * Provides two capabilities:
 *   1. Docs backup sync — lifted from core. Auth: existing `gh auth`.
 *   2. Blog sites (Phase 3+) — list of blog repos, post via local git ops.
 *
 * This phase ships capability 1 only. Routes match the previous core mount
 * points exactly so SyncButton + SyncSetupModal continue to work unchanged.
 */

import type { Request, Response } from 'express';
import type { OpenWriterPlugin, PluginRouteContext } from './helpers.js';
import { getServerModules } from './helpers.js';
import {
  getSyncStatus,
  getCapabilities,
  getPendingFiles,
  setupWithGh,
  setupWithPat,
  connectExisting,
  pushSync,
  type SyncStatus,
} from './git-sync.js';
import { blogTools } from './blog-tools.js';

const plugin: OpenWriterPlugin = {
  name: '@openwriter/plugin-github',
  version: '0.1.0',
  description: 'GitHub Plugin: Sync files and publish blogs.',
  category: 'productivity',

  // No user-input credentials — auth piggybacks on the user's existing
  // `gh auth` (verified in getCapabilities). Blog-site list is stored
  // outside the configSchema as structured data (Phase 3+).
  configSchema: {},

  mcpTools() {
    return blogTools();
  },

  registerRoutes(ctx: PluginRouteContext) {
    const broadcast = async (status: SyncStatus) => {
      try {
        const srv = await getServerModules();
        srv.broadcastSyncStatus(status);
      } catch (err: any) {
        console.error('[GitHub Plugin] broadcast failed:', err.message);
      }
    };

    // MCP-15: log the real error server-side; return a generic message to the
    // client so internal details (paths, git output, tokens) never leak.
    const fail = (res: Response, where: string, err: any, extra: Record<string, any> = {}) => {
      console.error(`[GitHub Plugin] ${where} failed:`, err?.message || err);
      res.status(500).json({ error: 'Internal error', ...extra });
    };

    ctx.app.get('/api/sync/status', async (_req: Request, res: Response) => {
      try { res.json(await getSyncStatus()); }
      catch (err: any) { fail(res, 'sync/status', err, { state: 'error' }); }
    });

    ctx.app.get('/api/sync/capabilities', async (_req: Request, res: Response) => {
      try { res.json(await getCapabilities()); }
      catch (err: any) { fail(res, 'sync/capabilities', err); }
    });

    ctx.app.get('/api/sync/pending', async (_req: Request, res: Response) => {
      try { res.json(await getPendingFiles()); }
      catch (err: any) { fail(res, 'sync/pending', err); }
    });

    ctx.app.post('/api/sync/setup', async (req: Request, res: Response) => {
      try {
        const { method, repoName, remoteUrl, pat, isPrivate } = req.body;

        if (method === 'gh') {
          await setupWithGh(repoName || 'openwriter-docs', isPrivate !== false);
        } else if (method === 'pat') {
          if (!pat) { res.status(400).json({ error: 'PAT is required' }); return; }
          await setupWithPat(pat, repoName || 'openwriter-docs', isPrivate !== false);
        } else if (method === 'connect') {
          if (!remoteUrl) { res.status(400).json({ error: 'Remote URL is required' }); return; }
          await connectExisting(remoteUrl, pat);
        } else {
          res.status(400).json({ error: 'Invalid method. Use: gh, pat, or connect' });
          return;
        }

        const status = await getSyncStatus();
        await broadcast(status);
        res.json({ success: true, status });
      } catch (err: any) {
        // Setup surfaces GitHub's own API feedback (e.g. "name already exists",
        // "bad credentials") which is user-actionable; the remote is now
        // credential-free so this carries no secret. Still log the full error.
        console.error('[GitHub Plugin] sync/setup failed:', err?.message || err);
        res.status(500).json({ error: err?.message || 'Setup failed' });
      }
    });

    ctx.app.post('/api/sync/push', async (_req: Request, res: Response) => {
      try {
        const result = await pushSync((s) => { void broadcast(s); });
        res.json(result);
      } catch (err: any) {
        fail(res, 'sync/push', err, { state: 'error' });
      }
    });
  },
};

export default plugin;
