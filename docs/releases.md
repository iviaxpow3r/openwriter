# Releases & Open Source

## Versioning
- Semver `0.x.y` (pre-1.0).
- **Patch (0.2.x)**: Bug fixes, refactors, internal improvements, API simplifications.
- **Minor (0.x.0)**: New user-facing features, new MCP tools, breaking changes worth announcing.
- **Major (1.0.0)**: When the MCP tool API is considered stable.

## Changelog
- `CHANGELOG.md` at repo root, [Keep a Changelog](https://keepachangelog.com/) format.
- Add entries under `[Unreleased]` as you work.
- On release: move `[Unreleased]` items into versioned section `[0.x.y] - YYYY-MM-DD`.

## Release Flow
1. Bump `version` in `packages/openwriter/package.json`
2. Bump `version` in `packages/openwriter/skill/SKILL.md` frontmatter
3. Sync skill: `cp packages/openwriter/skill/SKILL.md skills/openwriter/SKILL.md`
4. Update `CHANGELOG.md` (move Unreleased → versioned)
5. Commit: `Release v0.x.y`
6. Tag: `git tag v0.x.y`
7. Push: `git push origin main --tags`
8. Publish: `cd packages/openwriter && npm publish`

## npm
- Package name: `openwriter`
- Current version: `0.8.2` (published 2026-03-18)

## GitHub
- Repo: `travsteward/openwriter` (public, MIT license).
- Default branch: `main`.
- Pending: reclaim `openwriter` org name from dormant GitHub account.

## Skill Distribution
- `skills/openwriter/SKILL.md` in repo root — standard location for skill directories.
- `packages/openwriter/skill/SKILL.md` — bundled in npm for `npx openwriter install-skill`.
- Keep both in sync. Repo copy is discoverable by skill CLIs; npm copy is for offline install.
- Compatible CLIs: `npx skills add`, `npx add-skill`, `npx openskills install`
- Directories: skills.sh, mcp.so, PulseMCP, mcpservers.org, awesome-mcp-servers, awesome-claude-skills
- **Skill version is independent from app version.** Skill uses its own semver (currently 0.2.0). Bump skill version when SKILL.md content changes, not when app code changes.

## Public vs Internal Files
- **Public** (committed): README.md, LICENSE, CONTRIBUTING.md, CHANGELOG.md, source code
- **Gitignored** (internal): CLAUDE.md, docs/, .playwright-mcp/, TODO.md, .env, config.json

## History
- No BreeWriter references remain in source. All cleaned 2026-02-17.
