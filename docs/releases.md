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
1. Pre-release: run `/skill-publish openwriter` to sync `~/.claude/skills/openwriter/SKILL.md` → `skills/openwriter/SKILL.md` (the repo copy). The prepublish step in #9 then copies that repo copy into the npm bundle.
2. Bump `version` in `packages/openwriter/package.json`
3. Update `CHANGELOG.md` (move Unreleased → versioned)
4. Commit: `Release v0.x.y`
5. Tag: `git tag v0.x.y`
6. Push: `git push origin main --tags`
7. GitHub Release: `gh release create v0.x.y --title "v0.x.y" --latest --notes "{changelog}"`
8. Publish: `cd packages/openwriter && node scripts/prepublish.cjs && npm publish --ignore-scripts=false`

### Why the explicit prepublish + flag
`~/.npmrc` has `ignore-scripts=true` set globally for security (prevents arbitrary postinstall scripts when installing dependencies). That flag also silently skips your own `prepublishOnly` lifecycle hook during `npm publish`. v0.20.0 shipped a stale skill bundle (v0.7.6 instead of v0.10.0) because of this; v0.20.1 was the corrective patch.

Defense in depth:
- **`node scripts/prepublish.cjs &&`** — runs the bundle copy manually so the npm bundle is at the right version BEFORE npm packs, regardless of whether the lifecycle hook fires.
- **`--ignore-scripts=false`** — overrides the global setting for this one publish command, so the `prepublishOnly` hook also runs (belt-and-suspenders; if the bundle was already correct from the manual step it's a no-op repaint).

Verify after publish: `cd /tmp && npm pack openwriter@<version>` then `tar -xzf openwriter-<version>.tgz package/skill/SKILL.md && grep version package/skill/SKILL.md` — confirm the bundled skill version matches the local one.

## npm
- Package name: `openwriter`
- Current version: `0.25.0` (published 2026-05-24)

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
