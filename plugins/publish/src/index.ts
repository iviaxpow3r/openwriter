import MarkdownIt from 'markdown-it';
import markdownItIns from 'markdown-it-ins';
import markdownItMark from 'markdown-it-mark';
import markdownItSub from 'markdown-it-sub';
import markdownItSup from 'markdown-it-sup';
import { createRequire } from 'module';

// Lazy-load server modules at runtime (same process, resolved from monorepo root)
const require_ = createRequire(import.meta.url);

function getServerModules() {
  const markdown = require_('../../packages/openwriter/server/markdown.js');
  const state = require_('../../packages/openwriter/server/state.js');
  const helpers = require_('../../packages/openwriter/server/helpers.js');
  const connections = require_('../../packages/openwriter/server/connections.js');
  return {
    tiptapToMarkdown: markdown.tiptapToMarkdown as (doc: any, title: string, metadata?: Record<string, any>) => string,
    getDocument: state.getDocument as () => any,
    getTitle: state.getTitle as () => string,
    getMetadata: state.getMetadata as () => Record<string, any>,
    getActiveProfile: helpers.getActiveProfile as () => string,
    platformFetch: connections.platformFetch as (path: string, options?: RequestInit) => Promise<Response>,
  };
}

// Types
interface PluginConfigField {
  type: 'string' | 'number' | 'boolean';
  required?: boolean;
  env?: string;
  description?: string;
}

interface PluginMcpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (params: Record<string, unknown>) => Promise<unknown>;
}

interface OpenWriterPlugin {
  name: string;
  version: string;
  description?: string;
  category?: 'writing' | 'social-media' | 'image-generation' | 'publishing' | 'productivity' | 'analytics';
  configSchema?: Record<string, PluginConfigField>;
  mcpTools?(config: Record<string, string>): PluginMcpTool[];
}

// markdown-it instance matching export-routes.ts configuration
const md = new MarkdownIt({ linkify: false });
md.enable('strikethrough');
md.use(markdownItIns);
md.use(markdownItMark);
md.use(markdownItSub);
md.use(markdownItSup);

/** Strip YAML frontmatter from markdown output */
function stripFrontmatter(markdown: string): string {
  const match = markdown.match(/^---\n[\s\S]*?\n---\n\n/);
  return match ? markdown.slice(match[0].length) : markdown;
}

/** Convert current document's TipTap JSON to body HTML */
function documentToHtml(): { html: string; subject: string; json: any } {
  const server = getServerModules();
  const doc = server.getDocument();
  const title = server.getTitle();
  const metadata = server.getMetadata();

  // TipTap JSON → markdown → strip frontmatter → HTML
  const raw = server.tiptapToMarkdown(doc, title, metadata);
  const clean = stripFrontmatter(raw);
  const html = md.render(clean);

  return { html, subject: title, json: doc };
}

/** Make an authenticated request to the Publish API via platform proxy */
async function publishFetch(
  _config: Record<string, string>,
  path: string,
  options: RequestInit = {},
): Promise<Response> {
  const server = getServerModules();
  return server.platformFetch(path, options);
}

