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
  setupWithOAuth,
  connectExisting,
  listAccessibleRepositories,
  inspectAccessibleRepository,
  getCollaborationOverview,
  requestPrimaryWriterRole,
  approvePrimaryWriterTransfer,
  claimPrimaryWriterRole,
  pushSync,
  startAutomaticCheckpoints,
  activateCurrentProfileSync,
  disconnectCurrentProfile,
  startDeviceAuthorization,
  pollDeviceAuthorization,
  restoreOAuthSession,
  disconnectCurrentProfileGitHubAccount,
  type CollaborationSetup,
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

    // A profile can already be configured when the plugin registers (for
    // example, after an app restart), so begin watching immediately. A new
    // setup starts it again below; the function is idempotent.
    void startAutomaticCheckpoints((status) => { void broadcast(status); });

    ctx.app.get('/api/sync/status', async (_req: Request, res: Response) => {
      try { res.json(await getSyncStatus()); }
      catch (err: any) { fail(res, 'sync/status', err, { state: 'error' }); }
    });

    // The core profile switch has already changed the active data directory
    // before the UI calls this route. Rebind this optional plugin's watcher to
    // that directory and return the new profile's own status.
    ctx.app.post('/api/sync/profile-activated', async (_req: Request, res: Response) => {
      try { res.json({ status: await activateCurrentProfileSync((status) => { void broadcast(status); }) }); }
      catch (err: any) { fail(res, 'sync/profile-activated', err, { state: 'error' }); }
    });

    ctx.app.post('/api/sync/disconnect', async (_req: Request, res: Response) => {
      try {
        const status = await disconnectCurrentProfile();
        await broadcast(status);
        res.json({ success: true, status });
      } catch (err: any) {
        res.status(500).json({ error: err?.message || 'Cloud backup could not be disconnected.' });
      }
    });

    ctx.app.get('/api/sync/capabilities', async (_req: Request, res: Response) => {
      try { res.json(await getCapabilities()); }
      catch (err: any) { fail(res, 'sync/capabilities', err); }
    });

    ctx.app.post('/api/sync/github/device/start', async (_req: Request, res: Response) => {
      try { res.json(await startDeviceAuthorization()); }
      catch (err: any) { res.status(400).json({ error: err?.message || 'GitHub sign-in could not start.' }); }
    });

    ctx.app.get('/api/sync/github/device/:requestId', async (req: Request, res: Response) => {
      try {
        const rawRequestId = req.params.requestId;
        const requestId = Array.isArray(rawRequestId) ? rawRequestId[0] : rawRequestId;
        res.json(await pollDeviceAuthorization(requestId || ''));
      }
      catch (err: any) { res.status(500).json({ state: 'error', error: 'GitHub sign-in could not be completed.' }); }
    });

    ctx.app.post('/api/sync/github/session/restore', async (_req: Request, res: Response) => {
      try { res.json(await restoreOAuthSession()); }
      catch (err: any) { res.status(400).json({ error: err?.message || 'GitHub sign-in could not be restored.' }); }
    });

    // This is intentionally profile-scoped. It removes only OpenWriter's
    // device credential so an author can pair a different account for this
    // profile; it never signs the person out of GitHub in their browser/CLI.
    ctx.app.post('/api/sync/github/session/disconnect', async (_req: Request, res: Response) => {
      try { res.json({ success: true, capabilities: await disconnectCurrentProfileGitHubAccount() }); }
      catch (err: any) { res.status(400).json({ error: err?.message || 'GitHub sign-in could not be disconnected.' }); }
    });

    ctx.app.get('/api/sync/github/repositories', async (req: Request, res: Response) => {
      try {
        const rawMethod = Array.isArray(req.query.auth) ? req.query.auth[0] : req.query.auth;
        if (rawMethod !== 'oauth' && rawMethod !== 'gh') {
          res.status(400).json({ error: 'Choose a GitHub sign-in before listing repositories.' });
          return;
        }
        res.json({ repositories: await listAccessibleRepositories(rawMethod) });
      } catch (err: any) {
        res.status(400).json({ error: err?.message || 'GitHub could not load repositories.' });
      }
    });

    ctx.app.post('/api/sync/github/repository-inspect', async (req: Request, res: Response) => {
      try {
        const { remoteUrl, authMethod, pat } = req.body || {};
        if (typeof remoteUrl !== 'string' || !remoteUrl.trim()) {
          res.status(400).json({ error: 'Paste a GitHub repository link to check it.' });
          return;
        }
        if (authMethod !== 'oauth' && authMethod !== 'gh' && authMethod !== 'pat') {
          res.status(400).json({ error: 'Choose a GitHub sign-in before checking a repository.' });
          return;
        }
        res.json(await inspectAccessibleRepository(remoteUrl.trim(), authMethod, typeof pat === 'string' ? pat : undefined));
      } catch (err: any) {
        res.status(400).json({ error: err?.message || 'GitHub could not check this repository.' });
      }
    });

    ctx.app.get('/api/sync/pending', async (_req: Request, res: Response) => {
      try { res.json(await getPendingFiles()); }
      catch (err: any) { fail(res, 'sync/pending', err); }
    });

    ctx.app.get('/api/sync/collaboration', async (_req: Request, res: Response) => {
      try { res.json(await getCollaborationOverview()); }
      catch (err: any) { res.status(400).json({ error: err?.message || 'Writing roles could not be loaded.' }); }
    });

    ctx.app.post('/api/sync/collaboration/primary-request', async (_req: Request, res: Response) => {
      try { res.json(await requestPrimaryWriterRole()); }
      catch (err: any) { res.status(400).json({ error: err?.message || 'Primary-writer request could not be created.' }); }
    });

    ctx.app.post('/api/sync/collaboration/primary-transfer', async (req: Request, res: Response) => {
      const requestId = Number(req.body?.requestId);
      if (!Number.isInteger(requestId) || requestId <= 0) {
        res.status(400).json({ error: 'Choose a valid primary-writer request.' });
        return;
      }
      try { res.json(await approvePrimaryWriterTransfer(requestId)); }
      catch (err: any) { res.status(400).json({ error: err?.message || 'Primary-writer transfer could not be approved.' }); }
    });

    ctx.app.post('/api/sync/collaboration/claim-primary', async (_req: Request, res: Response) => {
      try { res.json(await claimPrimaryWriterRole()); }
      catch (err: any) { res.status(400).json({ error: err?.message || 'Primary writer role could not be activated.' }); }
    });

    ctx.app.post('/api/sync/setup', async (req: Request, res: Response) => {
      try {
        const { method, repoName, remoteUrl, pat, isPrivate, collaboration, authMethod } = req.body;
        const setup = (collaboration && typeof collaboration === 'object' ? collaboration : {}) as CollaborationSetup;

        if (method === 'gh') {
          await setupWithGh(repoName || 'openwriter-docs', isPrivate !== false, setup);
        } else if (method === 'oauth') {
          await setupWithOAuth(repoName || 'openwriter-docs', isPrivate !== false, setup);
        } else if (method === 'pat') {
          if (!pat) { res.status(400).json({ error: 'PAT is required' }); return; }
          await setupWithPat(pat, repoName || 'openwriter-docs', isPrivate !== false, setup);
        } else if (method === 'connect') {
          if (!remoteUrl) { res.status(400).json({ error: 'Remote URL is required' }); return; }
          const selectedAuth = authMethod === 'gh' || authMethod === 'oauth' || authMethod === 'pat'
            ? authMethod
            : pat ? 'pat' : 'oauth';
          await connectExisting(remoteUrl, pat, setup, selectedAuth);
        } else {
          res.status(400).json({ error: 'Invalid method. Use: oauth, gh, pat, or connect' });
          return;
        }

        const status = await getSyncStatus();
        await broadcast(status);
        await startAutomaticCheckpoints((nextStatus) => { void broadcast(nextStatus); });
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
