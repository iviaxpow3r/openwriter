# Alias Propagation

A two-tier linking system: the writing agent makes the *original* connection between two docs; a minion *propagates* that connection across the rest of the workspace by matching aliases. Builds on the v0.20 `references` + `aliases` data slots — no schema changes required.

## The problem

OpenWriter workspaces drift into linking debt. A book project has 60+ docs. The agent writes Chapter 7's beats; the prose says "frame" eleven times; not one of those mentions becomes a declared connection to the Frame master reference. The graph stays sparse, crawlability degrades, the user can't see which chapters touch frame without grepping prose.

The v0.21 right-click "See connections" UI works perfectly — when there's something to see. Most of the corpus has nothing to see because nobody declared the links.

Two existing patterns both fail on their own:

- **String-match auto-link.** Naive — "frame" is a verb in some sentences, a chapter concept in others. Auto-wrapping every "frame" produces noise and makes the user distrust the system.
- **Sweep-everything minion.** Reads every doc, decides every link from scratch. Lacks the authorial context that distinguishes link-worthy mentions from incidental ones. Same poor-man's-RAG failure mode that rejected the v0.20-era proposal.

## The split

| Actor | Job | Cadence |
|---|---|---|
| **Writing agent** | Declare the *original* source→target connection. Populate `aliases:` on the target doc with distinctive phrases readers might use to reference it. | Inline during writing — no separate pass |
| **Propagation minion** | Scan every doc's body for any alias from any target. Where the alias appears as unlinked text, propose (or auto-apply, see below) a `[match](doc:TARGET)` link at that site. | Background sweep — on-demand or scheduled |

The agent makes the *judgment call* (this concept is link-worthy; the canonical target is doc Y; readers will find it under these names). The minion does the *mechanical work* (find every unlinked occurrence of those names and wire it up).

## Data model

No new fields. Uses what v0.20 already added:

```yaml
# Target doc frontmatter (e.g. Frame master reference)
docId: 6dfff3c9
title: What Is Frame
aliases:
  - "frame"
  - "the Frame"
  - "frame system"
  - "cognitive defense system"
```

```yaml
# Source doc frontmatter (e.g. Chapter 7 beats) — unchanged
docId: c8b3537b
references:
  - 6dfff3c9    # declared by the agent OR backfilled from prose link
```

`aliases` is the matcher input. `references` is the output (one entry per source→target connection — paragraph-level granularity stays in prose link marks, not in this array).

## The propagation pipeline

```
1. Agent writes prose in Chapter 7. Mentions "frame system" deliberately.
2. Agent wraps it inline:  [frame system](doc:6dfff3c9)
   (or calls link_to(c8b3537b, 6dfff3c9) for a structural backstop without prose mutation)
3. Agent sets the target's aliases:
   set_metadata(6dfff3c9, aliases: ["frame", "the Frame", "frame system", "cognitive defense system"])
4. Save → syncReferencesFromProse auto-extracts the prose link target into c8b3537b.references
5. User (or scheduled hook) runs the propagation minion:
   - Builds an alias→targetDocId index across the workspace
   - Walks every other doc's body, looks for unlinked occurrences of any alias
   - For each hit: either auto-applies the link or queues a proposal
6. Minion reports: "Found 23 candidate links across 14 docs. Auto-applied 8 (high confidence). 15 proposed for review."
```

## Matching algorithm

**Match unit:** the alias string, case-insensitive, on word boundaries. Multi-word aliases match exact phrase; single-word aliases match whole-word only.

