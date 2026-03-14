/**
 * Post History Sync — pulls scheduler_history from platform,
 * updates local doc frontmatter with lastPost metadata.
 *
 * The platform is the canonical record for posted items.
 * Local frontmatter is a cached view for sidebar display.
 */

import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import matter from 'gray-matter';
import { filenameByDocId } from './documents.js';
import { getDataDir } from './helpers.js';
import { isAuthenticated, platformFetch } from './connections.js';
import { isExternalDoc } from './helpers.js';

interface HistoryItem {
  id: string;
  content_type: string;
  content: any;
  scheduled_at: string;
  posted_at: string;
  result: { url?: string; success?: boolean; platformId?: string };
  doc_id?: string;
  provider?: string;
}

/**
 * Sync posted history from platform → local doc frontmatter.
 * For each history item with a doc_id:
 *   - Find the local doc by docId
 *   - Check if frontmatter already has a lastPost >= posted_at
 *   - If not, write the appropriate context metadata
 */
export async function syncPostHistory(): Promise<{ synced: number; skipped: number; errors: number }> {
  if (!isAuthenticated()) return { synced: 0, skipped: 0, errors: 0 };

  let items: HistoryItem[];
  try {
    const res = await platformFetch('/scheduler/history');
    if (!res.ok) return { synced: 0, skipped: 0, errors: 0 };
    const data = await res.json() as { items: HistoryItem[] };
    items = data.items || [];
  } catch {
    return { synced: 0, skipped: 0, errors: 0 };
  }

  let synced = 0, skipped = 0, errors = 0;

  for (const item of items) {
    if (!item.doc_id || !item.result?.success || !item.posted_at) {
      skipped++;
      continue;
    }

    try {
      const filename = filenameByDocId(item.doc_id);
      if (!filename) { skipped++; continue; }

      const filePath = isExternalDoc(filename)
        ? filename
        : join(getDataDir(), filename);

      const raw = readFileSync(filePath, 'utf-8');
      const { data, content } = matter(raw);

      // Determine the context key based on content_type/provider
      const provider = item.provider || item.content_type;
      let contextKey: string;
      let lastPostField: string;
      let urlField: string;

      if (provider === 'x' || item.content_type === 'tweet' || item.content_type === 'thread') {
        contextKey = 'tweetContext';
        lastPostField = 'lastPost';
        urlField = 'tweetUrl';
      } else if (provider === 'linkedin' || item.content_type === 'linkedin') {
        contextKey = 'linkedinContext';
        lastPostField = 'lastPost';
        urlField = 'postUrl';
      } else if (item.content_type === 'blog' || provider === 'github') {
        contextKey = 'blogContext';
        lastPostField = 'lastPublish';
        urlField = 'publishUrl';
      } else if (item.content_type === 'newsletter') {
        // Newsletter uses its own sync path
        skipped++;
        continue;
      } else {
        contextKey = 'tweetContext';
        lastPostField = 'lastPost';
        urlField = 'tweetUrl';
      }

      // Check if already synced (existing lastPost >= this posted_at)
      const existingContext = data[contextKey] || {};
      const existingPost = existingContext[lastPostField];
      if (existingPost?.postedAt) {
        const existingTime = new Date(existingPost.postedAt).getTime();
        const newTime = new Date(item.posted_at).getTime();
        if (existingTime >= newTime) { skipped++; continue; }
      }

      // Write updated metadata
      data[contextKey] = {
        ...existingContext,
        [lastPostField]: {
          postedAt: item.posted_at,
          ...(item.result.url ? { [urlField]: item.result.url } : {}),
        },
      };

      const updated = matter.stringify(content, data);
      writeFileSync(filePath, updated, 'utf-8');
      synced++;
    } catch {
      errors++;
    }
  }

  if (synced > 0) {
    console.log(`[PostSync] Synced ${synced} posted items to local docs`);
  }

  return { synced, skipped, errors };
}
