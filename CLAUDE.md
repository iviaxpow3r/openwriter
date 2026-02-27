# OpenWriter

Local TipTap 3.0 editor for human-agent collaboration. Turborepo monorepo with plugin system.

## Architecture

- **`packages/openwriter`** — Main app: Express server + React frontend + MCP stdio transport → [docs/architecture.md](docs/architecture.md)
- **`plugins/*`** — Bundled plugin packages → [docs/plugin-architecture.md](docs/plugin-architecture.md) | [docs/plugin-development.md](docs/plugin-development.md)
- **`skills/openwriter`** — Public skill for agent discovery → [docs/skill-progression.md](docs/skill-progression.md)

## Skill System

OpenWriter's primary distribution is via a **public skill** — a SKILL.md that teaches agents how to install, configure, and use the editor.

- Install: `npx skills add https://github.com/travsteward/openwriter --skill openwriter`
- Two source files MUST stay in sync: `skills/openwriter/SKILL.md` (GitHub discovery) and `packages/openwriter/skill/SKILL.md` (npm bundle)
- The skill handles: setup detection, npm install, MCP server config, writing strategy, review etiquette
- Full history: [docs/skill-progression.md](docs/skill-progression.md)

## Deploy

### App (`packages/openwriter`)
```bash
cd packages/openwriter && npm publish
```
Package: `openwriter` on npm. Current: v0.3.1. See [docs/releases.md](docs/releases.md).

## Conventions

- **Commits**: `wip:` prefix for work-in-progress. Checkpoint after every fix/feature.
- **500-line rule**: No file should exceed 500 lines. Split early.
- **MCP tool count**: Currently 29 tools across 6 categories.
- **Skill version**: Lags behind app version — update SKILL.md when tools change.

## Key Design Decisions

- **Marketing site** — Separate private repo: `C:\openwriter-site` / `travsteward/openwriter-site`. See [docs/site-aesthetic.md](docs/site-aesthetic.md).
- **Skill-first onboarding** — Users install the skill, not the npm package directly. The skill teaches the agent to do the setup.
- **Two-step document creation** — `create_document` (spinner) → `populate_document` (content). Prevents 30s silence during generation.
- **Plain .md files** — No database. Filesystem is the index. YAML frontmatter for metadata.

## Gotchas

- **Browser doc-updates can corrupt server state**: `updateDocument()` accepts any document from the browser. Stale tabs, `beforeunload` flush (`/api/flush`), and component remount transitions (e.g. PadEditor → TweetComposeView) can send small/empty documents that overwrite the correct in-memory state. `state.ts` has a destructive update guard (rejects if incoming < 30% of current node count). Don't bypass it.
- **Dual document loading on refresh (HTTP + WS)**: On Ctrl+R, the browser fetches the doc via HTTP (`/api/document`) then receives the same doc again via WebSocket `document-switched`. If both trigger `setActiveDocKey++`, the editor remounts twice — the second mount can race with stale state. `App.tsx` skips the key bump on initial WS connect (`wasEmpty`) and same-doc echoes (`isSameDoc`).
- **Self-perpetuating corruption cycle**: If a corrupted doc-update overwrites in-memory state AND gets saved to disk, Ctrl+R serves the corrupted version permanently. The destructive update guard in `updateDocument()` + the existing destructive save guard in `save()` form a double barrier. Both are needed — the save guard alone wasn't enough because the in-memory state was already wrong.
- **TweetComposeView `splitContentAtHr` only runs on mount**: `useState` initializer splits the TipTap doc at `horizontalRule` nodes into tweet parts. If the initial content lacks HRs (corrupted), the view permanently shows 1 tweet. It won't self-correct — requires a remount with correct content.
