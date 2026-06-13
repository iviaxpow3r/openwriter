# Block-level author attribution — design proposal

**Status:** DESIGN ONLY — parked for Travis's review. Nothing built. Do not implement until sign-off.
**Worktree:** `C:\openwriter\.claude\worktrees\design-block-level-author-attribution` (branch `chip/design-block-level-author-attribution`)
**Author:** chip session, 2026-06-13.

## The problem

A single OpenWriter doc routinely interleaves human-authored and agent-authored
content with no way to tell them apart after the fact. Today's real case: a beat
sheet where the author dumped the ideas (human) and an agent added the academic
citations + several connector beats (agent) — now indistinguishable in one file.

Hard constraint (Travis): **attribution cannot be doc-level.** It must live at
sub-document granularity, survive edits, and survive markdown serialize/parse
round-trips. The `.md` body must stay clean — no inline markers in prose.

## The key finding: the hard part is already solved

OpenWriter already maintains **stable per-block identity** that survives every
realistic edit and every markdown round-trip — the node-identity system shipped
v0.14.0 (382 verifications, 0 failures). Every block has an 8-char hex ID stored
in frontmatter `nodes:` tuples. A save-time matcher (`state.ts` "Option B") reads
the previous identity from disk on **every** save, re-pins surviving IDs by
content fingerprint, mints fresh IDs for new blocks, and graveyards deleted ones.
Backlinks and pending-overlay already ride this for their durability.

**Attribution is just one more field on that same node graph.** The architecture
explicitly anticipated this: *"A backlink is just one type of node-relationship.
Pending state is another. Identity is another. They all belong in the same place,
expressed as fields on the same `nodes` graph."* (`docs/node-identity.md`)

This collapses the design risk. We are not building durable block identity — we
are decorating an identity layer that's already battle-tested.

## What the survey established (grounding)

- **Node IDs are stable** across edit / insert / delete / split / merge / move /
  type-change / paste-back, and across serialize→disk→parse. Split: first half
  keeps the ID, second half gets a fresh one. Merge: survivor keeps ID, other is
  graveyarded. Paste-back: ID revives from the graveyard. (`node-matcher.ts`,
  `docs/node-identity.md`)
- **Single save chokepoint.** All writes — agent and human — funnel through
  `writeToDisk()` in `server/state.ts` (~2383). At that point, for every node,
  its stable ID + fingerprint + type + position are all known in one place
  (`matchResult.pinned` + `newBlocks`). **This is the natural stamping point.**
- **Actor IS distinguishable at the entry point — just not currently recorded.**
  Agent writes enter via MCP tools (`create_document`, `populate_document`,
  `write_to_pad`, `edit_text` → `applyChanges` / `populateDocumentFile` etc. in
  `mcp.ts`). Human writes enter via the browser WebSocket `doc-update`
  (`syncBrowserDocUpdate` / `updateDocument` in `ws.ts` / `state.ts`). Two
  distinct doors. We just don't tag which door a save came through.
- **Pending overlay** keyed by node ID, stored in `_pending/{docId}.json` sidecar,
  status `insert|rewrite|delete`, accept/reject per-block (or per-group). It is
  ephemeral — cleared on accept, never written to the `.md` body. The accept/reject
  click is a natural attribution checkpoint.
- **Decorations** are a ProseMirror plugin keyed by `node.attrs.id`
  (`src/decorations/plugin.ts`). Coloring blocks by origin reuses this mechanism
  directly — add an attr, map to a CSS class, done. (Caveat: one primary
  background per block, so an origin-heatmap is a *view toggle*, not always-on
  alongside pending colors.)
- **"Agent marks"** is a deprecated alias for the **comments** system
  (`_marks/{filename}.json`) — anchored annotations, not provenance. Not the
  right primitive to overload.

## Design decisions

### 1. Granularity — per-node (TipTap block)

Per-node, riding the existing node IDs. Rejected alternatives:
- **Per-span / per-mark:** would require attribution marks *in the body* (or a
  span-offset map that breaks on every reflow). Violates "clean body," and span
  offsets are exactly the unstable thing node-IDs were built to avoid.
- **Per-character:** absurd for the `.md`-on-disk model.

Block granularity matches the real need: the beat-sheet case is "this beat is
mine, that citation-beat is the agent's" — block-level, not word-level.

