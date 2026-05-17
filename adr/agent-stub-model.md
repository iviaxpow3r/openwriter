# Agent-stub status is session-level, not disk-level

## Context

Two-step document creation (`create_document` → `populate_document`) needs
a way to mark "this doc is an agent-proposed shell that should be cleaned
up if the user rejects everything." The original implementation stored
this as `agentCreated: true` in the doc's frontmatter on disk.

That model produced a silent data-loss landmine. The flag persisted
across sessions, server restarts, and the doc's entire useful lifetime.
The `pending-resolved reject` handler in `ws.ts` consulted it to decide
whether to delete the file. So a user who:

1. Got a stub via `create_document` (flag persisted)
2. Worked in the doc for hours, accepting agent edits piecemeal (flag
   stayed because the piecemeal accepts didn't route through
   `pending-resolved` in a way that cleared it)
3. Eventually rejected one stale pending decoration from an abandoned
   revision pass

...would lose the entire file. The destructive `deleteDocument` call
fired because the stub flag was still on disk, even though "fresh stub"
was no longer a true description of the doc's state by any human
definition.

Live evidence: inbox brief
`2026-05-17-restore-version-reject-pending-deletes-doc.md`. The reporter
lost a Chapter 2 working document this way; recovery required manual
disk-level work against the version snapshots.

## Current invariants

- Stub status is tracked in an in-memory `Set<filename>`
  (`agentStubFilenames` in `state.ts`). Process lifetime only.
- `markAsAgentStub(filename)` is called by `createDocumentFile` and by
  the `agentCreated: true` HTTP API path. Nothing else writes the Set.
- `unmarkAgentStub(filename)` fires on:
  - any save where `hasAcceptedContent(doc) === true` (graduation by
    accepted content)
  - `pending-resolved` with `action === 'accept'` on the filename
  - `deleteDocument(filename)` (the entry is no longer meaningful)
- `isAgentStub(filename)` is the ONLY check the destructive
  delete-on-reject branch consults. There is no second path to that
  destructive operation.
- `agentCreated` is NEVER written to disk. The frontmatter does not
  contain stub state. `stripLegacyAgentCreated` removes the field on
  every load and on every save (defense in depth — once for migration
  from old files, once to catch any future code that re-introduces the
  field).
- A server restart empties the Set. A doc that survives a restart is by
  definition no longer fresh — reject-all on it will strip pending state
  but never delete the file.

## Decision log (append-only)

### 2026-05-17 — initial architectural fix
- Inbox brief: agentCreated reject-delete cascade.
- Prior workaround (commit ae36625): added a defensive guard in `ws.ts`
  + auto-clear in `writeToDisk` to prevent the destructive delete when
  the doc had accepted content. The guard was a workaround — the flag's
  presence on disk was the bug, not the destructive consequence.
- Architectural fix: removed the field from disk persistence entirely.
  Stub status is now an in-memory `Set<filename>` in `state.ts`. Disk
  frontmatter never carries stub state.
- Files changed:
  - `server/state.ts` — added `agentStubFilenames` Set + helpers,
    removed `writeToDisk` auto-clear workaround, removed `agentCreated`
    from `hasMetadata` gate, added `stripLegacyAgentCreated` on load
    and save, neutered `stripPendingAttrsFromFile`'s
    `clearAgentCreated` parameter (now a legacy no-op).
  - `server/documents.ts` — `createDocumentFile` no longer writes
    `agentCreated: true`; calls `markAsAgentStub(filename)` instead.
    `renameItem` transfers stub status across the rename.
    `deleteDocument` unmarks on delete.
  - `server/index.ts` — HTTP API create-with-`agentCreated` path uses
    `markAsAgentStub` instead of `setMetadata({ agentCreated: true })`.
  - `server/ws.ts` — `pending-resolved` reject branch checks
    `isAgentStub(filename)` instead of `metadata?.agentCreated`. Removed
    the defensive `cloneWithPendingReverted + hasAcceptedContent` guard
    (no longer needed — the flag can't be stale because it lives in
    memory and graduates on first accepted content).
  - `server/mcp.ts` — `restore_version` handler no longer touches
    `agentCreated` (the workaround that stripped it from parsed and
    live metadata is gone — there's nothing to strip).
