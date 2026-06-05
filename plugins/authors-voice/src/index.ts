/**
 * Author's Voice plugin for OpenWriter.
 * Proxies /api/voice/* to the AV backend and adds editor context-menu items
 * for sub-paragraph text actions (Enhance / Modify / Shrink / Expand / Insert / Fill).
 *
 * Sidebar document transforms (Vary / Shrinkify / Threadify / etc.) live in
 * @openwriter/plugin-publish — they go through the metered platform path.
 */

import type { Express, Request, Response } from 'express';
import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const PLUGIN_NAME = '@openwriter/plugin-authors-voice';

/**
 * Live-read the model tier from ~/.openwriter/config.json per request.
 * The host passes plugin config ONCE at registerRoutes and never reloads it on save, so the
 * dropdown's value would otherwise require a server restart. Reading the file per request
 * makes a model-picker change take effect on the very next Enhance. Falls back to the
 * load-time value on any error.
 */
function liveModelTier(fallback: string): string {
  try {
    const cfg = JSON.parse(readFileSync(join(homedir(), '.openwriter', 'config.json'), 'utf8'));
    const v = cfg?.plugins?.[PLUGIN_NAME]?.config?.model;
    return typeof v === 'string' ? v : fallback;
  } catch {
    return fallback;
  }
}

interface PluginConfigField {
  type: 'string' | 'number' | 'boolean' | 'select';
  required?: boolean;
  env?: string;
  description?: string;
  options?: Array<{ value: string; label: string }>;
}

interface PluginRouteContext {
  app: Express;
  config: Record<string, string>;
}

interface PluginContextMenuItem {
  label: string;
  shortcut?: string;
  action: string;
  condition?: 'has-selection' | 'empty-node' | 'always';
  promptForInput?: boolean;
}

interface OpenWriterPlugin {
  name: string;
  version: string;
  description?: string;
  category?: 'writing' | 'social-media' | 'image-generation';
  configSchema?: Record<string, PluginConfigField>;
  registerRoutes?(ctx: PluginRouteContext): void | Promise<void>;
  contextMenuItems?(): PluginContextMenuItem[];
}