### 2. Where attribution lives — frontmatter map keyed by node ID (recommended)

Add a parallel frontmatter slot keyed by node ID, **separate from** the compact
`nodes:` tuples (so we don't bloat the hot serialization path or shift tuple
indices):

```yaml
authorship:
  f167017d: { o: h, l: h }                 # origin human, last-touched human
  b97824bd: { o: a, l: h, via: claude }    # agent-authored, since human-edited
  2bfbc35f: { o: a, l: a, via: claude }    # pure agent
graveyard_authorship:                       # so paste-back revives attribution
  - { id: ..., o: a, l: a }
```

**Options considered:**

| Option | Pro | Con | Verdict |
|---|---|---|---|
| **A. Frontmatter map** (recommended) | Travels with the file; git-diffable; the "unified graph" the architecture wants; matcher already rewrites the node graph each save so ID-continuity is free | Roughly doubles frontmatter on a fully-attributed doc (one short entry/node) | **Recommend** |
| B. Sidecar `_authorship/{docId}.json` | Keeps frontmatter lean; precedent in `_pending/` & `_marks/` | Another file to keep in sync with matcher ID-rewrites; doesn't travel if file is copied out | Fallback if frontmatter bloat ever bites |
| C. TipTap mark → HTML comment in body | — | Violates "body completely undisturbed"; node-identity explicitly killed inline anchors | **Rejected** |

Both A and B inherit ID-stability for free. Recommend **A** for portability; the
matcher's existing `idTranslation` remap (state.ts ~2478, already done for pending
overlay) extends to the attribution map with a one-line addition.

### 3. Provenance states — two stored fields, four derived display states

Store **2 fields per node**, not 4 opaque labels:
- `o` (**origin**) — who created the block. Set once at creation, frozen.
- `l` (**lastBy**) — who last edited the block. Updates on every substantive edit.
- optional `via` — tool/model identity for richer agent provenance (multi-agent).

Each is `h` (human) | `a` (agent) | `?` (unknown, for legacy/pre-existing content).

Four meaningful display states fall out of `o × l`:

| origin | lastBy | Display | Meaning |
|---|---|---|---|
| h | h | **Human** | genuinely author-authored |
| a | a | **Agent** | pure agent-scaffolded (the thing Travis fears losing track of) |
| a | h | **Agent → human-edited** | agent draft the human has since worked |
| h | a | **Human → agent-edited** | human's words an agent polished |
| ? | ? | **Unknown** | pre-attribution legacy content |

