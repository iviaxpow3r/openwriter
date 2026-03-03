# OpenWriter

Local TipTap 3.0 editor for human-agent collaboration. Turborepo monorepo with plugin system.

## Architecture

- **`packages/openwriter`** — Main app: Express server + React frontend + MCP stdio transport → [docs/architecture.md](docs/architecture.md)
- **`plugins/*`** — Bundled plugin packages → [docs/plugin-architecture.md](docs/plugin-architecture.md) | [docs/plugin-development.md](docs/plugin-development.md)
- **`skills/openwriter`** — Public skill for agent discovery → [docs/skill-progression.md](docs/skill-progression.md)

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
Package: `openwriter` on npm. Current: v0.5.4. See [docs/releases.md](docs/releases.md).

## Conventions

- **Commits**: `wip:` prefix for work-in-progress. Checkpoint after every fix/feature.
- **500-line rule**: No file should exceed 500 lines. Split early.
- **MCP tool count**: Currently 30 tools across 6 categories.
- **Skill version**: Independent from app version (currently 0.1.0). Bump when SKILL.md content changes.

## Key Design Decisions

- **Marketing site** — Separate private repo: `C:\openwriter-site` / `travsteward/openwriter-site`. Astro 5 static + Cloudflare Workers. See [docs/site-aesthetic.md](docs/site-aesthetic.md).
- **Skill-first onboarding** — Users install the skill, not the npm package directly. The skill teaches the agent to do the setup.
- **Two-step document creation** — `create_document` (spinner) → `populate_document` (content). Prevents 30s silence during generation.
- **Plain .md files** — No database. Filesystem is the index. YAML frontmatter for metadata.

## Server Restart

After code changes: `npm run build` then `/mcp` to reconnect. That's it — build picks up all changes, `/mcp` restarts the server process with fresh code.

## Gotchas

Known pitfalls and non-obvious behaviors → [docs/gotchas.md](docs/gotchas.md)
