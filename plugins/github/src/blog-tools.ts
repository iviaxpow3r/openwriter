/**
 * Blog publishing MCP tools — local git ops, no Worker, no PAT.
 *
 * Auth: piggybacks on the user's existing `gh auth login`.
 * Persistence: blogSites in plugins['@openwriter/plugin-github'].blogSites.
 */

import { execFile } from 'child_process';
import { existsSync, mkdirSync, readFileSync, copyFileSync, writeFileSync, readdirSync, statSync, rmSync } from 'fs';
import { join, extname, dirname } from 'path';
import { randomUUID } from 'crypto';
import { homedir } from 'os';
import {
  getServerModules,
  listBlogSites,
  writeBlogSites,
  type BlogSite,
  type PluginMcpTool,
} from './helpers.js';

const NETWORK_TIMEOUT = 60000;

function exec(cmd: string, args: string[], cwd: string, timeout = NETWORK_TIMEOUT): Promise<string> {
  const safeArgs = args.map(a => a.includes(' ') ? `"${a}"` : a);
  return new Promise((resolve, reject) => {
    execFile(cmd, safeArgs, { cwd, shell: true, timeout, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr?.trim() || err.message));
      else resolve(stdout.trim());
    });
  });
}

async function ghAuthOk(cwd: string): Promise<boolean> {
  try { await exec('gh', ['auth', 'status'], cwd); return true; } catch { return false; }
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/['"]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
}

function owRoot(): string {
  return join(homedir(), '.openwriter');
}

// ---- inspect_blog_repo helpers ----

function walkDir(root: string, max = 5000): string[] {
  const out: string[] = [];
  const queue = [root];
  while (queue.length && out.length < max) {
    const dir = queue.shift()!;
    let entries: string[];
    try { entries = readdirSync(dir); } catch { continue; }
    for (const name of entries) {
      if (name === '.git' || name === 'node_modules') continue;
      const full = join(dir, name);
      let st;
      try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) queue.push(full);
      else out.push(full);
    }
  }
  return out;
}

function dirOfMostMarkdown(files: string[], cloneRoot: string): { dir: string; count: number } | null {
  const counts = new Map<string, number>();
  for (const f of files) {
    if (extname(f).toLowerCase() !== '.md' && extname(f).toLowerCase() !== '.mdx') continue;
    const rel = f.slice(cloneRoot.length + 1).replace(/\\/g, '/');
    const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
    // Skip README.md at root, etc.
    if (!dir) continue;
    counts.set(dir, (counts.get(dir) || 0) + 1);
  }
  let best: { dir: string; count: number } | null = null;
  for (const [dir, count] of counts) {
    if (!best || count > best.count) best = { dir, count };
  }
  return best;
}

function parseYamlFrontmatterKeys(raw: string): string[] {
  const m = raw.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!m) return [];
  const keys: string[] = [];
  for (const line of m[1].split('\n')) {
    const k = line.match(/^([A-Za-z_][\w-]*)\s*:/);
    if (k) keys.push(k[1]);
  }
  return keys;
}

function inferFramework(cloneRoot: string, files: string[]): BlogSite['framework'] {
  const has = (rel: string) => existsSync(join(cloneRoot, rel));
  if (
    has('astro.config.mjs') || has('astro.config.ts') || has('astro.config.js') ||
    files.some(f => /astro\.config\.(mjs|ts|js)$/.test(f))
  ) return 'astro';
  if (has('next.config.js') || has('next.config.mjs') || has('next.config.ts')) return 'next';
  if (has('_config.yml')) return 'jekyll';
  if (has('hugo.toml') || has('config.toml') || has('hugo.yaml') || has('config.yaml')) return 'hugo';
  return 'unknown';
}

function defaultDirsForFramework(fw: BlogSite['framework'], detectedContentDir: string): {
  content_dir: string;
  image_dir: string;
  image_public_prefix: string;
} {
  switch (fw) {
    case 'astro':
      return {
        content_dir: detectedContentDir || 'src/content/blog',
        image_dir: 'public/blog-images',
        image_public_prefix: '/blog-images',
      };
    case 'next':
      return {
        content_dir: detectedContentDir || 'posts',
        image_dir: 'public/blog-images',
        image_public_prefix: '/blog-images',
      };
    case 'jekyll':
      return {
        content_dir: '_posts',
        image_dir: 'assets/images',
        image_public_prefix: '/assets/images',
      };
    case 'hugo':
      return {
        content_dir: detectedContentDir || 'content/posts',
        image_dir: 'static/images',
        image_public_prefix: '/images',
      };
    default:
      return {
        content_dir: detectedContentDir || 'posts',
        image_dir: 'public/images',
        image_public_prefix: '/images',
      };
  }
}

