# Post-Write Audit

> Distribution-level statistical checks the orchestrator runs against the minion's returned prose. Sits between step 6 (NEVER scan) and step 7 (integration) of the Apply Protocol. Catches statistical fingerprints the minion's prompt can't reasonably prevent without cognitively overloading the writing pass.

## When this runs

After step 6 (NEVER-violations scan + brief-error patching), before step 7 (integration). The orchestrator reads this file, applies each check to the minion's output, and surgically rewrites the smallest span that brings the failing metric back into range.

## Why this layer exists

The minion writes prose. The orchestrator polices distribution and lexicon. Anything mechanically detectable after the fact lives here, not in the writing-pass prompt — the minion's cognitive budget should go to channeling the anchor and hitting the commitments, not tracking 60 micro-bans.

Two enforcement points still exist for the bans the minion DOES need to see (contrastive negation, sentence-opener repetition, em-dashes, etc.) — those live in `voice/never-rules.md` and get scanned at step 6. This audit is for the slop that's cheaper to scrub than to prevent.

## Remediation principle

For each failing check, rewrite the **smallest local span** that fixes the metric. Do not regenerate. Do not reach for stylistic improvement. The minion's voice IS the result — the audit only nudges the statistics.

If a failing span is load-bearing (a specific image, a coined term, a structural beat the brief demanded), leave it. Audit findings are advisory at the boundary case. The minion's intent wins ties.

Aim for the lightest touch: 5-10 small substitutions across a typical draft brings rates back in line. Heavier rewrites mean the audit is being misused.

## Distribution checks

### 1. Sentence-opener repetition

**What to measure:** walk the output sentence by sentence. For each window of 3 consecutive sentences, check whether all three start with the same first word.

**Threshold:** flag if >30% of windows trigger.

**Why this number:** human writing sits at ~17% (DFT 2026 — mostly from intentional list structures like "How does X?... How does Y?... How does Z?"). SFT models at T=0.7 hit 53.3%. The 30% line cleanly separates human from AI.

**Action:** locate the offending windows. For each, rewrite the second OR third sentence to start with a different word. If the window forms an intentional list, leave it — list structure is the human use case the 17% baseline reflects.

### 2. Sentence-initial "The" frequency

**What to measure:** percentage of sentences that begin with the word "The."

**Threshold:** flag if >15% of all sentences.

**Why this number:** "The" at sentence start is over-used by ~90% in SFT output vs human writing (DFT 2026, 14B SFT model). The +90% inflation puts AI rates well above the natural human range.

**Action:** locate sentences starting with "The." Rewrite a portion to start with a different determiner ("A", "An", "These"), a pronoun, a prepositional phrase, or a different subject. Five to seven swaps across a typical paragraph is usually sufficient.

### 3. Function-word over-use

**What to read for:** the AI distribution-distance signal lives mostly in function words, not fancy diction. Top-10 tokens account for 87.2% of L2 distribution distance in SFT output (DFT 2026). Watch for:

| Token | SFT inflation vs human |
|---|---|
| `is` | +44% |
| `was` | +49% |
| `are` | +31% |
| `that` | +25% |
| `a` | +15% |
| `to` | +11% |
| `.` (period) | +19% |

**Heuristic check (no exact threshold):** scan the draft for clusters of short copular sentences ("X is Y. Z is W. P is Q.") and high period density (many short sentences in a row). Both are signatures of function-word inflation.

**Action:** when noticed, merge two short copular sentences into one with a participial or relative clause; vary sentence structure to use action verbs instead of "is/was"; combine short sentences to drop period count. Three to five rewrites across a paragraph usually levels the distribution.

### 4. Sentence-length variance

**What to measure:** compute standard deviation of sentence length (in words) across the output. If the user has a `voice/stats.md`, compare to the user's own σ. Otherwise compare to baseline σ ≥ 8 words.

**Threshold:** flag if σ < 6 words (low variance — uniform sentence length is an AI signature).

**Action:** locate runs of similar-length sentences. Merge two short ones into a longer compound, or split a medium one. The goal is to restore length variance, not hit a specific number.

## Lexical watch list

Mechanical word-level scrubs. The minion doesn't see these — the audit handles them on the way out.

### GPT-5 specific over-used tokens (DFT 2026)

When the minion is a GPT-5-class model, these tokens are inflated vs human writing. Scan for them:

| Token | Inflation vs human | Human baseline |
|---|---|---|
| `corridors` | +45.2% | 0.1% |
| `norms` | +43.1% | 0.1% |
| `align` / `aligns` / `alignment` | +36.0% | 0.2% |
| `metrics` | +27.2% | 0.2% |
| `engagement` | +26.5% | 0.2% |
| `targeted` | +5.1% | 1.6% |
| `identity` | +5.0% | 1.0% |
| `trust` | +4.9% | 1.2% |

**Action:** swap to a context-appropriate alternative when the word appears in surplus (3+ uses in a short piece, OR any use in a context where the word feels generic). If the user's corpus contains the word at signature frequency (in `voice/stats.md` or `voice/never-rules.md` exempts), leave it — they own that word.

### Named-character defaults

AI defaults to specific generated names in fiction. Known examples:

- `Elara Voss` — documented in OpenAI's "goblin problem"
- Add new defaults as documented.

**Action:** if found in fiction output without explicit user specification, rename to something contextually appropriate or to a name the user has used in their corpus.

## Source

Distribution thresholds and over-use rates from "Fixing LLM Writing with Distribution Fine-Tuning," Rosmine 2026 (https://rosmine.ai/2026/05/18/fixing-llm-writing-with-distribution-fine-tuning/). Token over-use rates measured against 14B SFT vs human fineweb baseline. Sentence-opener repetition methodology: percent of texts containing 3+ consecutive sentences starting with the same first word.

This file is a living checklist. New research that surfaces measurable thresholds for AI-vs-human writing belongs here, not in `voice/never-rules.md` — the writing pass stays lean.
