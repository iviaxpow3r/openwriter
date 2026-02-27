/**
 * X API plugin for OpenWriter.
 * Registers routes for checking X connection status and posting tweets.
 * Uses @xdevplatform/xdk with OAuth1 credentials from plugin config.
 */

import type { Express, Request, Response } from 'express';
import { Client, OAuth1 } from '@xdevplatform/xdk';
import { homedir } from 'os';
import { join, extname } from 'path';
import { readFileSync, existsSync } from 'fs';

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

interface OpenWriterPlugin {
  name: string;
  version: string;
  description?: string;
  category?: 'writing' | 'social-media' | 'image-generation';
  configSchema?: Record<string, PluginConfigField>;
  registerRoutes?(ctx: PluginRouteContext): void | Promise<void>;
}

function createXClient(config: Record<string, string>): Client | null {
  const apiKey = config['api-key'] || process.env.X_API_KEY || '';
  const apiSecret = config['api-secret'] || process.env.X_API_SECRET || '';
  const accessToken = config['access-token'] || process.env.X_ACCESS_TOKEN || '';
  const accessTokenSecret = config['access-token-secret'] || process.env.X_ACCESS_TOKEN_SECRET || '';

  if (!apiKey || !apiSecret || !accessToken || !accessTokenSecret) return null;

  const oauth1 = new OAuth1({
    apiKey,
    apiSecret,
    callback: 'oob',
    accessToken,
    accessTokenSecret,
  });

  return new Client({ oauth1 });
}