const plugin: OpenWriterPlugin = {
  name: '@openwriter/plugin-authors-voice',
  version: '0.4.0',
  description: "Rewrite text in your voice using Author's Voice",
  category: 'writing',

  configSchema: {
    'api-key': {
      type: 'string',
      required: true,
      env: 'AV_API_KEY',
      description: 'Author\'s Voice API key',
    },
    'backend-url': {
      type: 'string',
      env: 'AV_BACKEND_URL',
      description: 'AV backend URL',
    },
    // Model tier for rewrites. Sent as `modelTier` on /api/voice/* (the AV API owns the
    // tier→model map + default — this is a pure pass-through of the user's pick). Blank =
    // API default (strongest). Labels mirror the API's TIER_PICKER_OPTIONS.
    'model': {
      type: 'select',
      env: 'AV_MODEL_TIER',
      description: 'Writing model',
      options: [
        { value: '', label: 'Default (Strongest)' },
        { value: 'strongest', label: 'Strongest — Claude Opus (best quality)' },
        { value: 'balanced', label: 'Balanced — Claude Sonnet' },
        { value: 'fast-plus', label: 'Fast+ — Gemini 3.5 Flash (newest, great)' },
        { value: 'fast', label: 'Fast — Gemini 2.5 Flash (free)' },
      ],
    },
  },

  registerRoutes(ctx: PluginRouteContext) {
    const backendUrl = ctx.config['backend-url'] || process.env.AV_BACKEND_URL || 'https://authors-voice.com';
    const apiKey = ctx.config['api-key'] || process.env.AV_API_KEY || '';
    const debugEnabled = process.env.AV_DEBUG === '1' || process.env.AV_DEBUG === 'true';
    const modelTier = ctx.config['model'] || process.env.AV_MODEL_TIER || '';

    const authHeaders = (): Record<string, string> => {
      const h: Record<string, string> = { 'Content-Type': 'application/json' };
      if (apiKey) h['Authorization'] = `Bearer ${apiKey}`;
      return h;
    };

    const withDebug = (body: unknown): unknown => {
      if (!debugEnabled || !body || typeof body !== 'object') return body;
      return { ...(body as Record<string, unknown>), debug: true };
    };

    // Inject the user's model-tier pick, read LIVE per request (dropdown changes take effect
    // immediately, no restart). Pure pass-through: the AV API validates the slug and falls
    // back to its own default if absent/unknown. Blank → nothing injected.
    const withModel = (body: unknown): unknown => {
      const tier = liveModelTier(modelTier);
      if (!tier || !body || typeof body !== 'object') return body;
      return { ...(body as Record<string, unknown>), modelTier: tier };
    };

    // Wildcard proxy for /api/voice/* routes. Pure pass-through: the AV API owns the
    // engine choice (v1/v2) via its own AV_DEFAULT_ENGINE setting, so the plugin injects
    // nothing but the optional owner-only dev debug flag.
    ctx.app.post('/api/voice/*', async (req: Request, res: Response) => {
      try {
        const subPath = (req.params as any)[0] || '';
        const targetUrl = `${backendUrl}/api/voice/${subPath}`;
        const body = withModel(withDebug(req.body));
        console.log(`[AV Plugin] ${req.method} ${req.path} → ${targetUrl}`);

        const upstream = await fetch(targetUrl, {
          method: 'POST',
          headers: authHeaders(),
          body: JSON.stringify(body),
        });

        res.status(upstream.status);
        const forwardHeaders = ['x-usage-rewrite-count', 'x-usage-rewrite-limit', 'x-usage-resets-at'];
        for (const h of forwardHeaders) {
          const val = upstream.headers.get(h);
          if (val) res.setHeader(h, val);
        }

        const responseText = await upstream.text();
        try {
          const data = JSON.parse(responseText);
          res.json(data);
        } catch {
          console.error('[AV Plugin] Non-JSON response:', responseText.substring(0, 500));
          res.status(502).json({ error: 'AV backend returned non-JSON response' });
        }
      } catch (err: any) {
        console.error('[AV Plugin] Backend error:', err?.message || err);
        res.status(502).json({ error: 'AV backend unreachable' });
      }
    });

    // Wildcard GET proxy for /api/voice/* — same key-injection + base-URL pattern as the POST
    // proxy above, no body. Covers the wallet/top-up reads (GET /api/voice/billing and
    // /api/voice/billing/topup-options); the matching POST /api/voice/billing/topup rides the
    // POST wildcard. Query string is forwarded so any future paginated read just works.
    ctx.app.get('/api/voice/*', async (req: Request, res: Response) => {
      try {
        const subPath = (req.params as any)[0] || '';
        const qs = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
        const targetUrl = `${backendUrl}/api/voice/${subPath}${qs}`;
        console.log(`[AV Plugin] ${req.method} ${req.path} → ${targetUrl}`);

        const upstream = await fetch(targetUrl, {
          method: 'GET',
          headers: authHeaders(),
        });

        res.status(upstream.status);
        const responseText = await upstream.text();
        try {
          res.json(JSON.parse(responseText));
        } catch {
          console.error('[AV Plugin] Non-JSON response:', responseText.substring(0, 500));
          res.status(502).json({ error: 'AV backend returned non-JSON response' });
        }
      } catch (err: any) {
        console.error('[AV Plugin] Backend error:', err?.message || err);
        res.status(502).json({ error: 'AV backend unreachable' });
      }
    });
  },

  contextMenuItems() {
    return [
      // Selection actions (require highlighted text)
      { label: 'Enhance', shortcut: 'R', action: 'av:rewrite', condition: 'has-selection' as const },
      { label: 'Modify...', action: 'av:custom', condition: 'has-selection' as const, promptForInput: true },
      { label: 'Shrink', shortcut: 'S', action: 'av:shrink', condition: 'has-selection' as const },
      { label: 'Expand', shortcut: 'E', action: 'av:expand', condition: 'has-selection' as const },
      // Empty node actions (cursor on empty line)
      { label: 'Insert', shortcut: 'I', action: 'av:insert', condition: 'empty-node' as const, promptForInput: true },
      { label: 'Fill paragraph', shortcut: 'F', action: 'av:fill', condition: 'empty-node' as const },
      { label: 'Fill sentence', action: 'av:fill-sentence', condition: 'empty-node' as const },
    ];
  },
};

export default plugin;
