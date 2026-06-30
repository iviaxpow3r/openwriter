/**
 * X API plugin for OpenWriter.
 * Registers routes for checking X connection status and posting tweets.
 * Uses @xdevplatform/xdk with OAuth1 credentials from plugin config.
 */

import type { Express, Request, Response } from 'express';
import { Client, OAuth1 } from '@xdevplatform/xdk';

import { join, extname } from 'path';
import { readFileSync, existsSync } from 'fs';
import sharp from 'sharp';
import twitter from 'twitter-text';
import { getServerBridge } from './server-bridge.js';

const { parseTweet } = twitter;

/** X Articles API base. Two-step: draft, then publish. */
const X_API_BASE = 'https://api.x.com/2';

interface PluginConfigField {
  type: 'string' | 'number' | 'boolean';
  required?: boolean;
  env?: string;
  description?: string;
}

interface PluginRouteContext {
  app: Express;
  config: Record<string, string>;
  dataDir: string;
}

interface OpenWriterPlugin {
  name: string;
  version: string;
  description?: string;
  category?: 'writing' | 'social-media' | 'image-generation';
  configSchema?: Record<string, PluginConfigField>;
  registerRoutes?(ctx: PluginRouteContext): void | Promise<void>;
}

/** Build the OAuth1 signer from plugin config / env. Returns null when any of
 *  the four credentials is missing. Shared by the SDK client and the raw
 *  Articles calls (which the SDK doesn't model). */
function createOAuth1(config: Record<string, string>): OAuth1 | null {
  const apiKey = config['api-key'] || process.env.X_API_KEY || '';
  const apiSecret = config['api-secret'] || process.env.X_API_SECRET || '';
  const accessToken = config['access-token'] || process.env.X_ACCESS_TOKEN || '';
  const accessTokenSecret = config['access-token-secret'] || process.env.X_ACCESS_TOKEN_SECRET || '';

  if (!apiKey || !apiSecret || !accessToken || !accessTokenSecret) return null;

  return new OAuth1({
    apiKey,
    apiSecret,
    callback: 'oob',
    accessToken,
    accessTokenSecret,
  });
}

function createXClient(config: Record<string, string>): Client | null {
  const oauth1 = createOAuth1(config);
  if (!oauth1) return null;
  return new Client({ oauth1 });
}

/** Make an OAuth1-signed JSON request to the X API. The SDK has no Articles
 *  resource, so we sign + fetch directly. `buildRequestHeader` correctly
 *  excludes a JSON body from the OAuth1 signature base string. */
