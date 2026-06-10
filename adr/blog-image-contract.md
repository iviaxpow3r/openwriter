# Blog image contract (path style + cover naming)

## Context

`post_to_blog` (github plugin) copies a doc's cover image into a registered
site's `image_dir`, rewrites the frontmatter image field, commits, pushes. The
original implementation hardcoded a single, implicit image contract:

- **Path style.** It always emitted an ABSOLUTE path — `image_public_prefix`
  kept its leading slash and was concatenated verbatim (`/images/og/<file>`).
  But many static templates render `<img src={`/${image}`}>` and expect a
  RELATIVE value (`images/og/x.png`), prepending the slash themselves. An
  absolute input there becomes `//images/og/x.png` — protocol-relative, broken.
- **Filename.** The published cover kept whatever the `/_images/` source was
  called (a hash, or an arbitrary name). It was never derived from the slug, so
  filenames were inconsistent, republishing a regenerated cover wrote a NEW
  filename and ORPHANED the old one, and republish was not byte-stable.

The `BlogSite` config modeled directories and frontmatter shape but never
modeled *how images are referenced or named*. So output could only match repos
that happened to fit the hardcoded assumption (absolute, raw-name) — or repos
hand-normalized to it. Concretely: paybotapp.com's 18 live posts all use
`image: "images/og/og-{slug}.png"` (no leading slash); a real publish would
have regressed every one of them to a broken `/images/og/<hash>.png`.

This is the same disease as `adr/plugin-slot-nested-data.md`: a contract that
lived in the writer's head instead of in the data model, so it silently broke
the moment a real repo diverged from the assumption.

## Current invariants

- **The image reference is a PER-SITE CONTRACT, stored on `BlogSite`, not a
  global assumption.** Two dimensions:
  - `image_path_style: 'relative' | 'absolute'` — whether emitted references
    carry a leading slash. Absent ⇒ `'absolute'` (the legacy behavior), so
    already-correct sites never regress.
  - `image_naming: string` — the cover filename template (`{slug}`, `{ext}`
    placeholders). Absent ⇒ `og-{slug}.{ext}`.
- **`image_public_prefix` is stored style-agnostically.** `imageRef()` strips
  leading + trailing slashes from the prefix and re-applies the slash based on
  `image_path_style` alone. So `/images/og` and `images/og` behave identically;
  the style field is the single source of truth for the slash.
- **The cover filename is deterministic.** `coverFilename()` resolves
  `og-{slug}.{ext}` (source extension preserved). Same doc + same slug ⇒ same
  filename on every republish: an idempotent overwrite, never an orphan. Inline
  body images still keep their source (hash) names — deterministic inline
  naming is a deferred follow-up (see below).
- **Both cover and inline body references honor `image_path_style`.** A site is
  either relative or absolute; the plugin never mixes.
- **The contract is INFERRED from the site's real posts, not guessed from the
  framework.** `inspect_blog_repo` samples existing posts and derives
  `image_path_style` (do values start with `/`?), `image_public_prefix` (the
  dominant directory), `image_naming` (`og-{slug}` vs `{slug}` vs hash), and
  the cover field name (e.g. `image` vs `coverImage`, written into
  `frontmatter_field_map`). `add_blog_site` for a new user's repo therefore
  produces output that matches what that repo already ships.

## Deferred / follow-up

- **Inline body image naming.** Inline `/_images/<hash>` references keep their
  hash filenames for now. They already honor `image_path_style`, but they are
  not slug-derived, so a regenerated inline image can still orphan its
  predecessor. Scope a future pass to give inline images deterministic names
  (e.g. `{slug}-{n}.{ext}`) once the cover contract has settled.

## Decision log (append-only)

### 2026-05-31 — Make the blog image reference a per-site contract

- **Trigger.** Audit found `post_to_blog` always emitted absolute, raw-named
  image paths. Verified against a fresh clone of travsteward/paybot-website:
  all 18 posts use relative `images/og/og-*.png`, so a real publish would have
  broken every cover image and orphaned files on republish.
