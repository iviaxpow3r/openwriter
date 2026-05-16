# Sidebar Writing Spinner Placement

## Context

When the MCP `create_document` (or `declare_writes`) tool runs with a `workspace` + `container` target, the server emits two WebSocket messages back-to-back: `workspaces-changed` (so the browser knows the new container exists) and `writing-started` (carrying `{ wsFilename, containerId }` so the sidebar knows where to render the spinner placeholder).

The sidebar renders that spinner placeholder in three possible places:

1. Inside a specific container (`SidebarDefault.tsx` ~line 411, `SidebarFiles.tsx` ~line 533) — match on `wsFilename + containerId`.
2. At the workspace root (`SidebarDefault.tsx` ~line 524, `SidebarFiles.tsx` ~line 622) — when `containerId === null`.
3. In the unassigned-documents section — when no workspace matches.

The race that makes this non-obvious: `workspaces-changed` only bumps a refresh key (`App.tsx:273`), which fires an **async** HTTP refetch in `useSidebarData`. `writing-started` updates `writingTarget` **synchronously**. React re-renders before the refetch settles, so on first paint `writingTarget.containerId` points to a container that isn't in the client's workspace tree yet.

## Current invariants

- **The spinner only renders at the workspace root when `containerId === null`.** No defensive fallback that promotes a container-targeted spinner up to the workspace root when the container appears absent — that fallback exists nowhere in `SidebarDefault.tsx` or `SidebarFiles.tsx`. If the container isn't in the client tree yet, the spinner waits one render cycle for the workspace refetch to complete, then renders inside the container.
- **The server is the authority on container existence at broadcast time.** `create_document` and `declare_writes` run `findOrCreateContainer` before broadcasting `writing-started`, so a `containerId` in the payload is guaranteed valid on disk. Client-side "is this container real" checks are redundant at best and bug-causing at worst.
- **`broadcastWorkspacesChanged()` MUST fire before `broadcastWritingStarted()` on the server.** Same WS, same connection, in-order delivery — the client sees the workspace-tree refresh kick off first, then the spinner-placement message. Reversing this order would break even with the right client-side logic.

## Decision log (append-only)

### 2026-05-16 — Drop the `!hasContainer(wsRoot, containerId)` fallback

- **Trigger.** Travis: *"When create_doc mcp runs in openwriter, it doesn't match the parent/child level the doc is being created in. So if the doc level its being made in is in a container, under a workspace, it shows it being created at the parent level."* Repro: any `create_document` with workspace + container — spinner renders at workspace root, then jumps into the container ~100–200ms later once the workspaces refetch lands.
- **Root cause.** `SidebarDefault.tsx:524` and `SidebarFiles.tsx:622` carried a fallback condition `writingTarget.containerId === null || !hasContainer(wsRoot, writingTarget.containerId)`. The `!hasContainer(...)` half was reasoned as "if the container doesn't exist, show the spinner somewhere sensible." But the only realistic way `!hasContainer` returns true is the async-refetch race — exactly when the spinner is meant for a brand-new container that the client hasn't fetched yet.
- **Change made.** `SidebarDefault.tsx:524` and `SidebarFiles.tsx:622` reduced to `writingTarget.containerId === null`. Also removed the now-unused `hasContainer` helper at `SidebarDefault.tsx:21`. Files: `packages/openwriter/src/sidebar/SidebarDefault.tsx`, `packages/openwriter/src/sidebar/SidebarFiles.tsx`. Parent commit before fix: 39d24ac.
- **Trade-off accepted.** The spinner is invisible for the ~100–200ms window between `writing-started` and the workspaces refetch settling. That's better than a flicker into the wrong location and back. If this window is later considered too long, the right fix is to send the workspaces snapshot inline with the `writing-started` payload — NOT to reintroduce the workspace-root fallback.
- **Invariant for future edits.** Do not add "show the spinner somewhere visible if its container can't be found" defensive code to either sidebar. A missing container in the client tree means a refetch is in flight — wait it out.
