/**
 * Scheduler routes — proxy all requests to the platform API.
 */

import { Router } from 'express';
import { platformFetch, isAuthenticated } from './connections.js';
import { syncPostHistory } from './post-sync.js';

export function createSchedulerRouter(): Router {
  const router = Router();

  function proxy(path: string, method: string = 'GET') {
    return async (req: any, res: any) => {
      try {
        if (!isAuthenticated()) {
          res.json({ error: 'Not authenticated' });
          return;
        }
        const options: RequestInit = { method };
        if (method !== 'GET' && method !== 'DELETE') {
          options.body = JSON.stringify(req.body);
        }
        const upstream = await platformFetch(path, options);
        const data = await upstream.json();
        if (!upstream.ok) { res.status(upstream.status).json(data); return; }
        res.json(data);
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    };
  }

  // Slots
  router.get('/api/scheduler/slots', proxy('/scheduler/slots'));
  router.post('/api/scheduler/slots', proxy('/scheduler/slots', 'POST'));
  router.patch('/api/scheduler/slots/:id', async (req, res) => {
    try {
      if (!isAuthenticated()) { res.json({ error: 'Not authenticated' }); return; }
      const upstream = await platformFetch(`/scheduler/slots/${req.params.id}`, {
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
  router.delete('/api/scheduler/slots/:id', async (req, res) => {
    try {
      if (!isAuthenticated()) { res.json({ error: 'Not authenticated' }); return; }
      const upstream = await platformFetch(`/scheduler/slots/${req.params.id}`, { method: 'DELETE' });
      const data = await upstream.json();
      if (!upstream.ok) { res.status(upstream.status).json(data); return; }
      res.json(data);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Queue
  router.get('/api/scheduler/queue', proxy('/scheduler/queue'));
  router.post('/api/scheduler/queue', proxy('/scheduler/queue', 'POST'));
  router.patch('/api/scheduler/queue/:id', async (req, res) => {
    try {
      if (!isAuthenticated()) { res.json({ error: 'Not authenticated' }); return; }
      const upstream = await platformFetch(`/scheduler/queue/${req.params.id}`, {
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
  router.delete('/api/scheduler/queue/:id', async (req, res) => {
    try {
      if (!isAuthenticated()) { res.json({ error: 'Not authenticated' }); return; }
      const upstream = await platformFetch(`/scheduler/queue/${req.params.id}`, { method: 'DELETE' });
      const data = await upstream.json();
      if (!upstream.ok) { res.status(upstream.status).json(data); return; }
      res.json(data);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // History
  router.get('/api/scheduler/history', proxy('/scheduler/history'));

  // Sync post history from platform → local doc frontmatter
  router.post('/api/scheduler/sync', async (_req, res) => {
    try {
      const result = await syncPostHistory();
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Available connections for scheduler
  router.get('/api/scheduler/connections', proxy('/scheduler/connections'));

  // Upload media via connection (proxies to platform)
  router.post('/api/connections/:id/upload-media', async (req, res) => {
    try {
      if (!isAuthenticated()) { res.json({ error: 'Not authenticated' }); return; }
      const upstream = await platformFetch(`/connections/${req.params.id}/upload-media`, {
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

  // --- Autoplugs ---

  // Goals
  router.get('/api/scheduler/autoplugs/goals', proxy('/scheduler/autoplugs/goals'));
  router.post('/api/scheduler/autoplugs/goals', proxy('/scheduler/autoplugs/goals', 'POST'));
  router.patch('/api/scheduler/autoplugs/goals/:id', async (req, res) => {
    try {
      if (!isAuthenticated()) { res.json({ error: 'Not authenticated' }); return; }
      const upstream = await platformFetch(`/scheduler/autoplugs/goals/${req.params.id}`, {
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
  router.delete('/api/scheduler/autoplugs/goals/:id', async (req, res) => {
    try {
      if (!isAuthenticated()) { res.json({ error: 'Not authenticated' }); return; }
      const upstream = await platformFetch(`/scheduler/autoplugs/goals/${req.params.id}`, { method: 'DELETE' });
      const data = await upstream.json();
      if (!upstream.ok) { res.status(upstream.status).json(data); return; }
      res.json(data);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Pool (per goal)
  router.get('/api/scheduler/autoplugs/goals/:id/pool', async (req, res) => {
    try {
      if (!isAuthenticated()) { res.json({ error: 'Not authenticated' }); return; }
      const upstream = await platformFetch(`/scheduler/autoplugs/goals/${req.params.id}/pool`);
      const data = await upstream.json();
      if (!upstream.ok) { res.status(upstream.status).json(data); return; }
      res.json(data);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });
  router.post('/api/scheduler/autoplugs/goals/:id/pool', async (req, res) => {
    try {
      if (!isAuthenticated()) { res.json({ error: 'Not authenticated' }); return; }
      const upstream = await platformFetch(`/scheduler/autoplugs/goals/${req.params.id}/pool`, {
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
  router.patch('/api/scheduler/autoplugs/pool/:id', async (req, res) => {
    try {
      if (!isAuthenticated()) { res.json({ error: 'Not authenticated' }); return; }
      const upstream = await platformFetch(`/scheduler/autoplugs/pool/${req.params.id}`, {
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
  router.delete('/api/scheduler/autoplugs/pool/:id', async (req, res) => {
    try {
      if (!isAuthenticated()) { res.json({ error: 'Not authenticated' }); return; }
      const upstream = await platformFetch(`/scheduler/autoplugs/pool/${req.params.id}`, { method: 'DELETE' });
      const data = await upstream.json();
      if (!upstream.ok) { res.status(upstream.status).json(data); return; }
      res.json(data);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Rules
  router.get('/api/scheduler/autoplugs/rules', proxy('/scheduler/autoplugs/rules'));
  router.post('/api/scheduler/autoplugs/rules', proxy('/scheduler/autoplugs/rules', 'POST'));
  router.patch('/api/scheduler/autoplugs/rules/:id', async (req, res) => {
    try {
      if (!isAuthenticated()) { res.json({ error: 'Not authenticated' }); return; }
      const upstream = await platformFetch(`/scheduler/autoplugs/rules/${req.params.id}`, {
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
  router.delete('/api/scheduler/autoplugs/rules/:id', async (req, res) => {
    try {
      if (!isAuthenticated()) { res.json({ error: 'Not authenticated' }); return; }
      const upstream = await platformFetch(`/scheduler/autoplugs/rules/${req.params.id}`, { method: 'DELETE' });
      const data = await upstream.json();
      if (!upstream.ok) { res.status(upstream.status).json(data); return; }
      res.json(data);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // AV Key
  router.post('/api/scheduler/autoplugs/av-key', proxy('/scheduler/autoplugs/av-key', 'POST'));
  router.delete('/api/scheduler/autoplugs/av-key', proxy('/scheduler/autoplugs/av-key', 'DELETE'));
  router.get('/api/scheduler/autoplugs/av-key/status', proxy('/scheduler/autoplugs/av-key/status'));

  // Tracking
  router.get('/api/scheduler/autoplugs/tracking', proxy('/scheduler/autoplugs/tracking'));
  router.patch('/api/scheduler/autoplugs/tracking/:id', async (req, res) => {
    try {
      if (!isAuthenticated()) { res.json({ error: 'Not authenticated' }); return; }
      const upstream = await platformFetch(`/scheduler/autoplugs/tracking/${req.params.id}`, {
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

  return router;
}