This is more durable and queryable than 4 fixed labels: any display policy ("show
everything an agent originated," "show what I've personally blessed") is a query
over two axes.

### 4. How attribution is SET — automatic, from the actor-distinct doors

The missing piece is one signal: **tag each save with the actor that triggered it.**
Thread an `actor: 'human' | 'agent'` (+ optional `via`) param into the save path.
MCP tool handlers pass `agent`; the browser `doc-update` path passes `human`.

At `writeToDisk()`, the matcher already classifies every node — combine with the
save's actor:

- **New node** (fresh ID) → `o = l = actor`.
- **Edited node** (pinned, fingerprint changed) → keep `o`, set `l = actor`.
- **Unchanged node** (pinned, fingerprint same) → no change.
- **Split** → first half keeps attribution; second half is new content → `o = l = actor`.
- **Merge** → survivor keeps `o`, `l = actor`.
- **Paste-back** (graveyard revive) → restore attribution from `graveyard_authorship`.

Almost zero human friction: provenance is a byproduct of which door the write came
through, not something anyone has to declare.

**Loaded decision — does accepting an agent change launder it to "human"?**
Recommendation: **NO.** Accepting an agent insert/rewrite keeps `o = agent`. The
human reviewed it; they didn't author it. Laundering accepted agent content into
"human" would destroy exactly the signal Travis wants. (Optional: record a separate
`reviewed: true` so "accepted" is distinguishable from "auto-accepted" without
touching origin.) — **flagged for Travis; this is the philosophical crux.**

### 5. How attribution is SHOWN

- **Editor heatmap toggle** — a view mode that tints each block by origin (human =
  no tint, agent = amber, agent→human-edited = faded amber, unknown = gray hatch),
  via the existing decoration plugin + a gutter bar like `pending-active`. A toggle,
  so it never fights pending colors.
- **Doc-header percentage** — e.g. "68% human · 29% agent · 3% unknown," weighted by
  **character count** (a one-line agent heading ≠ a 300-word human paragraph).
- **MCP read tool** — `get_attribution(docId)` → per-node origin + doc rollup, so an
  agent can self-report ("this section is mostly mine"). Could fold into `get_nodes`.

## Durability story (the crux, answered)

1. **Node IDs are stable across edits + round-trips** — the entire point of the
   node-identity system, already shipped and verified. Attribution keyed by node ID
   inherits that stability with zero new identity machinery.
2. **The matcher already remaps IDs** through `idTranslation` on the rare re-mint,
   and already applies that remap to the pending overlay (state.ts ~2478). The
   attribution map gets the identical one-line remap.
3. **Split / merge / type-change / move** — governed by the matcher's mutation rules;
   attribution rides the same ID-continuity (rules above).
4. **Paste-back** — graveyard the attribution alongside the node (backlinks and
   comments already auto-revive this way); restore on graveyard hit.
5. **Graceful failure** — if a block is rewritten so heavily the matcher can't detect
   it as an edit and mints a fresh ID, the block reads as "new" and is re-stamped to
   the current actor. That's arguably *correct*: content rewritten beyond recognition
   is new content. The failure mode degrades to the right answer.

## Reuse vs new layer

A **new persistent layer** that **rides existing solved infrastructure**:
- Reuses node identity (the hard part — done).
- Reuses the actor-distinct entry points (the two doors already exist).
- Reuses the save chokepoint and the matcher's per-node classification.
- Reuses the decoration plugin for display, and the graveyard for paste-back.
- It is *not* the pending overlay (pending is ephemeral; attribution is permanent) —
  but it shares the accept/reject lifecycle hook.
- It is *not* comments/agent-marks (those are resolvable annotations).

Net new surface is small: an `authorship` frontmatter slot, an `actor` param threaded
through the save path, update logic at the chokepoint, one MCP read tool, one editor
view toggle.

## Phased build path

- **Phase 0 — this.** Design + sign-off. (ADR to follow if adopted.)
- **Phase 1 — capture (data exists going forward).** Thread `actor` through the save
  path; stamp `o`/`l` at `writeToDisk()` using matcher output; persist the
  `authorship` map; graveyard it for paste-back. No UI. Verify round-trip durability
  with the live-test discipline (`/openwriter-testing`). This alone solves the
  going-forward problem.
- **Phase 2 — read/query.** `get_attribution` MCP tool + doc-header percentage. See it
  without editor work.
- **Phase 3 — visualize.** Editor heatmap toggle + gutter tint via the decoration plugin.
- **Phase 4 — refinements (optional).** Edit-magnitude threshold (a human typo-fix on an
  agent paragraph need not flip `lastBy`); per-agent `via` identity; `reviewed` flag;
  **best-effort retroactive attribution** for the existing book/beat-sheet from version
  history — the already-interleaved docs can't be reconstructed automatically going
  backward, so this would be an assisted one-time pass.

## Open decisions for Travis

1. **Storage:** frontmatter map (recommend, portable) vs sidecar file (leaner frontmatter)?
2. **State model:** 2 fields → 4 derived states (recommend) — or is binary origin-only
   enough, or do you want richer (which agent/model)?
3. **Does accepting an agent change launder it to human?** Recommend NO (origin stays
   agent; optional `reviewed` flag). This is the philosophical crux of your stated need.
4. **Edit magnitude:** does a human typo-fix on an agent block flip it to "human-touched"
   (binary, simple) — or only a substantive edit (threshold, Phase 4)?
5. **Retroactive:** is "going forward" enough, or do you want a one-time assisted pass to
   attribute the *existing* interleaved beat sheet / book?

## ADR note

Per the project's ADR convention (`~/.claude/docs/adr-convention.md`), if adopted this
warrants a new `adr/author-attribution.md` — it's a load-bearing invariant spanning the
save path, the matcher, frontmatter schema, and the decoration layer (3+ files), and a
choice between paths that look interchangeable but aren't (origin frozen vs lastBy
mutable; accept ≠ authorship). Write the ADR at implementation start, not now.
