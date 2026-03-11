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
      let markdownBody = parsed.content.trim();

      // Build clean blog YAML frontmatter — only include fields the target schema expects
      const fm: Record<string, any> = {
        title,
        description: blogCtx.description || '',
        date: blogCtx.date || new Date().toISOString().split('T')[0],
      };

      // Optional fields — only include if explicitly set
      if (blogCtx.author) fm.author = blogCtx.author;
      if (blogCtx.layout) fm.layout = blogCtx.layout;
      if (blogCtx.category) fm.category = blogCtx.category;
      if (blogCtx.tags?.length) fm.tags = blogCtx.tags;
      if (blogCtx.draft) fm.draft = true;

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

      // Fetch connection config to derive image web path
      let imageWebPrefix = '/images';
      try {
        const cfgRes = await platformFetch(`/connections/${ghConn.id}/config`);
        if (cfgRes.ok) {
          const cfg = await cfgRes.json() as Record<string, any>;
          const imgDir = cfg.config?.imageDir || cfg.imageDir;
          if (imgDir) {
            imageWebPrefix = '/' + (imgDir as string).replace(/^public\/?/, '');
          }
        }
      } catch { /* fall back to /images */ }

      // Cover image — read as base64 for GitHub commit
      let imageBase64: string | undefined;
      let imageFilename: string | undefined;
      if (blogCtx.coverImage) {
        const imgPath = blogCtx.coverImage.replace(/^\/_images\//, '');
        const fullImgPath = join(getDataDir(), '_images', imgPath);
        if (existsSync(fullImgPath)) {
          imageBase64 = readFileSync(fullImgPath).toString('base64');
          imageFilename = imgPath;
          fm.image = `${imageWebPrefix}/${imgPath}`;
        }
      }

      // Collect inline images and rewrite paths in markdown
      const inlineImages: Array<{ filename: string; base64: string }> = [];
      const imgRegex = /!\[([^\]]*)\]\(\/_images\/([^)]+)\)/g;
      markdownBody = markdownBody.replace(imgRegex, (_match, alt, imgFile) => {
        const fullImgPath = join(getDataDir(), '_images', imgFile);
        if (existsSync(fullImgPath)) {
          inlineImages.push({ filename: imgFile, base64: readFileSync(fullImgPath).toString('base64') });
        }
        return `![${alt}](${imageWebPrefix}/${imgFile})`;
      });

      // Assemble full markdown with YAML frontmatter
      const yamlLines = Object.entries(fm).map(([k, v]) => {
        if (Array.isArray(v)) return `${k}:\n${v.map(i => `  - ${JSON.stringify(i)}`).join('\n')}`;
        if (typeof v === 'boolean') return `${k}: ${v}`;
        return `${k}: ${JSON.stringify(v)}`;
      });
      const fullMarkdown = `---\n${yamlLines.join('\n')}\n---\n\n${markdownBody}`;

      // Build target filename from slug or title
      const slug = blogCtx.slug || title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      const filename = `${slug}.md`;

      // Post to platform — matches worker's expected payload:
      // { markdown, filename, imageBase64?, imageFilename?, commitMessage? }
      const upstream = await platformFetch(`/connections/${ghConn.id}/post`, {
        method: 'POST',
        body: JSON.stringify({
          markdown: fullMarkdown,
          filename,
          ...(imageBase64 && imageFilename ? { imageBase64, imageFilename } : {}),
          ...(inlineImages.length ? { images: inlineImages } : {}),
          commitMessage: `Add blog post: ${title}`,
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
