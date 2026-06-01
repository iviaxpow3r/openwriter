# Sort auto-drain via minion

## Context

The sidebar "Request sort" action stamps a `sortRequest` marker into a doc's
frontmatter. The doc is one the user couldn't place themselves — the mark
*is* the user delegating the placement decision ("I don't know where this
goes, you file it").

The original design (v0.x) surfaced pending sorts two ways, both copied from
the enrichment system's scaffold:

1. A `sortFooter()` appended to `list_documents` / `list_workspaces` /
   `get_workspace_structure`.
2. A `SORT_STATUS` line in the MCP server's session-start `instructions`.

But where enrichment's footer/instruction carry an **executable
`Agent(...)` dispatch** for an autonomous minion, sort's carried **advisory
prose**: *"Call list_pending_sorts when the user engages… discuss
destinations with the user… Sorting is a judgment call — handle it inline,
don't dispatch a subagent."* The stated reasoning ([state.ts] comment):
*"source-folder trust doesn't transfer to an unknown destination, so a
'trust me' preference has no good home."*

**This was proven wrong empirically.** On 2026-06-01 the Default profile had
3 docs marked for sort on 2026-05-26, -27, and -28 — sitting unfiled for
4–6 days, never touched. Over the same window enrichment drained 217/223
docs to current. Identical surfacing scaffold, opposite outcome. The
difference was the directive type, not the scaffold:

- **Enrichment** drains because its directive is executable, requires no
  per-doc human turn (logline is auto-derived), and runs
  `run_in_background: true` — an agent mid-task fires it without derailing.
- **Sort** never drained because its directive asked the agent to *interrupt
  the user's actual task* for a judgment conversation. An agent mid-task
  won't do that, so the queue grew stale forever.

The "judgment call → must gate on a human" premise was also self-defeating:
`propose_sort` already moved the judgment to an async sidebar accept/reject
step, so sorting never needed a synchronous human turn. And the gate it
justified just relocated the pileup — marks-that-never-drain would become
proposals-that-never-get-accepted (same queue, one step downstream).

## Current invariants

- **Sort drains on the same rail as enrichment.** `sortFooter()` and
  `buildSortInstructions()` emit a paste-ready `Agent(subagent_type:
  "openwriter-sort-minion", run_in_background: true)` dispatch — never
  advisory prose. The acting agent's burden is one paste.
- **The minion MOVES, it does not propose.** `openwriter-sort-minion`
  self-discovers via `list_pending_sorts`, reads each doc, picks a
  destination from workspace/container purpose hints, files it via
  `move_item`, retires the request via `mark_sorted`, and returns a
  one-line "what moved" summary. There is no pre-move human gate.
- **Safety is reversibility + transparency, not a gate.** A sort-marked doc
  has no user-expected location to violate (that's why it was marked). A
  misfile is a single `move_item` to undo, and every move is reported. This
  is the same safety class as enrichment (a wrong logline is cheap and
  overwritable) — neither system gates on a human.
- **`propose_sort` survives for the manual path.** The sidebar
  accept/reject flow (propose → badge → accept) still works for users who
  want a gate; the minion just doesn't use it.
- **Per-workspace opt-out mirrors enrichment.** `autoSortDisabled: true` on
  a workspace drops its docs from `list_pending_sorts`, so the minion never
  auto-files them — they fall back to manual handling. Default = false =
  auto-sort on. Mirrors `enrichmentDisabled` exactly (workspace top-level
  field, `null` clears, set via `update_workspace_context`).
- **Skill rule reflects the rail.** SKILL.md firm rule 6 is "dispatch the
  sort minion reflexively," paralleling firm rule 5 (enrichment) — not
  "handle inline, no minion."

## Decision log

### 2026-06-01 — Replace advisory inline-sort with autonomous sort minion

- **Trigger.** Operator report: "OpenWriter does NOT sort properly. We can
  mark to sort, it never picks them up. That method is proven wrong."
  Reproduced: 3 docs marked 4–6 days prior, still pending; enrichment over
  the same window at 217/223 drained.
- **Architectural framing.** The marker mechanism was never broken — marks
  persist on disk and `list_pending_sorts` returns them correctly. What was
  missing was a *consumer*. Sort was modeled as passive advisory pull by the
  main agent during unrelated work; the codebase's only proven drain pattern
  is executable-dispatch → autonomous minion → async (or no) human review.
  Sort copied enrichment's surfacing scaffold but omitted the one part that
  makes it drain. The fix is a model change (pull-by-main-agent → dispatch
  to an autonomous minion that moves), not a louder nudge.
- **Decision.** (1) `sortFooter()` + `buildSortInstructions()` emit an
  executable `Agent(...)` dispatch for `openwriter-sort-minion`. (2) New
  minion agent files the doc (move_item) and retires the mark (mark_sorted),
  reporting what moved — no pre-move gate. (3) `autoSortDisabled` workspace
  opt-out added (mirrors `enrichmentDisabled`); `listPendingSorts` excludes
  opted-out docs. (4) SKILL.md firm rule 6 flipped from "no minion / inline"
  to "dispatch reflexively." (5) `propose_sort` retained for the manual
  sidebar path.
- **Files.** `server/documents.ts` (sortFooter, buildSortInstructions,
  collectAutoSortOptedOutFilenames, listPendingSorts exclusion),
  `server/workspace-types.ts` (autoSortDisabled field),
  `server/workspaces.ts` (WorkspaceConfigUpdate + WORKSPACE_CONFIG_FIELDS),
  `server/mcp.ts` (update_workspace_context schema, list_pending_sorts +
  get_workspace_structure descriptions/header),
  `skills/openwriter/agents/openwriter-sort-minion.md` (new),
  `skills/openwriter/SKILL.md` (rule 6). Commit: pending.
- **Verification.** Live MCP: with 3 docs pending, dispatch minion → docs
  filed into sensible containers, marks cleared, `list_pending_sorts`
  returns 0. autoSortDisabled on a workspace drops its docs from the list.
