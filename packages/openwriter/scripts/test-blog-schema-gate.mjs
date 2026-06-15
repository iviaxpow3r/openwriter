/**
 * Deterministic integration test for the blog publish schema gate.
 * Exercises the COMPILED dist/server/blog-schema-gate.js against real,
 * on-disk Astro content configs (TS, esbuild-transpiled, shimmed) — proving
 * the gate catches the exact class of bug that shipped a red build + silent
 * 404 (category outside the site's z.enum), and never silently skips.
 *
 * Run: node scripts/test-blog-schema-gate.mjs   (from packages/openwriter)
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { pathToFileURL } from 'url';

const { validateBlogFrontmatter } = await import(
  pathToFileURL(join(process.cwd(), 'dist/server/blog-schema-gate.js')).href
);

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`); }
}

function makeRepo(configRel, configSrc) {
  const root = mkdtempSync(join(tmpdir(), 'ow-gate-test-'));
  const abs = join(root, configRel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, configSrc, 'utf-8');
  return root;
}

const ASTRO_CONFIG = `
import { defineCollection, z } from 'astro:content';
const blog = defineCollection({
  type: 'content',
  schema: z.object({
    title: z.string(),
    description: z.string(),
    pubDate: z.date(),
    category: z.enum(['Product Updates', 'Guides', 'Discord Tips', 'Tutorials']),
    draft: z.boolean().default(false),
  }),
});
export const collections = { blog };
`;

// Astro 5 shape: src/content.config.ts, glob loader, function-form schema + image()
const ASTRO5_CONFIG = `
import { defineCollection, z, reference } from 'astro:content';
import { glob } from 'astro/loaders';
const blog = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/blog' }),
  schema: ({ image }) => z.object({
    title: z.string(),
    description: z.string(),
    pubDate: z.coerce.date(),
    category: z.enum(['Product Updates', 'Guides', 'Discord Tips', 'Tutorials']),
    cover: image().optional(),
    related: z.array(reference('blog')).optional(),
  }),
});
export const collections = { blog };
`;

const fm = (over = {}) => {
  const base = { title: 'T', description: 'A description', pubDate: '2026-06-09', category: 'Guides' };
  const merged = { ...base, ...over };
  const lines = Object.entries(merged)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}: ${v}`);
  return `---\n${lines.join('\n')}\n---\n\nbody\n`;
};

const repos = [];
try {
  // ── Case 1: classic src/content/config.ts (a live Astro shape) ──────────
  {
    const root = makeRepo('src/content/config.ts', ASTRO_CONFIG); repos.push(root);
    const opts = { repoRoot: root, contentDir: 'src/content/blog' };

    const invalid = await validateBlogFrontmatter({ ...opts, frontmatter: fm({ category: 'Updates' }) });
    check('classic: invalid category rejected', invalid.ok === false && invalid.validation_failed !== true);
    const msg = (invalid.issues || []).map((i) => i.message).join('; ');
    check('classic: friendly enum message',
      msg === `category "Updates" isn't allowed — pick one of: Product Updates, Guides, Discord Tips, Tutorials`,
      msg);
    check('classic: configPath surfaced', invalid.configPath === 'src/content/config.ts', invalid.configPath);
    check('classic: collection resolved', invalid.collection === 'blog', invalid.collection);

    const valid = await validateBlogFrontmatter({ ...opts, frontmatter: fm({ category: 'Guides' }) });
    check('classic: valid category passes', valid.ok === true && !valid.skipped && !valid.issues);

    const missing = await validateBlogFrontmatter({ ...opts, frontmatter: fm({ description: undefined }) });
    const mm = (missing.issues || []).map((i) => i.message);
    check('classic: missing required → "description is missing"', missing.ok === false && mm.includes('description is missing'), JSON.stringify(mm));

    const baddate = await validateBlogFrontmatter({ ...opts, frontmatter: fm({ pubDate: 'not-a-date' }) });
    const dm = (baddate.issues || []).map((i) => i.message);
    check('classic: bad date → "pubDate must be a date"', baddate.ok === false && dm.includes('pubDate must be a date'), JSON.stringify(dm));
  }

  // ── Case 2: Astro 5 content.config.ts (loader + function-form + image()) ────
  {
    const root = makeRepo('src/content.config.ts', ASTRO5_CONFIG); repos.push(root);
    const opts = { repoRoot: root, contentDir: 'src/content/blog' };

    const invalid = await validateBlogFrontmatter({ ...opts, frontmatter: fm({ category: 'News' }) });
    check('astro5: invalid category rejected', invalid.ok === false);
    check('astro5: configPath = src/content.config.ts', invalid.configPath === 'src/content.config.ts', invalid.configPath);

    const valid = await validateBlogFrontmatter({ ...opts, frontmatter: fm({ category: 'Discord Tips', cover: '/images/og/x.png' }) });
    check('astro5: valid (with cover via image()) passes', valid.ok === true && !valid.skipped, JSON.stringify(valid.issues || valid.reason));
  }

  // ── Case 3: non-Astro repo (no content config) → loud skip, never silent ───
  {
    const root = mkdtempSync(join(tmpdir(), 'ow-gate-test-')); repos.push(root);
    const r = await validateBlogFrontmatter({ repoRoot: root, contentDir: '_posts', frontmatter: fm() });
    check('non-astro: skipped (not blocked)', r.ok === true && r.skipped === true);
    check('non-astro: reason names missing config', /no Astro content config/i.test(r.reason || ''), r.reason);
  }

  // ── Case 4: schemaless collection → skip with reason (nothing to gate on) ──
  {
    const root = makeRepo('src/content/config.ts',
      `import { defineCollection } from 'astro:content';\nconst blog = defineCollection({ type: 'content' });\nexport const collections = { blog };\n`);
    repos.push(root);
    const r = await validateBlogFrontmatter({ repoRoot: root, contentDir: 'src/content/blog', frontmatter: fm() });
    check('schemaless: skipped with reason', r.ok === true && r.skipped === true && /no schema/i.test(r.reason || ''), r.reason);
  }

  // ── Case 5: never throws — garbage config degrades to a loud skip ──────────
  {
    const root = makeRepo('src/content/config.ts', `this is (((not valid typescript @@@`);
    repos.push(root);
    const r = await validateBlogFrontmatter({ repoRoot: root, contentDir: 'src/content/blog', frontmatter: fm() });
    check('garbage config: skipped, not thrown, not a false-pass-block', r.ok === true && r.skipped === true, JSON.stringify(r));
  }
} finally {
  for (const r of repos) { try { rmSync(r, { recursive: true, force: true }); } catch { /* */ } }
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