const plugin: OpenWriterPlugin = {
  name: '@openwriter/plugin-publish',
  version: '0.1.0',
  description: 'OpenWriter Publish — newsletter, custom domains, publishing',
  category: 'publishing',

  configSchema: {
    'api-url': {
      type: 'string',
      description: 'Publish API URL',
      env: 'PUBLISH_API_URL',
    },
    'api-key': {
      type: 'string',
      required: true,
      description: 'API key (ow_live_...)',
      env: 'PUBLISH_API_KEY',
    },
  },

  mcpTools(config: Record<string, string>): PluginMcpTool[] {
    const baseUrl = config['api-url'] || 'https://publish.openwriter.io';

    return [
      {
        name: 'request_login_code',
        description:
          'Request a 6-digit verification code sent to the given email. First step of authentication — works for both new signups and key recovery.',
        inputSchema: {
          type: 'object',
          properties: {
            email: { type: 'string', description: 'Email address to send the verification code to' },
          },
          required: ['email'],
        },
        handler: async (params) => {
          const email = params.email as string;
          const res = await fetch(`${baseUrl}/auth/request-code`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email }),
          });

          if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            return { error: `Failed to request code: ${(err as any).error || res.statusText}` };
          }

          const data = await res.json() as { sent: boolean; email: string; expires_in_seconds: number };
          return {
            success: true,
            email: data.email,
            expires_in_seconds: data.expires_in_seconds,
            message: `Verification code sent to ${data.email}. Ask the user for the 6-digit code from their inbox, then call verify_login.`,
          };
        },
      },

      {
        name: 'verify_login',
        description:
          'Verify a 6-digit code and obtain an API key. Second step of authentication. On success, the API key is automatically saved to plugin config.',
        inputSchema: {
          type: 'object',
          properties: {
            email: { type: 'string', description: 'Email address the code was sent to' },
            code: { type: 'string', description: '6-digit verification code from email' },
          },
          required: ['email', 'code'],
        },
        handler: async (params) => {
          const email = params.email as string;
          const code = params.code as string;

          const res = await fetch(`${baseUrl}/auth/verify-code`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, code }),
          });

          if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            return { error: `Verification failed: ${(err as any).error || res.statusText}` };
          }

          const data = await res.json() as { apiKey: string; userId: string };

          // Auto-save API key to plugin config via local API
          try {
            const configRes = await fetch('http://127.0.0.1:5050/api/plugins/config', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                name: '@openwriter/plugin-publish',
                config: { 'api-key': data.apiKey },
              }),
            });

            if (configRes.ok) {
              return {
                success: true,
                userId: data.userId,
                message: 'Authenticated and API key saved to plugin config. You can now use all Publish tools.',
              };
            }
          } catch {
            // Config save failed — fall back to returning key
          }

          return {
            success: true,
            userId: data.userId,
            apiKey: data.apiKey,
            message: 'Authenticated but could not auto-save API key. Please save this key to the plugin config manually.',
          };
        },
      },

      {
        name: 'compose_newsletter',
        description:
          'Create a newsletter draft from the current document. Converts the active document to HTML and sends it to Publish as a draft issue.',
        inputSchema: {
          type: 'object',
          properties: {
            subject: {
              type: 'string',
              description: 'Email subject line. Defaults to the document title if not provided.',
            },
          },
        },
        handler: async (params) => {
          const { html, subject: docTitle, json } = documentToHtml();
          const subject = (params.subject as string) || docTitle;
          const res = await publishFetch(config, '/newsletter/issues', {
            method: 'POST',
            body: JSON.stringify({
              subject,
              content_html: html,
              content_json: json,
            }),
          });

          if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            return { error: `Failed to create draft: ${(err as any).error || res.statusText}` };
          }

          const data = await res.json() as { issue: any; subscriberCount: number };
          return {
            success: true,
            issueId: data.issue.id,
            subject: data.issue.subject,
            status: data.issue.status,
            subscriberCount: data.subscriberCount,
            message: `Draft created: "${data.issue.subject}" — ${data.subscriberCount} subscribers will receive it when sent.`,
          };
        },
      },

      {
        name: 'send_newsletter',
        description: 'Send a draft newsletter issue to all active subscribers immediately.',
        inputSchema: {
          type: 'object',
          properties: {
            issue_id: {
              type: 'string',
              description: 'The issue ID to send (from compose_newsletter).',
            },
          },
          required: ['issue_id'],
        },
        handler: async (params) => {
          const issueId = params.issue_id as string;
          const res = await publishFetch(config, `/newsletter/issues/${issueId}/send`, {
            method: 'POST',
          });

          if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            return { error: `Send failed: ${(err as any).error || res.statusText}` };
          }

          const data = await res.json() as { sent: number; failed: number };
          return {
            success: true,
            sent: data.sent,
            failed: data.failed,
            message: `Newsletter sent to ${data.sent} subscribers.${data.failed > 0 ? ` ${data.failed} failed.` : ''}`,
          };
        },
      },

      {
        name: 'list_subscribers',
        description: 'List newsletter subscribers for the active profile.',
        inputSchema: {
          type: 'object',
          properties: {
            limit: { type: 'number', description: 'Max subscribers to return (default 100)' },
            offset: { type: 'number', description: 'Pagination offset (default 0)' },
          },
        },
        handler: async (params) => {
          const limit = (params.limit as number) || 100;
          const offset = (params.offset as number) || 0;
          const res = await publishFetch(config, `/newsletter/subscribers?limit=${limit}&offset=${offset}`, {});

          if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            return { error: `Failed to list subscribers: ${(err as any).error || res.statusText}` };
          }

          const data = await res.json() as { subscribers: any[] };

          // Also get count
          const countRes = await publishFetch(config, '/newsletter/subscribers/count', {});
          const countData = countRes.ok
            ? (await countRes.json() as { count: number })
            : { count: data.subscribers.length };

          return {
            count: countData.count,
            subscribers: data.subscribers.map((s: any) => ({
              id: s.id,
              email: s.email,
              name: s.name,
              subscribedAt: s.subscribed_at,
            })),
          };
        },
      },

      {
        name: 'add_subscriber',
        description: 'Add a subscriber to the newsletter for the active profile.',
        inputSchema: {
          type: 'object',
          properties: {
            email: { type: 'string', description: 'Subscriber email address' },
            name: { type: 'string', description: 'Subscriber name (optional)' },
          },
          required: ['email'],
        },
        handler: async (params) => {
          const connId = params.connectionId as string | undefined;
          const res = await publishFetch(config, '/newsletter/subscribers', {
            method: 'POST',
            body: JSON.stringify({
              email: params.email,
              name: params.name || undefined,
            }),
          });

          if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            return { error: `Failed to add subscriber: ${(err as any).error || res.statusText}` };
          }

          const data = await res.json() as { subscriber: any };
          return {
            success: true,
            subscriber: data.subscriber,
            message: `Added ${data.subscriber.email} to newsletter.`,
          };
        },
      },

      {
        name: 'setup_custom_domain',
        description:
          'Set up a custom sending domain for newsletters. Automatically handles SendGrid domain auth, DNS records (auto-added for Cloudflare domains), and sender verification. Follow the next_action field in the response.',
        inputSchema: {
          type: 'object',
          properties: {
            domain: { type: 'string', description: 'Domain to set up (e.g. "yourdomain.com")' },
            from_email: {
              type: 'string',
              description: 'From email address (e.g. "newsletter@yourdomain.com")',
            },
            from_name: {
              type: 'string',
              description: 'From display name (e.g. "Your Newsletter")',
            },
          },
          required: ['domain', 'from_email'],
        },
        handler: async (params) => {
          const res = await publishFetch(config, '/newsletter/domains', {
            method: 'POST',
            body: JSON.stringify({
              domain: params.domain,
              from_email: params.from_email,
              from_name: params.from_name || undefined,
            }),
          });

          if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            return { error: `Failed to setup domain: ${(err as any).error || res.statusText}` };
          }

          const data = await res.json() as {
            domain: any;
            dnsRecords: any[];
            cloudflare_managed: boolean;
            dns_auto_added: boolean;
            sender_verification_sent: boolean;
            next_action: string;
          };
          return {
            success: true,
            domainId: data.domain.id,
            domain: data.domain.domain,
            dnsRecords: data.dnsRecords,
            cloudflare_managed: data.cloudflare_managed,
            dns_auto_added: data.dns_auto_added,
            sender_verification_sent: data.sender_verification_sent,
            next_action: data.next_action,
          };
        },
      },

      {
        name: 'check_domain_status',
        description:
          'Check if a custom domain is fully ready (DNS verified + sender verified). If domain_id omitted, lists all domains with their status.',
        inputSchema: {
          type: 'object',
          properties: {
            domain_id: {
              type: 'string',
              description: 'Domain ID to check (from setup_custom_domain). Omit to list all domains.',
            },
          },
        },
        handler: async (params) => {
          if (!params.domain_id) {
            const res = await publishFetch(config, '/newsletter/domains');
            if (!res.ok) {
              const err = await res.json().catch(() => ({}));
              return { error: `Failed to list domains: ${(err as any).error || res.statusText}` };
            }
            const data = await res.json() as { domains: any[] };
            return {
              domains: data.domains.map((d: any) => ({
                id: d.id,
                domain: d.domain,
                fromEmail: d.from_email,
                status: d.status,
                senderStatus: d.sender_status,
                cloudflareManaged: d.cloudflare_managed,
              })),
            };
          }

          const res = await publishFetch(config, `/newsletter/domains/${params.domain_id}/verify`, {
            method: 'POST',
          });

          if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            return { error: `Status check failed: ${(err as any).error || res.statusText}` };
          }

          const data = await res.json() as {
            domain: string;
            dns_verified: boolean;
            sender_verified: boolean;
            fully_ready: boolean;
            next_action: string;
          };
          return {
            domain: data.domain,
            dns_verified: data.dns_verified,
            sender_verified: data.sender_verified,
            fully_ready: data.fully_ready,
            next_action: data.next_action,
          };
        },
      },

      {
        name: 'resend_domain_verification',
        description:
          'Resend the SendGrid sender verification email for a custom domain. Use when the user did not receive or cannot find the original verification email.',
        inputSchema: {
          type: 'object',
          properties: {
            domain_id: {
              type: 'string',
              description: 'Domain ID to resend verification for.',
            },
          },
          required: ['domain_id'],
        },
        handler: async (params) => {
          const res = await publishFetch(config, `/newsletter/domains/${params.domain_id}/resend-verification`, {
            method: 'POST',
          });

          if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            return { error: `Resend failed: ${(err as any).error || res.statusText}` };
          }

          const data = await res.json() as { success: boolean; message: string };
          return {
            success: true,
            message: data.message,
          };
        },
      },

      {
        name: 'list_connections',
        description: 'List all connected accounts (X, LinkedIn, newsletter domains) for the active profile.',
        inputSchema: { type: 'object', properties: {} },
        handler: async () => {
          const server = getServerModules();
          const res = await server.platformFetch('/connections/unified');
          if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            return { error: `Failed to list connections: ${(err as any).error || res.statusText}` };
          }
          const data = await res.json() as { connections: any[] };
          return {
            connections: data.connections.map((c: any) => ({
              id: c.id,
              provider: c.provider,
              display_name: c.display_name,
              status: c.status,
            })),
          };
        },
      },

      {
        name: 'post_to_x',
        description: 'Post content to X (Twitter) via a connected account. Requires an active X connection.',
        inputSchema: {
          type: 'object',
          properties: {
            content: { type: 'string', description: 'Tweet text (max 280 characters)' },
            connection_id: { type: 'string', description: 'X connection ID. If omitted, uses the first active X connection.' },
          },
          required: ['content'],
        },
        handler: async (params) => {
          const connectionId = params.connection_id as string | undefined;
          let id = connectionId;

          if (!id) {
            const server = getServerModules();
            const listRes = await server.platformFetch('/connections');
            if (listRes.ok) {
              const data = await listRes.json() as { connections: any[] };
              const xConn = data.connections.find((c: any) => c.provider === 'x' && c.status === 'active');
              if (xConn) id = xConn.id;
            }
          }

          if (!id) return { error: 'No active X connection found. Connect an X account first.' };

          const server = getServerModules();
          const res = await server.platformFetch(`/connections/${id}/post`, {
            method: 'POST',
            body: JSON.stringify({ content: params.content }),
          });

          const data = await res.json();
          if (!res.ok) return { error: `Post failed: ${(data as any).error || res.statusText}` };
          return data;
        },
      },

      {
        name: 'post_to_linkedin',
        description: 'Post content to LinkedIn via a connected account. Requires an active LinkedIn connection.',
        inputSchema: {
          type: 'object',
          properties: {
            content: { type: 'string', description: 'Post text' },
            connection_id: { type: 'string', description: 'LinkedIn connection ID. If omitted, uses the first active LinkedIn connection.' },
          },
          required: ['content'],
        },
        handler: async (params) => {
          const connectionId = params.connection_id as string | undefined;
          let id = connectionId;

          if (!id) {
            const server = getServerModules();
            const listRes = await server.platformFetch('/connections');
            if (listRes.ok) {
              const data = await listRes.json() as { connections: any[] };
              const liConn = data.connections.find((c: any) => c.provider === 'linkedin' && c.status === 'active');
              if (liConn) id = liConn.id;
            }
          }

          if (!id) return { error: 'No active LinkedIn connection found. Connect a LinkedIn account first.' };

          const server = getServerModules();
          const res = await server.platformFetch(`/connections/${id}/post`, {
            method: 'POST',
            body: JSON.stringify({ content: params.content }),
          });

          const data = await res.json();
          if (!res.ok) return { error: `Post failed: ${(data as any).error || res.statusText}` };
          return data;
        },
      },
    ];
  },
};

export default plugin;
