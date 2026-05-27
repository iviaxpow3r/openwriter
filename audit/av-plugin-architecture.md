# Author's Voice plugin — architecture audit

Goal: confirm whether the canonical home for the AV plugin should be
`C:\openwriter\plugins\authors-voice\` (bundled inside OpenWriter) or
`C:\authors-voice\packages\openwriter-plugin\` (its own repo), and identify
how OpenWriter's plugin model actually works today.

All file:line references are relative to the OpenWriter monorepo root unless
otherwise noted.

---

## 1. Loader mechanism

Two-tier discovery at server startup. Bundled-first, user fallback, dedup
by package name with bundled winning.

**Bundled discovery** — [packages/openwriter/server/plugin-discovery.ts:41-82](packages/openwriter/server/plugin-discovery.ts:41):

```
monoPluginsDir = __dirname/../../../../plugins   # monorepo dev path
distPluginsDir = __dirname/../plugins            # npm-install path
pluginsDir = monoPluginsDir if exists else distPluginsDir
```

Then `readdirSync` every subdirectory and load each `package.json`. **No
naming convention enforced for bundled plugins** — any subdir of `plugins/`
with a valid `package.json` is treated as a plugin. Sort order is the
explicit allow-list `BUNDLED_ORDER` at `plugin-discovery.ts:147-152`
(`@openwriter/plugin-authors-voice`, `-publish`, `-image-gen`, `-x-api`).

**User discovery** — [plugin-discovery.ts:88-113](packages/openwriter/server/plugin-discovery.ts:88):
scans `~/.openwriter/plugins/node_modules/`. Naming convention IS enforced
here ([plugin-discovery.ts:124-128](packages/openwriter/server/plugin-discovery.ts:124)):

- `@openwriter/plugin-*`
- `openwriter-plugin-*`
- `@<scope>/openwriter-plugin-*`
- OR any package with an `openwriter` field in its `package.json`

**Module import** — [plugin-discovery.ts:186-219](packages/openwriter/server/plugin-discovery.ts:186):
imports via path (`pluginDir/dist/index.js`) for bundled, or via
`createRequire` resolved from `~/.openwriter/plugins/package.json` for user.

**Lifecycle** — [packages/openwriter/server/plugin-manager.ts](packages/openwriter/server/plugin-manager.ts):
`PluginManager.discover()` enumerates discovered plugins, loads each module
to read `configSchema`, and saves enabled/config state to
`~/.openwriter/config.json` via `savePluginState` (plugin-manager.ts:215-230).

Bottom line: discovery is a runtime filesystem scan in BOTH locations. There
is no static manifest, no npm-workspace-driven enumeration, no platform-side
registry. The workspaces config (`"workspaces": ["packages/*", "plugins/*"]`)
in the root `package.json` is only used by npm for symlink resolution during
local development; it plays no role at runtime.

## 2. What ships on `npm publish openwriter`

`packages/openwriter/package.json:103-107`:

```json
"files": ["dist/", "skill/", "package.json"]
"scripts": { "prepublishOnly": "node scripts/prepublish.cjs" }
```

`prepublish.cjs` runs before pack and does TWO copies:

- **Skill files** ([prepublish.cjs:9-41](packages/openwriter/scripts/prepublish.cjs:9)):
  pulls SKILL.md + selected docs + voices/ + agents/ from
  `../../skills/openwriter/` into `skill/`.
- **Bundled plugins** ([prepublish.cjs:43-87](packages/openwriter/scripts/prepublish.cjs:43)):
  iterates `../../plugins/`, copies each plugin's `package.json` + `dist/`
  directory into `packages/openwriter/dist/plugins/<dir-name>/`.

This means **the npm tarball for `openwriter` includes the compiled JS of
every `plugins/*` subdirectory at publish time**. Consumers who
`npm install openwriter` get the bundled AV plugin physically inside their
`node_modules/openwriter/dist/plugins/authors-voice/`.

At runtime in that npm-install context, `discoverBundledPlugins` falls
through from the (nonexistent) monorepo path to `dist/plugins/` and finds
the bundled copies. Full circle.

Caveat: prepublish has no build step. It copies whatever is currently in
`plugins/<dir>/dist/`. If a plugin hasn't been built (`tsc` not run),
nothing ships for it — silently. There is no guard against publishing
empty bundled plugins.

## 3. External plugin model

Yes, it exists — partially.

**CLI installer SHIPS** — `bin/pad.ts:61-62` routes
`openwriter plugin install <name>` to
[plugin-install.ts:31-51](packages/openwriter/server/plugin-install.ts:31).
It runs `npm install --save <name>` inside `~/.openwriter/plugins/`
(creating `package.json` + lockfile there). `install`, `remove`/`uninstall`,
`list`/`ls` subcommands all work.

**Naming gate** — `plugin-install.ts:14` regex:

```
^(@openwriter/plugin-[\w-]+|openwriter-plugin-[\w-]+|@[\w-]+/openwriter-plugin-[\w-]+)$
```

This rejects `@authors-voice/openwriter` (the authors-voice repo's package
name). Even if that package were published, the standard `openwriter plugin
install @authors-voice/openwriter` command would error out before touching
npm. The naming convention is intentionally exclusive about who can be a
plugin.

**Registry WAS DELETED**. Commit `585659f` (Feb 23, 2026) introduced
`registry.json` at repo root as a public catalog, plus the CLI installer +
context/sidebar menu items + plugin categories. Three weeks later, commit
`70c4ddb` (Mar 16, 2026 — *"fix: remove errant skills framework artifacts
from repo"*) deleted `registry.json` along with `skills-lock.json` and
several `.agents/` artifacts, treating it as part of an unintended commit
from a third-party skills framework. `.gitignore` was updated to keep it
out. **The deletion appears to have been a side-effect of cleaning up
unrelated skills-framework debris, not a deliberate retirement of the
plugin registry concept.** Today, `docs/plugin-development.md:200-225`
still tells plugin authors to "Submit a PR to add your plugin to
`registry.json`" — a file the repo no longer has.

**What `585659f` delivered that DID stick:**
- Dual-source discovery (bundled + user `~/.openwriter/plugins/`)
- `openwriter plugin install|remove|list` CLI
- `contextMenuItems` + `sidebarMenuItems` extension points in the plugin
  interface
- `category` manifest field
- `docs/plugin-development.md` (still live)

**What `585659f` delivered that DIDN'T stick:**
- `registry.json` browseable catalog (deleted, gitignored, doc still refers
  to it)

**Are any first-party AV-family plugins published to npm?** All four
bundled plugins are pinned at `"version": "0.1.0"` and have never been
bumped. There is no `npm publish` script in any plugin's `package.json`
(only `build` / `dev`). They live exclusively as monorepo workspaces + the
prepublish-bundled copies inside the `openwriter` npm tarball. No
independent distribution.

## 4. The "publish plugin owns them now" commit

`c7a4319` (Apr 5, 2026) commented out `sidebarMenuItems` in the AV plugin
("Vary, Shrinkify, Expandify, Threadify, Storify, Emailify, Postify") and
left a note pointing at the publish plugin. The publish plugin is
[plugins/publish/](plugins/publish/) — `@openwriter/plugin-publish` v0.1.0,
also bundled.

`plugins/publish/src/index.ts:1171-1180` registers **all seven sidebar
items** including threadify, under the `publish:` action prefix (not `av:` /
`voice:`). `plugins/publish/src/index.ts:1064-1146` handles
`POST /api/publish/sidebar-action` end to end:

- HTML-to-markdown conversion (its own copy of `htmlToMarkdown`)
- The threadify TipTap-JSON construction (paragraph + hardBreak nodes,
  horizontalRule separators between tweets)
- Variant-relationship wiring (`masterDocId`, `variantType` lookup table
  at `plugins/publish/src/index.ts:21-27`)
- Routing to the platform: `publishFetch` → `platformFetch`
  ([packages/openwriter/server/connections.ts:21-37](packages/openwriter/server/connections.ts:21))
  → `https://publish.openwriter.io/transforms` — a Cloudflare Worker that
  lives in the separate `C:\openwriter-publish` repo. That worker is what
  now proxies into the AV backend with billing/metering applied per-call.

The AV plugin's own `/api/voice/sidebar-action` handler (plus its threadify
TipTap-JSON branch) is **never reached** today — there is no UI item that
dispatches a `voice:` or `av:` prefixed action since `c7a4319`. The handler
is dead code held in place by accidental conservatism.

**Architectural intent**: sidebar transforms (document-level rewrites,
including all seven Vary/Shrinkify/etc.) go through the metered platform
path. The AV plugin retains only the editor context-menu actions
(Enhance / Modify / Shrink / Expand / Insert / Fill) which are sub-paragraph
operations against the AV backend directly via the user's own API key.

## 5. Drift origin

**Both repos descend from the same predecessor — BreeWriter — and were
extracted on the same day, ~2 hours apart.**

- `Feb 16, 2026 18:33 PST` — authors-voice repo:
  `a1eef0f Initial extraction of Author's Voice from BreeWriter` —
  *"Standalone monorepo with two packages: @authors-voice/api … +
  @authors-voice/openwriter: OpenWriter plugin proxy"*.
- `Feb 16, 2026 20:49 PST` — openwriter repo:
  `2848133 Initial commit: OpenWriter monorepo with review panel
  redesign` — *"Refactored from BreeWriter"*. Initial commit already
  contains `plugins/authors-voice/{package.json, src/index.ts, tsconfig.json}`
  (109 lines).

Neither copy is canonical historically — they are forked twins from a
shared ancestor. Both have evolved substantively since the split:

**OpenWriter copy** (`plugins/authors-voice/`, `@openwriter/plugin-authors-voice@0.1.0`,
mtime 2026-05-25, 270 lines):
- `sidebarMenuItems` commented out (handed off to publish plugin per `c7a4319`)
- The `/api/voice/sidebar-action` route handler + the threadify TipTap-JSON
  branch are **dead code**: the publish plugin now owns the entire sidebar
  transform pipeline including threadify
  ([plugins/publish/src/index.ts:1113-1146](plugins/publish/src/index.ts:1113)
  has the same TipTap JSON construction). Nothing in the UI dispatches
  `voice:` / `av:` prefixed actions anymore.
- Inline duplicated type definitions

**Authors-voice copy**
(`/c/authors-voice/packages/openwriter-plugin/`, `@authors-voice/openwriter@0.3.0`,
mtime 2026-05-27, 271 lines):
- v2 anchor-blend engine routing (`withEngine` wrapper,
  `AV_ENGINE` config + env, version param injection for `apply` / `generate` /
  `apply-editor` routes)
- `AV_DEBUG` flag wrapper (`withDebug`) that forwards debug:true to backend
- `sidebarMenuItems` still active with `av:` prefix (pre-`c7a4319` shape)
- Threadify uses HTML output with `<hr>` separators (older approach)

The version numbers are misleading: the authors-voice copy bumped 0.1.0 →
0.2.0 → 0.3.0 as it added features; the OpenWriter copy never bumped despite
similar volume of work. They drifted in parallel.

**Crucial fact**: the authors-voice copy is dead weight.
`grep -rln '@authors-voice/openwriter' C:\authors-voice` returns only
self-references (the package's own dist + tsconfig). Nothing depends on
it, nothing publishes it, nothing syncs from it.

## 6. Sync mechanism

**None.** No sync script in either repo:

- `find C:\openwriter -name '*.sh' -o -name '*.mjs' -o -name '*.js' |
  xargs grep -l 'plugins/authors-voice'` → no results outside the running
  npm packages themselves.
- `find C:\authors-voice -name '*.sh' -o -name '*.mjs' -o -name '*.js' |
  xargs grep -l 'openwriter/plugins\|plugins/authors-voice'` → no results.
- No git submodule. No npm cross-dependency. No turbo task crossing repos.
- The only mention of `@authors-voice/openwriter` anywhere on the C: drive
  is inside the authors-voice repo itself.

The two copies have been maintained by hand on parallel forks since the
day they were split. Each major change had to be replicated in the other
repo manually — and clearly hasn't been, since both have unique
features the other lacks.

## 7. Other drifted plugins

**Just authors-voice.** Inventory of bundled plugins and sibling repos:

| Bundled plugin | Pkg name | Sibling repo with mirror | Drifted? |
|---|---|---|---|
| `plugins/authors-voice` | `@openwriter/plugin-authors-voice@0.1.0` | `C:\authors-voice\packages\openwriter-plugin\` (`@authors-voice/openwriter@0.3.0`) | **Yes** |
| `plugins/publish` | `@openwriter/plugin-publish@0.1.0` | `C:\openwriter-publish\` is the **worker backend** (Hono on CF Workers), not a plugin | No |
| `plugins/github` | `@openwriter/plugin-github@0.1.0` | `C:\openwriter-github-plugin\` exists but is an **empty scaffold** (README + empty dirs, no package.json, no source) | No |
| `plugins/image-gen` | `@openwriter/plugin-image-gen@0.1.0` | None | No |
| `plugins/x-api` | `@openwriter/plugin-x-api@0.1.0` | None | No |

Only authors-voice has a real sibling that diverged.

## 8. Recommendation: option (A) — OpenWriter is canonical

**Make `C:\openwriter\plugins\authors-voice\` the sole home for the
plugin. Forward-port lost work from the authors-voice repo copy, then
delete `C:\authors-voice\packages\openwriter-plugin\` and remove it from
the authors-voice workspaces config.**

**Why A over B (authors-voice as canonical, OpenWriter installs as npm dep):**

1. **The running install reads OpenWriter's copy.** Discovery is
   bundled-first by design. To make B work we'd have to either publish
   `@authors-voice/openwriter` to npm AND change the discovery /
   installer naming gate to allow it, OR rename the authors-voice package
   to `@openwriter/plugin-authors-voice`. Either path is structurally
   bigger than forward-porting deltas.

2. **The CLI installer's name regex rejects `@authors-voice/openwriter`.**
   The naming convention is the gate. Renaming the authors-voice copy
   would resolve this, but at that point we've conceded that the canonical
   identity is `@openwriter/plugin-authors-voice` — i.e. option (A).

3. **The architecture is moving sidebar transforms off the AV plugin
   entirely.** The publish plugin already proxies Vary/Shrinkify/etc.
   through the platform worker. The AV plugin's remaining surface area
   (context-menu single-text actions) is small and stable. There is no
   reason for it to live in the authors-voice monorepo; that repo's
   job is the API backend + marketing site.

4. **No build pipeline depends on the authors-voice copy.** It is built
   by `authors-voice`'s root `npm run build --workspaces` but never
   consumed. Deleting it removes a CI step and zero downstream effect.

5. **`@authors-voice/openwriter` is not on npm and was never intended to
   be.** Its `package.json` has no `prepublishOnly`, no version-bump
   workflow, no publish script. It is a built-but-unused artifact.

**What to port forward into OpenWriter's copy before deleting authors-voice's:**

- v2 anchor-blend engine routing (`withEngine` wrapper, `AV_ENGINE` config
  + env var, version param injection for `apply` / `generate` /
  `apply-editor`)
- `AV_DEBUG` flag wrapper
- `engine` field in `configSchema` (with the documentation string about
  v2 default + v1 silent fallback)

**What to DELETE from OpenWriter's copy during the port** (publish plugin
owns it now — verified at `plugins/publish/src/index.ts:1064-1180`):

- The entire `/api/voice/sidebar-action` route handler in `registerRoutes`,
  including the threadify TipTap-JSON branch. Dead code — no UI dispatches
  to it.
- The commented-out `sidebarMenuItems` block (drop it instead of
  carrying the comment forward).
- The `htmlToMarkdown` helper if it's only used by the dead sidebar handler.

After both passes, the AV plugin's surface area is: wildcard
`/api/voice/*` proxy for single-text backend calls + the editor
context-menu actions (Enhance / Modify / Shrink / Expand / Insert / Fill).
That is its entire remaining job.

After port: bump OpenWriter's plugin version from `0.1.0` to something
that reflects the merged history (e.g. `0.4.0` to leap-frog the
authors-voice 0.3.0).

**Cleanup tasks (each its own commit, in this order):**

1. In `C:\openwriter`: port v2 routing + AV_DEBUG into
   `plugins/authors-voice/src/index.ts`, bump version, build, verify
   live with a `version: 'v2'` POST to `/api/voice/apply`.
2. In `C:\authors-voice`: delete `packages/openwriter-plugin/`, drop the
   workspace from root `package.json`, remove related docs/refs, commit.
3. In `C:\openwriter`: also fix the stale `registry.json` references in
   `docs/plugin-development.md` (either restore the file or remove the
   PR-instruction lines — separate decision but related to this audit).

## 9. Open questions for the operator

- **Should `registry.json` be restored?** The plugin ecosystem
  (CLI install, dual-source discovery, dev docs) all assumes a catalog
  exists. If the deletion was accidental side-effect cleanup, restoring
  it (un-gitignoring, re-creating from the seed in `585659f`) is a
  small win. If the deletion was deliberate retreat from "plugin
  ecosystem" as a near-term goal, the dev docs should be amended to
  remove the registry instructions. Either way, the current state is
  internally inconsistent.

- **Should the AV-plugin context-menu actions ALSO migrate to the
  publish-plugin worker path?** If the platform is metering AV usage
  for sidebar transforms via `/api/publish/sidebar-action`, the
  remaining direct `/api/voice/*` calls from `plugins/authors-voice`
  are unmetered. That may be intentional (BYO-key local-first), but
  worth confirming.

- **Is `@openwriter/plugin-*` namespace something to publish to npm
  long-term, or does the bundled-only model stay?** Today every
  first-party plugin pins to `0.1.0` and ships only inside the
  `openwriter` tarball. The `openwriter plugin install` CLI exists
  but has nothing curated to install — community plugins haven't
  arrived. Decision: lean into bundled-only and remove the CLI +
  user-discovery code (~280 LOC), or keep it ready for the day the
  ecosystem opens up.

- **`plugins/github` direction**: the empty scaffold at
  `C:\openwriter-github-plugin` suggests an earlier intent to extract
  it. The recent github plugin commits in OpenWriter (Phase 3
  integration, blog publishing, etc. — see session memory) all happened
  bundled. Worth confirming the extraction is dropped before we
  recommend the same "canonical home is OpenWriter" rule to that
  plugin too.
