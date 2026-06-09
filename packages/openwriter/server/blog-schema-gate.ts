/**
 * Blog publish schema gate — validate a post's frontmatter against the TARGET
 * SITE's live Astro content schema BEFORE the github plugin commits/pushes.
 *
 * Why this exists
 * ───────────────
 * `post_to_blog` builds frontmatter from a doc's metadata + the site's
 * `frontmatter_defaults`, then commits and pushes. Nothing checked that the
 * result satisfies the site's `src/content/config.ts` Zod schema. A bad value
 * (e.g. `category: "Updates"` when the schema is
 * `z.enum(['Product Updates','Guides','Discord Tips','Tutorials'])`) sailed
 * straight to a red Astro build — Netlify never shipped the page, and the only
 * signal was a manually-discovered 404. (Live incident, 2026-06-09.)
 *
 * Single source of truth
 * ──────────────────────
 * The schema is read from the cloned repo's OWN config every publish — never a
 * snapshot mirrored in OpenWriter's blog-site registry. A mirror drifts the
 * moment the site changes its schema; the repo's `config.ts` cannot.
 * adr: adr/blog-publish-schema-gate.md
 *
 * How it loads an Astro config outside Astro
 * ──────────────────────────────────────────
 * `src/content/config.ts` does `import { z, defineCollection } from 'astro:content'`,
 * which only resolves inside the Astro runtime. We:
 *   1. transpile the TS to ESM JS (esbuild when present — it ships with Vite),
 *   2. strip the `astro:content` / `astro/loaders` imports and prepend a tiny
 *      shim header: `z` → the real `zod` (by absolute file URL so it resolves
 *      from any temp location), `defineCollection` → identity (preserves
 *      `.schema`), `reference`/`glob`/`file` → harmless stubs,
 *   3. write the result to a temp `.mjs` and dynamic-import it,
 *   4. read `collections[<dir>]`, resolve its `.schema` (calling the
 *      `({ image }) => z.object(...)` function form with an `image()` stub),
 *   5. `schema.safeParse(grayMatterData)` — gray-matter yields the SAME typed
 *      object Astro feeds its schema (unquoted dates → real `Date`), so
 *      `z.date()` / `z.coerce.date()` behave identically here and at build time.
 *
 * Anything that prevents a faithful parse (no config, exotic imports, transpile
 * failure, no matching collection, no schema) is reported as `skipped` with a
 * reason — NEVER a silent pass. The caller surfaces that loudly.
 */

import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from 'fs';
import { join, basename } from 'path';
import { tmpdir } from 'os';
import { pathToFileURL } from 'url';
import { createRequire } from 'module';
import matter from 'gray-matter';
import { z } from 'zod';

const require = createRequire(import.meta.url);

/** One field-level problem, already phrased for humans (no raw Zod). */
export interface FrontmatterIssue {
  /** Dotted field path, or "frontmatter" for a top-level problem. */
  field: string;
  /** The original Zod issue code — useful for the agent, ignored by the toast. */
  code: string;
  /** Plain-language message, e.g. `category "Updates" isn't allowed — pick one of: …`. */
  message: string;
}

export interface FrontmatterValidationResult {
  /** true → frontmatter satisfies the schema (or there was nothing to check). */
  ok: boolean;
  /** true → validation could not run faithfully; caller MUST surface `reason`. */
  skipped?: boolean;
  /** Why validation was skipped (no config / unparseable / no schema). */
  reason?: string;
  /** Repo-relative path of the config the schema came from (when found). */
  configPath?: string;
  /** Collection key the post was validated against (when matched). */
  collection?: string;
  /** Friendly, per-field problems — present only when ok === false. */
  issues?: FrontmatterIssue[];
  /** One-line join of every issue message — convenient for a toast / MCP error. */
  summary?: string;
}

// Config filenames Astro recognizes (v2–v4 `src/content/config.*`, v5
// `src/content.config.*`), TS + already-ESM variants.
const CONFIG_CANDIDATES = [
  'src/content/config.ts',
  'src/content/config.mts',
  'src/content/config.js',
  'src/content/config.mjs',
  'src/content.config.ts',
  'src/content.config.mts',
  'src/content.config.js',
  'src/content.config.mjs',
];

function findContentConfig(repoRoot: string): string | null {
  for (const rel of CONFIG_CANDIDATES) {
    const abs = join(repoRoot, rel);
    if (existsSync(abs)) return abs;
  }
  return null;
}

/** `a`/`an` for a type word, so "must be a boolean" / "must be an array" read right. */
function article(word: string): string {
  return /^[aeiou]/i.test(word) ? 'an' : 'a';
}

