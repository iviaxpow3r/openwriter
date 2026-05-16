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
- **Container fingerprints are content-empty.** Containers (`blockquote`, `bulletList`, `orderedList`, `taskList`) have `charCount: 0, sentences: []` because their content lives in child nodes. As a side effect, the graveyard-restore rule will match any container of the right type at the right slot — deleting a blockquote and inserting a different blockquote at a similar slot will restore the original container ID (children get fresh IDs because their own fingerprints differ). This is intentional: container identity is structural, not content-based.
- **Slot-continuity wins over operation-intent.** If a single `write_to_pad` batch contains both `rewrite(X)` and `insert(above X)`, the matcher's slot-continuity rule pins X's ID to its original slot position (now holding the inserted content) and mints a fresh ID for the rewritten content at its new slot. The matcher sees fingerprints + positions, not operation tuples. Callers that depend on `rewrite` being identity-preserving should not combine it with adjacent inserts in the same save batch — issue them as separate saves if ID continuity for the rewritten block matters.
- **TipTap inserts a trailing empty paragraph on every load.** After a `markdownToTiptap` round-trip, the parsed tree gains an empty paragraph at the end so the editor cursor has a landing spot. The matcher mints a fresh ID for it (no fingerprint match in `previousNodes`). This shows up as a one-time `+1` to active node count on the first reload after a save. Not drift, not a bug — an editor UX artifact that's invisible in the rendered body (`<!-- -->` marker).

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

### 2026-05-16 — End-to-end integration test landed (commit 6ab1662)

- `scripts/test-state-integration.mjs` drives the real `state.ts` production path (setActiveDocument → save → writeToDisk) against an isolated test profile rather than mirroring writeToDisk's logic. 52 assertions across 12 scenarios: first save, text edit, insert, delete, paste-back, type-change, first-save-edge-case, external-doc bypass, reload roundtrip, multi-op burst, sync observer, slot-continuity.
- Combined with the existing matcher unit tests, total project test count is 151 assertions across 6 scripts.
- Why a separate file from `test-save-time-matcher.mjs`: that one mirrors writeToDisk's logic; this one calls the real exported function. Both are kept — the mirror is faster to debug, the real one catches plumbing bugs the mirror would miss.

### 2026-05-16 — Live MCP flood test (77 operations, 0 failures)

- Drove a rich 16-block doc (headings, paragraphs, lists, code, blockquote, marks) through 77 live MCP operations across 11 phases: 8 edits / 7 deletes / 8 inserts / 8 type-changes / 7 graveyard cycles / 17 multi-op burst changes / 5 slot-continuity replacements / 6 reorders / switch_document roundtrip / 5 edge cases (marks, special chars, 362-char paragraph, wikilinks, hash characters) / external file modification + reload_from_disk.
- After each phase, frontmatter was read directly from disk and asserted against expected ID state. Final integrity audit confirmed: all 29 active IDs unique, all 15 graveyard IDs unique, no overlap between active and graveyard, every fingerprint complete, graveyard within cap (15 ≤ 50), body markdown clean (no embedded `^id` anchors), frontmatter keys clean.
- 11/12 baseline IDs survived all 77 operations (1 intentionally deleted in Phase F).
- **New invariants surfaced and added above:** container fingerprints are content-empty (graveyard-restore by type matches blindly across containers); slot-continuity wins over operation-intent when `rewrite` and `insert` collide in the same batch; TipTap inserts a trailing empty paragraph on every load.
- Cumulative test surface across this ADR's three logged actions: 151 unit/integration assertions + 77 live MCP operations + 7 final integrity checks = **235 verifications, 0 failures**.
