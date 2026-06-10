# Analysis Protocol

Regenerates the voice files from the corpus. Run any time the corpus changes (new samples added, samples removed, samples revised). Loaded only when triggered — not in context during normal writing sessions.

## Protocol

1. **Read inputs.** Concatenate every file in `voice/corpus/` (strip frontmatter). Count words. Read `catalog/ai-tells.md`, `catalog/fingerprints.md`, `catalog/hurdle.md`.

2. **Compute deterministic tally** (best effort — counts may drift ±1 on long corpora):
   - **Sentence distribution**: split on `[.!?]\s`, compute short/medium/long/very-long percentages, average length. Set `short_max` (25th-pct, clamped [6,12]) and `long_min` (75th-pct, clamped [18,28]). Do NOT emit a sentence-length cap in the apply directive — the corpus distribution carries the right ceiling and an arbitrary cap suppresses signature long sentences.
   - **Punctuation density per 1k words** for em/en dash, colon, semicolon, question, exclamation, ellipsis, paren, bracket, straight/curly quotes. Categorize as `never` / `rare` / `low` / `strong`.
   - **AI-tell tally**: count each item from `catalog/ai-tells.md`. Apply hurdle from `catalog/hurdle.md`: passes hurdle → preserve; fails → emit NEVER rule; below-hurdle but present → log to `below_hurdle`.
   - **Fingerprints**: apply each detector from `catalog/fingerprints.md` with its decision rule.

3. **Determine tier** by word count: <300 = 0 Empty; 300-999 = 1 Anchor; 1000-4999 = 2 Preliminary; 5000-19999 = 3 Full Coverage; ≥20000 = 4 AV-Grade. See `docs/tiers.md` for what unlocks at each tier.

4. **Write `voice/stats.md`** — corpus stats, sentence distribution table, punctuation density table.

5. **Write `voice/never-rules.md`** — preserve `## Manual Additions` section verbatim (anchored to start-of-line; the literal also appears in the intro blockquote — naive search will mis-grab it).

6. **Write `voice/fingerprints.md`** — preserve `## Manual Overrides` section, same caution.

7. **Write `voice/status.md`** — tier, words, active features, locked features, next milestone, file list, below-hurdle detections.

8. **Report** — new tier, what changed in NEVER rules, what's locked next.

For corpora >10k words, count in passes (words → phrases → transitions) rather than tracking 60 counters at once.

## Adding Samples Later

User says "add this to my voice profile" or pastes new writing. Append to next `voice/corpus/sample-NNN.md`, re-run Analysis Protocol, report tier change if any.
