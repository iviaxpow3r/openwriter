# Anchor Iteration

Final-polish minion. Channels the user's voice anchors as a panel; iterates critique → rewrite → re-score until 90/100. Single minion conversation, visible iteration history. Mandatory anti-ai cleanup follow-up.

Specialization of `/polish`'s pattern for writers-voice: channels the user's specific voice anchors (dynamically loaded from `voice/anchor.md` or `voice/anchor-<context>.md`), not generic advertising practitioners.

Replaced the prior single-pass Anchor Critique tool. Single-pass scoring is now just "stop after iteration 1" of Anchor Iteration — same architecture, parameter difference.

## Why this works

AI cannot judge beats subjectively from generic prompts — no dopamine system to consult. But channeled anchors carry beat-judgment encoded in their training-data representations. Channeling Peterson reading prose surfaces Peterson's beat-trained sensibility. Multiplied across the panel, the collective weighted score reflects how the prose lands across the writer's actual voice ambition.

This is the ONLY AI critic tool that can do beat-level judgment, and it works only because the anchors are real humans whose dopamine-trained sensibilities are encoded in training data. Judgment is collective and writer-specific.

## Architecture: one minion, visible iteration

ONE minion conversation. The minion runs the entire iteration loop internally with full visible history — each iteration's anchor critiques are part of the minion's context for the next iteration. Anchors see how their previous critiques were addressed (or weren't), which sharpens subsequent critiques.

Mirrors `/polish` exactly. NOT extracted-and-rerun-cold per iteration. The loop has memory.

Optional fallback: if visible iteration converges on a local optimum (rewriter anchored to original framing through visibility), retry with blind iteration (no prior history shown across iterations). Default = visible.

## Inputs (only)

- The prose to polish
- The voice anchor blend (dynamically loaded from `voice/anchor.md` or `voice/anchor-<context>.md`)

That's the complete input. No commitments. No beat sheet. No project context. Anchors read the prose AS-IS, like a reader encountering it cold.

**Why no context:** anchors must judge the prose AS IT LANDS, not as it was intended to land. Briefing them on the project would have them judge against the brief, not against the prose. Cold reading is the point.

## Personas (dynamic, inferred)

Pulled from `voice/anchor.md` (or context-specific variant). Each anchor listed with a blend percentage that serves as both voice influence weight and panel vote weight.

The minion infers each anchor's persona from training data — named writers are known entities to opus. System prompt does NOT enumerate per-persona profiles. `/polish` works the same way ("top 10 advertising practitioners" — no profiles needed; opus knows Hopkins, Ogilvy, Sugarman, etc.).

Example book-project anchor file:

```
- 26% Jordan Peterson
- 22% Robert Sapolsky
- 20% Nassim Taleb
- 18% Bryan Caplan
- 14% Naval Ravikant
```

Minion channels each with their characteristic sensibility — Peterson for moral weight and structural rigor, Sapolsky for biological grounding and dry mechanism, Taleb for skin-in-the-game and aphoristic hardness, Caplan for clear thesis with evidence, Naval for aphoristic screenshot-worthy compression.

## Process (per iteration)

1. Each anchor reads the current prose AS-IS, with their characteristic sensibility
2. Each anchor produces:
   - SCORE 0-100 (honest read of how this lands for them)
   - TOP CRITIQUE (ONE thing they would cut, sharpen, or restructure)
   - STRENGTH (what's working that must be preserved)
3. Compute collective weighted score using anchor blend percentages
4. If collective ≥ 90/100: STOP. Mark as FINAL ITERATION. Return converged prose.
5. If collective < 90/100: synthesize panel's critiques into a FULL REWRITE of the prose (not a sentence-level patch). Preserve named strengths.
6. Begin next iteration with rewritten prose. Each iteration's anchors see all previous iterations and critiques in their context.

ITERATION CAP: 6 iterations. If still <90 after 6, return highest-scoring iteration with note about non-convergence.

## Output format

Per iteration:

```
====== ITERATION N ======

PROSE (current state):
[the prose being read this iteration]

ANCHOR READINGS:

{Anchor Name} ({weight}%): SCORE: X/100
  TOP CRITIQUE: ...
  STRENGTH: ...

[repeat per anchor]

COLLECTIVE WEIGHTED SCORE: X/100

[if < 90:]
SYNTHESIS — what the rewrite must address:
- ...

REWRITE:
[next iteration's prose, full text]

[if ≥ 90:]
CONVERGED. Final prose ready below.
```

After convergence (or cap):

```
====== FINAL ======
Iterations: N
Final score: X/100
Convergence: YES / NO

FINAL PROSE:
[the polished prose, full text]
```

## Mandatory anti-ai follow-up

Anchor iteration runs no-context. NEVER rules and presentation fingerprints are not in scope during iteration. Rewriter will introduce AI tells the original prose may have avoided.

After convergence, editor MUST run an anti-ai cleanup pass against `voice/never-rules.md` and `voice/fingerprints.md`. Common scrubs:

- em-dashes → commas, periods, or restructured sentences
- semicolons → "and" or new sentences
- contrastive negation patterns → direct positive statements
- banned diction → plain equivalents
- inserted parenthetical em-dashes → restructure

TWO-STEP pattern. Iteration THEN anti-ai. Two passes do different jobs and should not be conflated. Skipping the anti-ai pass ships AI fingerprints into the published prose.

## When to fire

- Final polish of a beat or section before publishing
- After integration of multi-minion drafts is complete and the Blinder Audit is clean
- When prose is content-finished and needs to land at ship-level voice quality

Do NOT fire on:

- Rough first drafts (commitments may still be evolving — polish wastes effort)
- Sections under structural revision (rewrite the commitments first, then polish the result)
- Single-paragraph fragments (panel needs prose to evaluate; isolation produces weak critiques)

## Editor's role

1. Identifies a beat ready for final polish
2. Fires Anchor Iteration with the prose + dynamically loaded anchor blend
3. Receives the converged output
4. Runs the mandatory anti-ai cleanup pass
5. Posts the result for review or comparison

The editor does NOT:
- Inject project context into the iteration (preserves cold-reader purity)
- Stop the iteration early (let convergence happen — the loop is the point)
- Re-judge the panel's collective decisions (panel's authority is the entire point of the tool)

## Failure modes

- **Sycophantic clustering**: anchors give 85+ uniformly. Prompt explicitly bans default-middle scoring and names what 90/60/40 means for each anchor (90 = anchor would actually quote / share; 60 = competent but forgettable; 40 = anchor would put it down).
- **Persona drift**: anchors all sound like generic helpful AI. Combat by instructing channel-faithfully — each anchor should sound like the actual writer, hostile to AI flattening.
- **Iteration plateau**: scores stop rising after iteration 3-4. Panel has done what it can. Ship the highest iteration even if below 90, or fall back to blind iteration.
- **Manufactured content**: rewriter may invent details to address critiques (fabricated autobiographical claims, invented statistics, manufactured anecdotes). Editor MUST scan output for invented content during anti-ai pass and verify or cut as appropriate.

## Model

**Opus required.** Sonnet drifts to default-helpful behavior, scores uniformly high, produces weak rewrites that don't actually address critiques. Opus channels personas with discipline and produces rewrites worth re-scoring.

## Cost

Single conversation, multiple turns. Per iteration: ~3-5k input tokens (prose + previous iteration history) + ~3-5k output (critiques + rewrite). Three iterations ≈ 30k total tokens. Acceptable for chapter-scale work.

For short pieces (tweets, single paragraphs), Anchor Iteration is overkill. Use `/anti-ai` alone or a single Apply call with strong commitments.

## Validation

Tested 2026-05-18 on a 1000-word chapter beat. Three iterations:

- **Iteration 1**: 77.20/100. Panel flagged: thesis buried, mechanism overclaim, no skin-in-the-game, no screenshot-worthy lines.
- **Iteration 2**: 86.32/100. Rewrite added thesis paragraph + personal admission + mechanism hedge + sharpened closing teaser.
- **Iteration 3**: 91.04/100. Strengthened personal admission, fixed determinist phrasing, added specific enemies, gave load-bearing line its own paragraph. Converged.

Notable failure modes observed:

- Rewriter manufactured an autobiographical detail (Iteration 2 invented a personal admission to satisfy a skin-in-the-game critique). Editor caught and flagged for verification during anti-ai pass.
- Iteration introduced em-dashes across 8 paragraphs and semicolons in the opening (original prose used "and"). Mandatory anti-ai pass scrubbed all of them.

The tool delivered ship-quality prose in 3 iterations. The post-iteration anti-ai pass was non-optional.