- **Root cause.** The image contract (path style + filename) was hardcoded in
  the transform, not modeled per-site. It worked only for repos matching the
  assumption.
- **Fix.** Added `image_path_style` + `image_naming` to `BlogSite`; extracted
  `pathStyleOf` / `imageRef` / `coverFilename` pure resolvers; rewrote
  `post_to_blog` to emit cover + inline references through them; extended
  `inspect_blog_repo` to infer the full contract (style, prefix, naming, cover
  field name) from sampled posts via `inferImageConventions` +
  `imageDirForFramework`; added the fields to the `add_blog_site` schema; and
  surfaced the resolved cover path/filename in the `post_to_blog` result.
  Defaults reproduce legacy behavior (`absolute`, `og-{slug}.{ext}`) so
  registered sites without the keys are unaffected.
- **Migration.** travsteward/paybot-website (site id
  `7db71cdc-a8e0-4461-99af-605675ed7f04`) migrated to
  `image_path_style: relative` + `image_naming: og-{slug}.png`.
- **Verification.** `scripts/test-blog-cover-path.mjs` — 38 assertions: path
  style (relative drops the slash, absolute keeps it, prefix normalized
  regardless of stored slash), deterministic naming + ext preservation,
  buildFrontmatter emit for both styles, idempotent no-orphan republish, and
  `inferImageConventions` against paybot's real post shape.
- **Note on `lastPublish`.** The brief also flagged `blogContext.lastPublish`
  as clobberable by `set_metadata({ blogContext })`. That was already fixed by
  commit `91d55e0` (the `blogContext` deep-merge in
  `state.ts:mergeMetadataUpdates`); this work adds a regression test pinning it
  rather than re-fixing it.

### 2026-06-01 — Date fields emit as unquoted YAML scalars

- **Trigger.** A live publish to paybotapp.com froze the Netlify build:
  `InvalidContentEntryFrontmatterError … pubDate: Expected type "date",
  received "string"`. Every deploy after the publish failed, so the site
  served stale content for ~6h while origin/master already had the new post.
- **Root cause.** `buildFrontmatter` routed every value through `yamlValue`,
  which `JSON.stringify`s strings — so the date (a `YYYY-MM-DD` string out of
  `formatDate`) emitted **quoted**: `pubDate: "2026-05-31"`. Astro's
  `z.date()` parses a quoted scalar as a String, not a Date, and rejects it.
  Same disease as the image contract: a correct-looking emit that silently
  breaks the moment a real schema diverges from the assumption.
- **Fix.** `buildFrontmatter` now tracks the date destination key(s)
  (`dateDest` + any `publishedDateDest`) and emits them as **raw, unquoted**
  YAML scalars when the value matches `YYYY-MM-DD` (`pubDate: 2026-05-31`).
  Unquoted is the universally-correct form: it satisfies `z.date()` AND
  `z.coerce.date()`, and Jekyll/Hugo/Next (gray-matter) all accept it. A
  non-date-shaped value (e.g. `Spring 2026`) falls back to quoted, and real
  string fields (title, description) are unaffected.
- **Immediate remediation.** The already-pushed poisoned file was hand-fixed
  in paybot-website (`pubDate: "2026-05-31"` → `pubDate: 2026-05-31`, commit
  `709c85a`) to unblock the deploy; this plugin fix prevents recurrence for
  every user, not just PayBot.
- **Verification.** `scripts/test-blog-cover-path.mjs` section [9] — 7 added
  assertions: pubDate unquoted, ISO-datetime sliced + unquoted, default `date`
  field unquoted, auto-derived date unquoted, non-date value stays quoted,
  string fields still quoted.

- **2026-06-10** — Genericized two code comments in blog-tools (src+dist) that referenced specific private deployments; no behavior change. Part of the bundled-tree privacy scrub (fictional examples only in public skill/plugin sources).
