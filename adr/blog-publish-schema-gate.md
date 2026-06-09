# Blog publish schema gate (validate frontmatter before commit)

## Context

`post_to_blog` (github plugin) builds a post's YAML frontmatter from the doc's
`blogContext` metadata plus the registered site's `frontmatter_defaults`, writes
the file into a cloned copy of the target site repo, then commits and pushes —
with **no validation** that the result satisfies the site's content schema.

Astro sites declare that schema in `src/content/config.ts` (or, Astro 5,
`src/content.config.ts`) as a Zod object per collection, e.g.

```ts
const blog = defineCollection({
  schema: z.object({
    category: z.enum(['Product Updates', 'Guides', 'Discord Tips', 'Tutorials']),
    pubDate: z.coerce.date(),
    description: z.string(),
    // …
  }),
});
```

A frontmatter value outside that schema does not fail at publish time — it fails
at **build** time, on the host. On 2026-06-09 a post shipped with
`category: "Updates"` (not one of the four allowed values). Astro's content
validation threw, Netlify never built the page, and the only signal was a manual
`curl` finding a 404. The push "succeeded"; the page silently never existed.

This is the same disease as `adr/blog-image-contract.md`: a contract the target
site owns (here, its content schema) was never checked at the publish chokepoint,
so output could violate it and the failure surfaced far downstream — invisibly.

The schema must come from the **site repo itself, read live on every publish** —
never a copy mirrored into OpenWriter's `BlogSite` registry. A mirror drifts the
instant the site edits its schema, reintroducing exactly the silent-mismatch
class this gate exists to close. Single source of truth = the repo's `config.ts`.

## Current invariants

- **A pre-commit gate sits between "write file" and "git commit" in the
  `post_to_blog` handler** (`plugins/github/src/blog-tools.ts`). It is the one
  chokepoint every publish passes through.
- **The schema is loaded from the cloned repo's live content config every
  publish.** No schema snapshot is stored on `BlogSite`. Implementation:
  `packages/openwriter/server/blog-schema-gate.ts` →
  `validateBlogFrontmatter({ repoRoot, contentDir, frontmatter })`.
- **The Astro config is loaded outside the Astro runtime** via a tiny shim:
  transpile the TS to ESM (esbuild when present), strip the
  `astro:content` / `astro/loaders` imports, prepend a header binding `z` to the
  real `zod` (by absolute file URL, so it resolves from a temp dir),
  `defineCollection` to identity (preserves `.schema`), and
  `reference`/`glob`/`file` to harmless stubs. The temp `.mjs` is dynamic-imported,
  `collections[<dir-basename>]` is resolved (falling back to the sole collection),
  and a function-form `schema: ({ image }) => …` is called with an `image()` stub
  returning `z.string()`.
- **The frontmatter is parsed with `gray-matter` before `safeParse`.** gray-matter
  uses the same js-yaml default schema as Astro's content layer, so unquoted ISO
  dates become real `Date` objects and `z.date()` / `z.coerce.date()` behave
  identically here and at build time.
- **On a schema violation the publish ABORTS before commit/push.** No commit, no
  push. The local working-tree edit is wiped by the next publish's
  `git reset --hard origin/<branch>`.
- **Three error surfaces, all required:**
  1. **MCP response** — `post_to_blog` returns `{ error, validation_failed: true,
     issues: [...] }` so the calling agent sees exactly what to fix.
  2. **Browser toast** — `broadcastToast()` (server/ws.ts) fires a `toast` WS
     message that the client routes to the canonical `showToast()` primitive, so
     whoever clicked Publish sees the rejection regardless of which surface
     (modal, compose view, bare agent call) started it.
  3. **Plain language** — `friendlyZodIssue()` maps each Zod issue to a human
     sentence (`category "Updates" isn't allowed — pick one of: …`,
     `pubDate must be a date`, `description is missing`). Neither surface ever
     shows raw Zod text.
- **Validation is never silently skipped.** When it can't run faithfully (no
  Astro config, an unparseable config, a schemaless collection), the result is
  `{ ok: true, skipped: true, reason }`. The publish proceeds (there is nothing
  to gate on) but the reason rides back on the MCP response as
  `validation_warning` AND fires a toast — an `error` toast on an Astro site (a
  real gap), an `info` toast on other frameworks (no Astro schema applies).
- **esbuild is optional.** It ships transitively with Vite, so dev / build
  installs have it. Production npm installs may not; the loader falls back to
  importing the config source verbatim (works for already-ESM configs and TS
  free of type-only syntax), and any failure degrades to a loud `skipped`, never
  a silent pass.

## Decision log

- **2026-06-09** — Initial gate. Added `server/blog-schema-gate.ts`
  (`validateBlogFrontmatter` + `friendlyZodIssue`), `broadcastToast` in
  `server/ws.ts` + a `toast` handler in `src/ws/client.ts` (→ `showToast`),
  exposed both through the github-plugin server bridge
  (`plugins/github/src/helpers.ts`), and wired the gate into `post_to_blog`
  between write-file and commit. Motivated by the live `category: "Updates"` →
  red build → silent 404 incident the same day. Single-source-of-truth decision
  (live `config.ts`, never a mirror) recorded here per the chip brief.
