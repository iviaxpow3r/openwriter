# Voice Frames

Pre-built voice postures the agent applies as behavioral constraints while
writing in OpenWriter. Each frame is a distinct **communication posture** —
not a register or tone — with its own strategy, diction, syntax, and discourse
pattern. No API keys, no network calls, no retrieval. The agent reads a `.md`
file from `voices/` and applies the rules.

Use frames when:
- The user asks for a specific posture ("authority voice", "contrarian take", "business email", "tell the story")
- They want a voice-matched draft but don't have a custom profile
- Quick tasks where configuring anything heavier isn't worth it

## The Five Frames

### Short-form (social media, threads, posts)

**Authority** (`voices/authority.md`) — teaches from experience. Credibility via specificity. First-person experiential language, sentence distribution skewed short.

**Provocateur** (`voices/provocateur.md`) — contrarian engagement. Opens with a claim that contradicts audience beliefs. Sharp verbs, hard lines.

### Long-form (essays, blog posts, articles)

**Logical** (`voices/logical.md`) — disassembles accepted assumptions, rebuilds from first principles. Names the conventional answer then dismantles it.

**Storyteller** (`voices/storyteller.md`) — narrative-driven. Opens with a scene, not a thesis. Real names, real stakes. Lesson emerges from the story.

### Business communication

**Business** (`voices/business.md`) — high-status brevity. 12-word sentence ceiling. First sentence is the ask or decision. No filler.

## Protocol

### Step 1: Select the frame

If the user names one, use it. If not, infer:

- **Short-form** → `authority` (teaching) or `provocateur` (challenging)
- **Long-form** → `logical` (analytical) or `storyteller` (narrative)
- **Business comms** → `business`

If ambiguous, ask.

### Step 2: Load the voice file

Read the selected `voices/<frame>.md`. Internalize all 6 categories (Diction,
Syntax, Punctuation, Rhetoric, Discourse, Idiolect) as hard constraints.

### Step 3: Write

Apply every rule as a constraint. Match the sentence distribution targets.
Use the file's pre-resolved Tier 2 decisions without guessing.

### Step 4: Anti-AI pass

Run `docs/anti-ai.md` Tier 1 (hard rules) against your output:
- Em-dash density (zero for frames unless the file says otherwise)
- Contrastive formula ("It's not X, it's Y")
- Nuclear phrases ("valuable insights", "delve deeper", etc.)
- Copula inflation ("serves as", "boasts", "underscores")
- Sycophantic filler ("interestingly", "it's worth noting")
- Contraction consistency, colon density, register variation

Tier 2 checks are pre-resolved in each frame file — no profile needed.

## Voice File Schema

Every frame file follows the same format:

```
# Frame Name
Posture + when to use.

## Diction, Syntax, Punctuation, Rhetoric, Discourse, Idiolect
2-5 imperative rules per category.

## Sentence Distribution
Short/medium/long/very-long percentages.

## Tier 2 Decisions
Pre-resolved answers for anti-AI checks (varies per frame).

## Use-Case Constraints
What this voice is for and what it isn't.
```

Rules are single imperative sentences. Two agents reading the same rule should
produce similar output.
