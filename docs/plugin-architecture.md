# Plugin Architecture

Design decisions for OpenWriter's plugin system.

## Bundled vs User-Installed

Plugins live in one of two locations:

| Type | Path | Ships with npm | Survives upgrades |
|------|------|---------------|-------------------|
| **Bundled** | `plugins/` (monorepo root) | Yes | N/A (part of package) |
| **User-installed** | `~/.openwriter/plugins/node_modules/` | No | Yes |

Discovery deduplicates by name — bundled takes priority if both exist.

### Current decision: bundle first-party plugins

All three first-party plugins ship bundled:

- **Author's Voice** (`@openwriter/plugin-authors-voice`) — AI rewriting, sidebar transforms
- **Image Gen** (`@openwriter/plugin-image-gen`) — AI image generation via Gemini
- **X / Twitter** (`@openwriter/plugin-x-api`) — Post to X from the editor

**Why bundled (for now):**
- They're tiny (~150-270 lines each, 6 files per plugin)
- Zero friction for skill-driven setup — the agent enables them, no install step needed
- No npm packages to maintain/version/publish separately
- The user-install path (`~/.openwriter/plugins/`) is ready but untested in production
- Nobody installs OpenWriter without the skill, and the skill handles plugin config

**When to unbundle:**
- Third-party plugin ecosystem emerges (bundling first-party feels like lock-in)
- Users complain about install size (unlikely — plugins add ~600 lines total)
- A plugin grows large enough to warrant its own release cycle
- We want to demonstrate the user-install path works end-to-end

**How to unbundle (when ready):**
1. Publish each plugin to npm under `@openwriter/plugin-*`
2. Remove from `plugins/` directory
3. Update the skill to `npm install` them into `~/.openwriter/plugins/`
4. Update `files` array in `packages/openwriter/package.json` if plugins were included

The plugin system already supports both paths — no code changes needed to unbundle.

## Plugin Discovery

Two-phase discovery runs at server startup:

1. **`discoverBundledPlugins()`** — scans `plugins/` for subdirectories with `package.json`
2. **`discoverUserPlugins()`** — scans `~/.openwriter/plugins/node_modules/` for packages matching naming conventions

Valid plugin names:
- `@openwriter/plugin-*` (first-party)
- `openwriter-plugin-*` (community)
- `@scope/openwriter-plugin-*` (scoped community)
- Any package with an `"openwriter"` field in `package.json`

## Plugin Lifecycle

```
discover() → Map<name, ManagedPlugin>
    ↓
enable(name)
    → loadPluginModule() via ESM import
    → registerRoutes() → Express sub-router (auto-disabled when plugin disabled)
    → mcpTools() → MCP tool registration (auto-removed when disabled)
    → contextMenuItems() → sent to frontend via /api/plugins
    → sidebarMenuItems() → sent to frontend via /api/plugins
    ↓
disable(name)
    → unmount routes, remove MCP tools
    → save state to ~/.openwriter/config.json
```

Plugins are lazy-loaded — discovery reads `package.json` metadata only. The actual module is imported when enabled.

## Action Dispatch

### Editor context menu actions
Client sends `POST /api/plugins/context-action` with `{ action, text, ... }`. The action prefix (before `:`) routes to the correct plugin.

### Sidebar document actions
Client sends `POST /api/plugins/sidebar-action` with `{ action, filename, title, instructions }`. The server:
1. Strips the namespace prefix from the action
2. Reads the document content from disk (so plugins don't need a callback)
3. Forwards the enriched body to `POST /api/{prefix}/sidebar-action`

This means plugins receive the full document content without needing to know OpenWriter's filesystem layout.

## Config Resolution

Plugin config values resolve in order:
1. Saved config in `~/.openwriter/config.json`
2. Environment variable (if `env` specified in `configSchema`)
3. Empty string

Users configure plugins via the Plugin Panel UI. Agents configure them via MCP tools (`configure_plugin`).
