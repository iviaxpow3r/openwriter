# Authenticity Hurdle

> The core decision rule: when does a pattern in the user's corpus count as "their voice" versus "AI contamination"?

## The problem

If we just emit NEVER rules for everything in the AI tells catalog, we'll strip out words the user actually likes and uses. Example: Mark Manson regularly uses "crucial" and "vital." Banning those flattens his voice.

If we don't emit any rules unless the word appears zero times, we keep AI contamination. Example: an essay that the user originally drafted with ChatGPT help and then edited still contains stray "delves" and "valuable insights" — that's not their voice, that's leftover residue.

The hurdle resolves this: a pattern is "authentic" only if it appears at signature frequency. Below that → contamination, ban it.

## The thresholds

| Category | Min count | Min rate per 1000 words | Why |
|----------|-----------|-------------------------|-----|
| `word` | 2 | 0.15 | Single words are noise-prone. Need at least 2 and a non-trivial rate. |
| `transition` | 2 | 0.15 | Same as words. |
| `phrase` | 2 | 0.05 | Phrases are more distinctive — a lower rate still signals deliberate use. |
| `punctuation` | 15 | 1.5 | Punctuation is denser than diction. A few em-dashes is normal; signature use means many. |

## The decision

For each AI tell, given `count` (how many times it appears in the corpus) and `words` (total word count of the corpus):

```
rate_per_1k = (count / words) * 1000
passes = count >= min_count AND rate_per_1k >= min_rate_per_1k
```

If `passes` → **preserve** (no NEVER rule). The user genuinely uses this.

If not `passes` → **forbid** (emit NEVER rule). This includes:
- Items that never appear (forbid because training data will push them back in)
- Items that appear once or twice but below the rate threshold (forbid because it's likely contamination, not signature)

## Worked examples

**Word "delve" in a 2000-word corpus:**
- count = 0 → fails (count < 2) → **forbid**: `NEVER "delve".`
- count = 1 → fails (count < 2) → **forbid**: `NEVER "delve".` _(below hurdle — flagged in status.md as likely contamination)_
- count = 2, rate = 1.0/1k → passes (count ≥ 2, rate ≥ 0.15) → **preserve**, no rule.

**Em-dashes in a 5000-word corpus:**
- count = 8, rate = 1.6/1k → fails (count < 15) → **forbid**: `NEVER "em-dashes".`
- count = 20, rate = 4.0/1k → passes → **preserve**, no rule.

The em-dash hurdle is intentionally hard. Most human writers don't clear it. The few who do (people with serious published-prose backgrounds) get to keep their em-dashes.

## What this implies about tier progression

The skill's tier system tracks corpus word count:
- Tier 1 (300–1k words): too small to clear most hurdles. NEVER rules emit aggressively.
- Tier 2 (1k–5k): some words start to pass. Most phrases still fail (they need ≥2 instances).
- Tier 3 (5k–20k): phrases and many words can pass. Em-dash hurdle still hard.
- Tier 4 (20k+): em-dash hurdle achievable. Profile is AV-grade.

The hurdle stays the same across tiers. What changes is that more corpus means more chances for the user's signature patterns to clear it.

## Status reporting

For items that appear in the corpus but fail the hurdle (the "below_hurdle" set), flag them in `voice/status.md` under a "Below-Hurdle Detections" section. Format:

```
- `delve` — appears 1x, rate 0.5/1k
- `however` — appears 1x, rate 0.5/1k
```

This is informational — the user can see what got flagged as contamination. It helps them notice "oh, I have a habit of letting AI drafts through" or alternatively "wait, I actually do use that word, let me add it to manual preserves."

## Edge cases

- **Count = 0**: always forbid. Don't list in below_hurdle (because it isn't "present in corpus").
- **Tied counts in fingerprint binary**: if `a == b` (exactly equal), treat as `mixed`.
- **Total < 3 in fingerprint**: skip entirely — not enough signal.
- **Negative numbers, NaN, infinity**: shouldn't happen, but guard with `count = max(0, count)` if you implement defensively.
