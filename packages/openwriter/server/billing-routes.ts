/**
 * Billing proxy routes — proxies to the publish API's /billing endpoints.
 * Used by the PluginPanel to show plan info and initiate checkout/portal.
 */

import { Router } from 'express';
import { platformFetch, isAuthenticated } from './connections.js';

export function createBillingRouter(): Router {
  const router = Router();

  // GET /api/billing — current plan + limits
  router.get('/api/billing', async (_req, res) => {
    if (!isAuthenticated()) {
      return res.json({ plan: 'free', limits: null, billing: null, authenticated: false });
    }
    try {
      const upstream = await platformFetch('/billing');
      const data = await upstream.json();
      res.json({ ...data as object, authenticated: true });
    } catch {
      res.json({ plan: 'free', limits: null, billing: null, authenticated: false });
    }
  });

  // POST /api/billing/checkout — get Stripe Checkout URL
  router.post('/api/billing/checkout', async (req, res) => {
    if (!isAuthenticated()) return res.status(401).json({ error: 'Not authenticated' });
    try {
      const upstream = await platformFetch('/billing/checkout', {
        method: 'POST',
        body: JSON.stringify(req.body),
      });
      const data = await upstream.json();
      res.status(upstream.status).json(data);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/billing/portal — get Stripe Customer Portal URL
  router.post('/api/billing/portal', async (_req, res) => {
    if (!isAuthenticated()) return res.status(401).json({ error: 'Not authenticated' });
    try {
      const upstream = await platformFetch('/billing/portal', {
        method: 'POST',
        body: JSON.stringify({ return_url: 'http://localhost:5050' }),
      });
      const data = await upstream.json();
      res.status(upstream.status).json(data);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/billing/cancel — cancel subscription
  router.post('/api/billing/cancel', async (_req, res) => {
    if (!isAuthenticated()) return res.status(401).json({ error: 'Not authenticated' });
    try {
      const upstream = await platformFetch('/billing/cancel', { method: 'POST' });
      const data = await upstream.json();
      res.status(upstream.status).json(data);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
