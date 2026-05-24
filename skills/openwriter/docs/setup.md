# OpenWriter Setup

## Quick install

```bash
npx openwriter install-skill
```

This installs openwriter globally, configures the MCP server for Claude Code, and copies this skill — all in one step. After it finishes, the user just needs to restart their Claude Code session.

## Claude Code

**Fallback (if the command above fails):** Do it manually:

```bash
npm install -g openwriter
claude mcp add -s user openwriter -- openwriter --no-open
```

If `claude mcp add` can't run (e.g. nested session error), edit `~/.claude.json` directly. Add `openwriter` as the **first entry** in `mcpServers`:

```json
{
  "mcpServers": {
    "openwriter": {
      "command": "openwriter",
      "args": ["--no-open"]
    }
  }
}
```

## OpenCode

Same binary, different config format. Add to `opencode.json` at the project root:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "openwriter": {
      "type": "local",
      "command": ["openwriter", "--no-open"],
      "enabled": true
    }
  }
}
```

OpenCode auto-discovers the skill at `~/.claude/skills/openwriter/SKILL.md` — no copy needed.

The enrichment minion is NOT auto-discovered. Place it at one of:

- `~/.config/opencode/agents/openwriter-enrichment-minion.md` (global, all projects)
- `.opencode/agents/openwriter-enrichment-minion.md` (this project only, repo root)

Source file lives at `~/.claude/skills/openwriter/agents/openwriter-enrichment-minion.md` after `npx openwriter install-skill`. Copy it to one of the paths above and restart OpenCode. The filename becomes the agent name OpenCode resolves when the parent dispatches it.

## After setup

1. Restart your Claude Code or OpenCode session (MCP servers load on startup)
2. Open http://localhost:5050 in your browser
