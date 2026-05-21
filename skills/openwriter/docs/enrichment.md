# Enrichment Dispatch — Detailed Procedure

OpenWriter's frontmatter enrichment is dispatched via the
`openwriter-enrichment-minion` custom subagent. SKILL.md firm rule 5
covers the common case (single minion, small/medium batch). This doc
handles the **large-corpus case** where one minion isn't enough — and
the parallel-dispatch pattern that scales it.

## When to chunk

| Dirty docs (N) | Dispatch shape | Wall time |
|---|---|---|
| 1–30 | Single minion. Default prompt. | ~10–45 seconds |
| 31+  | Chunked parallel minions. | ~30 seconds (regardless of N) |

The minion's turn budget (`maxTurns: 500` in its frontmatter) can handle
~50 docs serially, but at that size the wall-clock cost (3+ minutes)
becomes visible to the user. Parallel dispatch keeps total wall time
under ~30 seconds for any corpus size up to a few hundred docs.

## Step-by-step (large corpus)

### 1. Inventory the work

```
mcp__openwriter__list_dirty_docs()
```

Returns every dirty doc across all workspaces with `docId`, `title`,
`workspaceFile`, `reason`. If `total ≤ 30`, stop — single minion path
(firm rule 5) is correct. If `total > 30`, continue.

### 2. Chunk the work

v0.19.0 simplified the minion to logline-only — workspace vocab is no
longer relevant (the `domain` field that used it was dropped). You can
group chunks however you want; workspace-grouping is no longer required.
Practical defaults:

**Target: 12–15 docs per chunk.**

- **Very large dirty list (>100 docs):** split into chunks of ~15.
- **Workspace-grouped is still fine** if it makes the dispatch prompts
  easier to read, but it's no longer a performance concern.

You'll typically land on 4–10 chunks. Don't exceed ~10 parallel —
Anthropic per-account rate limits kick in beyond that and you get
serialized anyway.

### 3. Dispatch all chunks in one message

Send **every chunk in a single assistant message** with multiple `Agent`
tool uses. This is the only way they actually run in parallel —
sequential `Agent` calls block each other.

Use `run_in_background: true` so you can keep talking to the user while
the minions work. You'll receive a `<task-notification>` per chunk as
each one finishes.

### 4. Prompt format (explicit-list mode)

The minion's agent file (`~/.claude/agents/openwriter-enrichment-minion.md`)
supports an explicit-list mode — pass docIds in the prompt and the minion
skips `list_dirty_docs` and uses your list directly.

Example prompt for one chunk (v0.19.0 — logline-only):

```
Enrich these specific openwriter docs:

- a1b2c3d4 — Frame Holding Master Reference
- e5f6a7b8 — Tournament Male
- 9z8y7x6w — Contest Mosaic Theory
- 1q2w3e4r — Ch 3 — Beats
- 5t6y7u8i — Ch 4 — Draft

For each: read_pad to get the body, write a logline ≤150 chars, then
bulk mark_enriched at the end with { docId, logline } per entry.
```

Keep prompts short. The minion already knows the procedure from its
agent file — you're just handing it the work list. The minion's tool
allowlist (v0.19.0) is `list_dirty_docs`, `read_pad`, `mark_enriched`
— `get_workspace_structure` is no longer needed because there's no
workspace-vocab dependency.

### 5. Surface to the user (large-batch phrasing)

Before dispatching, tell the user what's happening. Firm rule 5's
"large batch" tier (N > 20) requires a heads-up. Example:

> OpenWriter detected 73 docs that haven't been summarized yet —
> first-time setup. Refreshing them in 6 parallel batches in the
> background; this'll take ~30 seconds and a few cents of Haiku usage.

Then dispatch. Stay silent as notifications come in unless one fails.
When all are done, report once:

> Enrichment complete: 73 docs across 8 workspaces. Cost: ~$0.15.

### 6. Verify completion

After every chunk has notified, call `list_dirty_docs` once more. If
`total > 0`, some docs slipped — usually because a minion errored on a
specific doc or a doc was modified mid-enrichment. Re-dispatch a single
minion for the stragglers; don't redo the whole batch.

## Why this shape

**Why parallel, not serial single-minion at maxTurns: 500?**
A single minion processing 100 docs takes 3+ minutes wall time. The
user sits in silence. Six parallel minions of ~15 docs each finish in
~30 seconds. Same total token cost — much better UX.

**Why explicit docId list instead of letting each minion call `list_dirty_docs`?**
Race conditions. If you spawn 6 minions and they all call
`list_dirty_docs`, they all see the same 100 dirty docs and try to
enrich the same docs in parallel. Most enrichments succeed (last write
wins on the frontmatter), but it's wasteful and the per-doc baselines
get computed multiple times. Explicit lists partition the work cleanly.

**Why 12–15 docs per chunk and not 50?**
Two reasons: (1) turn budget — each doc costs ~1 turn (one `read_pad`
call); ~15 docs leaves headroom inside the 500-turn ceiling even with
retries. (2) failure isolation — if one minion's batch errors, you lose
15 docs of work, not 50.

**Why dispatch in one message, not sequential Agent calls?**
Sequential `Agent` calls block each other. Only multiple `Agent` tool
uses in the **same assistant message** run truly in parallel.

## Cost ballpark

Haiku token cost per doc: ~1.5K–3K in v0.19.0 (one read_pad + one
logline synthesis + share of mark_enriched). Roughly half what it cost
under v0.16's five-field schema.

| Corpus size | Approx cost (v0.19.0) |
|---|---|
| 30 docs   | ~$0.02 |
| 100 docs  | ~$0.08 |
| 500 docs  | ~$0.40 |

Compare to ~$5.00 per doc if you used the general-purpose subagent with
full MCP tool registry (~50K token overhead per spawn). The custom
minion's tool allowlist (3 tools in v0.19.0: `list_dirty_docs`,
`read_pad`, `mark_enriched`) is what makes the math work.

## Failure modes

- **Minion returns with no `mark_enriched` call** — almost always means
  it hit the turn ceiling. Confirm its agent file has `maxTurns: 500`
  in the frontmatter, then reduce chunk size to ~10 docs and re-dispatch
  that chunk.
- **Minion reports "No enrichment work pending"** — its assigned docs
  got enriched by a sibling minion first (race condition from
  `list_dirty_docs` mode, not explicit-list mode). Benign; the other
  minion's work landed correctly.
- **`<task-notification>` reports an error** — re-dispatch just that
  one chunk. Don't restart the whole batch.
- **Logline cap violations** — the minion's agent file enforces a
  150-char hard cap. If you spot longer loglines on disk after the
  fact, it's a minion regression — flag for agent-file revision rather
  than re-enriching.

## When NOT to chunk

If `list_dirty_docs` returns ≤30 docs, dispatch a single minion with
the default prompt:

```
Agent({
  subagent_type: "openwriter-enrichment-minion",
  description: "Enrich stale openwriter docs",
  prompt: "Enrich all currently stale openwriter docs."
})
```

The minion calls `list_dirty_docs` itself, processes everything in one
pass, and reports back. Chunking ≤30 docs is overhead, not gain.
