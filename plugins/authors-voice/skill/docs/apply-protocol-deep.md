# Apply Protocol — Deep Reference

Loaded when scoping a brief (Apply step 4) or running cross-section coherence review (Apply step 8). Not in context for routing or other turns.

## Step 4 — Writing the TASK brief

Promoted to `SKILL.md` Apply Protocol step 4. The load-bearing rules (commitments-only default, never meta-references, COMMITMENTS as quasi-verbatim, read-prior-integrated-sections, preservation scope, cadence prescription) live there. This doc holds the edge-case templates and minion taxonomy below.

## Writing minion taxonomy

| Minion | Scope | Input | Output | When fires |
|---|---|---|---|---|
| **Apply** | Generative writing | Commitments + voice + context SUMMARIES (no source prose) | Fresh prose | Initial drafts. Also small reframes when audit prescribes a structural fix (audit's prescription becomes the commitment). |
| **Rewrite** | Generative writing against updated commitments WITH context awareness | Updated commitments + voice + context layers (summary of preceding + key-term glossary + adjacent seam paragraphs as orientation-only) + cadence prescription. NO source prose for content being written. | Fresh prose | Beat Map commitments changed; surrounding prose is acceptable and should be preserved. Apply brief + context awareness layers. |

Plus **Blinder Audit** (Step 8b — paragraph-level substance duplication, critic only) and **Anchor Iteration** (Step 10 — final polish, channels voice anchors as panel, iterates to 90/100; see `anchor-iteration.md`).

### Editor's classification job after Audit fires

Each finding routes to one of three paths:
- **Editor direct (no minion)** — cuts, swaps, reorders, sentence-level surgical patches. Per FIRM RULE 1 carve-out.
- **Rewrite Minion** — paragraph's SUBSTANCE needs to change (structurally redundant with another, or mission needs to shift). Compression alone produces thin output.
- **Apply Minion (small)** — audit prescribes a specific reframe of a small span and new prose is needed (e.g., "reframe opening sentence to acknowledge pivot from X to Y"). Audit's prescription becomes the commitment.

Classification rule: **before flagging anything for a minion, ask "is this a SHAPE problem or a SUBSTANCE problem?"** Different work needed → Rewrite or Cut. New prose into a small span → small Apply. Surgical word/sentence work on existing prose → editor direct.

## Rewrite Minion

The Rewrite Minion IS the Apply Minion fired with context awareness. The brief shape preserves Apply's no-source-prose-ceiling property (minion brings its own moves) while adding context layers needed to flow into surrounding prose.

### Validated brief shape

```
[Voice profile: anchor, NEVER rules, fingerprints, stats, coined terms, examples]

---

TASK:

PROJECT: [1-paragraph context — what the doc is, what the section does]

CONTEXT — what's already established in the surrounding prose:
- [Summary of preceding section as bullets — what was named, what was claimed, what threads are live. NOT raw prose. 5-10 bullets.]

KEY TERMS already named (available for callback if useful):
[Glossary list — coined terms, named concepts, distinctive phrasings the prose has established]

IMMEDIATELY PRECEDING PARAGRAPH (for seam continuity ONLY; do NOT mirror its cadence):
[Full paragraph verbatim — 1 only]

IMMEDIATELY FOLLOWING PARAGRAPH (for seam continuity ONLY; do NOT mirror its cadence):
[Full paragraph verbatim — 1 only]

COMMITMENT(S) — what your new content must land in the reader:
[Outcome statement(s) per beat]

CADENCE PRESCRIPTION (per paragraph):
[Explicit rhythm direction — open with X, build with Y, close with Z. Mandatory.]

LENGTH: [target word count]

Return prose only. No commentary. No headers. No beat labels.
```

The two seam paragraphs are full prose (minion needs flow continuity at the join), flagged explicitly as orientation-only. This avoids the source-prose ceiling because the task is "write fresh content that flows from / into these" rather than "match this cadence." **Framing matters more than presence.**

### Why these elements

- FULL adjacent seam paragraphs flagged "orientation only — do NOT mirror cadence" — flow continuity without ceiling
- SUMMARIES of preceding section (bullets, not raw prose) + key-term glossary — document-scale awareness
- OMITTING source prose for content being written — preserves no-ceiling property
- INCLUDING explicit cadence prescription per paragraph — mandatory; short calls need cadence MORE, not less

### Scope

Works at any scope: paragraph-level (1 new paragraph), section-level (3-5 paragraphs), beat-level (full beat regeneration). Pick by what changed in commitments — one beat's outcome → regenerate one paragraph; chapter-arc beat's whole outcome shape → regenerate the whole beat; multiple beats → batch per chapter-arc beat.

### Preserving specific lines from existing prose

List them as MUST-APPEAR-VERBATIM in commitments (Apply's "selective lifts" mode). Rare — usually the writer's training data brings stronger lines than the existing prose anyway.

### Audit follow-up MANDATORY

Rewrite outputs are subject to the same minion-blinder problem as first-pass Apply. The minion only sees its slice — seam paragraphs + summary bullets, not every paragraph in adjacent sections. It can introduce repetitions with paragraphs it didn't see.

**After any Rewrite Minion call, fire the Audit Minion (Step 8b) on the integrated document.** No exceptions. Empirical case: first Rewrite test (B1 close + B2 opening) produced strong individual prose AND 8 audit findings — most notably a visual-roster repetition across 4 paragraphs the rewriter never saw.

### Don't conflate rewrites with violation patches

Violation patches (FIRM RULE 1 carve-out) are 1-3 sentence local fixes to NEVER violations or brief errors WITHIN otherwise-acceptable prose. Editor work, small scope, surgical. Rewrites here mean re-running the minion against UPDATED commitments — different scenario, different scope decision.

## Step 8 — Cross-section coherence review

After integrating multiple minion outputs, scan for what individual runs cannot see:

- **Cadence repetition** across sections (same opens, same closes, same paragraph counts)
- **Recurring metaphors / phrases** across sections
- **Structural sameness** (every section ends with 4-layer enumeration, every section opens with 3 shorts)
- **Coined term overuse** — coined terms get injected into every minion call as MUST-PRESERVE, producing document-scale repetition (e.g., "territory" every 3 paragraphs). Track heavy-use terms; for subsequent minions, omit heavy-use terms from coined-terms injection OR add "use sparingly" instruction

Fix options: re-spawn with varied prescription, surgical post-edit (combine/split/swap), vary commitments + coined-terms per section at brief-assembly time, or accept for low-stakes drafts. The editor owns document-scale coherence; minions are responsible only for section-scale quality.

## Step 8b — Blinder Audit Minion (mandatory post-integration)

### Purpose

Minions write with SURGICAL context — just their slice of the doc — to avoid source-prose ceiling and context pollution. The trade-off: minion A doesn't know what minion B wrote. They can independently produce paragraphs whose ENTIRE SUBSTANCE mirrors another paragraph's entire substance. The **blinder problem**.

The Blinder Audit Minion has ONE job: find pairs of paragraphs whose whole substance closely mirrors each other.

### Operational test

The audit must reduce to an OBJECTIVE pattern-match — not a subjective claim about reader experience. The working question:

**"Summarize each paragraph in one sentence. Are two paragraphs' summaries effectively the same?"**

Or sharper: **"Could I cut this paragraph entirely and lose only redundancy?"** Answerable by reading; neither requires reader-experience judgment.

Empirically validated: the visual-roster case (4 paragraphs each enumerating the same 5 species in different framings) was a real blinder hit. Every other category tested at sentence-level, transition-level, or image-anchor level was a false positive — either intentional craft (image-anchoring, scaffolding, callbacks) or AI baseline patterns the reader doesn't notice.

### When to fire (mandatory)

- After integrating ≥2 minion outputs into one document
- After any rewrite cycle touching multiple sections
- Before showing the integrated document to the user

Skip when: single-minion / single-section work; surgical violation patches only.

### What to scan for (ONE category)

**PARAGRAPH-LEVEL SUBSTANCE DUPLICATION** — two paragraphs whose entire substance closely mirrors each other.

Diagnostic for any candidate pair:
1. Summarize paragraph A in one sentence. ("This paragraph does X.")
2. Summarize paragraph B in one sentence. ("This paragraph does Y.")
3. If X and Y are effectively the same job done with different words — finding.
4. If X and Y are different work — even if paragraphs share images, lexical phrases, or thematic threads — NOT a finding.

Cut test: could you delete one paragraph and lose only redundancy (no unique substance, no unique image-anchor, no unique scaffolding move)? Yes → real blinder. Cutting would lose something distinct → NOT a blinder regardless of surface similarity.

### What NOT to scan for (explicit exclusions — these produce false positives)

The audit must NOT flag any of these, even when surface similarity exists:

- **Sentence-level overlap across paragraph boundaries** (P4's closing shares thematic thread with P5's opening). Bridge/transition work. Cutting disconnects.
- **Image-anchoring across paragraphs** (the same image used in 2-3 paragraphs to thread a concept). Craft. The savanna/lion appearing in opener + body + closing is intentional thread.
- **Callbacks** (an image returning later as frame device or recognition moment). Craft.
- **Scaffolding repeats** (a paragraph opening with brief re-statement of previous paragraph's premise to set up its own new move). Premise-restatement is structure-promise, not duplication.
- **Sentence-level lexical/thematic overlap of any kind** unless part of WHOLE-PARAGRAPH substance duplication. Sharing the word "engine" or "same biology" is sentence-level — not a finding.
- **Structural sameness** (parallel cadence, repeated openers, declarative thesis + builds + aphorism). Readers don't notice; AI baseline behavior addressed by /anti-ai.
- **Cadence repetition** (parallel rhythm runs in adjacent paragraphs). Same reason.
- **Coined-term recurrence**. Coined terms are SUPPOSED to recur as identity markers.
- **Single-paragraph internal repetition** (triple anaphora within ONE paragraph). Craft, and the audit scans across paragraphs not within.

### Expected hit rate

Paragraph-level substance duplication is rare in semi-competent writing. On well-written beats the audit should typically return **NO BLINDER ERRORS FOUND** — the correct output, not a list of stretched findings to justify the call.

The audit fires as backstop on every integration. It catches gross duplications (visual-roster case, two paragraphs accidentally doing the same teaching beat). Most of the time it correctly returns zero.

### Report format

```
Finding #N
- LOCATION: paragraph references (e.g., "B2 P4 + B2 P5")
- SUMMARY A: one sentence describing what paragraph A does
- SUMMARY B: one sentence describing what paragraph B does
- WHY THE SUMMARIES MATCH: one sentence showing the substance duplication
- CUT TEST: could one paragraph be deleted entirely with only redundancy lost? (If no, the finding is invalid; do not include.)
- SEVERITY: moderate / major (paragraph-level duplication does not produce "minor" findings)
- SUGGESTED FIX: cut paragraph A / cut paragraph B / merge to single paragraph
```

If nothing meets the bar, return exactly: **"NO BLINDER ERRORS FOUND"** — that string, nothing else. Do NOT pad with sentence-level observations, structural notes, or polishing suggestions.

### Editor's response

For each finding:
- Apply the cut test independently. Does deleting one paragraph lose only redundancy?
- Yes → **cut** (editor territory, FIRM RULE 1 carve-out). Delete weaker paragraph via write_to_pad. If both are strong but redundant, merge unique fragments via Rewrite Minion.
- No → audit got it wrong. Defer.

Audit minion does NOT patch. Only reports.

Classification failure modes:
1. Trusting a finding without applying the cut test. If both paragraphs carry distinct substance, the audit was matching surface features. Defer.
2. Routing a paragraph-level cut to a Rewrite Minion when it should just be a cut. If two paragraphs do the same work, deleting one is the cleanest move.

### Brief shape (template)

Index every paragraph in the doc (e.g., "B1 P1: ...", "B2 P7: ...") so the audit can reference cleanly. Pass the full indexed document + the ONE category + the explicit exclusions + the output format. No voice profile needed (this isn't writing prose). Use opus.
