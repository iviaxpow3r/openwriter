/**
 * HTTP routes for connection CRUD + profile binding toggles.
 */

import { Router } from 'express';
import { listConnections, getConnection, createConnection, updateConnection, deleteConnection, getActiveConnections, toggleProfileBinding, readConnections } from './connections.js';
import { getActiveProfile } from './helpers.js';

export function createConnectionRouter(): Router {
  const router = Router();

  // All connections + active IDs for a profile (defaults to current)
  router.get('/api/connections', (req, res) => {
    try {
      const profile = (req.query.profile as string) || getActiveProfile();
      const data = readConnections();
      const activeIds = data.profileBindings[profile] || [];
      res.json({ connections: data.connections, activeIds });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Active connections for current profile, optionally filtered by type
  router.get('/api/connections/active', (req, res) => {
    try {
      const profile = (req.query.profile as string) || getActiveProfile();
      const type = req.query.type as string | undefined;
      const conns = getActiveConnections(profile, type as any);
      res.json({ connections: conns });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/api/connections', (req, res) => {
    try {
      const { type, name, credentials } = req.body;
      if (!type || !name || !credentials) {
        res.status(400).json({ error: 'type, name, and credentials are required' });
        return;
      }
      const conn = createConnection(type, name, credentials);
      res.json({ connection: conn });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  router.put('/api/connections/:id', (req, res) => {
    try {
      const { name, credentials } = req.body;
      const conn = updateConnection(req.params.id, { name, credentials });
      res.json({ connection: conn });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  router.delete('/api/connections/:id', (req, res) => {
    try {
      deleteConnection(req.params.id);
      res.json({ success: true });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  router.post('/api/connections/:id/toggle', (req, res) => {
    try {
      const profile = (req.body.profile as string) || getActiveProfile();
      const active = toggleProfileBinding(profile, req.params.id);
      res.json({ active });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // Test connection credentials by hitting upstream
  router.post('/api/connections/:id/test', async (req, res) => {
    try {
      const conn = getConnection(req.params.id);
      if (!conn) { res.status(404).json({ error: 'Connection not found' }); return; }

      if (conn.type === 'newsletter') {
        const baseUrl = conn.credentials['api-url'] || 'https://publish.openwriter.io';
        const apiKey = conn.credentials['api-key'];
        if (!apiKey) { res.json({ ok: false, error: 'No API key configured' }); return; }

        const upstream = await fetch(`${baseUrl}/newsletter/subscribers/count`, {
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
        });
        if (upstream.ok) {
          const data = await upstream.json() as { count: number };
          res.json({ ok: true, subscriberCount: data.count });
        } else {
          res.json({ ok: false, error: `Upstream returned ${upstream.status}` });
        }
      } else {
        res.json({ ok: false, error: `Unknown connection type: ${conn.type}` });
      }
    } catch (err: any) {
      res.json({ ok: false, error: err.message });
    }
  });

  return router;
}