**Exclusion zones — never link inside:**
- Existing link marks (would double-link)
- Code blocks, inline code
- Headings (preserves heading clarity; user opens the link from the body instead)
- Footnote definitions
- Already-linked prose pointing at a different doc (don't override an authorial choice)

**Confidence tiers — drives auto-apply vs propose:**

| Tier | Rule | Default action |
|---|---|---|
| **High** | Multi-word alias (≥2 words) OR alias equals target's title exactly | Auto-apply |
| **Medium** | Single-word alias that matches a distinctive term (≥7 chars, no common stopwords) | Propose |
| **Low** | Single-word alias on a common word ("frame", "territory") | Propose, with surrounding sentence shown |

Auto-apply only fires on high-confidence matches. Medium and low always propose, never auto-apply. The agent or user accepts each proposal — or the script supports `--apply-all-medium` for bulk-accept when scanning a known-clean corpus.

## Scope

**Workspace-scoped.** A target doc's aliases only match against bodies of docs in the *same workspace*. Frame mentions in Newsletter drafts shouldn't auto-link to the book's Frame master.

**Body only.** Skip frontmatter, titles, footnote labels, table of contents. Body prose is the only target.

**Idempotent.** Re-running the minion on an already-linked corpus produces zero changes. The exclusion rule "never link inside existing link marks" guarantees this.

## Surface

Three call sites:

1. **CLI script:** `scripts/propagate-aliases.mjs [--apply] [--workspace=NAME]` — dry-run by default, mirrors `migrate-references.mjs` and `strip-self-links.mjs`. Reports proposed and applied counts. Same workflow user already knows.
2. **MCP tool:** `propagate_aliases({ workspace_id, mode: "propose" | "apply" })` — agent-callable from writing flow. Returns the proposal list as JSON so the agent can apply selectively.
3. **Background hook (Phase 2):** auto-runs after `set_metadata` updates an `aliases:` field. New aliases get propagated immediately. Skipped for v1 — too easy to cause runaway link churn before the matcher is battle-tested.

## Open questions

1. **Alias governance.** Who owns the aliases array on each target doc? Author writes it manually? Enrichment minion infers it from the body? Mixed? Recommendation: author-owned initially (no auto-population), revisit once we see how much manual work it is across a 60-doc workspace.
2. **Anchor links (paragraph-level).** When the alias matches inside a doc that has paragraph-level granularity, does the minion link to the doc root or to a specific paragraph? Recommendation: doc root for v1 — paragraph anchoring requires the *target* doc to have a canonical "definition paragraph" for that alias, and we don't track that yet.
3. **Stemming/plurals.** Should the alias "frame" also match "frames", "framing", "framed"? Recommendation: no for v1 — too easy to over-link. Author declares plural forms explicitly if needed.
4. **Linkrot.** What if a target doc is deleted? Existing `[text](doc:DELETED)` links break gracefully (PadLink falls back to non-link text). Propagation minion treats missing target as "alias entry stale, skip during sweep."

## Out of scope

- **Initial linking.** This minion never invents a new connection. It only propagates existing source→target relationships to additional source sites. The first connection between two docs is always made by an agent.
- **Cross-workspace linking.** Each workspace gets its own alias index. Two docs in different workspaces with the same alias do not interact.
- **Semantic similarity.** No embeddings, no fuzzy matching, no LLM judgments inside the minion. Pure string matching against author-declared aliases. The intelligence sits with the author who curates the alias list.
- **Auto-aliases from doc titles.** Tempting to default `aliases: [doc.title]` but breaks the model — author should think about which alias forms are link-worthy, not get them inferred from a title that may include qualifiers ("Frame — Thread v2") that shouldn't match in prose.

## Phasing

**v1 (next minor release after v0.21.x).**
- CLI script `propagate-aliases.mjs` with dry-run + apply modes
- High-confidence tier auto-apply
- Medium and low tiers propose-only (printed list, no UI yet)
- Per-workspace scope

**v2 (followup).**
- MCP tool surface for agent-driven propagation
- Inbox-style proposal review in the editor sidebar
- Hook on `set_metadata({ aliases })` to propagate-on-write (gated behind opt-in flag until matcher is trusted)

**v3 (if needed).**
- Alias inference from body usage patterns (e.g. detect that "the Frame" appears in 8 docs that all also link to Frame → propose adding "the Frame" to that doc's aliases array)

## Why this isn't auto-link v2

Earlier proposals failed because they tried to do both jobs in one pass: detect connections AND propagate them. This split keeps detection (author judgment) and propagation (mechanical) cleanly separated. The minion is dumb on purpose. The intelligence lives in the agent's choice to declare an alias, not in the sweeper's choice of what to match.
