# Document History & Author Attribution — final design

**Status:** DESIGN ONLY — parked for Travis's sign-off. Nothing built. Supersedes the v1
"per-node label map" framing (kept in git history). This is the synthesized output of a
multi-agent design pass (6 grounding readers, 3 architectures, 12 adversarial critiques)
plus the discussion with Travis.
**Worktree:** `chip/design-block-level-author-attribution`. **Author:** chip session, 2026-06-13.

---

## 1. Recommendation

Build **one document-history system with three tiers over a single capture point**, folding
the three systems that already exist rather than adding a parallel one:

- **Tier C — version snapshots = the commit / restore unit** (today's `versions.ts`, unchanged in spirit).
- **Tier B — the enriched activity log = the attributed edit-event stream** (the "who/what" — git's author + changelog), now per-save and span-grained instead of headline-coarse.
- **Tier A — a materialized current-blame sidecar = the instant heatmap** (zero-compute read, rendered straight through the existing decorations plugin).

All three are written from **one chokepoint** (`writeToDisk()` in `state.ts`), where the
actor, the matcher's per-node mutation, and the per-sentence hash delta are *already all in
scope* (~`state.ts:2452-2498`, ~140 lines before `snapshotIfNeeded` fires at ~2601).

It won because it was the only candidate that is genuinely **one system on both the read and
write side** and scored evenly across all four critique lenses (durability/elegance/cost/
concurrency ≈ 71), where the pure append-log designs each cratered to 38 on concurrency. Its
one weak axis — durability — is fixed by grafting the event-sourced design's **content-
addressed anchoring**: blame follows `(sentenceHash)`, not node-ids or mutation labels.

## 2. The keystone question, answered

**"Activity + version snapshot — retain the activity log to a version when it's saved?" → YES.**

Concretely: every edit-event carries the `versionTs` of the snapshot cut it folds into, so
"the activity slice for version *v*" is just the events stamped with *v*. Versions and the
edit log are **bound by cross-reference, not by embedding** — the snapshot stays a lean `.md`;
it does not swell with history. Any version can resolve "what edits, by whom, produced me,"
and the log stays a single append-only stream. Your later refinement — *"a more granular
activity log that appends to any version on save"* — **is exactly Tier B.** You arrived at
event-sourcing independently; this design adopts it with the snapshot as the commit boundary.

## 3. Best-of-both-worlds argument

One capture, two reads:

- **Restore** (rare, whole-doc) reads **Tier C** — check out a snapshot `.md`. Unchanged from today; fast; lossless.
- **Blame / layers / voice-shape** (the new git-style view) reads **Tier B** folded over `docId`, or **Tier A** for the instant heatmap.

They share a spine because a **version cut is the commit boundary**: at each snapshot, Tier B's
accumulated events since the last cut are folded into Tier A (frozen as that version's blame),
and the version *is* the restore point. Restore and blame stop being two systems fighting over
retention — they're two projections of one attributed event stream punctuated by snapshots.

## 4. Data model

**EditEvent (Tier B — the enriched activity log entry).** Today's `ActivityEvent` grows a
typed `edit` kind. Existing fields (`ts, kind, headline, detail?, docId?, filename?, nodeId?`)
are unchanged; the right-rail keeps working.

```ts
interface EditEvent extends ActivityEvent {
  kind: 'edit';
  docId: string;
  actor: 'human' | 'agent';        // REQUIRED — no default (see §6)
  via?: { tool?: string; model?: string };   // agent identity, optional
  versionTs: number;                // the snapshot cut this event folds into (the binding)
  seq: number;                      // per-doc monotonic, survives profile switch
  spans: SpanDelta[];
}

interface SpanDelta {
  nodeId: string;                   // stable node id (post-matcher)
  sentenceHash: string;             // content-addressed anchor — blame follows THIS, not nodeId
  op: 'add' | 'edit' | 'remove';
  supersedes?: string;              // prior sentenceHash this one replaced (heavy-rewrite/re-mint lineage)
}
```

**Blame anchor = `sentenceHash`, not `nodeId`.** This is the durability graft and the most
important single decision: a sentence's author is keyed to its *content hash*, which the
matcher already computes. When a block splits, merges, type-changes, gets re-minted on heavy
rewrite, or is pasted back, the sentence's hash rides along and its author is inherited — no
dependence on fragile node-id lineage or mutation labels (which the critics proved only cover
zero-edit cuts).

**Current-blame sidecar (Tier A — materialized for the instant heatmap).**

```ts
// _blame/{docId}.json — frozen per version cut
{ versionTs: number,
  nodes: { [nodeId]: { origin: 'human'|'agent'|'unknown',
                       sentences: { [sentenceHash]: { lastBy: 'human'|'agent', firstBy: 'human'|'agent' } } } } }
```

`unknown` is the honest default for pre-feature content (a doc-level `attributionSince`
marker disambiguates "legacy" from "human").

## 5. On-disk layout

Body stays **clean markdown** — zero inline markers (the node-identity invariant holds).

| Tier | File | Format | Notes |
|---|---|---|---|
| C | `.versions/{docId}/{ts}.md` (+ `-N` on ms collision) | full `.md` snapshot | today's mechanism; the commit/restore unit |
| B | `_history/{docId}.jsonl` | append-only JSONL, per-doc | the edit-event stream; **per-doc**, not the global `activity.log` |
| A | `_blame/{docId}.json` | small JSON, frozen per version | instant heatmap; derived, rebuildable from B+C |
| — | global `activity.log` | unchanged | becomes a **derived coarse view** computed from B (the right-rail keeps its headlines) |

Decisive split from the keystone's "single store": the **spine is a per-doc `_history/` sidecar**,
not the global profile-level `activity.log`. Three reasons the global log can't *be* the spine:
granularity (it's headline-coarse), scope (profile-global, not per-doc — history must travel
with the doc), and rotation (its 10MB/5-file rotation would silently drop old blame). The
global activity log is **reframed as a cheap human-facing projection** of the same events — one
stream, two renderings.

## 6. Capture mechanism (and the bugs the critics caught)

At `writeToDisk()`, after the matcher runs, emit one `EditEvent` from `matchResult` (actor +
per-sentence hash delta are already in scope). Then `snapshotIfNeeded` cuts Tier C and folds
B→A. **Six fixes are mandatory and Phase-1, not deferred** — every critic flagged these:

1. **Actor is a save-scoped REQUIRED parameter, never a module-global shim.** Thread `actor`
   through `debouncedSave(actor)` → `save()` → `writeToDisk()`, captured *at schedule time*.
   The module-level `currentActor` shim races under interleaved saves and corrupts attribution
   — do not ship it even in Phase 1.
2. **The human door defaults to `human` at exactly one site** (the WS `doc-update` handler in
   `ws.ts`); **every agent door must pass `agent` explicitly.**
3. **"Door 3" — non-active agent writes** (`applyChangesToFile` / `populateDocumentFile` →
   `flushDocToFile`) produce **no snapshot today**. Add `snapshotIfNeeded(docId, targetPath,
   'agent')` at its tail (after the `atomicWriteFileSync`, ~`state.ts:3255`) so the restore
   floor and attribution exist on this path too.
4. **autoAccept** (`state.ts:1527,1649`) commits with no overlay/pendingStatus, so capture
   can't infer agent-origin. Stamp `origin:'agent'` onto node attrs at `applyChangesToDoc`
   time — the same site that decides to omit `pendingStatus`.
5. **Collision-safe snapshot ids.** Snapshot writers must return the *actual* filename and add
   a monotonic suffix on same-ms collision (`{ts}-1.md`); blame must never key off `Date.now()`.
6. **Per-doc state + profile-switch reset.** Tier A/seq state is per-`docId` and registers a
   reset hook alongside `clearVersionsCache` / `clearActivityBuffer`; door 3 reads `seq` from
   the file tail (read-modify-append) since it doesn't share the in-memory counter.

**Accept does not launder.** Accepting an agent's pending change keeps `origin:'agent'`
(optional separate `reviewed:true`). Capture honors this because origin is stamped at *write*,
not at accept.

## 7. Restore mechanism

Unchanged: `restoreVersion(docId, ts)` parses the snapshot `.md` → TipTap. Snapshots remain
full, self-contained `.md` (no replay needed for restore — replay is only for blame). A restore
emits its own `EditEvent` (actor = whoever restored) so history stays honest.

## 8. History / blame / layers / voice-shape

- **Current heatmap** (always-on, cheap): read Tier A `_blame/{docId}.json`, color each block/
  sentence by `lastBy` through the existing decorations plugin (new attr + CSS + view toggle).
- **Replayable layers** (occasional): fold `_history/{docId}.jsonl` for a node — the ordered
  `SpanDelta`s by `sentenceHash` are the stack ("human base → agent edited s3 → human edited").
- **Voice-shape %** (doc header): aggregate Tier A weighted by **character count** (a one-line
  agent heading ≠ a 300-word human paragraph), e.g. "68% human · 29% agent · 3% unknown."
- **MCP read tool** `get_attribution(docId)` → per-node origin + rollup, so agents can self-report.

## 9. Durability story

Blame is anchored to `sentenceHash`, so it rides node-identity continuity *and* survives the
cases pure node-id keying breaks:

- **Edit / insert / delete / move / type-change / md-roundtrip** — node-id continuity (the v0.14 matcher) carries the anchor; unchanged-hash sentences keep their author.
- **Split-with-edit** — attribute per sentence-hash regardless of which fragment a sentence lands in (not via `mutation='split-first'`, which only covers zero-edit cuts).
- **Heavy rewrite that re-mints the node id** — emit a `supersedes` edge from new hash → orphaned old hash; the new content is correctly the rewriter's, lineage preserved.
- **Paste-back** — on `graveyard-restore`, the restored sentence-hashes **inherit attribution from the graveyard entry**, not from the paster (fixes the mis-attribution the critic found).
- **Prune** — see §10: compaction is *driven by* prune so blame never orphans.

## 10. Cost, compaction, retention (the silent-loss bug, fixed)

The real bug the cost critics found: `versions.ts` prune keeps `max(50, within-7-days)`, so a
doc edited heavily then left idle loses old snapshots — orphaning any blame keyed to them.

**Fix — compaction is driven by prune, in the same phase as capture:** before `pruneVersions`
unlinks a snapshot, fold every `_history` event whose `versionTs` is that snapshot (or older)
into a single synthetic per-node attribution summary, so the *current* blame survives even
when the granular layer-history for ancient cuts is compacted away. The blame walk treats the
on-disk `.md` snapshots as ground truth and `_index.json` as advisory.

Cost is bounded and cheap on the hot path: one JSONL append per save (~hundreds of bytes), a
small frozen `_blame` JSON per version, snapshots unchanged. A 1000-block book edited thousands
of times stays bounded because granular history compacts at the prune horizon while current
blame is preserved indefinitely.

## 11. Reuse vs new

- **Reused:** the node-identity matcher + per-sentence fingerprints (already compute the delta, today discarded); `versions.ts` snapshots (the commit/restore unit); the activity log (becomes Tier B's stream + a derived view); the decorations plugin (the heatmap); the graveyard (paste-back).
- **Genuinely new:** the `edit` EditEvent kind + `_history/{docId}.jsonl`; the `_blame/{docId}.json` materialization; the save-scoped `actor` parameter; the fold-on-cut + fold-on-prune compaction; the `get_attribution` MCP tool + heatmap toggle.

## 12. Phased build path

- **Phase 0 — this.** Sign-off, then ADR.
- **Phase 1 — capture + restore parity + heatmap.** Save-scoped `actor` (all six §6 fixes, *including* door 3, autoAccept, collision-safe ids, prune-driven compaction). Emit EditEvents to `_history`; freeze Tier A on cut. Ship the **voice-shape heatmap** (the first thing you'll see) + doc-header %. Verify with `/openwriter-testing` live discipline.
- **Phase 2 — query.** `get_attribution` MCP tool; activity log reframed as derived view.
- **Phase 3 — replayable layers.** Per-node layer-stack UI folding `_history`; `supersedes`-edge lineage view.
- **Phase 4 — refinements (optional).** Per-agent `via` identity (which model/tool). *(Edit-magnitude threshold and retroactive backfill were considered and declined — see §13.)*

## 13. Decisions (locked 2026-06-13)

1. **Human edits emit a lightweight Tier-B event.** Layers are complete (you can replay
   exactly when a human touched a sentence); Tier A still treats human as the default fill.
2. **Per-doc sidecars, gitignored.** `_history/{docId}.jsonl` + `_blame/{docId}.json` live
   next to the doc and travel if the folder is copied, but are git-ignored like `_pending/`
   and `_marks/` — local working state, rebuildable from snapshots. **Phase-1 task:**
   `ensureGitignore` must *reconcile* an existing `.gitignore` (append `_history/`, `_blame/`
   if missing), not skip when the file already exists — the critics caught that the current
   helper no-ops on existing repos.
3. **Going forward only.** Attribution captures from build onward; existing interleaved
   content reads `unknown` until edited. No retroactive backfill (the beat sheet's blending
   can't be reconstructed with certainty). Drop the Phase-4 backfill item.
4. **Binary edit flips `lastBy`, Phase 1.** Any human edit to a sentence sets `lastBy=human`;
   a typo-fix counts as a touch. No magnitude threshold (drop the Phase-4 threshold item).

No open decisions remain — the design is ready to become an ADR + Phase-1 build on your go.

## 14. ADR note

Per `~/.claude/docs/adr-convention.md`, this warrants `adr/document-history-attribution.md` at
build start — it's a load-bearing invariant spanning the save chokepoint, the matcher, the
version system, the activity log, and frontmatter/sidecar schema (≫3 files), and encodes
non-obvious guards (sentence-hash anchoring vs node-id; prune-driven compaction; actor is
save-scoped not global; accept ≠ authorship). Write it in the same commit as Phase 1.
