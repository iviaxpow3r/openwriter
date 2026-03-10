/**
 * Blog publishing routes — push blog content to GitHub via platform connection.
 * Builds clean YAML frontmatter + markdown body, collects images, posts to platform.
 */

import { Router } from 'express';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import matter from 'gray-matter';
import { getDocument, getTitle, getMetadata, save, cancelDebouncedSave } from './state.js';
import { tiptapToMarkdown } from './markdown.js';
import { platformFetch, isAuthenticated } from './connections.js';
import { getDataDir } from './helpers.js';

export function createBlogRouter(): Router {
  const router = Router();

  // Find active GitHub connection for blog publishing
  router.get('/api/blog/connection', async (_req, res) => {
    try {
      if (!isAuthenticated()) {
        res.json({ connection: null });
        return;
      }
      const upstream = await platformFetch('/connections/unified');
      if (!upstream.ok) {
        res.json({ connection: null });
        return;
      }
      const data = await upstream.json() as { connections: any[] };
      const ghConn = data.connections?.find((c: any) => c.provider === 'github' && c.status === 'active');
      res.json({ connection: ghConn || null });
    } catch {
      res.json({ connection: null });
    }
  });

  // Publish blog post to GitHub via platform connection
  router.post('/api/blog/publish', async (req, res) => {
    try {
      if (!isAuthenticated()) {
        res.status(401).json({ error: 'Not authenticated' });
        return;
      }

      // Flush current doc to disk
      cancelDebouncedSave();
      save();

      const doc = getDocument();
      const title = getTitle();
      const metadata = getMetadata();
      const blogCtx = metadata.blogContext;

      if (!blogCtx?.active) {
        res.status(400).json({ error: 'Not a blog document' });
        return;
      }

      // Get clean markdown body (strip OpenWriter JSON frontmatter)
      const fullMd = tiptapToMarkdown(doc, title, metadata);
      const parsed = matter(fullMd);
      const markdownBody = parsed.content.trim();

      // Build clean blog YAML frontmatter
      const blogFrontmatter: Record<string, any> = {
        title,
        description: blogCtx.description || '',
        date: blogCtx.date || new Date().toISOString().split('T')[0],
        author: blogCtx.author || '',
        tags: blogCtx.tags || [],
        draft: blogCtx.draft || false,
      };

      if (blogCtx.slug) blogFrontmatter.slug = blogCtx.slug;

      // Collect cover image as base64
      const images: Array<{ filename: string; data: string; contentType: string }> = [];
      if (blogCtx.coverImage) {
        const imgPath = blogCtx.coverImage.replace(/^\/_images\//, '');
        const fullImgPath = join(getDataDir(), '_images', imgPath);
        if (existsSync(fullImgPath)) {
          const imgData = readFileSync(fullImgPath);
          const ext = imgPath.split('.').pop()?.toLowerCase() || 'jpg';
          const contentType = ext === 'png' ? 'image/png' : ext === 'gif' ? 'image/gif' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
          images.push({ filename: imgPath, data: imgData.toString('base64'), contentType });
          blogFrontmatter.image = imgPath;
        }
      }

      // Collect inline images from markdown body
      const imgRegex = /!\[.*?\]\(\/_images\/([^)]+)\)/g;
      let match;
      while ((match = imgRegex.exec(markdownBody)) !== null) {
        const imgFilename = match[1];
        if (images.some(i => i.filename === imgFilename)) continue;
        const fullImgPath = join(getDataDir(), '_images', imgFilename);
        if (existsSync(fullImgPath)) {
          const imgData = readFileSync(fullImgPath);
          const ext = imgFilename.split('.').pop()?.toLowerCase() || 'jpg';
          const contentType = ext === 'png' ? 'image/png' : ext === 'gif' ? 'image/gif' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
          images.push({ filename: imgFilename, data: imgData.toString('base64'), contentType });
        }
      }

      // Find GitHub connection
      const connectionId = req.body.connectionId;
      const connRes = await platformFetch('/connections/unified');
      if (!connRes.ok) {
        res.status(500).json({ error: 'Failed to fetch connections' });
        return;
      }
      const connData = await connRes.json() as { connections: any[] };
      const ghConn = connectionId
        ? connData.connections?.find((c: any) => c.id === connectionId)
        : connData.connections?.find((c: any) => c.provider === 'github' && c.status === 'active');

      if (!ghConn) {
        res.status(400).json({ error: 'No GitHub connection found. Connect a GitHub repo first.' });
        return;
      }

      // Post to platform via GitHub connection
      const upstream = await platformFetch(`/connections/${ghConn.id}/post`, {
        method: 'POST',
        body: JSON.stringify({
          content_type: 'blog',
          title,
          slug: blogCtx.slug || '',
          content: markdownBody,
          frontmatter: blogFrontmatter,
          images,
        }),
      });

      const result = await upstream.json();
      if (!upstream.ok) {
        res.status(upstream.status).json(result);
        return;
      }

      res.json({ success: true, ...result });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