// ---- post_to_blog helpers ----

function yamlEscape(v: any): string {
  if (v == null) return '""';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return '[' + v.map(yamlEscape).join(', ') + ']';
  const s = String(v);
  if (/[:#\n"']/.test(s) || s.trim() !== s) return JSON.stringify(s);
  return s;
}

function buildFrontmatter(title: string, metadata: Record<string, any>, slug: string): string {
  const skip = new Set(['docId', 'content_type', 'updated', 'created', 'blogContext']);
  const lines: string[] = [`title: ${yamlEscape(title)}`, `slug: ${yamlEscape(slug)}`];
  if (!metadata.date && !metadata.pubDate) {
    lines.push(`date: ${new Date().toISOString()}`);
  }
  for (const [k, v] of Object.entries(metadata)) {
    if (skip.has(k) || k === 'title' || k === 'slug') continue;
    lines.push(`${k}: ${yamlEscape(v)}`);
  }
  return `---\n${lines.join('\n')}\n---\n\n`;
}

function stripFrontmatter(md: string): string {
  return md.replace(/^---\n[\s\S]*?\n---\n+/, '').replace(/^\s*<!--\s*-->\s*$/gm, '').trim();
}

// ---- Tools ----

export function blogTools(): PluginMcpTool[] {
  return [
    {
      name: 'inspect_blog_repo',
      description: 'Clone a GitHub blog repo (shallow) to a local cache and infer its framework, content directory, image directory, and frontmatter schema. Read-only — produces a config preview you can feed to add_blog_site.',
      inputSchema: {
        type: 'object',
        properties: {
          repo_url: { type: 'string', description: 'GitHub repo URL or owner/repo shorthand (e.g. "https://github.com/user/blog" or "user/blog")' },
        },
        required: ['repo_url'],
      },
      handler: async (params) => {
        const repoUrl = String(params.repo_url || '').trim();
        if (!repoUrl) return { error: 'repo_url is required' };

        // Normalize to owner/repo
        let ownerRepo = repoUrl
          .replace(/^https?:\/\/github\.com\//, '')
          .replace(/\.git$/, '')
          .replace(/^github:/, '');
        const parts = ownerRepo.split('/').filter(Boolean);
        if (parts.length < 2) return { error: 'Could not parse owner/repo from repo_url' };
        const owner = parts[0];
        const repo = parts[1];

        const cacheRoot = join(owRoot(), '_blog-inspect-cache');
        mkdirSync(cacheRoot, { recursive: true });
        const cloneDir = join(cacheRoot, `${owner}-${repo}`);

        if (!(await ghAuthOk(cacheRoot))) {
          return { error: 'gh CLI not authenticated. Run `gh auth login` first.' };
        }

        // Refresh: remove existing then clone shallow
        if (existsSync(cloneDir)) {
          try { rmSync(cloneDir, { recursive: true, force: true }); } catch { /* ignore */ }
        }
        try {
          await exec('gh', ['repo', 'clone', `${owner}/${repo}`, cloneDir, '--', '--depth', '1'], cacheRoot);
        } catch (err: any) {
          return { error: `Clone failed: ${err.message}` };
        }

        const files = walkDir(cloneDir);
        const framework = inferFramework(cloneDir, files);
        const mdBest = dirOfMostMarkdown(files, cloneDir);
        const detected = mdBest?.dir || '';
        const defaults = defaultDirsForFramework(framework, detected);

        // Frontmatter schema from first .md in detected dir (or any .md)
        let frontmatter_schema: string[] = [];
        const sampleFile = files.find(f => {
          const rel = f.slice(cloneDir.length + 1).replace(/\\/g, '/');
          return (detected ? rel.startsWith(detected + '/') : true) && /\.(md|mdx)$/i.test(rel);
        });
        if (sampleFile) {
          try {
            frontmatter_schema = parseYamlFrontmatterKeys(readFileSync(sampleFile, 'utf-8'));
          } catch { /* ignore */ }
        }

        const confidence: 'high' | 'medium' | 'low' =
          framework !== 'unknown' && detected ? 'high'
          : detected ? 'medium'
          : 'low';

        return {
          owner,
          repo,
          framework,
          content_dir: defaults.content_dir,
          image_dir: defaults.image_dir,
          image_public_prefix: defaults.image_public_prefix,
          frontmatter_schema,
          markdown_files_found: mdBest?.count ?? 0,
          confidence,
        };
      },
    },

    {
      name: 'add_blog_site',
      description: 'Register a GitHub blog repo as a publishing target. Use inspect_blog_repo first to discover sensible defaults.',
      inputSchema: {
        type: 'object',
        properties: {
          label: { type: 'string', description: 'User-facing name (e.g. "Personal blog")' },
          owner: { type: 'string', description: 'GitHub owner/user/org' },
          repo: { type: 'string', description: 'Repo name' },
          branch: { type: 'string', description: 'Branch to push to (default: main)' },
          content_dir: { type: 'string', description: 'Directory where post .md files live (e.g. "src/content/blog")' },
          image_dir: { type: 'string', description: 'Directory where image files write (e.g. "public/blog-images")' },
          image_public_prefix: { type: 'string', description: 'URL prefix for images in markdown (e.g. "/blog-images")' },
          framework: { type: 'string', enum: ['astro', 'next', 'jekyll', 'hugo', 'unknown'], description: 'Site framework' },
        },
        required: ['label', 'owner', 'repo', 'content_dir', 'image_dir', 'image_public_prefix', 'framework'],
      },
      handler: async (params) => {
        const site: BlogSite = {
          id: randomUUID(),
          label: String(params.label),
          owner: String(params.owner),
          repo: String(params.repo),
          branch: String(params.branch || 'main'),
          content_dir: String(params.content_dir),
          image_dir: String(params.image_dir),
          image_public_prefix: String(params.image_public_prefix),
          framework: (params.framework as BlogSite['framework']) || 'unknown',
        };
        const sites = await listBlogSites();
        sites.push(site);
        await writeBlogSites(sites);
        return { success: true, site };
      },
    },

    {
      name: 'list_blog_sites',
      description: 'List all registered GitHub blog sites.',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => {
        const sites = await listBlogSites();
        return { sites };
      },
    },

    {
      name: 'remove_blog_site',
      description: 'Remove a registered blog site by id.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Blog site id (from list_blog_sites)' },
        },
        required: ['id'],
      },
      handler: async (params) => {
        const id = String(params.id);
        const sites = await listBlogSites();
        const next = sites.filter(s => s.id !== id);
        if (next.length === sites.length) return { error: `No blog site with id ${id}` };
        await writeBlogSites(next);
        return { success: true, removed: id };
      },
    },

    {
      name: 'post_to_blog',
      description: 'Publish the active OpenWriter document to a registered GitHub blog site via local git ops (clone-or-pull, write file + images, commit, push). Auth uses your existing `gh auth login`.',
      inputSchema: {
        type: 'object',
        properties: {
          site_id: { type: 'string', description: 'Blog site id (from list_blog_sites)' },
          slug: { type: 'string', description: 'Filename slug (without .md). Default: slugified document title.' },
          commit_message: { type: 'string', description: 'Git commit message. Default: "blog: {title}".' },
        },
        required: ['site_id'],
      },
      handler: async (params) => {
        const siteId = String(params.site_id);
        const sites = await listBlogSites();
        const site = sites.find(s => s.id === siteId);
        if (!site) return { error: `No blog site with id ${siteId}` };

        const srv = await getServerModules();
        const doc = srv.getDocument();
        const title = srv.getTitle();
        const metadata = srv.getMetadata() || {};
        if (!doc || !doc.content) return { error: 'No active document. Switch to a document first.' };
        if (!title) return { error: 'Document has no title. Set a title before publishing.' };

        const contentType =
          metadata.content_type ||
          (metadata.tweetContext ? 'tweet'
            : metadata.articleContext ? 'article'
            : metadata.linkedinContext ? 'linkedin'
            : metadata.newsletterContext ? 'newsletter'
            : metadata.blogContext ? 'blog'
            : undefined);
        if (contentType !== 'blog') {
          return {
            error: `Active document is content_type "${contentType || 'untyped'}", not "blog". post_to_blog only publishes blog docs. Create a blog doc (sidebar → "+ New" → Blog) and switch to it before posting.`,
          };
        }

        const cloneRoot = join(owRoot(), '_blog-clones');
        mkdirSync(cloneRoot, { recursive: true });
        const clonePath = join(cloneRoot, site.id);

        if (!(await ghAuthOk(cloneRoot))) {
          return { error: 'gh CLI not authenticated. Run `gh auth login` first.' };
        }

        // Clone or refresh
        if (!existsSync(join(clonePath, '.git'))) {
          if (existsSync(clonePath)) {
            try { rmSync(clonePath, { recursive: true, force: true }); } catch { /* ignore */ }
          }
          try {
            await exec('gh', ['repo', 'clone', `${site.owner}/${site.repo}`, clonePath], cloneRoot);
          } catch (err: any) {
            return { error: `Clone failed: ${err.message}` };
          }
          try {
            await exec('git', ['checkout', site.branch], clonePath);
          } catch { /* may already be on it */ }
        } else {
          try {
            await exec('git', ['fetch', 'origin', site.branch], clonePath);
            await exec('git', ['checkout', site.branch], clonePath);
            await exec('git', ['reset', '--hard', `origin/${site.branch}`], clonePath);
          } catch (err: any) {
            return { error: `Failed to refresh clone: ${err.message}` };
          }
        }

        // Build markdown body
        const rawMd = srv.tiptapToMarkdown(doc, title, metadata);
        const bodyMd = stripFrontmatter(rawMd);

        const slug = String(params.slug || slugify(title));
        if (!slug) return { error: 'Could not derive a slug from the title.' };

        // Rewrite image refs, collect filenames
        const imgPrefix = site.image_public_prefix.replace(/\/+$/, '');
        const imageRefs = new Set<string>();
        const bodyRewritten = bodyMd.replace(/\/_images\/([^\s)"'<>]+)/g, (_m, fn) => {
          imageRefs.add(fn);
          return `${imgPrefix}/${fn}`;
        });

        // Copy images
        const dataDir = srv.getDataDir();
        const imageDirAbs = join(clonePath, site.image_dir);
        mkdirSync(imageDirAbs, { recursive: true });
        let imagesCopied = 0;
        for (const fn of imageRefs) {
          const src = join(dataDir, '_images', fn);
          if (!existsSync(src)) continue;
          const dst = join(imageDirAbs, fn);
          mkdirSync(dirname(dst), { recursive: true });
          copyFileSync(src, dst);
          imagesCopied++;
        }

        // Write the post file
        const frontmatter = buildFrontmatter(title, metadata, slug);
        const postRel = join(site.content_dir, `${slug}.md`);
        const postAbs = join(clonePath, postRel);
        mkdirSync(dirname(postAbs), { recursive: true });
        writeFileSync(postAbs, frontmatter + bodyRewritten + '\n', 'utf-8');

        // Commit + push
        const commitMessage = String(params.commit_message || `blog: ${title}`);
        try {
          await exec('git', ['add', '-A'], clonePath);
          // Detect if there's anything to commit
          const status = await exec('git', ['status', '--porcelain'], clonePath);
          if (!status) {
            return {
              success: true,
              file: postRel.replace(/\\/g, '/'),
              images_committed: 0,
              message: 'No changes — file already up to date.',
            };
          }
          await exec('git', ['commit', '-m', commitMessage], clonePath);
          await exec('git', ['push', 'origin', site.branch], clonePath);
        } catch (err: any) {
          return { error: `Git op failed: ${err.message}` };
        }

        let shortHash = '';
        try { shortHash = await exec('git', ['rev-parse', '--short', 'HEAD'], clonePath); } catch { /* ignore */ }

        return {
          success: true,
          file: postRel.replace(/\\/g, '/'),
          commit: shortHash,
          images_committed: imagesCopied,
          message: `Pushed to ${site.owner}/${site.repo}@${site.branch}`,
        };
      },
    },
  ];
}