async function xApiFetch(
  oauth1: OAuth1,
  method: string,
  path: string,
  body?: Record<string, any>,
): Promise<{ ok: boolean; status: number; data: any }> {
  const url = `${X_API_BASE}${path}`;
  const bodyStr = body ? JSON.stringify(body) : '';
  const authHeader = await oauth1.buildRequestHeader(method, url, bodyStr);
  const headers: Record<string, string> = { Authorization: authHeader };
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(url, { method, headers, body: body ? bodyStr : undefined });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
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
        const detail = err.data ? JSON.stringify(err.data) : err.message;
        console.error('[X Plugin] Post failed:', detail);
        res.status(500).json({ success: false, error: detail });
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

        // Validate character limits using X's weighted counting (emojis=2, URLs=23, CJK=2)
        const CHAR_LIMIT = 25000;
        const overLimit = normalized.map((t, i) => ({ i, len: parseTweet(t.text).weightedLength })).filter(x => x.len > CHAR_LIMIT);
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
        const filePath = join(ctx.dataDir, '_images', filename);

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

        let fileBuffer = readFileSync(filePath);
        let uploadType: MediaMime = mediaType;
        const origSize = fileBuffer.length;

        // Compress large images or PNGs to JPEG to stay under X API limits
        if (fileBuffer.length > 3 * 1024 * 1024 || ext === '.png') {
          fileBuffer = Buffer.from(await sharp(fileBuffer).jpeg({ quality: 85 }).toBuffer());
          uploadType = 'image/jpeg';
          console.log(`[X Plugin] Compressed ${filename}: ${(origSize / 1024 / 1024).toFixed(2)}MB → ${(fileBuffer.length / 1024 / 1024).toFixed(2)}MB`);
        }

        console.log(`[X Plugin] Uploading ${filename}: ${(fileBuffer.length / 1024 / 1024).toFixed(2)}MB, type: ${uploadType}`);
        const mediaBase64 = fileBuffer.toString('base64');
        const uploadResult = await client.media.upload({
          body: { media: mediaBase64, mediaCategory: 'tweet_image', mediaType: uploadType },
        });
        const mediaId = (uploadResult as any)?.data?.id
          || (uploadResult as any)?.media_id_string;

        if (!mediaId) {
          res.status(500).json({ success: false, error: 'Upload succeeded but no media ID returned' });
          return;
        }

        console.log(`[X Plugin] Media uploaded: ${filename} → ${mediaId}`);
        res.json({ success: true, mediaId });
      } catch (err: any) {
        console.error('[X Plugin] Media upload failed:', err.message);
        if (err.response) {
          try {
            const body = await err.response.text();
            console.error('[X Plugin] X API response:', err.response.status, body);
          } catch { /* ignore */ }
        }
        if (err.data) console.error('[X Plugin] Error data:', JSON.stringify(err.data));
        console.error('[X Plugin] Full error:', JSON.stringify(err, Object.getOwnPropertyNames(err)));
        res.status(500).json({ success: false, error: err.message });
      }
    });

    // POST /api/x/post-article — publish the active document as a native X
    // Article. Two-step X flow: draft, then publish. Reads the active server
    // doc (same source the managed/publish path reads) and converts it to X's
    // DraftJS content_state via the shared converter.
    ctx.app.post('/api/x/post-article', async (_req: Request, res: Response) => {
      try {
        const oauth1 = createOAuth1(ctx.config);
        if (!oauth1) {
          res.status(400).json({ success: false, error: 'X API credentials not configured' });
          return;
        }

        const bridge = await getServerBridge();
        const doc = bridge.getDocument();
        const title = (bridge.getTitle() || '').trim();
        const metadata = bridge.getMetadata() || {};

        if (!title || title === 'Untitled') {
          res.status(400).json({ success: false, error: 'Article needs a title before posting.' });
          return;
        }

        const contentState = bridge.tiptapToDraftjs(doc);
        if (!contentState.blocks.some((b: any) => (b.text || '').trim().length > 0)) {
          res.status(400).json({ success: false, error: 'Article body is empty.' });
          return;
        }

        // Optional cover image — upload to X and attach as cover_media.
        let coverMedia: { media_category: string; media_id: string } | undefined;
        const coverSrc = metadata?.articleContext?.coverImage;
        if (coverSrc && typeof coverSrc === 'string' && /^\/_images\/[^/\\]+$/.test(coverSrc)) {
          const client = createXClient(ctx.config);
          if (client) {
            const mediaId = await uploadCoverMedia(client, ctx.dataDir, coverSrc);
            if (mediaId) coverMedia = { media_category: 'TWEET_IMAGE', media_id: mediaId };
          }
        }

        // Step 1 — create the draft.
        const draftBody: Record<string, any> = { title, content_state: contentState };
        if (coverMedia) draftBody.cover_media = coverMedia;
        const draft = await xApiFetch(oauth1, 'POST', '/articles/draft', draftBody);
        if (!draft.ok) {
          const detail = draft.data?.detail || draft.data?.title || JSON.stringify(draft.data);
          console.error('[X Plugin] Article draft failed:', draft.status, detail);
          res.status(draft.status || 500).json({ success: false, error: `Draft failed: ${detail}` });
          return;
        }
        const articleId = draft.data?.data?.id;
        if (!articleId) {
          res.status(500).json({ success: false, error: 'Draft created but no article id returned.' });
          return;
        }

        // Step 2 — publish the draft (makes it public). Surface any error
        // verbatim — a draft is private until this succeeds.
        const published = await xApiFetch(oauth1, 'POST', `/articles/${articleId}/publish`);
        if (!published.ok) {
          const detail = published.data?.detail || published.data?.title || JSON.stringify(published.data);
          console.error('[X Plugin] Article publish failed:', published.status, detail);
          res.status(published.status || 500).json({ success: false, articleId, error: `Publish failed: ${detail}` });
          return;
        }
        const postId = published.data?.data?.post_id;
        const articleUrl = postId ? `https://x.com/i/status/${postId}` : undefined;

        console.log(`[X Plugin] Article published: ${articleId} -> ${articleUrl}`);
        res.json({ success: true, articleId, postId, articleUrl });
      } catch (err: any) {
        const detail = err.data ? JSON.stringify(err.data) : err.message;
        console.error('[X Plugin] Post article failed:', detail);
        res.status(500).json({ success: false, error: detail });
      }
    });
  },
};

/** Upload an article cover image to X, returning its media_id. Mirrors the
 *  /api/x/upload-media compression rules (>3MB or PNG -> JPEG). Returns null on
 *  any failure — the article still posts, just without a cover. */
async function uploadCoverMedia(client: Client, dataDir: string, src: string): Promise<string | null> {
  try {
    const filename = src.replace('/_images/', '');
    const filePath = join(dataDir, '_images', filename);
    if (!existsSync(filePath)) return null;

    type MediaMime = 'image/jpeg' | 'image/png' | 'image/webp' | 'image/bmp' | 'image/tiff';
    const ext = extname(filename).toLowerCase();
    const mimeMap: Record<string, MediaMime> = {
      '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
      '.png': 'image/png', '.webp': 'image/webp',
      '.gif': 'image/jpeg', '.bmp': 'image/bmp',
      '.tiff': 'image/tiff', '.tif': 'image/tiff',
    };
    let fileBuffer = readFileSync(filePath);
    let uploadType: MediaMime = mimeMap[ext] || 'image/jpeg';
    if (fileBuffer.length > 3 * 1024 * 1024 || ext === '.png') {
      fileBuffer = Buffer.from(await sharp(fileBuffer).jpeg({ quality: 85 }).toBuffer());
      uploadType = 'image/jpeg';
    }

    const uploadResult = await client.media.upload({
      body: { media: fileBuffer.toString('base64'), mediaCategory: 'tweet_image', mediaType: uploadType },
    });
    return (uploadResult as any)?.data?.id || (uploadResult as any)?.media_id_string || null;
  } catch (err: any) {
    console.error('[X Plugin] Cover upload failed:', err.message);
    return null;
  }
}

export default plugin;
