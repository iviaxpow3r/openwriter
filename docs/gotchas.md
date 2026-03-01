# Gotchas

## Browser doc-updates can corrupt server state

`updateDocument()` accepts any document from the browser. Stale tabs, `beforeunload` flush (`/api/flush`), and component remount transitions (e.g. PadEditor → TweetComposeView) can send small/empty documents that overwrite the correct in-memory state. `state.ts` has a destructive update guard (rejects if incoming < 30% of current node count). Don't bypass it.

## Dual document loading on refresh (HTTP + WS)

On Ctrl+R, the browser fetches the doc via HTTP (`/api/document`) then receives the same doc again via WebSocket `document-switched`. If both trigger `setActiveDocKey++`, the editor remounts twice — the second mount can race with stale state. `App.tsx` skips the key bump on initial WS connect (`wasEmpty`) and same-doc echoes (`isSameDoc`).

## Self-perpetuating corruption cycle

If a corrupted doc-update overwrites in-memory state AND gets saved to disk, Ctrl+R serves the corrupted version permanently. The destructive update guard in `updateDocument()` + the existing destructive save guard in `save()` form a double barrier. Both are needed — the save guard alone wasn't enough because the in-memory state was already wrong.

## TweetComposeView `splitContentAtHr` only runs on mount

`useState` initializer splits the TipTap doc at `horizontalRule` nodes into tweet parts. If the initial content lacks HRs (corrupted), the view permanently shows 1 tweet. It won't self-correct — requires a remount with correct content.

## Orphaned server → client mode → browser dies (fixed 2026-03-01)

**Symptom:** Browser works briefly after session start, then goes completely dead. WebSocket errors flood the console. `/mcp` fixes it.

**Root cause:** Previous Claude Code session's openwriter process survives as an orphan on port 5050. New session's port check sees the port as taken → enters client mode (MCP proxy only, no HTTP/WS server). Browser connects to the orphaned server and works. Orphaned process eventually dies (stdin EOF). Browser loses connection with no server to reconnect to — current process is in client mode with no HTTP server.

**Three-layer fix applied:**

1. **Health-checked port probe** (`bin/pad.ts`): Port check now hits `GET /api/status` with a 2s timeout instead of just TCP connect. If the port is held by an unresponsive process, classifies it as "orphaned" and waits up to 6s (two 3s retries) for it to die before claiming primary mode. Only enters client mode if the existing server responds to the health check.

2. **server.listen retry + error logging** (`server/index.ts`, `bin/pad.ts`): `startHttpServer()` was fire-and-forget with no `.catch()` — if it threw, MCP kept working but the browser had no server. Now: errors are logged to stderr, and `server.listen` retries once on `EADDRINUSE` after a 2s wait (covers port release timing).

3. **Connection banner + WS resilience** (`src/App.tsx`, `src/App.css`, `src/ws/client.ts`): The `connected` boolean from `useWebSocket` was completely unused — zero visual feedback when disconnected. Now shows a "Reconnecting to server..." banner with spinner. WebSocket reconnection uses exponential backoff (1s→8s) instead of fixed 2s, and immediately reconnects on tab visibility change (user switching back to tab).

**Files changed:**
- `packages/openwriter/bin/pad.ts` — health-checked port probe, `.catch()` on `startHttpServer`
- `packages/openwriter/server/index.ts` — `server.listen` wrapped in promise with EADDRINUSE retry
- `packages/openwriter/src/ws/client.ts` — exponential backoff, visibility-change reconnect
- `packages/openwriter/src/App.tsx` — destructure `connected`, render connection banner
- `packages/openwriter/src/App.css` — `.connection-banner` styles
