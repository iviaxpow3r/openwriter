# Node Identity Matcher — Save-Time vs Load-Time Boundary

## Context

OpenWriter persists every document as a plain `.md` file with YAML frontmatter. Every save round-trips an in-memory TipTap tree through markdown text. Identity tracking (node IDs that survive edits) lives in the `nodes` field of frontmatter — `[{id, fp}, ...]` where `fp` is a deterministic per-block fingerprint.

The matcher reconstructs identity by comparing two snapshots of the same document — the pre-edit graph (last save's `nodes`) against the post-edit tree (current TipTap). When fingerprints align, IDs flow forward; when content changes shape, the matcher's mutation rules decide whether it's an edit (preserve ID), an insert (mint new), a delete (move to graveyard), a type-change (preserve ID across type swap), or a paste-back (restore ID from graveyard).

For full design context: `docs/node-identity.md`.

## Current invariants

- **Disk is the canonical identity store.** `nodes` and `graveyard` in frontmatter are the only durable record of node identity. No parallel in-memory cache mirrors them.
- **The matcher reads `previousNodes` + `graveyard` from disk at save time.** Specifically: `writeToDisk` in `server/state.ts` calls `readPersistedIdentity(state.filePath)` immediately before serializing, parses the existing file's frontmatter, runs `matchNodes(previousNodes, newBlocks, { graveyard })`, applies pinned IDs back onto the in-memory tree via `applyIdsToTiptap`, and writes the resulting `nextGraveyard` into the new frontmatter.
- **The matcher also runs at load time** (`server/markdown-parse.ts` → `applyMatcher`) so the in-memory tree starts each session with the same IDs the disk frontmatter encodes.
- **External docs** (anything outside `~/.openwriter/profiles/`) bypass the matcher entirely. They keep their frontmatter verbatim via `state.originalFrontmatter`; we never inject `nodes` / `graveyard` into a user's other markdown files.
- **`tiptapToMarkdownChecked` is the serializer of record for internal docs.** It re-parses the just-written markdown and logs a sync report if the round-trip changes block shape — drift never blocks the save, but it shouts in the console.
- **`PadState` does NOT cache `lastSavedNodes` or `graveyard`.** If you find yourself reaching for `state.lastSavedNodes`, stop — that's the anti-pattern this ADR exists to prevent.

## Decision log (append-only)

### 2026-05-16 — Option B: save-time matcher reads from disk, no in-memory identity cache

- **Trigger.** Live flood-test on `Matcher Integration Test.md` revealed that type-change (Op 7) and graveyard-restore (Op 8) never fired within a session. Root cause: the matcher only ran on load. The editor minted fresh IDs at every insert, and by the time a save fired, the in-memory tree had drifted from the disk-saved graph with no path to reconcile.
- **First attempt (rejected).** Added `state.lastSavedNodes` and `state.graveyard` to `PadState`, refreshed via a `computeLastSavedNodes(doc)` helper after every write. The matcher ran at save time using those cached entries as `previousNodes`. Worked, but introduced a parallel state store mirroring disk — every cache invalidation path (`updateCacheEntry`, `setActiveDocument`, `clearAllCaches`, `CachedDoc`) had to know about it.
- **User pushback.** Travis: *"save really doesn't make sense to me, isn't markdown just always LIVE, all changes present? Why do we have 'States' for this?"* Then: *"an oversight this obvious seems like we need to really understand what we're trying to do."* The frame: markdown is the source of truth; memory is an ephemeral working copy. A parallel identity cache violates that frame.
- **Option B chosen.** Drop `state.lastSavedNodes` and `state.graveyard`. At save time, `readPersistedIdentity(state.filePath)` opens the existing file, runs `matter()` over the frontmatter, normalizes `data.nodes` and `data.graveyard` into `NodeEntry[]`, and hands them to the matcher. One extra `readFileSync` per save — negligible cost for documents of any realistic size, and disk stays the single source of identity truth.
- **Why not Option A (save-time matcher + broadcast).** Would also have required a change-listener path to push corrected IDs to the browser. Memory becomes the truth, disk follows, and broadcast races become possible.
- **Why not Option C (load-time only).** Type-change and graveyard-restore stay broken in-session. Operations would only re-pin after a doc switch / reload — invisible, surprising failure mode.
- **Change made.** `server/state.ts:writeToDisk` reads identity from disk before serializing; `server/state.ts` drops the `lastSavedNodes` / `graveyard` fields from `PadState` and `CachedDoc`; `server/documents.ts` drops the trailing two args from all 7 `setActiveDocument` call sites. Verified with `scripts/test-save-time-matcher.mjs` (22/22 pass) plus the existing `scripts/test-sync-check.mjs` (9/9), `scripts/test-nodeid-roundtrip.mjs` (22/22), `scripts/test-backlinks.mjs` (20/20), `scripts/test-link-href.mjs` (26/26). Commit hash: 2d5ec07.
- **Invariant for future edits.** Do not add an in-memory identity cache to `PadState` or `CachedDoc` to avoid the disk read. The disk read is the design, not a performance bug. If save-time identity becomes a hot path, the right fix is to cache the parsed frontmatter, not to introduce a parallel state store.
