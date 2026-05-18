# Pending state lives in a sidecar, not in frontmatter

## Context

Pending changes (agent rewrites/inserts awaiting user review) used to live
in the .md file's YAML frontmatter as `meta.pending`. That model
collapsed three different bugs into one shape:

- **Round-trip corruption on restore_version.** The frontmatter was a
  lossy projection of the in-memory pending tree. Round-tripping through
  serialize → write → read → deserialize lost the `originalBaseline`
  needed to revert a rewrite. Restore-version then wrote a partially-
  reverted body back to disk, corrupting the canonical content.
- **Silent overwrites on external edits.** Any tool that touched the
  .md file (VSCode, scripts, `Edit`) had to know to preserve the
  `meta.pending` block or it would silently drop pending state.
- **Pending leakage into derived views.** The frontmatter pending blob
  appeared in every grep, every backup, every diff. It was on-disk noise
  that didn't belong in the canonical document.

Architectural move: split pending state out of the canonical file
entirely. Canonical .md files contain only accepted content. Pending
state lives in `~/.openwriter/profiles/<profile>/_pending/{docId}.json`
sidecars that travel alongside the canonical file but are read/written
through their own pathway.

## Current invariants

- **Disk = canonical only.** No `pending:` or `meta.pending` field in
  frontmatter. The body holds only accepted content. `tiptapToMarkdown`
  reverts pending nodes to their `originalBaseline` before serializing.
- **Sidecar = overlay.** `_pending/{docId}.json` holds one entry per
  pending node, keyed by nodeId (not position). Entry shape:
  - `nodeId` — the canonical ID the entry attaches to
  - `status` — `insert` | `rewrite`
  - `originalBaseline` — full TipTap node for revert (rewrites only)
  - `newContent` — full TipTap node for accept (the agent's proposed
    content)
  - `afterNodeId` / `parentNodeId` — anchor for inserts (positional
    intent without positional dependence)
- **In-memory = merged.** `state.document` carries pending attrs on the
  affected nodes (canonical merged with overlay). The browser sees the
  merged form; only the persistence boundary is split.
- **NodeId-keyed.** Entries survive structural edits because they
  attach by canonical nodeId, not by position. The matcher maintains
  nodeId continuity across content changes; the overlay attaches to
  whatever node ends up carrying the ID.
- **Sidecar lifecycle mirrors canonical lifecycle.** Every write path
  that emits a canonical .md must paired-write the overlay:
  - `writeToDisk` (active doc) — extracts overlay from `state.document`,
    writes sidecar in the same pass as the .md write
  - `flushDocToFile` (non-active doc — populate, write_to_pad,
    edit_text, applyChangesToFile, applyTextEditsToFile all funnel
    through this) — same contract
  - `saveDocToFile` (browser doc-update for non-active doc) — same
    contract
  - `stripPendingAttrsFromFile` (accept-all / clear path) — deletes
    sidecar (not just clears it; absence means "no overlay")
- **Legacy migration.** On load, if the file has a legacy `meta.pending`
  block, `migrateLegacyPending` converts it to the sidecar form and the
  next save emits canonical .md (no `pending:`) + sidecar. One-time
  migration; subsequent loads find the sidecar directly.
- **No sidecar means no overlay.** Absence of the JSON file is the
  canonical "no pending changes" signal. Empty entries array also
  works but absence is preferred (smaller filesystem footprint).

## Decision log (append-only)

### 2026-05-17 — initial split (foundation commit e2e0944)
- Moved pending state from `meta.pending` (frontmatter) to
  `_pending/{docId}.json` sidecars.
- Built `pending-overlay.ts` with `extractOverlay`, `applyOverlay`,
  `saveOverlay`, `loadOverlay`, `deleteOverlay`, `migrateLegacyPending`.
- Wired the active-doc save path (`writeToDisk`) to extract + persist.
- Added legacy migration on load.
- ADR file slot reserved (`adr/pending-overlay-model.md`) but the file
  was not created in that commit — referenced from 8 callsites without
  the linked document existing.

