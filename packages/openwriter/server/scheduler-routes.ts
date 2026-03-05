/**
 * Scheduler routes — proxy all requests to the platform API.
 */

import { Router } from 'express';
import { platformFetch, isAuthenticated } from './connections.js';

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

  // Available connections for scheduler
  router.get('/api/scheduler/connections', proxy('/scheduler/connections'));

  return router;
}
