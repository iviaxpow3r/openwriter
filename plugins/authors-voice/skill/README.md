# authors-voice

> **AI writing that sounds like you, not AI.**

Most attempts to make AI sound like you start the same way. Train it. Fine-tune it. Feed it your samples and tell it to imitate. The model doesn't actually learn you from any of this. It pattern-matches at the lexical layer, lifting your common words and sentence shapes without ever building a deep representation of how you think. Cold-start imitation tops out shallow.

Flip the direction. The model already carries deep internal representations of widely-published authors it was trained on at scale, voices it can channel with real fidelity because it saw thousands of pages of each. The move is to identify which of those authors a user statistically resembles, assign proportional weights to the closest matches, and instruct the model to write as that weighted blend. Your voice gets reconstructed as a coordinate inside the model's existing author space, anchored to authors it has already mastered.

That changes the problem. The model isn't being asked to learn anything new about you. It's being asked to mix voices it knows cold, in proportions that triangulate your position among them. The anchor does the heavy lifting before a single sample of yours enters the prompt. The blend is the voice.

The result is AI writing that sounds like you. Not AI imitating you.

On top of the anchor, four layers sharpen the output. A list of AI words and constructions the model must never use, because the moment it stops channeling the anchor it reverts to its trained register and reaches for the same fifty tells. Presentation choices you make consistently, like whether you capitalize after a colon or use the Oxford comma, small mechanical preferences that read as authentic. A sentence-length and punctuation rhythm pulled from your own writing, so the cadence matches even when the diction is on loan. A growing folder of your samples that the skill mines as the negative rules and rhythm get re-derived.

Each sample you add updates the NEVER rules and the sentence rhythm against your latest corpus. The anchor and presentation fingerprints don't auto-refresh. Regenerate those when you've added enough new writing to shift the matches, or when you want a fresh pass. The profile gets sharper the more you write and the more often you ask for a refresh.

Roughly 80% of the way to your real voice. A hard jump above what stock prompting and fine-tuning produce.

## Install

The skill is **agent-agnostic**. Pure markdown, no language runtime. Any LLM-based agent that can read `SKILL.md` and follow instructions can use it.

### Claude Code

```bash
claude install github:travsteward/authors-voice
```

Clones to `~/.claude/skills/authors-voice/` and registers the skill with Claude Code.

### Vercel skills CLI (Claude Code, Codex, Cursor, and other agents)

```bash
npx skills add travsteward/authors-voice
```

### Manual (any agent)

```bash
git clone https://github.com/travsteward/authors-voice
```

Then drop the cloned folder wherever your agent loads skills from. The `SKILL.md` at the root has the trigger phrases and routing logic the agent reads.

## Quick Start

Two paths. Pick one.

**Path A: Web tool first (fastest first-run)**
1. Visit [openwriter.io/voice-match](https://openwriter.io/voice-match), paste 300 to 800 words of your writing, copy the result block.
2. Tell your agent: *"set up my voice match"*. Paste the block when prompted.
3. **Seed your corpus**: paste 2 to 5 paragraphs that feel most like you. The agent saves them under `voice/corpus/`.
4. Done.

**Path B: Skill mode (no web round-trip)**
1. Tell your agent: *"set up my voice match"* and *"I want to skip the web tool."*
2. Paste 2 to 5 paragraphs of your writing. The agent saves them under `voice/corpus/`.
3. The agent runs the Anchor Protocol over your corpus and writes `voice/anchor.md` directly.
4. Done.

The skill is self-routing. You don't memorize subcommands. Just tell the agent what you want:

- *"voice status"* → reports your current tier and word count
- *"add this essay to my voice profile"* → appends, re-analyzes
- *"write me a tweet about X"* → uses your voice automatically

## How It Works

Your voice profile lives in `voice/` as a handful of `.md` files the agent reads at write time:

| File | Source | Purpose |
|------|--------|---------|
| `anchor.md` | One-time match from [openwriter.io/voice-match](https://openwriter.io/voice-match) (or skill-mode). Refresh on demand. | 3 to 5 training-data authors with weights |
| `stats.md` | Auto-regenerated from corpus on every analysis run | Sentence distribution + punctuation density |
| `never-rules.md` | Auto-regenerated from corpus on every analysis run. Manual additions preserved. | AI words and phrases the model must never use |
| `fingerprints.md` | Agent extracts from corpus during analysis runs. Manual overrides preserved. | Presentation choices (Oxford comma, capitalization after colon, contraction frequency) |
| `coined-terms.md` | You curate | Your repeated coinages |
| `examples.md` | You curate | Reference paragraphs in your voice |
| `status.md` | Auto-regenerated on every analysis run | Current tier and what's locked next |

Plus `voice/corpus/`. Your raw samples accumulating over time. None of `voice/*` is committed. It's all local to your disk.

What updates reliably on every sample add: NEVER rules, sentence stats, status. What gets re-derived in protocol but agents sometimes skip: fingerprints (ask for a rebuild if you want certainty). What needs an explicit ask: anchor weights ("regenerate my anchor"). The corpus folder is yours to grow.

## Progressive Tiers

The more samples you add, the more confident the analysis.

| Words | Tier | Active |
|-------|------|--------|
| under 300 | 0 | seed corpus first |
| 300 to 1k | 1 | anchor and basic stats |
| 1k to 5k | 2 | preliminary NEVER rules and top fingerprints unlock |
| 5k to 20k | 3 | full NEVER coverage and all fingerprints unlock |
| 20k and up | 4 | high-confidence profile |

## Privacy

- Your voice data lives entirely on your disk. `.gitignore` excludes everything in `voice/` from the public repo.
- The skill never uploads your corpus anywhere.
- The only thing that leaves your machine is the initial 300 to 800 word paste into openwriter.io/voice-match for the anchor matching step. That's cached 24h by hash and never trained on.

## Requirements

- A Claude Code or compatible agent that supports skills (no Node.js dependency)
- An initial visit to [openwriter.io/voice-match](https://openwriter.io/voice-match) for the anchor (free, no signup), or use skill-mode to build it locally

## Beyond the skill

Pairs naturally with [OpenWriter](https://openwriter.io), the free AI writing surface. Same anchor system also powers the paid Author's Voice plugin (inline voice edits inside OpenWriter) and the paid API (programmatic voice-matched output for workflows and apps). See [authors-voice.com](https://authors-voice.com) when you outgrow the skill alone.

## License

MIT. See [LICENSE](./LICENSE).

## Replaces

This skill replaces the older `writers-voice` skill and the legacy `voice-apply`, `voice-generate`, `voice-setup`, `voice-upload`, `voice-manage`, and `voice-automate` skills. They are now one trigger: `/authors-voice`.

## History

The local-skill half of `/authors-voice` started life as the standalone `writers-voice` skill. Its full development history (every iteration of the anchor protocol, NEVER rules, fingerprints, and tier logic) lives in the archived `travsteward/writers-voice` repo's git log. The repo is private now, but the commit log is preserved as the record of how the constructed-voice architecture evolved before it was unified here.

## Credits

Built on the negative-first voice profiling architecture from [Author's Voice](https://authors-voice.com). Pairs with [OpenWriter](https://openwriter.io), the writing surface for AI agents.
