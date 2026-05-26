# Plugin slot nested data

## Context

`~/.openwriter/config.json` stores per-plugin state under `plugins[<name>]`. Originally only `{enabled, config}` lived there — flat scalars set via the Plugins tab UI. The PluginManager rebuilt the whole `plugins` map on every state change from its in-memory `Map<name, {enabled, config}>`, then wrote that via `saveConfig({ plugins })` (a shallow top-level merge).

This worked until plugins started owning their own nested data on the same slot. The github plugin's `blogSites: BlogSite[]` was the first — registered blog repos stored under `plugins['@openwriter/plugin-github'].blogSites`, with `frontmatter_defaults`, `frontmatter_field_map`, and `frontmatter_schema` nested inside each site entry. The publish plugin will likely follow with billing snapshots; future plugins will too.

Without an invariant on the writer side, every plugin enable/disable, config edit, or startup discovery cycle silently wiped that nested data. The user added a blog site, restarted, and `list_blog_sites` returned `[]` — config blown away by a routine write that didn't even know the data existed.

## Current invariants

- **The plugin slot is owned by the plugin, not by PluginManager.** PluginManager owns exactly two keys per slot — `enabled` and `config`. Everything else on the slot is plugin-private and must survive any state-save PluginManager performs.
- **`savePluginState` reads-before-write.** It loads the current on-disk plugins record, spreads each existing slot's keys into the rebuilt slot, then overwrites only `enabled` and `config`. This preserves `blogSites` (github), and any future plugin-owned keys, across every plugin manager save.
- **Plugins that store nested data write through their own helper, not through PluginManager.** The github plugin uses `writeBlogSites` (in `plugins/github/src/helpers.ts`), which does the same read-before-write pattern on its slot. PluginManager's writes and plugin-owned writes must both follow this pattern — neither can rebuild the slot from scratch.
- **`saveConfig`'s shallow merge is intentional.** Making `saveConfig` deep-merge would mask bugs and surprise other callers. The invariant lives at the write-site (savePluginState, writeBlogSites), not in the generic helper.

## Decision log (append-only)

### 2026-05-26 — Original incident: caloriebot blog site wiped by plugin manager startup save

- **Trigger.** Added travsteward/caloriebot-website as a blog site via `add_blog_site`, posted to it successfully. Killed openwriter processes for a code rebuild, respawned. Next `list_blog_sites` returned `{sites: []}` — the site was gone.
- **Root cause.** `PluginManager.savePluginState` rebuilt `config.plugins` from its in-memory `Map<name, {enabled, config}>` and wrote via `saveConfig({ plugins })`. The shallow top-level merge in `saveConfig` replaced the entire `plugins` key. PluginManager didn't know `blogSites` existed nested in the github slot, so the rebuilt slot omitted it. Every startup discovery cycle (which fires savePluginState) wiped the array.
- **Fix.** `plugin-manager.ts:savePluginState` now reads the current config, takes each plugin's existing slot keys, spreads them into the rebuilt slot, then overwrites `enabled` and `config`. Managed fields stay authoritative; plugin-owned data survives. Commit `28ae971`.
- **Verification.** Re-added caloriebot site, killed all openwriter procs, called `list_blog_sites` (forces a fresh MCP spawn + plugin manager init + savePluginState). Site returned with all nested data intact (`frontmatter_defaults`, `frontmatter_field_map`, `frontmatter_schema`).
- **Why this happened now.** Phase 3 of the github plugin migration (commit `c593ec1`, merged earlier) added `blogSites` to the github plugin slot as the first plugin-owned nested data. The bug had been latent in PluginManager for as long as plugins have existed but only became reachable when something actually used the nested space.