/**
 * Map one Zod issue to a plain-language sentence. NEITHER the MCP error nor the
 * browser toast ever shows raw Zod text — this is the only place that touches
 * the issue shape. Covers the codes a content schema actually produces; the
 * default keeps everything else human ("<field> is invalid").
 */
export function friendlyZodIssue(issue: any): FrontmatterIssue {
  const field = Array.isArray(issue?.path) && issue.path.length ? issue.path.join('.') : 'frontmatter';
  const code = String(issue?.code || 'invalid');
  let message: string;
  switch (code) {
    case 'invalid_enum_value': {
      const opts = Array.isArray(issue.options) ? issue.options.join(', ') : '';
      message = `${field} "${issue.received}" isn't allowed — pick one of: ${opts}`;
      break;
    }
    case 'invalid_type': {
      // Zod reports a missing required field as invalid_type with received "undefined".
      if (issue.received === 'undefined' || issue.received === 'null') {
        message = `${field} is missing`;
      } else if (issue.expected === 'date') {
        message = `${field} must be a date`;
      } else {
        message = `${field} must be ${article(String(issue.expected))} ${issue.expected}`;
      }
      break;
    }
    case 'invalid_string': {
      if (issue.validation === 'url') message = `${field} must be a valid URL`;
      else if (issue.validation === 'email') message = `${field} must be a valid email`;
      else if (issue.validation === 'datetime') message = `${field} must be a valid date-time`;
      else if (issue.validation === 'uuid') message = `${field} must be a valid UUID`;
      else message = `${field} has an invalid format`;
      break;
    }
    case 'invalid_date':
      message = `${field} must be a valid date`;
      break;
    case 'too_small': {
      const t = issue.type;
      const n = issue.minimum;
      if (t === 'string') message = `${field} is too short (minimum ${n} characters)`;
      else if (t === 'array') message = `${field} needs at least ${n} item${n === 1 ? '' : 's'}`;
      else if (t === 'number') message = `${field} must be at least ${n}`;
      else message = `${field} is too small`;
      break;
    }
    case 'too_big': {
      const t = issue.type;
      const n = issue.maximum;
      if (t === 'string') message = `${field} is too long (maximum ${n} characters)`;
      else if (t === 'array') message = `${field} allows at most ${n} item${n === 1 ? '' : 's'}`;
      else if (t === 'number') message = `${field} must be at most ${n}`;
      else message = `${field} is too big`;
      break;
    }
    case 'unrecognized_keys': {
      const keys = Array.isArray(issue.keys) ? issue.keys.join(', ') : '';
      message = `unexpected field${issue.keys?.length === 1 ? '' : 's'}: ${keys}`;
      break;
    }
    default:
      message = `${field} is invalid`;
      break;
  }
  return { field, code, message };
}

/** esbuild ships with Vite (dev/build installs). Production npm installs may
 *  lack it — in that case we fall back to importing the source verbatim, which
 *  works for already-ESM configs and TS configs free of type-only syntax; a
 *  failure there surfaces as a `skipped` reason, never a silent pass.
 *  The specifier is held in a variable so tsc/bundlers don't hard-require it. */
async function loadEsbuild(): Promise<any | null> {
  try {
    const spec = 'esbuild';
    return await import(spec);
  } catch {
    return null;
  }
}

async function toEsmJs(src: string, isTypeScript: boolean): Promise<string> {
  if (!isTypeScript) return src;
  const esbuild = await loadEsbuild();
  if (esbuild?.transform) {
    const out = await esbuild.transform(src, { loader: 'ts', format: 'esm' });
    return out.code;
  }
  // Best-effort: a config with no TS-only syntax is valid JS once imports are
  // rewritten. If it isn't, the dynamic import throws and we report `skipped`.
  return src;
}

/**
 * Build the self-contained ESM module text: shim header (real zod by absolute
 * URL + identity/stub helpers) followed by the config with its astro imports
 * stripped. `[^;]*?` spans newlines so multi-line import statements are removed
 * too, stopping at the statement's terminating `;`.
 */
