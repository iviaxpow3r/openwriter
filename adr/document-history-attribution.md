# ADR: Document history & author attribution

## Context

OpenWriter docs interleave human-authored and agent-authored content with no way,
after the fact, to tell which is which. The need is git-style **attributed edit
history** — per-span human-vs-agent blame, replayable layers, doc "voice-shape" —
*and* the existing whole-doc version **restore**, from one system.

Three systems already exist and are folded here rather than duplicated:
- **Version snapshots** (`server/versions.ts`) — whole-doc `.md` copies, the commit/restore unit.
- **Activity log** (`server/activity-log.ts`) — agent-attributed event stream (humans are intentionally unlogged), the "who/what".
- **Node-identity matcher + per-sentence fingerprints** (`server/node-matcher.ts`, `node-fingerprint.ts`) — already compute, every save, which sentence in which block changed; that delta was discarded.

Full design + the multi-agent design pass that produced it: `chip-notes/author-attribution-design.md`.

## Current invariants

1. **Blame is anchored to `sentenceHash`, never to nodeId or matcher mutation labels.**
   A sentence's author follows its content hash (`simpleHash(text+terminator)`, the
   same hash the fingerprint/enrichment path uses). This is what makes blame survive
   split, merge, type-change, heavy-rewrite-that-re-mints-an-id, and paste-back —
   node-id keying and `mutation='split-first'` labels only cover zero-edit cuts.
2. **One capture point: `writeToDisk()` in `state.ts`.** Actor + per-sentence delta are
   computed there (the same `harvestSentenceHashes(newBlocks)` already used for
   enrichment staleness) and written to Tier B + Tier A before `snapshotIfNeeded`.
3. **Actor is a save-scoped, REQUIRED value — never a module-global shim.** It is threaded
   `save(actor)` → `writeToDisk(actor)`. The human default lives at exactly one site (the
   WS `doc-update` door); every agent door passes `'agent'` explicitly. A module-level
   `currentActor` would race under interleaved saves and corrupt attribution — banned.
4. **Three tiers, cross-referenced not embedded.**
   - Tier C = `.versions/{docId}/{ts}.md` (commit/restore, unchanged in spirit).
   - Tier B = `_history/{docId}.jsonl` (append-only attributed `EditEvent`s; per-doc, NOT the global `activity.log`).
   - Tier A = `_blame/{docId}.json` (materialized current blame; the instant heatmap; rebuildable from B+C).
   `EditEvent.versionTs` binds each event to the snapshot cut it folded into.
5. **Accept does not launder.** Accepting an agent's pending change keeps agent origin —
   origin is decided at write time, not at accept. autoAccept agent writes are stamped at
   `applyChangesToDoc` (the site that omits `pendingStatus`), so capture still sees agent.
6. **Sidecars live in the profile data dir, never beside user content.** `_history/{docId}.jsonl`
   and `_blame/{docId}.json` are written under `getDataDir()` (alongside `_pending/`, `_marks/`,
   `.versions/`), keyed by docId — NOT next to an external/vault `.md`. So a user's own git repo
   is never polluted, and the data dir is local-by-default (not a tracked repo). No `.gitignore`
   management is required in this codebase. (The design doc's "ensureGitignore reconcile" task
   referenced a different codebase's assumption; OpenWriter has no such helper.)
7. **Prune-driven compaction.** Before `pruneVersions` unlinks a snapshot, the current
   blame is preserved (folded into Tier A); only ancient granular layer-history is compacted.
   Blame must never silently vanish when versions prune (`max(50, 7-day)`) or `activity.log` rotates.
8. **Pre-feature content is `unknown`, not `human`.** A doc-level `attributionSince` marker
   disambiguates legacy from genuinely human.

## Decision log

- **2026-06-13** — Design ratified (5 forks decided by owner: human edits emit a lightweight
  event; per-doc sidecars gitignored; going-forward only, no backfill; binary `lastBy` flip).
  Chosen architecture: hybrid three-tier over one capture point, with content-addressed
  (sentence-hash) blame grafted in for durability. Phase 1 = capture + restore parity +
  voice-shape heatmap. Build started this commit.
