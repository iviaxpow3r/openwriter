# AI Tells Catalog

> The 60+ words, transitions, phrases, and patterns that signal "this was AI-generated."
> Use this list when analyzing a user's corpus to decide which NEVER rules to emit.

## How to use this catalog

For each item below, count how many times it appears in the user's corpus (case-insensitive, whole-word match for words; literal substring for phrases). Then apply the [authenticity hurdle](./hurdle.md):

- **If count and rate both clear the hurdle** → the user genuinely uses this. Preserve it. Do NOT emit a NEVER rule.
- **If it appears but below the hurdle** → corpus contamination (likely from AI-assisted earlier drafts). Emit a NEVER rule.
- **If it doesn't appear at all** → emit a NEVER rule (training data will push it back in unless explicitly banned).

The default state for every item here is "forbidden." It only graduates to "preserved" if the user uses it at signature frequency.

## AI Words (whole-word, case-insensitive)

Category: `word`. Authenticity hurdle: count ≥ 2 AND rate ≥ 0.15 per 1000 words.

- `delve`
- `delves`
- `pivotal`
- `tapestry`
- `realm`
- `beacon`
- `harness`
- `illuminate`
- `underscore` / `underscores`
- `bolster` / `bolsters`
- `facilitate` / `facilitates`
- `multifaceted`
- `foster` / `fosters`
- `crucial`
- `vital`
- `comprehensive`
- `robust`
- `leverage` / `leverages`
- `seamless` / `seamlessly`
- `navigate` / `navigates`
- `embark` / `embarks`
- `nestled`
- `unwavering`
- `indelible`
- `meticulous` / `meticulously`
- `transformative`
- `revolutionize` / `revolutionise`

## AI Transitions (sentence-initial unless noted)

Category: `transition`. Hurdle: count ≥ 2 AND rate ≥ 0.15 per 1000 words.

Match these only when they start a sentence (after `.`, `!`, `?`, or paragraph start). The same word mid-sentence is fine — it's the sentence-leading transitional move that signals AI.

- `Moreover,` (sentence start)
- `Furthermore,` (sentence start)
- `Notably,` (sentence start)
- `Additionally,` (sentence start)
- `Consequently,` (sentence start)
- `Ultimately,` (sentence start)
- `Therefore,` (sentence start)
- `However,` (sentence start) — note: sentence-leading "However" is the tell, not all uses
- `Indeed,` (sentence start)
- `Thus,` (sentence start)
- `Subsequently,` (sentence start)
- `Nonetheless,` (sentence start)
- `Firstly,` (sentence start)
- `In conclusion,` (anywhere)

## AI Phrases (literal substring, case-insensitive)

Category: `phrase`. Hurdle: count ≥ 2 AND rate ≥ 0.05 per 1000 words.

- `provides valuable insights` / `provide valuable insights`
- `gains valuable insights` / `gain valuable insights`
- `valuable insights`
- `a rich tapestry`
- `plays a crucial role`
- `in today's digital age` / `in today's digital era`
- `in the fast-paced world` / `in today's fast-paced world`
- `at its core`
- `that being said`
- `to put it simply`
- `it's worth noting`
- `it's important to note`
- `delve into`
- `dive into`
- `navigate the complexities` / `navigating the complexities`
- `the intricate relationship`
- `a nuanced understanding`
- `opens new avenues` / `opens up new avenues`
- `leaves an indelible mark` / `leave an indelible mark`
- `stands as a testament` / `stand as a testament`
- `paves the way` / `pave the way`
- `a stark reminder`
- `a beacon of`

## AI Punctuation

Category: `punctuation`. Hurdle: count ≥ 15 AND rate ≥ 1.5 per 1000 words. (Much higher than diction because punctuation is denser.)

- **Em-dashes (`—`)** — the single highest punctuation tell. Most human writers use them at <1 per 1000 words. AI defaults to 4-8 per 1000.

## AI Structural Patterns (no regex — pattern recognition)

These can't be matched with simple string search. Read the corpus and judge whether each pattern appears.

### Always banned (unconditional)

- **Contrastive negation** — `"It's not X, it's Y"`, `"Not just X but Y"`, `"Rather than X, Y"`, `"Less X, more Y"`. This is the single most identifiable AI-rhetoric move. Emit the NEVER rule regardless of whether the user uses it. Reason: it's so detectable that even occasional use blows the cover.

### Vote-to-ban (emit NEVER unless user clearly uses it as signature move)

For each of these, decide: does the user use this as a deliberate stylistic move (≥2 clear instances in corpus)? If yes, preserve. If no, emit a NEVER rule.

- **Tricolon abstractions** — rule-of-three lists of abstract nouns as a flourish (e.g., `"innovation, collaboration, and excellence"`, `"strength, courage, and resilience"`). Distinct from regular three-item lists about concrete things.
- **Soft repetition** — restating the same point with only minor wording changes across consecutive sentences. (Anchoring the same idea with different specifics is fine; rewording the same idea isn't.)
- **Mismatched enthusiasm** — encouragement, excitement, or affirmation beyond what the content warrants. The "wow that's so insightful!" energy that doesn't fit the actual subject.
- **Representational hedging** — telling the reader what things `"represent"`, `"underscore"`, `"reflect"`, or `"stand as a testament to"`. The interpretive overlay AI loves to add when concrete description would do.

## Adjacent never-rules (deduced from punctuation tally, not from this catalog)

After the punctuation density count, if the rate is exactly 0 ("never" category) for any of these, emit a NEVER rule for it — UNLESS it's already covered by an AI-tell label above. This handles punctuation the author simply doesn't use, regardless of whether it's an AI tell.

- `en_dash` → "No en-dashes."
- `semicolon` → "No semicolons."
- `ellipsis` (`...` or `…`) → "No ellipses."
- `bracket` (`[`) → "No square brackets."
- `double_quote_curly` (`"` `"`) → "No curly double quotes."
- `single_quote_curly` (`'` `'`) → "No curly single quotes / apostrophes."
- `exclamation` (`!`) → "No exclamation marks."

## Output format

When emitting a NEVER rule for items from this catalog, use this exact format:

- Diction (words, transitions, phrases): `NEVER "<label>".`
  - Examples: `NEVER "delve".`, `NEVER "Moreover," (sentence start).`, `NEVER "a rich tapestry".`
- Punctuation (catalog items): `NEVER "<label>".`
  - Example: `NEVER "em-dashes".`
- Punctuation (deduced): `No <nicename>.`
  - Example: `No en-dashes.`
- Structural: use the verbatim NEVER text from the pattern entry above.

This format matches what the Author's Voice plugin emits, so the rules read consistently across both tools.
