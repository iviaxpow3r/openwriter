import MarkdownIt from 'markdown-it';
import markdownItIns from 'markdown-it-ins';
import markdownItMark from 'markdown-it-mark';
import markdownItSub from 'markdown-it-sub';
import markdownItSup from 'markdown-it-sup';
// Lazy-load server modules at runtime (same process, resolved from monorepo root)
// Uses dynamic import() since server modules are ESM
const baseDir = new URL('../../../packages/openwriter/dist/server/', import.meta.url).href;

interface ServerModules {
  tiptapToMarkdown: (doc: any, title: string, metadata?: Record<string, any>) => string;
  getDocument: () => any;
  getTitle: () => string;
  getMetadata: () => Record<string, any>;
  getActiveProfile: () => string;
  platformFetch: (path: string, options?: RequestInit) => Promise<Response>;
}

let _cached: ServerModules | null = null;

async function getServerModules(): Promise<ServerModules> {
  if (_cached) return _cached;
  const [markdown, state, helpers, connections] = await Promise.all([
    import(baseDir + 'markdown.js'),
    import(baseDir + 'state.js'),
    import(baseDir + 'helpers.js'),
    import(baseDir + 'connections.js'),
  ]);
  _cached = {
    tiptapToMarkdown: markdown.tiptapToMarkdown,
    getDocument: state.getDocument,
    getTitle: state.getTitle,
    getMetadata: state.getMetadata,
    getActiveProfile: helpers.getActiveProfile,
    platformFetch: connections.platformFetch,
  };
  return _cached;
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

/** Strip YAML frontmatter and TipTap empty markers from markdown output */
function stripFrontmatter(markdown: string): string {
  let result = markdown;
  // Strip YAML frontmatter
  const fmMatch = result.match(/^---\n[\s\S]*?\n---\n\n/);
  if (fmMatch) result = result.slice(fmMatch[0].length);
  // Strip TipTap empty paragraph markers (<!-- -->)
  result = result.replace(/^\s*<!--\s*-->\s*$/gm, '');
  return result.trim();
}

/** Convert current document's TipTap JSON to body HTML + plain text */
async function documentToEmail(): Promise<{ html: string; text: string; subject: string; json: any }> {
  const server = await getServerModules();
  const doc = server.getDocument();
  const title = server.getTitle();
  const metadata = server.getMetadata();

  // TipTap JSON → markdown → strip frontmatter
  const raw = server.tiptapToMarkdown(doc, title, metadata);
  const clean = stripFrontmatter(raw).trim();

  // HTML version: markdown → HTML
  const html = md.render(clean);


  // Plain text version: strip markdown syntax for clean reading
  const text = markdownToPlainText(clean);

  return { html, text, subject: title, json: doc };
}

/** Strip markdown syntax to produce clean plain text for email */
function markdownToPlainText(markdown: string): string {
  const lines = markdown.split('\n');
  const out: string[] = [];
  let inCodeBlock = false;
  let codeLines: string[] = [];

  for (const line of lines) {
    // Code block fences
    if (/^```/.test(line)) {
      if (inCodeBlock) {
        // End fence — flush indented code
        for (const cl of codeLines) out.push('    ' + cl);
        codeLines = [];
        inCodeBlock = false;
      } else {
        inCodeBlock = true;
      }
      continue;
    }

    if (inCodeBlock) {
      codeLines.push(line);
      continue;
    }

    // HTML comments (TipTap empty paragraph markers)
    if (/^\s*<!--.*-->\s*$/.test(line)) continue;

    // Images: strip entirely
    if (/^!\[.*\]\(.*\)\s*$/.test(line)) continue;

    // Table separator rows: |---|---|
    if (/^\|[\s:|-]+\|\s*$/.test(line)) continue;

    // Table data rows: keep pipe-separated text
    if (/^\|(.+)\|\s*$/.test(line)) {
      const cells = line
        .slice(1, -1)
        .split('|')
        .map((c) => stripInline(c.trim()));
      out.push(cells.join(' | '));
      continue;
    }

    // Horizontal rules
    if (/^[-*_]{3,}\s*$/.test(line)) {
      out.push('---');
      continue;
    }

    // Headers: remove # prefix
    const headerMatch = line.match(/^(#{1,6})\s+(.*)/);
    if (headerMatch) {
      out.push(stripInline(headerMatch[2]));
      continue;
    }

    // Blockquotes
    const bqMatch = line.match(/^(>\s?)+(.*)$/);
    if (bqMatch) {
      out.push(stripInline(bqMatch[2]));
      continue;
    }

    // Task lists: preserve checkbox markers
    const taskMatch = line.match(/^(\s*)[-*+]\s+\[([ xX])\]\s+(.*)/);
    if (taskMatch) {
      const indent = taskMatch[1];
      const check = taskMatch[2] === ' ' ? '[ ]' : '[x]';
      out.push(indent + check + ' ' + stripInline(taskMatch[3]));
      continue;
    }

    // Unordered lists: preserve indentation
    const ulMatch = line.match(/^(\s*)[-*+]\s+(.*)/);
    if (ulMatch) {
      out.push(ulMatch[1] + '- ' + stripInline(ulMatch[2]));
      continue;
    }

    // Ordered lists: preserve
    const olMatch = line.match(/^(\s*)(\d+)\.\s+(.*)/);
    if (olMatch) {
      out.push(olMatch[1] + olMatch[2] + '. ' + stripInline(olMatch[3]));
      continue;
    }

    // Regular line — strip inline marks
    out.push(stripInline(line));
  }

  // Flush any unclosed code block
  if (inCodeBlock) {
    for (const cl of codeLines) out.push('    ' + cl);
  }

  return out
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Strip inline markdown marks from a string */
function stripInline(text: string): string {
  return text
    // Images inline: strip entirely
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '')
    // Links: [text](url) → text (url)
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')
    // Inline code
    .replace(/`([^`]+)`/g, '$1')
    // Bold/italic combos: ***text***, ___text___
    .replace(/(\*{3}|_{3})(.+?)\1/g, '$2')
    // Bold: **text**, __text__
    .replace(/(\*{2}|_{2})(.+?)\1/g, '$2')
    // Italic: *text*, _text_
    .replace(/(\*|_)(.+?)\1/g, '$2')
    // Strikethrough: ~~text~~
    .replace(/~~(.+?)~~/g, '$1')
    // Inserted: ++text++
    .replace(/\+\+(.+?)\+\+/g, '$1')
    // Highlighted: ==text==
    .replace(/==(.+?)==/g, '$1')
    // Subscript: ~text~
    .replace(/~([^~]+)~/g, '$1')
    // Superscript: ^text^
    .replace(/\^([^^]+)\^/g, '$1');
}

/** Make an authenticated request to the Publish API via platform proxy */
async function publishFetch(
  _config: Record<string, string>,
  path: string,
  options: RequestInit = {},
): Promise<Response> {
  const server = await getServerModules();
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
        name: 'send_newsletter',
        description:
          'Send the current document as a newsletter. Sends to all subscribers, or to a single test address if test_email is provided.',
        inputSchema: {
          type: 'object',
          properties: {
            subject: {
              type: 'string',
              description: 'Email subject line. Defaults to the document title if not provided.',
            },
            format: {
              type: 'string',
              enum: ['html', 'plaintext'],
              description: 'Email format: "html" (rich formatted) or "plaintext" (plain text only). Defaults to "html".',
            },
            test_email: {
              type: 'string',
              description: 'If provided, sends a test email to this address instead of all subscribers.',
            },
          },
        },
        handler: async (params) => {
          const { html, text, subject: docTitle, json } = await documentToEmail();
          const subject = (params.subject as string) || docTitle;
          const format = (params.format as string) || 'html';
          const testEmail = params.test_email as string | undefined;

          // Read preview text from document metadata
          const server = await getServerModules();
          const metadata = server.getMetadata();
          const previewText = metadata?.newsletterContext?.previewText || undefined;

          // Guard: don't send empty newsletters
          if (!text.trim() && !html.trim()) {
            return { error: 'Newsletter body is empty. Write some content in the editor before sending.' };
          }

          const res = await publishFetch(config, '/newsletter/issues/send', {
            method: 'POST',
            body: JSON.stringify({
              subject,
              content_html: format === 'html' ? html : null,
              content_text: text,
              content_json: json,
              format,
              test_email: testEmail,
              preview_text: previewText,
            }),
          });

          if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            return { error: `Send failed: ${(err as any).error || res.statusText}` };
          }

          const data = await res.json() as { sent?: number; failed?: number; test?: boolean; sent_to?: string };

          if (data.test) {
            return {
              success: true,
              test: true,
              sent_to: data.sent_to,
              message: `Test email sent to ${data.sent_to}.`,
            };
          }

          return {
            success: true,
            sent: data.sent,
            failed: data.failed,
            message: `Newsletter sent to ${data.sent} subscribers.${data.failed && data.failed > 0 ? ` ${data.failed} failed.` : ''}`,
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
            physical_address: {
              type: 'string',
              description: 'Physical mailing address for CAN-SPAM compliance (required before sending). E.g. "123 Main St, Portland, OR 97201"',
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
              physical_address: params.physical_address || undefined,
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
                hasPhysicalAddress: !!d.physical_address,
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
          const server = await getServerModules();
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
            const server = await getServerModules();
            const listRes = await server.platformFetch('/connections');
            if (listRes.ok) {
              const data = await listRes.json() as { connections: any[] };
              const xConn = data.connections.find((c: any) => c.provider === 'x' && c.status === 'active');
              if (xConn) id = xConn.id;
            }
          }

          if (!id) return { error: 'No active X connection found. Connect an X account first.' };

          const server = await getServerModules();
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
            const server = await getServerModules();
            const listRes = await server.platformFetch('/connections');
            if (listRes.ok) {
              const data = await listRes.json() as { connections: any[] };
              const liConn = data.connections.find((c: any) => c.provider === 'linkedin' && c.status === 'active');
              if (liConn) id = liConn.id;
            }
          }

          if (!id) return { error: 'No active LinkedIn connection found. Connect a LinkedIn account first.' };

          const server = await getServerModules();
          const res = await server.platformFetch(`/connections/${id}/post`, {
            method: 'POST',
            body: JSON.stringify({ content: params.content }),
          });

          const data = await res.json();
          if (!res.ok) return { error: `Post failed: ${(data as any).error || res.statusText}` };
          return data;
        },
      },
      // --- Scheduler tools ---

      {
        name: 'schedule_post',
        description: 'Schedule content for posting. Modes: queue (next available slot), now (immediate), custom (specific time).',
        inputSchema: {
          type: 'object',
          properties: {
            content: { type: 'string', description: 'Post content' },
            connection_id: { type: 'string', description: 'Target connection ID (use list_connections to find)' },
            content_type: { type: 'string', enum: ['tweet', 'x', 'linkedin', 'newsletter'], description: 'Content type' },
            mode: { type: 'string', enum: ['queue', 'now', 'custom'], description: 'Scheduling mode (default: queue)' },
            scheduled_at: { type: 'string', description: 'ISO datetime for custom mode' },
          },
          required: ['content', 'content_type'],
        },
        handler: async (params) => {
          const res = await publishFetch(config, '/scheduler/queue', {
            method: 'POST',
            body: JSON.stringify({
              content: params.content,
              content_type: params.content_type,
              connection_id: params.connection_id,
              mode: params.mode || 'queue',
              scheduled_at: params.scheduled_at,
            }),
          });
          const data = await res.json();
          if (!res.ok) return { error: `Schedule failed: ${(data as any).error || res.statusText}` };
          return { success: true, item: data.item, message: `Content scheduled for ${(data as any).item?.scheduled_at}` };
        },
      },

      {
        name: 'list_schedule',
        description: 'Show upcoming queued items with slot times.',
        inputSchema: { type: 'object', properties: {} },
        handler: async () => {
          const res = await publishFetch(config, '/scheduler/queue');
          const data = await res.json();
          if (!res.ok) return { error: `Failed: ${(data as any).error || res.statusText}` };
          return data;
        },
      },

      {
        name: 'manage_schedule',
        description: 'Cancel or reschedule a queued item.',
        inputSchema: {
          type: 'object',
          properties: {
            item_id: { type: 'string', description: 'Queue item ID' },
            action: { type: 'string', enum: ['cancel', 'reschedule'], description: 'Action to take' },
            scheduled_at: { type: 'string', description: 'New ISO datetime (for reschedule)' },
          },
          required: ['item_id', 'action'],
        },
        handler: async (params) => {
          const itemId = params.item_id as string;
          const action = params.action as string;

          if (action === 'cancel') {
            const res = await publishFetch(config, `/scheduler/queue/${itemId}`, { method: 'DELETE' });
            const data = await res.json();
            if (!res.ok) return { error: `Cancel failed: ${(data as any).error || res.statusText}` };
            return { success: true, message: 'Item cancelled' };
          }

          if (action === 'reschedule') {
            if (!params.scheduled_at) return { error: 'scheduled_at required for reschedule' };
            const res = await publishFetch(config, `/scheduler/queue/${itemId}`, {
              method: 'PATCH',
              body: JSON.stringify({ scheduled_at: params.scheduled_at }),
            });
            const data = await res.json();
            if (!res.ok) return { error: `Reschedule failed: ${(data as any).error || res.statusText}` };
            return { success: true, item: (data as any).item };
          }

          return { error: `Unknown action: ${action}` };
        },
      },

      {
        name: 'list_slots',
        description: 'Show all slot templates with filters.',
        inputSchema: { type: 'object', properties: {} },
        handler: async () => {
          const res = await publishFetch(config, '/scheduler/slots');
          const data = await res.json();
          if (!res.ok) return { error: `Failed: ${(data as any).error || res.statusText}` };
          return data;
        },
      },

      {
        name: 'create_slot',
        description: 'Create a scheduling slot template.',
        inputSchema: {
          type: 'object',
          properties: {
            time: { type: 'string', description: 'Time in HH:MM format' },
            days: { type: 'array', items: { type: 'string' }, description: 'Days array (mon, tue, etc.) or ["default"] for every day' },
            filter_type: { type: 'string', enum: ['any', 'content_type', 'connection', 'category'], description: 'Slot filter type (default: any)' },
            filter_value: { type: 'string', description: 'Filter value (content type name or connection ID)' },
            timezone: { type: 'string', description: 'IANA timezone (default: America/New_York)' },
          },
          required: ['time', 'days'],
        },
        handler: async (params) => {
          const body = { ...params };
          if (typeof body.days === 'string') {
            try { body.days = JSON.parse(body.days as string); } catch { /* leave as-is */ }
          }
          const res = await publishFetch(config, '/scheduler/slots', {
            method: 'POST',
            body: JSON.stringify(body),
          });
          const data = await res.json();
          if (!res.ok) return { error: `Failed: ${(data as any).error || res.statusText}` };
          return { success: true, slot: (data as any).slot };
        },
      },

      {
        name: 'edit_slot',
        description: 'Edit a slot template.',
        inputSchema: {
          type: 'object',
          properties: {
            slot_id: { type: 'string', description: 'Slot ID to edit' },
            time: { type: 'string', description: 'New time in HH:MM format' },
            days: { type: 'array', items: { type: 'string' }, description: 'New days array' },
            filter_type: { type: 'string', enum: ['any', 'content_type', 'connection', 'category'] },
            filter_value: { type: 'string' },
            timezone: { type: 'string' },
          },
          required: ['slot_id'],
        },
        handler: async (params) => {
          const { slot_id, ...changes } = params as any;
          const res = await publishFetch(config, `/scheduler/slots/${slot_id}`, {
            method: 'PATCH',
            body: JSON.stringify(changes),
          });
          const data = await res.json();
          if (!res.ok) return { error: `Failed: ${(data as any).error || res.statusText}` };
          return { success: true, ...data };
        },
      },

      {
        name: 'delete_slot',
        description: 'Delete a slot template.',
        inputSchema: {
          type: 'object',
          properties: {
            slot_id: { type: 'string', description: 'Slot ID to delete' },
          },
          required: ['slot_id'],
        },
        handler: async (params) => {
          const res = await publishFetch(config, `/scheduler/slots/${params.slot_id}`, { method: 'DELETE' });
          const data = await res.json();
          if (!res.ok) return { error: `Failed: ${(data as any).error || res.statusText}` };
          return { success: true, ...data };
        },
      },
    ];
  },
};

export default plugin;
