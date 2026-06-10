# Setup, Anchor Protocol, Multi-Register

Loaded on first run, when generating a new anchor, or when splitting a corpus by register. Not in context during normal writing sessions.

## Setup Flow

If `voice/anchor.md` doesn't exist or is empty, walk the user through setup:

1. **Get the anchor.** Derivation is **fully local** — your own agent analyzes the writing, nothing leaves the machine, no service cost. Run the **Anchor Protocol** below to generate `voice/anchor.md` directly from the corpus on disk. Launch it as a sub-agent (see "Launching the anchor as a sub-agent") so the full stylometry rubric never pollutes the main session. Works offline. If the user has no corpus yet, ask them to seed 2-5 paragraphs (step 2) first — there is no hosted alternative.

2. **Seed the corpus** — ask for 2-5 paragraphs, write each to `voice/corpus/sample-NNN.md` with `added: YYYY-MM-DD` frontmatter.
3. **Run Analysis Protocol** (see `docs/analysis.md`) — populates `stats.md`, `never-rules.md`, `fingerprints.md`, `status.md`.
4. **Optional: curate examples** — ask the user for 3-5 most-representative paragraphs, write to `voice/examples.md`.
5. **Optional: populate coined terms** — ask the user for any coined terms / proper-noun concepts they want preserved verbatim, write to `voice/coined-terms.md` as a bare bullet list.
6. **Report status** — read `voice/status.md` and tell the user their tier + what unlocks next.

## Anchor Protocol (fully in-agent)

Generates `voice/anchor.md` (lean) and `voice/anchor-analysis.md` (rich).

1. Confirm corpus has ≥300 words. Below 300, ask the user to add a few more samples before anchoring.
2. Read `voice/stats.md`. If missing, run **Analysis Protocol** first.
3. Read `catalog/anchor-prompt.md` (full stylometry rubric) and `catalog/author-hints.md` (curated training-data authors with prose features).
4. **Set aside conversational context.** Score the corpus on prose mechanics only — never on themes/topics.
5. **Per-sample register analysis.** For each sample, record word count, address mode, register, signature moves. Flag samples >25% volume. Cluster by register; if 2+ distinct registers appear, flag as multi-register corpus.
6. **Score with register-aware feature validation.** Apply the 8 dimensions from `catalog/anchor-prompt.md`. Match against author hints. Assign weights summing to 100. For each cited feature, verify ≥40% sample appearance OR ≥40% volume (if neither, drop the feature; if it was the strongest evidence, drop the author).
7. **Self-criticism pass.** Strip any thematic reasoning. Set `confidence` and `any_thematic_reasoning` flags.
8. **Write `voice/anchor.md`** — JUST the lean `- N% Author` lines. No headers, no sub-bullets.
9. **Write `voice/anchor-analysis.md`** — per-author features, per-sample table, register diversity, self-check, refresh notes. Human-facing only.
10. **If multi-register corpus detected**, recommend a Multi-Register Split (see below).
11. Report blend + confidence + caveats to user.

## Launching the anchor as a sub-agent

The Anchor Protocol loads a large stylometry rubric (`catalog/anchor-prompt.md`),
the author-hints catalog, and the full corpus. Running it inline floods the main
session with analysis context the user never needs to see. **Launch it as a
sub-agent instead** — the sub-agent does the heavy reading and writes the files;
the main session gets back only a short summary.

Use the Agent/Task tool (general-purpose) with a self-contained prompt. The
sub-agent has no memory of this conversation, so the prompt must name every file
by absolute path:

> Generate a writer's-voice anchor, entirely locally. Do NOT call any network
> service or API — analyze with your own reasoning only.
> 1. Read the stylometry rubric at `<skill>/catalog/anchor-prompt.md` and the
>    author hints at `<skill>/catalog/author-hints.md`.
> 2. Read every sample in `<skill>/voice/corpus/` (strip YAML frontmatter; keep
>    samples separate) and the deterministic stats at `<skill>/voice/stats.md`
>    (run the Analysis Protocol first if it's missing).
> 3. Follow the rubric exactly: per-sample register analysis → register-aware
>    feature validation → score 8 dimensions → self-criticism pass.
> 4. Write `<skill>/voice/anchor.md` (lean blend lines only) and
>    `<skill>/voice/anchor-analysis.md` (rich, human-facing).
> 5. Return ONLY: the blend lines, confidence, and any multi-register warning.

Replace `<skill>` with the skill's absolute path. After it returns, read
`voice/anchor.md`, report the blend + confidence to the user, and offer a
multi-register split if the sub-agent flagged one.

## Multi-Register Anchors

If the corpus spans multiple registers (e.g., third-person expository AND direct-you instructional), maintain a separate anchor per register: `voice/anchor-<context>.md` (e.g., `anchor-book.md`, `anchor-essay.md`, `anchor-tweets.md`). Same lean format. Each gets a paired `voice/anchor-<context>-analysis.md`.

**Multi-Register Split procedure:**

1. Identify registers from the per-sample analysis.
2. For each register, ask the user for a slug + one-line description.
3. Filter corpus to samples in that register.
4. Run the matcher on the subset (same `catalog/anchor-prompt.md` rubric, same variance checks).
5. Write `voice/anchor-<slug>.md` (lean) + `voice/anchor-<slug>-analysis.md` (rich).

**Apply-time anchor selection:** at write time, if multiple anchor files exist, pick by user's request context (explicit naming wins; project the user is working on wins next; ask if ambiguous; fallback to `voice/anchor.md`).
