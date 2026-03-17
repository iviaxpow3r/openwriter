import { readFileSync } from 'fs';
import type { PluginMcpTool } from './helpers.js';
import {
  getServerModules,
  documentToEmail,
  extractLocalImages,
  publishFetch,
} from './helpers.js';

export function newsletterTools(config: Record<string, string>): PluginMcpTool[] {
  return [
    {
      name: 'send_newsletter',
      description:
        'Send the current document as a newsletter. Sends to all subscribers, or to a single test address if test_email is provided. Supports subscriber selection via subscriber_ids or exclude_issue_id.',
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
          subscriber_ids: {
            type: 'array',
            items: { type: 'string' },
            description: 'Send only to these subscriber IDs (use list_subscribers to find IDs).',
          },
          exclude_issue_id: {
            type: 'string',
            description: 'Send to subscribers who did NOT receive this issue (use list_newsletter_issues to find issue IDs). For "send to remaining" after a partial send.',
          },
        },
      },
      handler: async (params) => {
        const { html, text, subject: docTitle, json } = await documentToEmail();
        const subject = (params.subject as string) || docTitle;
        const format = (params.format as string) || 'html';
        const testEmail = params.test_email as string | undefined;
        let subscriberIds = params.subscriber_ids as string[] | string | undefined;
        if (typeof subscriberIds === 'string') {
          try { subscriberIds = JSON.parse(subscriberIds); } catch { subscriberIds = undefined; }
        }
        const excludeIssueId = params.exclude_issue_id as string | undefined;

        const server = await getServerModules();
        const metadata = server.getMetadata();
        const previewText = metadata?.newsletterContext?.previewText || undefined;

        if (!text.trim() && !html.trim()) {
          return { error: 'Newsletter body is empty. Write some content in the editor before sending.' };
        }

        const images = format === 'html' && html ? await extractLocalImages(html) : [];
        const docId = server.getDocId();

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
            images,
            document_id: docId || undefined,
            subscriber_ids: subscriberIds,
            exclude_issue_id: excludeIssueId,
          }),
        });

        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          return { error: `Send failed: ${(err as any).error || res.statusText}` };
        }

        const data = await res.json() as { sent?: number; failed?: number; test?: boolean; sent_to?: string; issueId?: string };

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
          issueId: data.issueId,
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
      name: 'import_subscribers',
      description:
        'Bulk import subscribers from a CSV file or pasted CSV text. Supports common export formats from ConvertKit, Mailchimp, Substack, Beehiiv, etc. Auto-detects column names (email/Email Address/email_address, name/first_name+last_name). Skips invalid emails and unsubscribed rows.',
      inputSchema: {
        type: 'object',
        properties: {
          file: {
            type: 'string',
            description: 'Absolute path to a CSV file (e.g. "C:/Users/me/Downloads/subscribers.csv")',
          },
          csv_text: {
            type: 'string',
            description: 'Raw CSV text pasted directly (header row + data rows)',
          },
        },
      },
      handler: async (params) => {
        const filePath = params.file as string | undefined;
        const csvText = params.csv_text as string | undefined;

        if (!filePath && !csvText) {
          return { error: 'Provide either file (path to CSV) or csv_text (raw CSV content)' };
        }

        let raw: string;
        if (filePath) {
          try {
            raw = readFileSync(filePath, 'utf-8');
          } catch (e: any) {
            return { error: `Failed to read file: ${e.message}` };
          }
        } else {
          raw = csvText!;
        }

        // Parse CSV
        const lines = raw.split(/\r?\n/).filter((l) => l.trim());
        if (lines.length < 2) {
          return { error: 'CSV must have a header row and at least one data row' };
        }

        const parseCsvLine = (line: string): string[] => {
          const fields: string[] = [];
          let current = '';
          let inQuotes = false;
          for (let i = 0; i < line.length; i++) {
            const ch = line[i];
            if (ch === '"') {
              if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
              else { inQuotes = !inQuotes; }
            } else if (ch === ',' && !inQuotes) {
              fields.push(current.trim());
              current = '';
            } else {
              current += ch;
            }
          }
          fields.push(current.trim());
          return fields;
        };

        const headers = parseCsvLine(lines[0]).map((h) => h.toLowerCase().replace(/['"]/g, '').trim());

        const emailAliases = ['email', 'email_address', 'email address', 'subscriber_email', 'e-mail', 'contact email'];
        const nameAliases = ['name', 'full_name', 'full name', 'subscriber_name'];
        const firstNameAliases = ['first_name', 'first name', 'firstname', 'first'];
        const lastNameAliases = ['last_name', 'last name', 'lastname', 'last'];
        const statusAliases = ['status', 'state', 'subscription_status'];

        const findCol = (aliases: string[]) => headers.findIndex((h) => aliases.includes(h));
        const emailIdx = findCol(emailAliases);
        const nameIdx = findCol(nameAliases);
        const firstIdx = findCol(firstNameAliases);
        const lastIdx = findCol(lastNameAliases);
        const statusIdx = findCol(statusAliases);

        if (emailIdx === -1) {
          return { error: `Could not find email column. Found headers: ${headers.join(', ')}` };
        }

        const skipStatuses = new Set(['unsubscribed', 'cancelled', 'canceled', 'inactive', 'bounced', 'complained']);
        const subscribers: { email: string; name?: string }[] = [];
        let skippedStatus = 0;

        for (let i = 1; i < lines.length; i++) {
          const fields = parseCsvLine(lines[i]);
          const email = (fields[emailIdx] || '').replace(/['"]/g, '').trim();
          if (!email) continue;

          if (statusIdx !== -1) {
            const status = (fields[statusIdx] || '').replace(/['"]/g, '').trim().toLowerCase();
            if (skipStatuses.has(status)) { skippedStatus++; continue; }
          }

          let name: string | undefined;
          if (nameIdx !== -1) {
            name = (fields[nameIdx] || '').replace(/['"]/g, '').trim() || undefined;
          } else if (firstIdx !== -1) {
            const first = (fields[firstIdx] || '').replace(/['"]/g, '').trim();
            const last = lastIdx !== -1 ? (fields[lastIdx] || '').replace(/['"]/g, '').trim() : '';
            name = [first, last].filter(Boolean).join(' ') || undefined;
          }

          subscribers.push({ email, ...(name ? { name } : {}) });
        }

        if (subscribers.length === 0) {
          return { error: `No valid subscribers found. ${skippedStatus} skipped (unsubscribed/inactive).` };
        }

        const res = await publishFetch(config, '/newsletter/subscribers/import', {
          method: 'POST',
          body: JSON.stringify({ subscribers }),
        });

        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          return { error: `Import failed: ${(err as any).error || res.statusText}` };
        }

        const data = (await res.json()) as { imported: number; skipped: number; total: number };
        return {
          success: true,
          imported: data.imported,
          skippedInvalid: data.skipped,
          skippedStatus,
          total: subscribers.length + skippedStatus,
          message: `Imported ${data.imported} subscribers.${skippedStatus ? ` ${skippedStatus} skipped (unsubscribed/inactive).` : ''}${data.skipped ? ` ${data.skipped} skipped (invalid email).` : ''}`,
        };
      },
    },

    {
      name: 'resend_to_unopened',
      description:
        'Resend a newsletter issue to subscribers who didn\'t open it. Uses a new subject line but the same email body. Can only be done once per issue. Best practice: wait 48-72 hours after original send.',
      inputSchema: {
        type: 'object',
        properties: {
          issue_id: { type: 'string', description: 'Newsletter issue ID to resend (from list_newsletter_issues)' },
          subject: { type: 'string', description: 'New subject line for the resend (tip: try a different angle)' },
        },
        required: ['issue_id', 'subject'],
      },
      handler: async (params) => {
        const issueId = params.issue_id as string;
        const subject = params.subject as string;

        const res = await publishFetch(config, `/newsletter/issues/${issueId}/resend`, {
          method: 'POST',
          body: JSON.stringify({ subject }),
        });

        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          return { error: `Resend failed: ${(err as any).error || res.statusText}` };
        }

        const data = await res.json() as { sent: number; failed: number; non_openers: number };
        return {
          success: true,
          sent: data.sent,
          failed: data.failed,
          non_openers: data.non_openers,
          message: `Resent to ${data.sent} non-openers with new subject: "${subject}".${data.failed > 0 ? ` ${data.failed} failed.` : ''}`,
        };
      },
    },

    {
      name: 'list_newsletter_issues',
      description: 'List past newsletter sends with open/click stats. Returns issue IDs needed for get_newsletter_analytics and send_newsletter exclude_issue_id.',
      inputSchema: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'Max issues to return (default 20, max 200)' },
        },
      },
      handler: async (params) => {
        const limit = Math.min((params.limit as number) || 20, 200);
        const res = await publishFetch(config, `/newsletter/issues?limit=${limit}`);

        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          return { error: `Failed to list issues: ${(err as any).error || res.statusText}` };
        }

        const data = await res.json() as { issues: any[] };
        return {
          issues: data.issues.map((i: any) => ({
            id: i.id,
            subject: i.subject,
            status: i.status,
            sent_at: i.sent_at,
            recipient_count: i.recipient_count,
            unique_opens: i.unique_opens,
            unique_clicks: i.unique_clicks,
          })),
        };
      },
    },

    {
      name: 'get_newsletter_analytics',
      description: 'Get detailed analytics for a specific newsletter issue. Shows delivery stats, per-subscriber event breakdown, and recipient list.',
      inputSchema: {
        type: 'object',
        properties: {
          issue_id: { type: 'string', description: 'Newsletter issue ID (from list_newsletter_issues)' },
        },
        required: ['issue_id'],
      },
      handler: async (params) => {
        const issueId = params.issue_id as string;
        const res = await publishFetch(config, `/newsletter/issues/${issueId}/analytics`);

        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          return { error: `Failed to get analytics: ${(err as any).error || res.statusText}` };
        }

        return await res.json();
      },
    },
    {
      name: 'get_subscribe_embed',
      description:
        'Get the public subscribe URL and embed code for the active profile. Returns an HTML form snippet (works without JS) and a JS fetch snippet. Use this to help users set up newsletter signup forms on their websites.',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        const res = await publishFetch(config, '/newsletter/subscribers/embed-info');

        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          return { error: `Failed: ${(err as any).error || res.statusText}` };
        }

        const data = await res.json();
        return {
          ...(data as object),
          instructions: [
            'HTML Form: Paste embed_html into any page. Replace YOUR_THANK_YOU_PAGE_URL. Works without JavaScript.',
            'JS Fetch: Use embed_js for AJAX submissions (no page reload). Returns { success: true } on success.',
            'hp_field is a honeypot — keep it hidden and empty.',
            'Set source to identify each form placement (e.g. "homepage", "footer", "blog-sidebar").',
          ].join('\n'),
        };
      },
    },
  ];
}
