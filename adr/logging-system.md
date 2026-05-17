# Structured logging system

## Context

OpenWriter's bugs live in the choreography between actors — OS filesystem,
server in-memory state, WebSocket layer, browser TipTap, agent lock,
debounce timers. Most production bugs are races that unit tests cannot
reach. The diagnostic value of logs is therefore high.

Before this system, openwriter relied on scattered `console.log` calls
across server modules. Claude Code captures stdout, but two structural
problems made the captured logs unreliable for diagnostics:

1. **Log capture dies on MCP restart.** Claude Code binds the log handle
   to the original MCP process. After `taskkill` + respawn, the new
   server's stdout no longer reaches the log file. Investigating any
   post-restart bug becomes guesswork.
2. **No structure.** Plain-text lines mean grep is the only query. No
   per-request correlation, no level filtering, no field-based
   selection. "What did this WS message cause" requires eyeballing
   timestamps.
3. **No privacy story for public users.** `console.log` lines included
   document text excerpts (the `nodeTextPreview` helper). For Travis
   locally, that's his writing. For public users, it's THEIR writing
   landing in a file on disk they didn't opt into.

Today's pending-state corruption bug surfaced all three problems:
the corruption fired during a server restart (logs missed), the actor
causing the corrupted payload couldn't be traced without correlation,
and the diagnostic text excerpts we needed locally would have leaked
document content publicly.

## Current invariants

- **One log file per profile.** `~/.openwriter/profiles/<profile>/events.log`.
  JSON-per-line. One file (not category-split) so grep covers everything
  in one place. Tools like `jq` query by field.
- **File handle is server-owned, not Claude Code's.** Survives MCP kill +
  respawn. Same trick the prior ad-hoc `diagnostic.log` proved.
- **Default config is safe for public.** Missing config file = `level: error,
  includeText: false`. Errors only, no document text. Public users never
  have writing land in logs.
- **Local override via config file.** `~/.openwriter/log-config.json` —
  `{ level, includeText }`. Travis's machine has `level: trace, includeText:
  true`. Live-reloaded via `fs.watch` — flip verbosity without restarting.
- **Errors always log regardless of level.** A crash trace is non-
  negotiable. `level: error` is the floor, not a gate.
- **Request IDs flow through async chains.** `withRequestId(id, fn)` wraps
  every external trigger (WS message, MCP tool call). `AsyncLocalStorage`
  carries the ID through every awaited downstream call. Every log emitted
  during the request inherits the ID. "What did this request cause" is one
  `jq 'select(.requestId=="ws-doc-update-abc123")'`.
- **50 MB rotation, keep last 5.** `events.log.1` through `events.log.5`.
  Old files auto-deleted. No manual cleanup ever needed.
- **Text redaction is centralized.** Any log helper that emits document
  text routes through `redactText()`. When `includeText: false`, returns
  `<redacted:Nchars>` instead of the content. Single chokepoint, easy to
  audit.
- **Categories are an enum.** `mcp | ws | state | overlay | save | watch |
  lock | plugin | lifecycle | error`. Each event picks one. Filter by
  category to focus an investigation.
- **Standard log shape.** `{ ts, level, category, event, requestId?, msg?,
  fields?, err? }`. Errors include `{ message, stack }` for the exception.
- **Logger calls never throw.** Logging is best-effort — a logger crash
  must not crash the server. Internal try/catch swallows.

## Decision log (append-only)

### 2026-05-17 — initial implementation
- Trigger: pending-state corruption bug surfaced the cost of
  ad-hoc, unstructured logging. The diagnostic.log file we created
  during that investigation worked but wasn't extensible.
- Architectural framing: every event in the system needs (a) survival
  across restarts, (b) structure for querying, (c) correlation IDs
  for tracing, (d) public-safe defaults for privacy. The implementation
  must enforce all four at the source — not as conventions.
- Files created:
  - `server/logger.ts` — core module. Config loader + live-reload,
    `logger.{error|warn|info|debug|trace}` API, `withRequestId` /
    `getCurrentRequestId` for async correlation, `redactText` for
    privacy, file rotation, append-with-best-effort.
  - `scripts/test-logger.mjs` — 22-assertion test pinning the
    invariants (default safe, verbose override, request ID flow,
    errors-always-log, malformed-config-fallback).
  - `adr/logging-system.md` — this file.
- Files modified:
  - `server/pending-overlay.ts` — `diagLog` moved to `logger.ts`,
    re-exported as a shim so existing callsites keep working.
    `nodeTextPreview` now routes through `redactText`.
  - `server/index.ts` — `initLogger()` at the top of
    `startHttpServer`. `/api/mcp-call` wrapped in `withRequestId`.
  - `server/mcp.ts` — every tool handler in `TOOL_REGISTRY` wrapped
    in `withRequestId` at registration time so MCP stdio calls get
    correlation for free.
  - `server/ws.ts` — every WS message handled inside a `withRequestId`
    scope. Inner `handleMessage` function extracted so the scope
    wraps the whole dispatch.
- Verification: 22-assertion unit test green. Live test: server boot
  emits a `state.server-boot` event with port field; MCP `get_pad_status`
  call emits a `mcp.tool-call` event with `requestId=mcp-get_pad_status-...`.
  Config file change live-reloads (logged as `state.log-config-reloaded`).
- Deferred to v2:
  - `openwriter logs` CLI (tail / grep / request-trace / share).
  - Per-category level overrides (e.g. `ws: trace, others: error`).
  - Desktop toast notification on error-level events.
  - Plugin logger API (plugins currently use `console.log`; will route
    later when migration is done across all server modules).
  - Migration of remaining `console.log` callsites — current shim
    re-routes the most diagnostic-critical ones (overlay/ws/lock)
    via `diagLog`, others stay on stdout. Will migrate piecewise.