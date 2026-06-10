# Tier Reference

Determined by total word count in `voice/corpus/`. Each tier unlocks additional voice-profile features. Computed during Analysis Protocol.

| Tier | Words | Name | Unlocked | Locked |
| --- | --- | --- | --- | --- |
| 0 | <300 | Empty | (none) | anchor blend, basic stats, NEVER rules, fingerprints |
| 1 | 300-999 | Anchor | anchor blend, basic stats | preliminary NEVER rules, fingerprints |
| 2 | 1000-4999 | Preliminary | anchor blend, basic stats, preliminary NEVER rules, top fingerprints | full NEVER coverage, all fingerprints |
| 3 | 5000-19999 | Full Coverage | anchor blend, stats, full NEVER rules, full fingerprints | high-confidence em-dash hurdle |
| 4 | ≥20000 | AV-Grade | anchor blend, stats, full NEVER rules, full fingerprints, em-dash hurdle cleared | (none) |

The tier is reported to the user after every Analysis Protocol run, with a "what unlocks next" pointer.
