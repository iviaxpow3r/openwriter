# Voice Profile

This directory is your **voice profile**. Files in here are read by the agent at write time and applied as style constraints. The skill builds these up progressively over time.

## What goes here

| File | Purpose | Source |
|------|---------|--------|
| `anchor.md` | Anchor blend (3-5 training-data authors with weights) | Pasted from openwriter.io/writers-voice OR generated in-agent by the skill |
| `anchor-<context>.md` | OPTIONAL per-register anchors (e.g., `anchor-book.md`, `anchor-tweets.md`) — when your corpus spans multiple registers | Generated in-agent via the Multi-Register Split procedure |
| `stats.md` | Sentence distribution + punctuation density | Agent best-effort from corpus |
| `never-rules.md` | NEVER rules (kill-list) | Agent + manual additions |
| `fingerprints.md` | Exact presentation choices (Oxford comma, etc.) | Agent + manual overrides |
| `examples.md` | Curated reference paragraphs | Manually picked by the user |
| `status.md` | Current tier + what's locked | Agent-generated |
| `corpus/` | Raw samples accumulating over time | Manually added (drop files here) |

## Multi-Register Anchors

If your corpus contains writing in multiple registers — third-person expository AND second-person instructional, or analytical essays AND aphoristic tweets — a single blended anchor will pull toward whichever register has the most volume in your corpus, leaving the others under-weighted.

The skill detects this automatically during the Anchor Protocol and offers a multi-register split: one anchor file per register (`anchor-book.md`, `anchor-tweets.md`, etc.). At write-time, the agent picks the right anchor based on what you're writing.

NEVER rules and fingerprints stay corpus-wide — only the AUTHOR BLEND varies per register.

To generate per-register anchors, ask: *"Split my anchor by register."* See the **Multi-Register Anchors** section in `SKILL.md` for the full procedure.

## How it grows

The more samples you accumulate in `corpus/`, the richer the analysis. Tiers:

- **300-1k words**: anchor blend + basic stats
- **1k-5k words**: + preliminary NEVER rules + top fingerprints
- **5k-20k words**: + full NEVER coverage + all fingerprints
- **20k+ words**: AV-grade (high-confidence profile)

## Re-running analysis

After adding samples to `corpus/`, tell the agent:

> "Re-analyze my voice profile."

The agent reads `catalog/*.md` and the corpus, then regenerates `stats.md`, `never-rules.md`, `fingerprints.md`, and `status.md`. No Node script — pure markdown skill, the agent is the extractor.

## Manual edits

`never-rules.md` and `fingerprints.md` have a `## Manual Additions` / `## Manual Overrides` section at the bottom. The agent preserves anything you put there across regenerations.

## Privacy

This is your voice profile. The files live on your disk. The skill never uploads anything — analysis is local (agent reasoning over local files). The only thing that leaves your machine is if you use the web tool at openwriter.io/writers-voice for the anchor step (300-800 words pasted in, used once, cached 24h, never trained on). If you use skill mode instead, even the anchor is generated locally.