const plugin: OpenWriterPlugin = {
  name: '@openwriter/plugin-x-api',
  version: '0.1.0',
  description: 'Post tweets from OpenWriter',
  category: 'social-media',

  configSchema: {
    'api-key':             { type: 'string', env: 'X_API_KEY', description: 'X API Key' },
    'api-secret':          { type: 'string', env: 'X_API_SECRET', description: 'X API Secret' },
    'access-token':        { type: 'string', env: 'X_ACCESS_TOKEN', description: 'X Access Token' },
    'access-token-secret': { type: 'string', env: 'X_ACCESS_TOKEN_SECRET', description: 'X Access Token Secret' },
  },

  registerRoutes(ctx: PluginRouteContext) {
    // GET /api/x/status — check if plugin is configured + authenticated
    ctx.app.get('/api/x/status', async (_req: Request, res: Response) => {
      try {
        const client = createXClient(ctx.config);
        if (!client) {
          res.json({ connected: false });
          return;
        }

        const me = await client.users.getMe();
        const username = (me as any)?.data?.username;
        res.json({ connected: true, username: username || undefined });
      } catch (err: any) {
        console.error('[X Plugin] Status check failed:', err.message);
        res.json({ connected: false, error: err.message });
      }
    });

    // POST /api/x/post — post a tweet (with optional media)
    ctx.app.post('/api/x/post', async (req: Request, res: Response) => {
      try {
        const { text, replyTo, quoteTweetId, mediaIds } = req.body;

        if ((!text || typeof text !== 'string') && (!Array.isArray(mediaIds) || mediaIds.length === 0)) {
          res.status(400).json({ success: false, error: 'text or mediaIds is required' });
          return;
        }

        if (mediaIds && (!Array.isArray(mediaIds) || mediaIds.length > 4)) {
          res.status(400).json({ success: false, error: 'mediaIds must be an array of 1-4 IDs' });
          return;
        }

        const client = createXClient(ctx.config);
        if (!client) {
          res.status(400).json({ success: false, error: 'X API credentials not configured' });
          return;
        }

        const body: { text?: string; reply?: Record<string, any>; quoteTweetId?: string; media?: Record<string, any> } = {};

        if (text) body.text = text;

        if (replyTo) {
          body.reply = { inReplyToTweetId: replyTo };
        }
        if (quoteTweetId) {
          body.quoteTweetId = quoteTweetId;
        }
        if (mediaIds && mediaIds.length > 0) {
          body.media = { media_ids: mediaIds };
        }

        const result = await client.posts.create(body);
        const tweetId = (result as any)?.data?.id;
        const tweetUrl = tweetId ? `https://x.com/i/status/${tweetId}` : undefined;

        res.json({ success: true, tweetId, tweetUrl });
      } catch (err: any) {
        console.error('[X Plugin] Post failed:', err.message);
        res.status(500).json({ success: false, error: err.message });
      }
    });

    // POST /api/x/post-thread — post a full thread as a reply chain (with optional media per tweet)
    ctx.app.post('/api/x/post-thread', async (req: Request, res: Response) => {
      try {
        const { tweets, replyTo } = req.body;

        if (!Array.isArray(tweets) || tweets.length === 0) {
          res.status(400).json({ success: false, error: 'tweets must be a non-empty array' });
          return;
        }

        // Normalize: accept string[] or { text, mediaIds? }[]
        const normalized = tweets.map((t: string | { text: string; mediaIds?: string[] }) =>
          typeof t === 'string' ? { text: t, mediaIds: undefined } : t
        );

        // Validate character limits
        const CHAR_LIMIT = 280;
        const overLimit = normalized.map((t, i) => ({ i, len: t.text.length })).filter(x => x.len > CHAR_LIMIT);
        if (overLimit.length > 0) {
          res.status(400).json({
            success: false,
            error: `${overLimit.length} tweet(s) exceed ${CHAR_LIMIT} chars: ${overLimit.map(x => `#${x.i + 1} (${x.len})`).join(', ')}`,
          });
          return;
        }

        // Validate mediaIds per tweet
        for (let i = 0; i < normalized.length; i++) {
          const ids = normalized[i].mediaIds;
          if (ids && (!Array.isArray(ids) || ids.length > 4)) {
            res.status(400).json({ success: false, error: `Tweet ${i + 1}: mediaIds must be an array of 1-4 IDs` });
            return;
          }
        }

        const client = createXClient(ctx.config);
        if (!client) {
          res.status(400).json({ success: false, error: 'X API credentials not configured' });
          return;
        }

        const postedTweets: { index: number; tweetId: string; text: string }[] = [];
        let previousTweetId: string | undefined = replyTo;

        for (let i = 0; i < normalized.length; i++) {
          const { text, mediaIds } = normalized[i];
          const body: { text?: string; reply?: Record<string, any>; media?: Record<string, any> } = {};

          if (text) body.text = text;

          if (previousTweetId) {
            body.reply = { inReplyToTweetId: previousTweetId };
          }

          if (mediaIds && mediaIds.length > 0) {
            body.media = { media_ids: mediaIds };
          }

          const result = await client.posts.create(body);
          const tweetId = (result as any)?.data?.id;

          if (!tweetId) {
            res.status(500).json({
              success: false,
              postedTweets,
              failedAt: i,
              error: `Tweet ${i + 1} posted but no ID returned`,
            });
            return;
          }

          postedTweets.push({ index: i, tweetId, text });
          previousTweetId = tweetId;
        }

        // Build thread URL from first tweet
        const firstTweetId = postedTweets[0]?.tweetId;
        const threadUrl = firstTweetId ? `https://x.com/i/status/${firstTweetId}` : undefined;

        console.log(`[X Plugin] Thread posted: ${postedTweets.length} tweets, ${threadUrl}`);
        res.json({ success: true, postedTweets, threadUrl });
      } catch (err: any) {
        console.error('[X Plugin] Post thread failed:', err.message);
        res.status(500).json({ success: false, error: err.message });
      }
    });
    // POST /api/x/upload-media — upload a local /_images/ file for tweet attachment
    ctx.app.post('/api/x/upload-media', async (req: Request, res: Response) => {
      try {
        const { src } = req.body;

        if (!src || typeof src !== 'string') {
          res.status(400).json({ success: false, error: 'src is required' });
          return;
        }

        // Security: only allow /_images/ paths, no traversal
        if (!/^\/_images\/[^/\\]+$/.test(src)) {
          res.status(400).json({ success: false, error: 'Invalid image path — must be /_images/<filename>' });
          return;
        }

        const filename = src.replace('/_images/', '');
        const filePath = join(homedir(), '.openwriter', '_images', filename);

        if (!existsSync(filePath)) {
          res.status(404).json({ success: false, error: `Image not found: ${filename}` });
          return;
        }

        type MediaMime = 'image/jpeg' | 'image/png' | 'image/webp' | 'image/bmp' | 'image/tiff';
        const ext = extname(filename).toLowerCase();
        const mimeMap: Record<string, MediaMime> = {
          '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
          '.png': 'image/png', '.webp': 'image/webp',
          '.gif': 'image/jpeg', '.bmp': 'image/bmp',
          '.tiff': 'image/tiff', '.tif': 'image/tiff',
        };
        const mediaType: MediaMime = mimeMap[ext] || 'image/jpeg';

        const client = createXClient(ctx.config);
        if (!client) {
          res.status(400).json({ success: false, error: 'X API credentials not configured' });
          return;
        }

        const media = readFileSync(filePath);
        const uploadResult = await client.media.upload({
          body: { media, mediaCategory: 'tweet_image', mediaType },
        });
        const mediaId = (uploadResult as any)?.media_id_string;

        if (!mediaId) {
          res.status(500).json({ success: false, error: 'Upload succeeded but no media ID returned' });
          return;
        }

        console.log(`[X Plugin] Media uploaded: ${filename} → ${mediaId}`);
        res.json({ success: true, mediaId });
      } catch (err: any) {
        console.error('[X Plugin] Media upload failed:', err.message);
        res.status(500).json({ success: false, error: err.message });
      }
    });
  },
};

export default plugin;
