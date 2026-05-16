# Node Mapping Test Harness

Proof-of-concept for the node-identity architecture described in `docs/node-identity.md`.

**Goal:** prove that a markdown doc's blocks can be tracked across edits using only intrinsic properties (sentence-level char counts, word sequences at start/end, punctuation patterns, structural context) — no inline markers, no body annotations.

## Run

From `packages/openwriter`:

```bash
node scripts/test-node-mapping/runner.mjs
```

The runner loads each test case in `corpus/`, runs the matcher, and reports what mapped, what's unmatched, and what's orphaned. Any non-empty `unmatched` is a missing rule we need to add to the matcher.

## Layout

- `walker.mjs` — parses markdown to a flat ordered list of blocks with parent/child links
- `fingerprint.mjs` — computes the per-block signal vector (char counts, sentence vectors, word sequences, structure, context)
- `matcher.mjs` — Phase 1 exact-anchor pinning, plus mutation rules as they're discovered
- `runner.mjs` — loads corpus pairs, runs the matcher, prints reports
- `corpus/` — staged test docs and their mutations
- `results/` — output reports

## Process

1. Run the harness.
2. Look at the unmatched set per test case.
3. Decide what mutation explains each unmatched block.
4. Codify the mutation rule in `matcher.mjs`.
5. Re-run. The unmatched set should shrink.
6. Iterate until the unmatched set is empty for every test case in the stage.
7. Add the next stage of complexity. Repeat.
