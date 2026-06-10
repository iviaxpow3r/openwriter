# Fingerprints Catalog

> Exact presentation choices the author makes consistently. LLMs default to training-data defaults for all of these unless explicitly told the user's choice. So we measure each one and emit a one-liner.
> Use this when analyzing a user's corpus.

## How to use this catalog

For each fingerprint below:

1. Read the user's corpus.
2. Count the relevant variants.
3. Apply the decision rule (mostly ≥3 total observations, then a ratio threshold).
4. Emit a one-line fingerprint line if confidence ≥ medium. Skip if `n/a` (not enough signal).

The output goes into `voice/fingerprints.md` as a bullet list, each line in the format `<Label>: <value>`.

## Confidence rule (used by most binary fingerprints)

Total observations = `a + b` where `a` is the count of one variant and `b` the other.

- If total < 3 → **`n/a` (low confidence)**, skip emitting.
- If `a / total ≥ 0.85` → **`a` wins, high confidence**, emit.
- If `a / total ≤ 0.15` → **`b` wins, high confidence**, emit.
- If `0.70 ≤ a / total < 0.85` → **`a` wins, medium confidence**, emit.
- If `0.15 < a / total ≤ 0.30` → **`b` wins, medium confidence**, emit.
- Otherwise (0.30 < ratio < 0.70) → **`mixed` (low confidence)**, emit as "inconsistent" only if the user explicitly wants to see mixed signals; otherwise skip.

For the curious: this is asymmetric because we want either a clear choice (≥70%) or to skip. The 0.30-0.70 band is "the author isn't actually making a consistent choice" — emitting a fingerprint there would mislead.

## The eight fingerprints

### 1. Em-dash spacing

What to measure:
- `spaced` count = occurrences of `<whitespace>—<whitespace>` (e.g., `word — word`)
- `unspaced` count = occurrences of `<non-whitespace>—<non-whitespace>` (e.g., `word—word`)

Apply the binary confidence rule.

Output map:
- `spaced` → `Em-dash spacing: word — word`
- `unspaced` → `Em-dash spacing: word—word`
- `mixed` → `Em-dash spacing: inconsistent`

Note: if the user is on a NEVER em-dashes rule (didn't clear the punctuation hurdle), skip this fingerprint entirely.

### 2. Ellipsis style

What to measure:
- `three_dots` count = occurrences of `...` (three ASCII dots, not part of a longer run)
- `unicode` count = occurrences of `…` (single Unicode character)
- `spaced_dots` count = occurrences of `. . .` (dots separated by spaces)

Decision:
- If total < 3 → `n/a`, skip.
- If max variant / total ≥ 0.85 → emit the winning style.
- Otherwise → `mixed`.

Output map:
- `three_dots` → `Ellipsis style: ...`
- `unicode` → `Ellipsis style: …`
- `spaced_dots` → `Ellipsis style: . . .`
- `mixed` → `Ellipsis style: inconsistent`

### 3. Sentence-initial conjunction capitalization

What to measure:
- `caps` count = occurrences of `[.!?]<whitespace>(But|And|So|Or|Yet)\b` — i.e., starts a new sentence with capitalized conjunction
- `lower` count = occurrences of `[.!?]<whitespace>(but|and|so|or|yet)\b` — same but lowercase (unusual, only if author uses a stylistic comma-after-period thing)

Apply the binary confidence rule.

Output map:
- `caps` → `Sentence-initial "But/And/So": capitalized (". But")`
- `lower` → `Sentence-initial "But/And/So": lowercase (", but")`
- `mixed` → `Sentence-initial "But/And/So": inconsistent`

### 4. Oxford comma

What to measure (rough — accept some noise):
- `withOxford` = sequences matching `<word>, <word>(...), and <word>` or `<word>, <word>(...), or <word>`
- `withoutOxford` = sequences matching `<word>, <word>(...) and <word>` or `<word>, <word>(...) or <word>` (no comma before "and"/"or")

Apply the binary confidence rule.

Output map:
- `yes` → `Oxford comma: yes`
- `no` → `Oxford comma: no`
- `mixed` → `Oxford comma: inconsistent`

### 5. Quote style

What to measure:
- `straight` count = occurrences of `"`
- `curly` count = occurrences of `"` or `"`

Apply the binary confidence rule.

Output map:
- `straight` → `Quote style: straight "..."`
- `curly` → `Quote style: curly "..."`
- `mixed` → `Quote style: inconsistent`

### 6. Capitalization after colon

What to measure:
- `upper` count = occurrences of `: <Uppercase letter>`
- `lower` count = occurrences of `: <lowercase letter>`

Apply the binary confidence rule. Require total ≥ 3.

Output map:
- `upper` → `Capitalization after colon: upper`
- `lower` → `Capitalization after colon: lower`
- `mixed` → `Capitalization after colon: inconsistent`

### 7. Contractions

What to measure:
- `contracted` count = occurrences of `<word>'<s|re|ve|ll|d|t|m>` (e.g., `don't`, `I'm`, `we'll`)
- `expanded` count = occurrences of the literal phrases `do not`, `does not`, `did not`, `is not`, `are not`, `was not`, `were not`, `cannot`, `will not`, `would not`, `should not`, `could not`, `have not`, `has not`, `had not`, `I am`, `you are`, `we are`, `they are`, `it is`, `that is`, `there is`, `let us`

Apply the binary confidence rule.

Output map:
- `yes` → `Contractions: uses contractions`
- `no` → `Contractions: avoids contractions`
- `mixed` → `Contractions: mixed`

### 8. Paragraph length

What to measure:
- Split the corpus on double-newlines (`\n\n+`) to get paragraphs.
- For each paragraph, count sentences (split on `[.!?]<whitespace>`).
- Compute the average sentences-per-paragraph.

Require at least 3 paragraphs. Otherwise `n/a`, skip.

Decision:
- avg ≤ 2 → `short`, high confidence
- 2 < avg ≤ 4 → `medium`, high confidence
- avg ≥ 6 → `long`, high confidence
- 4 < avg < 6 → `mixed`, medium confidence

Output map:
- `short` → `Paragraph length: 1–2 sentences`
- `medium` → `Paragraph length: 3–4 sentences`
- `long` → `Paragraph length: 5+ sentences`
- `mixed` → `Paragraph length: varied`

## Output structure

The agent writes `voice/fingerprints.md` as:

```markdown
# Presentation Fingerprints

> Auto-generated from `voice/corpus/`. Exact presentation choices the user makes consistently.
> Match these in every generated response — LLMs default to training data otherwise.

- Em-dash spacing: word — word
- Oxford comma: yes
- Quote style: straight "..."
- Contractions: uses contractions
- Paragraph length: 3–4 sentences

## Manual Overrides

<!-- Override any auto-detected fingerprint here. These win over the auto-detected ones above. -->
<!-- Example: -->
<!-- - Em-dash spacing: never use em-dashes at all. -->
<!-- - Quote style: straight always. -->
```

The `## Manual Overrides` section MUST be preserved across regenerations.
