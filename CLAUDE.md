# OpenWriter

Local TipTap 3.0 editor for human-agent collaboration. Turborepo monorepo with plugin system.

## Architecture

- **`packages/openwriter`** — Main app: Express server + React frontend + MCP stdio transport → [docs/architecture.md](docs/architecture.md)
- **`plugins/*`** — Bundled plugin packages → [docs/plugin-architecture.md](docs/plugin-architecture.md) | [docs/plugin-development.md](docs/plugin-development.md)
- **`skills/openwriter`** — Public skill for agent discovery → [docs/skill-progression.md](docs/skill-progression.md)
- **Connections** — Platform-owned OAuth for content distribution (12 providers + built-in newsletter) → [docs/connections.md](docs/connections.md)
- **Content Types** — Typed docs (blog, linkedin, newsletter) with compose views + sidebar creation → [docs/content-types.md](docs/content-types.md)
- **Scheduler** — Content scheduling: slots, queue, cron-fired posts via platform Worker → [docs/scheduler.md](docs/scheduler.md)
- **Scheduler Connectors** — `connect-*` plugins for third-party schedulers (Postiz, Buffer, etc.) via federated SchedulerSource → [docs/scheduler-connectors.md](docs/scheduler-connectors.md)
- **Vault Bridge** — Obsidian-style features (search dropdown, outline, wikilinks, backlinks panel, command palette) → [docs/vault-bridge.md](docs/vault-bridge.md)
- **Node Identity** — Math-first per-block fingerprints in YAML frontmatter (`nodes:` + `graveyard:`) so block IDs survive edits, type-changes, deletes, paste-back. Save-time matcher reads from disk every save (Option B). Body stays clean markdown. → [docs/node-identity.md](docs/node-identity.md) · [adr/node-identity-matcher.md](adr/node-identity-matcher.md)

## Skill System

OpenWriter's primary distribution is via a **public skill** — a SKILL.md that teaches agents how to install, configure, and use the editor.

- Install: `npx skills add https://github.com/travsteward/openwriter --skill openwriter`
- Canonical copy: `~/.claude/skills/openwriter/SKILL.md` (local, what the agent reads and edits)
- Published via `/skill-publish openwriter` to `skills/openwriter/SKILL.md` (GitHub discovery)
- npm copy (`packages/openwriter/skill/SKILL.md`) auto-derived at publish time via `prepublishOnly`
- The skill handles: setup detection, npm install, MCP server config, writing strategy, review etiquette
- Full history: [docs/skill-progression.md](docs/skill-progression.md)

## Deploy

### App (`packages/openwriter`)
```bash
cd packages/openwriter && npm publish
```
Package: `openwriter` on npm. Current: v0.14.1. See [docs/releases.md](docs/releases.md).

## Conventions

- **Commits**: `wip:` prefix for work-in-progress. Checkpoint after every fix/feature.
- **MCP tool count**: Currently 65 tools (44 core + 21 publish plugin).
- **Skill version**: Independent from app version (currently 0.7.1). Bump when SKILL.md content changes.

## Key Design Decisions

- **Marketing site** — Separate private repo: `C:\openwriter-site` / `travsteward/openwriter-site`. Astro 5 static + Cloudflare Workers. See [docs/site-aesthetic.md](docs/site-aesthetic.md).
- **Skill-first onboarding** — Users install the skill, not the npm package directly. The skill teaches the agent to do the setup.
- **Two-step document creation** — `create_document` (spinner) → `populate_document` (content). Prevents 30s silence during generation.
- **Plain .md files** — No database. Filesystem is the index. YAML frontmatter for metadata.

## Server Restart

Global `openwriter` command is npm-linked to `C:\openwriter\packages\openwriter` — local builds ARE what the MCP runs. After code changes: `npm run build`, kill the running openwriter process (`taskkill //F //PID <pid>`), then `/mcp` to start fresh. `/mcp` alone only reconnects to the existing process — it won't pick up new code unless the old process is killed first.

## Logs (for troubleshooting)

Claude Code writes MCP + main process logs to `C:/Users/travy/AppData/Roaming/Claude/logs/`:

- **`mcp-server-openwriter.log`** — openwriter MCP server stdout/stderr. Includes `[WS] doc-update`, `[WS] Broadcast id-rewrites`, `[State] BLOCKED save`, `[sync-check serialize:<Doc>] FAIL`, plugin load errors. **First place to look** when a bug brief mentions silent data loss, rewrite loops, or sync failures.
- **`mcp.log`** — MCP framework (transport, init, tool discovery).
- **`main.log`** — Claude Code desktop main process.
- **`claude.ai-web.log`** — Web/desktop client.

To grab logs from the user's perspective: Settings → Developer → View Logs (opens the logs folder in Explorer).

## Gotchas

Known pitfalls and non-obvious behaviors → [docs/gotchas.md](docs/gotchas.md)