### 2026-05-17 — symmetric overlay save for non-active write paths
- Bug: `populate_document` / `write_to_pad` / `edit_text` /
  `applyChanges` on a non-active doc dropped pending content silently.
  The canonical write fired (`atomicWriteFileSync` on stripped body),
  but no overlay was persisted. Result: 25-word populate produced a
  0-word file with no sidecar. Reproduced during live testing of the
  versioning fixes.
- Root cause: the foundation commit established the
  "canonical-write + overlay-write" contract on the active-doc path
  (`writeToDisk`) but missed the parallel non-active write paths
  (`flushDocToFile`, `saveDocToFile`, `stripPendingAttrsFromFile`).
  All three serialize through `tiptapToMarkdown` / `tiptapToBody`
  which revert pending — and then wrote only the canonical without
  the overlay sidecar.
- Architectural fix: every write path that emits a canonical .md must
  paired-write the overlay in the same pass. `flushDocToFile` and
  `saveDocToFile` now call `saveOverlay(docId, extractOverlay(doc))`
  after `atomicWriteFileSync`. `stripPendingAttrsFromFile` calls
  `deleteOverlay(docId)` because the strip path's contract is "no
  pending anywhere" — absence of the sidecar is the canonical signal.
- Files changed:
  - `server/state.ts` — added `saveOverlay` / `deleteOverlay` calls to
    `flushDocToFile`, `saveDocToFile`, `stripPendingAttrsFromFile`.
    Added inline ADR pointers and explanatory comments at each site.
  - `scripts/test-nonactive-overlay-symmetry.mjs` — 26-assertion
    regression test covering all three paths plus the transitive
    `populateDocumentFile`, `applyChangesToFile`, `applyTextEditsToFile`
    that funnel through `flushDocToFile`.
  - `adr/pending-overlay-model.md` — created (this file). Foundation
    commit reserved the slot; this commit fills it in.
- Verification: full unit suite green (25 files, 575 assertions, +26
  from the new symmetry test). Live integration test on docId
  `82712ff4` (non-active): populate sent 33 words → disk body 64 bytes
  frontmatter-only → sidecar JSON had 3 insert entries with full content
  → switch_document re-attached all 3 pending paragraphs as expected.
- Out of scope (filed as follow-up): `delete_document` /
  `archive_document` / `rename_item` lifecycle paths also need
  sidecar-paired actions. Currently delete leaves an orphan sidecar.

### 2026-05-17 — lifecycle invariant: sidecar bound to docId existence
- Bug: `delete_document` left an orphan `_pending/{docId}.json` after
  moving the .md to OS trash. Observed live during the previous fix's
  verification (delete of docId 82712ff4 left its sidecar behind).
- Survey turned up four lifecycle paths that touch the .md file:
  delete, archive, unarchive, promoteTempFile. Reporter framing was
  "add deleteOverlay() to all four." Wrong framing — only delete
  actually retires the docId.
- Architectural framing: pending state is bound to the docId's
  *existence in the workspace*, not to the .md's filesystem path or
  the doc's active/archived flag. Sidecar lives as long as the docId
  does. The four paths split cleanly:
    - **delete** retires the docId → sidecar removed
    - **archive** hides but doesn't retire → sidecar persists (so
      unarchive can resume the review queue)
    - **unarchive** restores → sidecar already correct (no action)
    - **promoteTempFile** renames the .md, docId is stable, sidecar
      is docId-keyed → no action (and a test that locks this in)
- Files changed:
  - `server/documents.ts` — read docId from frontmatter before
    `trash()`, call `deleteOverlay(docIdToRetire)` after. Added
    `deleteOverlay` import.
  - `scripts/test-lifecycle-overlay.mjs` — 20-assertion test pinning
    the invariant for all four paths plus a no-op-clean defensive
    test (delete with no sidecar).
- Verification: full unit suite green (26 files, 595 assertions, +20
  from the new lifecycle test). Live test: created docId fc272d6f,
  populated with pending content (sidecar written with 2 insert
  entries), deleted → .md moved to trash AND `_pending/fc272d6f.json`
  removed. `_pending/` directory now sits empty.
