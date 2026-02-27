/**
 * X API plugin for OpenWriter.
 * Registers routes for checking X connection status and posting tweets.
 * Uses @xdevplatform/xdk with OAuth1 credentials from plugin config.
 */

import type { Express, Request, Response } from 'express';
import { Client, OAuth1 } from '@xdevplatform/xdk';

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

    // POST /api/x/post — post a tweet
    ctx.app.post('/api/x/post', async (req: Request, res: Response) => {
      try {
        const { text, replyTo, quoteTweetId } = req.body;

        if (!text || typeof text !== 'string') {
          res.status(400).json({ success: false, error: 'text is required' });
          return;
        }

        const client = createXClient(ctx.config);
        if (!client) {
          res.status(400).json({ success: false, error: 'X API credentials not configured' });
          return;
        }

        const body: { text: string; reply?: Record<string, any>; quoteTweetId?: string } = { text };

        if (replyTo) {
          body.reply = { inReplyToTweetId: replyTo };
        }
        if (quoteTweetId) {
          body.quoteTweetId = quoteTweetId;
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

    // POST /api/x/post-thread — post a full thread as a reply chain
    ctx.app.post('/api/x/post-thread', async (req: Request, res: Response) => {
      try {
        const { tweets } = req.body;

        if (!Array.isArray(tweets) || tweets.length === 0) {
          res.status(400).json({ success: false, error: 'tweets must be a non-empty array of strings' });
          return;
        }

        // Validate all tweets are within limit before posting anything
        const CHAR_LIMIT = 280;
        const overLimit = tweets.map((t: string, i: number) => ({ i, len: t.length })).filter((x: { i: number; len: number }) => x.len > CHAR_LIMIT);
        if (overLimit.length > 0) {
          res.status(400).json({
            success: false,
            error: `${overLimit.length} tweet(s) exceed ${CHAR_LIMIT} chars: ${overLimit.map((x: { i: number; len: number }) => `#${x.i + 1} (${x.len})`).join(', ')}`,
          });
          return;
        }

        const client = createXClient(ctx.config);
        if (!client) {
          res.status(400).json({ success: false, error: 'X API credentials not configured' });
          return;
        }

        const postedTweets: { index: number; tweetId: string; text: string }[] = [];
        let previousTweetId: string | undefined;

        for (let i = 0; i < tweets.length; i++) {
          const text = tweets[i];
          const body: { text: string; reply?: Record<string, any> } = { text };

          if (previousTweetId) {
            body.reply = { inReplyToTweetId: previousTweetId };
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
  },
};

export default plugin;
