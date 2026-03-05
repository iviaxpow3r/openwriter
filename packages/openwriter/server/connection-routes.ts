/**
 * Connection routes — proxy all requests to the platform API.
 * Local app no longer stores connections.
 */

import { Router } from 'express';
import { platformFetch, isAuthenticated } from './connections.js';

export function createConnectionRouter(): Router {
  const router = Router();

  // Unified connections list (OAuth + newsletter domains)
  router.get('/api/connections', async (req, res) => {
    try {
      if (!isAuthenticated()) {
        res.json({ connections: [] });
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
      const data = await upstream.json();
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

  return router;
}