function buildModuleSource(esmJs: string): string {
  const zodUrl = pathToFileURL(require.resolve('zod')).href;
  const stripped = esmJs
    .replace(/import\s+[^;]*?from\s*["']astro:content["']\s*;?/g, '')
    .replace(/import\s+[^;]*?from\s*["']astro\/loaders["']\s*;?/g, '');
  const header = [
    `import * as __ow_zod from ${JSON.stringify(zodUrl)};`,
    `const z = __ow_zod.z ?? __ow_zod.default?.z ?? __ow_zod.default;`,
    `const defineCollection = (c) => c;`,
    `const reference = () => z.string();`,
    `const glob = () => ({});`,
    `const file = () => ({});`,
    ``,
  ].join('\n');
  return header + stripped;
}

/**
 * Load the site's content collections and return the Zod schema for the
 * collection that backs `contentDir`. Throws on any failure (caller converts
 * to a `skipped` result). Returns `{ schema: null }` when the collection has
 * no schema declared (Astro doesn't validate those — nothing to gate on).
 */
async function loadCollectionSchema(
  configPath: string,
  contentDir: string,
): Promise<{ schema: any | null; collection: string | null }> {
  const isTs = /\.m?ts$/.test(configPath);
  const src = readFileSync(configPath, 'utf-8');
  const esmJs = await toEsmJs(src, isTs);
  const modSrc = buildModuleSource(esmJs);

  const dir = mkdtempSync(join(tmpdir(), 'ow-blog-gate-'));
  const modPath = join(dir, 'content-config.mjs');
  try {
    writeFileSync(modPath, modSrc, 'utf-8');
    const mod = await import(pathToFileURL(modPath).href);
    const collections = mod?.collections;
    if (!collections || typeof collections !== 'object') {
      throw new Error('config has no `collections` export');
    }
    // Resolve the collection by the content dir's last segment
    // (src/content/blog → "blog"); fall back to the sole collection.
    const key = basename(contentDir.replace(/\\/g, '/').replace(/\/+$/, ''));
    let collection: string | null = null;
    let col: any = undefined;
    if (key && collections[key]) {
      collection = key;
      col = collections[key];
    } else {
      const keys = Object.keys(collections);
      if (keys.length === 1) {
        collection = keys[0];
        col = collections[keys[0]];
      }
    }
    if (!col) {
      throw new Error(`no "${key}" collection in config (have: ${Object.keys(collections).join(', ') || 'none'})`);
    }
    let schema = col.schema;
    // Astro's function form: schema: ({ image }) => z.object({...}). Call it
    // with an image() stub that returns a string schema — a cover path is a
    // string at the frontmatter level, which is all we validate.
    if (typeof schema === 'function') {
      schema = schema({ image: () => z.string() });
    }
    if (!schema || typeof schema.safeParse !== 'function') {
      return { schema: null, collection };
    }
    return { schema, collection };
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

/**
 * Validate a post's built frontmatter against the target site's live content
 * schema. `frontmatter` is the YAML block the plugin is about to write (with or
 * without `---` fences, with or without the body appended — gray-matter handles
 * all three). `repoRoot` is the cloned site repo; `contentDir` is the site's
 * post directory (e.g. `src/content/blog`).
 *
 * Returns `ok:true` on a clean parse, `ok:false` + friendly `issues` on a
 * schema violation, or `ok:true, skipped:true` + a `reason` when validation
 * could not run faithfully (no config / unparseable / no schema). It NEVER
 * throws — every failure mode resolves to a result the caller can act on.
 */
export async function validateBlogFrontmatter(opts: {
  repoRoot: string;
  contentDir: string;
  frontmatter: string;
}): Promise<FrontmatterValidationResult> {
  let data: Record<string, any>;
  try {
    // gray-matter parses the same way Astro's content layer does (js-yaml
    // default schema → unquoted ISO dates become real Date objects).
    const parsed = matter(opts.frontmatter.startsWith('---') ? opts.frontmatter : `---\n${opts.frontmatter}\n---\n`);
    data = parsed.data || {};
  } catch (err: any) {
    return { ok: true, skipped: true, reason: `could not parse built frontmatter: ${err?.message || err}` };
  }

  const configPath = findContentConfig(opts.repoRoot);
  if (!configPath) {
    return { ok: true, skipped: true, reason: 'no Astro content config found (src/content/config.* or src/content.config.*)' };
  }
  const configRel = configPath.slice(opts.repoRoot.length + 1).replace(/\\/g, '/');

  let loaded: { schema: any | null; collection: string | null };
  try {
    loaded = await loadCollectionSchema(configPath, opts.contentDir);
  } catch (err: any) {
    return { ok: true, skipped: true, reason: `could not load ${configRel}: ${err?.message || err}`, configPath: configRel };
  }

  if (!loaded.schema) {
    return {
      ok: true,
      skipped: true,
      reason: `${loaded.collection ? `collection "${loaded.collection}"` : 'matched collection'} has no schema to validate against`,
      configPath: configRel,
      collection: loaded.collection || undefined,
    };
  }

  const result = loaded.schema.safeParse(data);
  if (result.success) {
    return { ok: true, configPath: configRel, collection: loaded.collection || undefined };
  }

  const issues: FrontmatterIssue[] = (result.error?.issues || []).map(friendlyZodIssue);
  return {
    ok: false,
    configPath: configRel,
    collection: loaded.collection || undefined,
    issues,
    summary: issues.map((i) => i.message).join('; '),
  };
}
