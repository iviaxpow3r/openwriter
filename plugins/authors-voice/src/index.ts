/**
 * Author's Voice plugin for OpenWriter.
 * Proxies /api/voice/* to the AV backend and adds context menu items
 * for rewriting, shrinking, expanding, and custom instructions.
 * Also registers sidebar menu items for document-level transforms.
 */

import type { Express, Request, Response } from 'express';

interface PluginConfigField {
  type: 'string' | 'number' | 'boolean';
  required?: boolean;
  env?: string;
  description?: string;
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

interface PluginSidebarMenuItem {
  label: string;
  action: string;
  promptForFocus?: boolean;
}

interface OpenWriterPlugin {
  name: string;
  version: string;
  description?: string;
  category?: 'writing' | 'social-media' | 'image-generation';
  configSchema?: Record<string, PluginConfigField>;
  registerRoutes?(ctx: PluginRouteContext): void | Promise<void>;
  contextMenuItems?(): PluginContextMenuItem[];
  sidebarMenuItems?(): PluginSidebarMenuItem[];
}

/** Simple HTML → markdown conversion for document creation */
function htmlToMarkdown(html: string): string {
  let md = html;
  // <hr> → horizontal rule
  md = md.replace(/<hr\s*\/?>/gi, '\n---\n');
  // <br> → newline
  md = md.replace(/<br\s*\/?>/gi, '\n');
  // <strong>/<b> → **bold**
  md = md.replace(/<(strong|b)>([\s\S]*?)<\/\1>/gi, '**$2**');
  // <em>/<i> → *italic*
  md = md.replace(/<(em|i)>([\s\S]*?)<\/\1>/gi, '*$2*');
  // <p> → paragraph boundaries
  md = md.replace(/<p[^>]*>/gi, '');
  md = md.replace(/<\/p>/gi, '\n\n');
  // Strip remaining tags
  md = md.replace(/<[^>]+>/g, '');
  // Normalize whitespace
  md = md.replace(/\n{3,}/g, '\n\n');
  return md.trim();
}

const plugin: OpenWriterPlugin = {
  name: '@openwriter/plugin-authors-voice',
  version: '0.1.0',
  description: "Rewrite text in your voice using Author's Voice",
  category: 'writing',

  configSchema: {
    'api-key': {
      type: 'string',
      env: 'AV_API_KEY',
      description: 'Author\'s Voice API key',
    },
    'backend-url': {
      type: 'string',
      env: 'AV_BACKEND_URL',
      description: 'AV backend URL',
    },
  },

  registerRoutes(ctx: PluginRouteContext) {
    const backendUrl = ctx.config['backend-url'] || process.env.AV_BACKEND_URL || 'https://authors-voice.com';
    const apiKey = ctx.config['api-key'] || process.env.AV_API_KEY || '';

    const authHeaders = (): Record<string, string> => {
      const h: Record<string, string> = { 'Content-Type': 'application/json' };
      if (apiKey) h['Authorization'] = `Bearer ${apiKey}`;
      return h;
    };

    // Sidebar action handler — must be registered BEFORE the wildcard
    ctx.app.post('/api/voice/sidebar-action', async (req: Request, res: Response) => {
      try {
        const { action, filename, title, instructions, content } = req.body;
        console.log(`[AV Plugin] Sidebar action: ${action} on "${title}"`);

        if (!content) {
          res.status(400).json({ error: 'Document content is required' });
          return;
        }

        // Call AV backend transform endpoint
        const transformUrl = `${backendUrl}/api/voice/transform`;
        const upstream = await fetch(transformUrl, {
          method: 'POST',
          headers: authHeaders(),
          body: JSON.stringify({ action, content, title, instructions }),
        });

        if (!upstream.ok) {
          const errData = await upstream.json().catch(() => ({}));
          console.error('[AV Plugin] Transform failed:', upstream.status, errData);
          res.status(upstream.status).json(errData);
          return;
        }

        const transformResult = await upstream.json() as {
          success: boolean;
          html: string;
          newTitle: string;
          metadata: Record<string, any>;
        };

        // Convert HTML output to markdown for document creation
        const markdownContent = htmlToMarkdown(transformResult.html);

        // Create new document in OpenWriter via internal HTTP call
        const host = req.get('host') || 'localhost:5050';
        const protocol = req.protocol || 'http';
        const createUrl = `${protocol}://${host}/api/documents`;
        const createRes = await fetch(createUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: transformResult.newTitle, content: markdownContent, markPending: true, agentCreated: true }),
        });

        if (!createRes.ok) {
          const errData = await createRes.json().catch(() => ({}));
          console.error('[AV Plugin] Document creation failed:', errData);
          res.status(500).json({ error: 'Failed to create result document' });
          return;
        }

        const docResult = await createRes.json();
        res.json({
          success: true,
          action,
          filename: docResult.filename,
          title: transformResult.newTitle,
          metadata: transformResult.metadata,
        });
      } catch (err: any) {
        console.error('[AV Plugin] Sidebar action error:', err?.message || err);
        res.status(500).json({ error: 'Sidebar action failed' });
      }
    });

    // Wildcard proxy for all other /api/voice/* routes
    ctx.app.post('/api/voice/*', async (req: Request, res: Response) => {
      try {
        const subPath = (req.params as any)[0] || '';
        const targetUrl = `${backendUrl}/api/voice/${subPath}`;
        console.log(`[AV Plugin] ${req.method} ${req.path} → ${targetUrl}`);

        const upstream = await fetch(targetUrl, {
          method: 'POST',
          headers: authHeaders(),
          body: JSON.stringify(req.body),
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

  sidebarMenuItems() {
    return [
      { label: 'Vary', action: 'av:vary', promptForFocus: true },
      { label: 'Shrinkify', action: 'av:shrinkify', promptForFocus: true },
      { label: 'Expandify', action: 'av:expandify', promptForFocus: true },
      { label: 'Threadify', action: 'av:threadify', promptForFocus: true },
      { label: 'Storify', action: 'av:storify', promptForFocus: true },
      { label: 'Emailify', action: 'av:emailify', promptForFocus: true },
      { label: 'Postify', action: 'av:postify', promptForFocus: true },
    ];
  },
};

export default plugin;
