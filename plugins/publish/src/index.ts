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
  return {
    tiptapToMarkdown: markdown.tiptapToMarkdown as (doc: any, title: string, metadata?: Record<string, any>) => string,
    getDocument: state.getDocument as () => any,
    getTitle: state.getTitle as () => string,
    getMetadata: state.getMetadata as () => Record<string, any>,
    getActiveProfile: helpers.getActiveProfile as () => string,
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

/** Make an authenticated request to the Publish API */
async function publishFetch(
  config: Record<string, string>,
  path: string,
  options: RequestInit = {}
): Promise<Response> {
  const baseUrl = config['api-url'] || 'https://publish.openwriter.io';
  const apiKey = config['api-key'];
  const server = getServerModules();
  const profile = server.getActiveProfile();

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
    'X-Profile': profile,
    ...(options.headers as Record<string, string> || {}),
  };

  return fetch(`${baseUrl}${path}`, {
    ...options,
    headers,
  });
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
    return [
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

          const res = await publishFetch(config, `/newsletter/subscribers?limit=${limit}&offset=${offset}`);

          if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            return { error: `Failed to list subscribers: ${(err as any).error || res.statusText}` };
          }

          const data = await res.json() as { subscribers: any[] };

          // Also get count
          const countRes = await publishFetch(config, '/newsletter/subscribers/count');
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
        name: 'setup_domain',
        description:
          'Add a custom sending domain for newsletters. Returns DNS records (CNAME entries) that must be added to your DNS provider for DKIM/SPF verification.',
        inputSchema: {
          type: 'object',
          properties: {
            domain: { type: 'string', description: 'Domain to verify (e.g. "yourdomain.com")' },
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

          const data = await res.json() as { domain: any; dnsRecords: any[]; instructions: string };
          return {
            success: true,
            domainId: data.domain.id,
            domain: data.domain.domain,
            dnsRecords: data.dnsRecords,
            instructions: data.instructions,
            message: `Domain "${data.domain.domain}" added. Add the DNS records below, then use verify_domain to check.`,
          };
        },
      },

      {
        name: 'verify_domain',
        description: 'Check if a custom sending domain has been verified (DNS records propagated).',
        inputSchema: {
          type: 'object',
          properties: {
            domain_id: {
              type: 'string',
              description:
                'Domain ID to verify (from setup_domain). If not provided, lists all domains.',
            },
          },
        },
        handler: async (params) => {
          if (!params.domain_id) {
            // List all domains
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
                dnsRecords: d.dns_records,
              })),
            };
          }

          // Verify specific domain
          const res = await publishFetch(config, `/newsletter/domains/${params.domain_id}/verify`, {
            method: 'POST',
          });

          if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            return { error: `Verification failed: ${(err as any).error || res.statusText}` };
          }

          const data = await res.json() as { verified: boolean; domain: string; message?: string };
          return {
            verified: data.verified,
            domain: data.domain,
            message: data.verified
              ? `Domain "${data.domain}" is verified! Newsletters will send from your custom domain.`
              : `Domain "${data.domain}" is not yet verified. DNS records may still be propagating.`,
          };
        },
      },
    ];
  },
};

export default plugin;
