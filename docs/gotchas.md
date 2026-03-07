# Gotchas

## Browser doc-updates can corrupt server state

`updateDocument()` accepts any document from the browser. Stale tabs, `beforeunload` flush (`/api/flush`), and component remount transitions (e.g. PadEditor → TweetComposeView) can send small/empty documents that overwrite the correct in-memory state. `state.ts` has a destructive update guard (rejects if incoming < 30% of current node count). Don't bypass it.

## Dual document loading on refresh (HTTP + WS)

On Ctrl+R, the browser fetches the doc via HTTP (`/api/document`) then receives the same doc again via WebSocket `document-switched`. If both trigger `setActiveDocKey++`, the editor remounts twice — the second mount can race with stale state. `App.tsx` skips the key bump on initial WS connect (`wasEmpty`) and same-doc echoes (`isSameDoc`).

## Self-perpetuating corruption cycle

If a corrupted doc-update overwrites in-memory state AND gets saved to disk, Ctrl+R serves the corrupted version permanently. The destructive update guard in `updateDocument()` + the existing destructive save guard in `save()` form a double barrier. Both are needed — the save guard alone wasn't enough because the in-memory state was already wrong.

## blogContext contamination on doc-switch transitions

Compose views with useEffect-based metadata saves (BlogComposeView, potentially others) can contaminate non-typed documents during doc-switch transitions. When switching FROM a blog doc TO a plain doc, the component's state resets to defaults, triggering save useEffects while the component is still mounted. Fix: `canSave = !!blogContext?.active` guard on all save operations (client-side) + `setMetadata()` rejects blogContext writes without `active:true` when the doc doesn't already have active blogContext (server-side defense-in-depth). Both guards are required — old browser tabs can bypass client-side fixes.

## TweetComposeView `splitContentAtHr` only runs on mount

`useState` initializer splits the TipTap doc at `horizontalRule` nodes into tweet parts. If the initial content lacks HRs (corrupted), the view permanently shows 1 tweet. It won't self-correct — requires a remount with correct content.

## Newsletter email gap above first-child heading (fixed 2026-03-07)

**Symptom:** Sent newsletter emails have a noticeable gap at the top when the body starts with an H1 (or any heading).

**Root cause — two issues:**

1. **CSS specificity in email template** (`openwriter-publish/src/email/template.ts`): The rule `.eb > *:first-child { margin-top: 0; }` was supposed to zero out top margin for the first element. But `.eb h1 { margin-top: 2em; }` has equal specificity (0-1-1) and appears later in the stylesheet, so it wins. juice inlines both, and the later rule's value takes precedence.

2. **TipTap `<!-- -->` markers blocking frontmatter stripping** (`plugins/publish/src/index.ts`): `stripFrontmatter()` tried to strip the leading `# Title` heading before removing `<!-- -->` empty paragraph markers. TipTap serializes empty paragraphs as `<!-- -->`, and these appeared before the heading in the raw markdown. The `^# [^\n]*\n\n` regex couldn't match because the heading wasn't at position 0. Order of operations: strip `<!-- -->` first → `.trim()` → then strip heading (if desired).

**Fixes applied:**

1. **CSS**: Changed to `.eb > *:first-child { margin-top: 0 !important; }` — `!important` is standard practice in email CSS and ensures first-child always wins regardless of specificity order.

2. **`stripFrontmatter()`**: Reordered to strip `<!-- -->` markers before any heading-dependent regex. H1 stripping itself was removed (headings should render in the email body; the subject line is separate).

**Lesson:** When juice inlines CSS, equal-specificity rules resolve by source order (last wins). Always use `!important` for email CSS overrides that must take precedence. Also, TipTap's `<!-- -->` markers can appear before content in serialized markdown — account for them before applying start-of-string regexes.

## MCP pipe disconnect kills HTTP server (fixed 2026-03-01)

**Symptom:** Browser works briefly after session start, then goes completely dead. `ERR_CONNECTION_REFUSED` on port 5050. `/mcp` fixes it by restarting the process.

**Root cause:** The MCP SDK's `StdioServerTransport.send()` writes to `process.stdout` with NO error handler. When Claude Code closes or resets the MCP pipe, the write throws EPIPE → unhandled exception → Node.js process dies → HTTP server (browser UI) crashes with it. The process was sharing a single Node.js runtime for both MCP stdio transport and the Express HTTP/WS server, so an MCP transport failure killed everything.

**Four-layer fix applied:**

1. **Crash guards** (`bin/pad.ts`): Added `uncaughtException`, `unhandledRejection`, and `process.stdout.on('error')` handlers at the top of the entry point. They catch EPIPE and ERR_STREAM_DESTROYED (broken MCP pipe) and silently ignore them, letting the HTTP server survive. This is the critical fix — the others are defense-in-depth.

2. **Health-checked port probe** (`bin/pad.ts`): Port check now hits `GET /api/status` with a 2s timeout instead of just TCP connect. If the port is held by an unresponsive process, classifies it as "orphaned" and waits up to 6s (two 3s retries) for it to die before claiming primary mode. Only enters client mode if the existing server responds to the health check.

3. **server.listen retry + error logging** (`server/index.ts`, `bin/pad.ts`): `startHttpServer()` was fire-and-forget with no `.catch()` — if it threw, MCP kept working but the browser had no server. Now: errors are logged to stderr, and `server.listen` retries once on `EADDRINUSE` after a 2s wait.

4. **Connection banner + WS resilience** (`src/App.tsx`, `src/App.css`, `src/ws/client.ts`): The `connected` boolean from `useWebSocket` was completely unused — zero visual feedback when disconnected. Now shows a "Reconnecting to server..." banner with spinner. WebSocket reconnection uses exponential backoff (1s→8s) instead of fixed 2s, and immediately reconnects on tab visibility change.

**Files changed:**
- `packages/openwriter/bin/pad.ts` — crash guards, health-checked port probe, `.catch()` on `startHttpServer`
- `packages/openwriter/server/index.ts` — `server.listen` wrapped in promise with EADDRINUSE retry
- `packages/openwriter/src/ws/client.ts` — exponential backoff, visibility-change reconnect
- `packages/openwriter/src/App.tsx` — destructure `connected`, render connection banner
- `packages/openwriter/src/App.css` — `.connection-banner` styles
