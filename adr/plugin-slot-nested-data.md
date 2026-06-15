# Plugin slot nested data

## Context

`~/.openwriter/config.json` stores per-plugin state under `plugins[<name>]`. Originally only `{enabled, config}` lived there — flat scalars set via the Plugins tab UI. The PluginManager rebuilt the whole `plugins` map on every state change from its in-memory `Map<name, {enabled, config}>`, then wrote that via `saveConfig({ plugins })` (a shallow top-level merge).

This worked until plugins started owning their own nested data on the same slot. The github plugin's `blogSites: BlogSite[]` was the first — registered blog repos stored under `plugins['@openwriter/plugin-github'].blogSites`, with `frontmatter_defaults`, `frontmatter_field_map`, and `frontmatter_schema` nested inside each site entry. The publish plugin will likely follow with billing snapshots; future plugins will too.

Without an invariant on the writer side, every plugin enable/disable, config edit, or startup discovery cycle silently wiped that nested data. The user added a blog site, restarted, and `list_blog_sites` returned `[]` — config blown away by a routine write that didn't even know the data existed.

## Current invariants

- **The plugin slot is owned by the plugin, not by PluginManager.** PluginManager owns exactly two keys per slot — `enabled` and `config`. Everything else on the slot is plugin-private and must survive any state-save PluginManager performs.
- **`savePluginState` reads-before-write.** It loads the current on-disk plugins record, spreads each existing slot's keys into the rebuilt slot, then overwrites only `enabled` and `config`. This preserves `blogSites` (github), and any future plugin-owned keys, across every plugin manager save.
- **PluginManager only asserts `enabled` for plugins it actually loaded.** A plugin that failed to import (`managed.plugin === undefined`) sits in the map with the default `enabled === false`. `savePluginState` must NOT persist that default over the on-disk value — for unloaded plugins it preserves `prior.enabled`. Without this, a load failure (e.g. running from an unbuilt worktree) is silently recorded as a deliberate disable and sticks forever, since startup only re-enables plugins marked `true`. A genuinely user-disabled plugin keeps `managed.plugin` set (`disable()` never clears it), so deliberate `false` still persists.
- **Plugins that store nested data write through their own helper, not through PluginManager.** The github plugin uses `writeBlogSites` (in `plugins/github/src/helpers.ts`), which does the same read-before-write pattern on its slot. PluginManager's writes and plugin-owned writes must both follow this pattern — neither can rebuild the slot from scratch.
- **`saveConfig`'s shallow merge is intentional.** Making `saveConfig` deep-merge would mask bugs and surprise other callers. The invariant lives at the write-site (savePluginState, writeBlogSites), not in the generic helper.

## Decision log (append-only)

### 2026-06-01 — Load failure persisted as a deliberate disable; all content plugins silently turned off

- **Trigger.** All four content plugins (authors-voice, publish, image-gen, x-api) came up disabled in the main checkout, despite the user never disabling them. `config.json` showed `enabled: false` for all four; only github was `true`.
- **Root cause.** A server had booted from a git worktree (`.claude/worktrees/admiring-tu-7af229`) whose bundled plugins were never built — `plugins/*/dist/index.js` missing. At startup the four imports failed, so each stayed `enabled === false` in the map (`enable()` bails before setting true on load failure). The github plugin *did* load and enabled, ending in `savePluginState()`, which serialized the **entire** map — writing the failed plugins' default `false` over the on-disk `true`. `config.json` lives in `~/.openwriter` (global, shared across every checkout), so the main repo inherited the disabled flags and, since startup only re-enables `true` plugins, they stayed off on every subsequent boot.
- **Fix.** `savePluginState` now preserves `prior.enabled` for any plugin with `managed.plugin === undefined` (never loaded), asserting `managed.enabled` only for plugins it actually loaded. New invariant above. A transient load failure can no longer be laundered into a sticky disable.
- **Verification.** Re-enabled the four in `config.json`, rebuilt + restarted; confirmed they enable at boot and a subsequent github toggle (which fires `savePluginState`) no longer clobbers them.
- **Why this happened now.** Latent since plugins existed, but only reachable once someone ran the server from a checkout where the bundled plugin dists were absent (worktree without a plugin build). The shared global `config.json` turned a transient, location-specific load failure into permanent cross-checkout state.

### 2026-05-26 — Original incident: a blog site wiped by plugin manager startup save

- **Trigger.** Added a blog site (travsteward/example-blog-website) via `add_blog_site`, posted to it successfully. Killed openwriter processes for a code rebuild, respawned. Next `list_blog_sites` returned `{sites: []}` — the site was gone.
- **Root cause.** `PluginManager.savePluginState` rebuilt `config.plugins` from its in-memory `Map<name, {enabled, config}>` and wrote via `saveConfig({ plugins })`. The shallow top-level merge in `saveConfig` replaced the entire `plugins` key. PluginManager didn't know `blogSites` existed nested in the github slot, so the rebuilt slot omitted it. Every startup discovery cycle (which fires savePluginState) wiped the array.
- **Fix.** `plugin-manager.ts:savePluginState` now reads the current config, takes each plugin's existing slot keys, spreads them into the rebuilt slot, then overwrites `enabled` and `config`. Managed fields stay authoritative; plugin-owned data survives. Commit `28ae971`.
- **Verification.** Re-added the blog site, killed all openwriter procs, called `list_blog_sites` (forces a fresh MCP spawn + plugin manager init + savePluginState). Site returned with all nested data intact (`frontmatter_defaults`, `frontmatter_field_map`, `frontmatter_schema`).
- **Why this happened now.** Phase 3 of the github plugin migration (commit `c593ec1`, merged earlier) added `blogSites` to the github plugin slot as the first plugin-owned nested data. The bug had been latent in PluginManager for as long as plugins have existed but only became reachable when something actually used the nested space.

### 2026-06-01 — Writeback site touched (no change to this invariant)

- The `post_to_blog` `blogContext.lastPublish` writeback (which bears this ADR's marker because it writes through `setMetadata`'s deep-merge) gained two WS broadcasts after `save()` so connected clients converge live. This does **not** alter the slot-persistence model documented here — `setMetadata`'s deep-merge of `blogContext` still preserves sibling keys, and config-slot nested-data persistence is untouched. The broadcast convention is documented separately in [adr/plugin-metadata-broadcast.md](plugin-metadata-broadcast.md).
