# Plugin metadata writebacks must broadcast

## Context

The core MCP tools follow a strict convention: any tool that mutates the
active document's metadata and persists it (`set_metadata`, `tag_doc`,
reference edits, mark-sent) calls `broadcastMetadataChanged(getMetadata())`
immediately after `setMetadata` + `bumpDocVersion`. Several also call
`broadcastDocumentsChanged()` when the change affects the file tree. See
`mcp.ts:1025`, `1118`, `1752`, `2051`. Without the broadcast, server state and
disk are correct but every connected browser keeps rendering stale metadata
until the user manually reloads — the WebSocket is the only thing that pulls a
live client back into sync.

Plugins mutate active-doc metadata too. The github plugin's `post_to_blog`
writes `blogContext.lastPublish` (`publishedAt`, `publishedUrl`, `commit`,
`file`) so three surfaces can reflect "this doc is on the site":

- the file-tree green ✓ + the "Republish to Blog" context-menu label — both
  read `blogContext.lastPublish.publishedUrl` → `postedUrl` from
  `/api/documents` (`documents.ts:131`);
- the compose-view "Published" pill — reads the active doc's live `metadata`.

But plugins can't `import` the server's `ws.js` directly — they reach server
internals only through the `ServerModules` bridge in
`plugins/github/src/helpers.ts`. That bridge originally exposed `setMetadata`,
`bumpDocVersion`, and `save` but **not** the broadcast functions. So
`post_to_blog` persisted the writeback and then went silent: the file tree and
the compose pill stayed stale until a reload, even though disk was correct.

The brief that surfaced this proposed a client-side fix — have the publish
modal re-fetch after success. That only patches the one invocation path
(modal-driven publish) and leaves the agent-driven path (an agent calling
`post_to_blog` over MCP) just as stale. The producer is where the convergence
guarantee belongs.

## Current invariants

- **A plugin tool that mutates + persists active-doc metadata MUST broadcast,
  exactly like the core tools.** After `setMetadata` + `bumpDocVersion` +
  `save`, call `broadcastMetadataChanged(getMetadata())` (updates the active
  doc's live metadata on every client) and, when the change affects the
  file-tree row (published state, send state, title), `broadcastDocumentsChanged()`
  (triggers a `/api/documents` re-fetch).
- **The broadcast lives at the producer, not the consumer.** It fires from the
  writeback site in the plugin, so all clients and all invocation paths
  converge — never from a single UI surface after one specific user action.
- **The broadcast is gated on a successful writeback.** It sits inside the same
  `try` as `save()`. If the writeback throws, no broadcast fires and the tool
  returns a `warning` instead — clients are not told "synced" when the disk
  write failed.
- **The `ServerModules` bridge exposes the broadcasts plugins are allowed to
  fire.** `broadcastMetadataChanged` and `broadcastDocumentsChanged` are part of
  the bridge contract in `plugins/github/src/helpers.ts`; any future plugin that
  does a metadata writeback uses them rather than re-importing `ws.js`.

## Decision log (append-only)

### 2026-06-01 — Original: Post-to-Blog sent badge stayed stale until reload

- **Trigger.** Publishing a doc via the Post-to-Blog modal succeeded and wrote
  `blogContext.lastPublish` to disk, but the file-tree ✓, the "Republish to
  Blog" label, and the compose-view "Published" pill did not update until the
  user manually reloaded the tab.
- **Root cause.** `post_to_blog` was the only metadata-mutating write path that
  persisted state without broadcasting. The plugin's `ServerModules` bridge
  didn't expose `broadcastMetadataChanged` / `broadcastDocumentsChanged`, so the
  plugin physically could not follow the core-tool convention.
- **Fix.** Added both broadcasts to the bridge (`helpers.ts`) and called them at
  the `post_to_blog` writeback site (`blog-tools.ts`), inside the writeback
  `try`, after `save()`. This fixes every client and both invocation paths
  (modal and direct-agent MCP) with no per-call-site wiring. Shipped alongside
  the contract-field fix that has the modal consume `live_url` and the
  compose pill read `publishedUrl`.
- **Why this happened now.** `blogContext.lastPublish` is recent (the live-URL
  writeback). It was the first plugin-owned active-doc metadata write whose
  effect was visible in the UI, so the missing-broadcast gap only became
  reachable once something rendered off it.
