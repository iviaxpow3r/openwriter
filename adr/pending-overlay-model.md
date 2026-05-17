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