- Rejected alternative: aggressive "call deleteOverlay() on every
  lifecycle path that touches the .md" — would silently destroy
  review state on archive/unarchive. The architectural test ("does
  this path retire the docId?") gates the action.

### 2026-05-17 — preview-swap echoes its own swap to the server (CORRUPTION)
- Bug: clicking "Show original" on a pending rewrite in the review
  panel emits a doc-update to the server with the original content
  in the node and pendingStatus=rewrite preserved. The server can't
  distinguish this from a real user edit. Result: state.document's
  node content gets overwritten with the originalBaseline content
  while pendingStatus stays. Next save extracts the overlay and
  writes a sidecar entry where newContent === originalBaseline — a
  degenerate "identity rewrite" with no actual change to review.
- Why it didn't always fire: the WS doc-update handler has a stale-
  version check (`browserVersion < serverVersion`) which blocked
  the corrupted echo most of the time, since the agent's rewrite
  bumped server's version before the browser had picked it up.
  After server restart, both versions reset to 0, and the corrupted
  echo lands.
- Root cause: in `ReviewPanel.tsx togglePreview`, the swap-to-
  original branch called `replaceNodeContent` (which fires a
  ProseMirror transaction → TipTap's onUpdate) BEFORE calling
  `setPreviewState(true)`. The onUpdate guard
  `if (isPreviewActive()) return` therefore saw `false` when the
  swap's transaction fired, and emitted a doc-update carrying the
  original content as if the user typed it.
- Architectural framing: preview swaps are visualization, not edits,
  and must never reach the server. The order-of-operations was the
  symptom; the architectural rule is "the preview-suppress flag
  must be active for every transaction the preview machinery
  dispatches."
- Fix (this commit): flip the order in both the single-node and
  group branches of `togglePreview` — set preview state FIRST, then
  swap. Roll back the preview state if the swap fails so the user
  can retry. The swap-back-to-modified path was already correct
  because preview state is already true at entry; the
  `restoreIfPreviewing` helper unsets it after the swap.
- Diagnostic logging shipped alongside (see `pending-overlay.ts`
  `diagLog`): every overlay save logs a before/after diff, every WS
  doc-update logs the pending-state shape it carries (with an
  `IDENTITY!` flag when newContent === originalBaseline), every
  document-switched broadcast logs the pending state being sent.
  Logs go to `~/.openwriter/profiles/<profile>/diagnostic.log` —
  our own file handle, so they survive MCP kill+restart.
- Files changed:
  - `src/review/ReviewPanel.tsx` — order flip in `togglePreview`
    for single-node and group cases, with roll-back on swap
    failure.
  - `server/pending-overlay.ts` — added `diagLog`, `nodeTextPreview`,
    `entrySummary`; instrumented `saveOverlay`, `applyOverlay`,
    `IDENTITY-REWRITE` warning.
  - `server/ws.ts` — instrumented doc-update handler (BEFORE/AFTER
    diff, IDENTITY flag), document-switched broadcast.
  - `server/state.ts` — instrumented `setAgentLock`.
- Verification: live test with browser MCP control. Pre-fix: clicking
  "Show original" produced `[WS] doc-update BLOCKED by stale version
  ... IDENTITY!` in diag log. Post-fix: clicking "Show original" and
  back to "Modified" produced ZERO doc-update echoes. Sidecar
  unchanged through both toggle directions.
- Open follow-up: defense-in-depth guard at `saveOverlay` that
  refuses to persist a rewrite entry where newContent ===
  originalBaseline. Today's fix prevents the corruption from being
  generated; the defense-in-depth would prevent any future variant
  from being persisted. Not shipping in this commit.

### 2026-05-18 — Idempotent apply + canonical cache + startup repair

- Incident: User's Beat Map doc rendered 4 copies of a single
  agent-inserted paragraph ("2.0 BRIDGE from the prior chapter..."),
  with the sidecar `_pending/c28f34d6.json` accumulating up to 14
  copies of the same nodeId entry. Subsequent delete operations on
  the duplicates had no effect (`appliedCount:1` but render
  unchanged). Cross-referenced inbox brief
  `2026-05-18-write-to-pad-duplicate-inserts-from-stacked-pending.md`.
- Root cause: `applyOverlay` mutated its input canonical doc and
  was not idempotent — the insert path called
  `parent.splice(loc.index + 1, 0, newNode)` without checking
  whether a node with that ID already existed at the splice
  location. Combined with `cacheActiveDocument` storing the
  merged-view doc (canonical + overlay applied) and
  `setActiveDocument`'s strip-and-reapply path on cache restore,
  every switch-away/switch-back to the doc doubled the count of
  insert-pending nodes. The duplicate nodes in the doc tree then
  produced duplicate entries on the next `extractOverlay` call,
  which were persisted verbatim by `saveOverlay`. The chain
  compounded over multiple switches; the brief's "delete had no
  effect" observation traced to the re-apply path immediately
  re-inserting whatever a delete had just resolved.
- Fix: three changes that enforce the architectural rule
  "applying the same overlay twice produces the same result as
  applying it once" by construction.
  1. **`applyOverlayPure`** in `server/pending-overlay.ts` —
     pure function returning a new merged tree. Insert path
     looks up `nodeById.get(entry.nodeId)` before splicing; if
     present, refreshes the pending marker on the existing node
     and skips the splice. Replaces the mutating `applyOverlay`
     at the cache-restore and load paths.
  2. **`splitMergedDoc`** in `server/pending-overlay.ts` —
     inverse of apply. Takes a merged doc and returns
     `{canonical, overlayEntries}`. Used at cache write time
     (`cacheActiveDocument`) so the cache stores canonical +
     overlay separately, never the merged view. Re-apply runs
     on clean canonical, never on its own output.
  3. **`saveOverlay` dedupes by nodeId** before writing. Map
     collapse keeps first occurrence (preserves the original
     anchor over the self-referential anchors that propagated
     through the compounding bug). Defense in depth: even if a
     future path produces duplicate entries, they can't reach
     disk.
- Healing: **`repairOverlaysOnStartup`** in
  `server/pending-overlay.ts` runs once during `load()` before
  any doc opens. Walks every `_pending/*.json`, dedupes by
  nodeId, rewrites. On Travis's machine: 29 entries → 7 clean.
- Files changed:
  - `packages/openwriter/server/pending-overlay.ts` —
    `applyOverlayPure`, `splitMergedDoc`, `stripPendingFromDoc`,
    `repairOverlaysOnStartup`, dedup in `saveOverlay`.
  - `packages/openwriter/server/state.ts` — `getCanonical()`
    and `getOverlayEntries()` derive on demand via
    `splitMergedDoc`. `CachedDoc` now stores
    `canonical + overlayEntries` separately. `cacheActiveDocument`,
    `updateCacheEntry`, `reloadActiveDocFromDisk`, and
    `mergeOverlayOnLoad` all route through the new split + apply
    pure path. Startup hook calls `repairOverlaysOnStartup`.
- Architectural diagnosis: the original refactor moved canonical
  storage out of frontmatter into a separate sidecar, but the
  in-memory representation kept `state.document` as the
  merged-hybrid (canonical + overlay applied). The cache cloned
  that hybrid. The re-apply path used `stripPendingAttrsFromDoc`
  to "go back to canonical," but strip only removed pending
  marker attrs — not the inserted nodes themselves. The result
  was a doc that was neither canonical nor merged: original
  canonical plus orphan insert content that looked canonical.
  Re-applying overlay onto that hybrid added another copy.
  This commit closes the asymmetry on the read side
  (canonical/overlay derived via splitMergedDoc whenever the
  system needs canonical), and on the cache write side (stores
  the split, not the merged). The full split of `state.document`
  into separate in-memory `state.canonical` + `state.overlay`
  fields (the elegant end-state) is deferred to a future
  decision — this commit lands the bug fix structurally without
  changing the active-state representation.
- Verification: restart openwriter, switch to Beat Map, `read_pad`
  returns ONE BRIDGE node. Sidecar collapsed from 29 → 7
  entries. Commit `e9475ab`.
- Related inbox briefs (probably resolved by the same root):
  - `2026-05-17-restore-version-reject-pending-deletes-doc.md`
  - `2026-05-17-restore-version-safety-checkpoint-captures-wrong-state.md`
  - `2026-05-18-restore-version-resets-autoaccept-flag.md`
  These share the "code expected canonical view, got merged
  hybrid" shape. Should be re-tested before closing.

### 2026-05-18 — Canonical + overlay as primary state

- Trigger: continuation of the earlier "land the architecture the
  documentation already claims" plan. The previous commit made the
  read-side (cache writes, save path) consistent by deriving canonical
  on demand from `state.document` via `splitMergedDoc`. This commit
  flips the in-memory model so canonical and overlay become the actual
  primary state, with `state.document` derived from them.
- Change: `PadState` gains `canonical: PadDocument` and
  `overlay: Map<string, PendingEntry>` as primary fields.
  `state.document` is now a synced mirror updated by `recomputeMerged()`
  whenever primary state changes. All mutators route through sanctioned
  helpers (`setCanonical`, `setOverlayFromEntries`, `setPrimaryFromMerged`);
  direct assignment to `state.document` is forbidden.
  Existing readers via `getDocument()` continue to see the merged view
  unchanged, so the migration didn't require touching all 79 callsites.
  Save path now persists `state.overlay` directly (no extraction from
  the merged view).
- Regression caught and fixed mid-implementation: the `load()` function
  used `state.document = parsed.document` direct assignment, bypassing
  the new helpers. This left `state.canonical = DEFAULT_DOC` after
  startup, and the first save with empty `state.overlay` deleted the
  active doc's sidecar via `saveOverlay`'s "no entries → delete"
  branch. Cost: Travis's 7 pending entries on the Beat Map doc were
  permanently lost (the disk markdown was intact; only the pending
  overlay layer was destroyed). Fix: route the initial load through
  `setPrimaryFromMerged` too. Moved `repairOverlaysOnStartup` to run
  BEFORE the file-walk so sidecars are deduped before any load reads
  them.
- Files: `packages/openwriter/server/state.ts` (the data model
  change + all the mutator updates).
- Verification: full test suite — 326 passed, 0 failed across
  state-integration, pending-integration, lifecycle-overlay,
  pending-classification, restore-version-pending,
  nonactive-overlay-symmetry, versions-integration, id-rewrite-*,
  save-time-matcher, matcher-preserves-ids, active-doc-watcher,
  comments-integration, sync-check.
- Commit: `fb666e6`.

### 2026-05-18 — Sync-merge replaces stale-version reject

- Trigger: the same-doc concurrent collaboration story discussed
  during the architectural analysis. The old behavior — server
  rejects browser doc-updates when browserVersion < serverVersion —
  preserved agent work but silently discarded the user's in-flight
  typing. The user kept editing, the server kept rejecting, the
  edits piled up in browser memory hoping a sync round would land.
- Change: `syncBrowserDocUpdate(browserDoc, browserVersion)` replaces
  the reject path. Browser's canonical view is authoritative for
  content. Server overlay entries with `addedAtVersion > browserVersion`
  are agent additions the browser hadn't seen yet — preserved
  unconditionally. Conflicts (both have an entry for the same nodeId)
  → server wins, on the principle that an explicit pending proposal
  outranks a browser save that didn't see it. The user can reject
  via the normal review UI if they disagree.
- New field on `PendingEntry`: optional `addedAtVersion: number`,
  stamped by `setOverlayFromEntries` on first sight of an entry,
  preserved across re-splits. Sidecars without the field (legacy)
  effectively count as "always recent" — preserved on merge rather
  than dropped, which is the direction we want errors to land.
- Files: `packages/openwriter/server/pending-overlay.ts` (new field),
  `packages/openwriter/server/state.ts` (`syncBrowserDocUpdate` +
  version stamping), `packages/openwriter/server/ws.ts` (calls sync
  merge instead of rejecting).
- New test: `scripts/test-sync-merge.mjs`. Two scenarios — disjoint
  touches preserve both sides; in-sync submissions apply directly.
  5 passed, 0 failed.
- Limitations: does NOT handle character-level merge inside a single
  paragraph. If two cursors are typing in the same sentence, the
  server-wins-on-conflict rule means one of them lands and the other
  is buried in version history. The architectural bet is that this
  case is rare in agent collaboration (agents tend to rewrite whole
  paragraphs; users tend to edit different paragraphs). If real usage
  shows the bet wrong, a per-paragraph CRDT layer can swap in without
  changing the surrounding system.
- Commit: `338fe8b`.
