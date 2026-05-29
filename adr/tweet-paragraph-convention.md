# Tweet paragraphs are separate nodes, healed at every ingress

## Context

X/tweet templates have two visual break types: an intra-paragraph soft
line break (single `<br>`) and a paragraph break. There were historically
two ways to represent a paragraph break in the TipTap tree:

- **Fused:** one `paragraph` node whose inline content carries a run of 2+
  `hardBreak`s between the prose chunks (the Twitter-native "double-`<br>`"
  form).
- **Separate:** one `paragraph` node per chunk (doc-mode form), with CSS
  `p + p` margin supplying the visual gap.

The system drifted into a split-brain. Different ingresses disagreed about
which form was canonical, and the disagreement only surfaced under the
sidecar/round-trip architecture (see [[pending-overlay-model]],
[[node-identity-matcher]]):

- Editor (`TweetEnterHardBreak`, 2026-03-10): double-Enter deletes the
  `<br>` and splits into a **separate** node.
- Agent write path: `mergeParagraphsToHardBreaks` produced **fused** nodes
  for tweet docs until `6d0a75e` (2026-05-27) removed it → now **separate**.
- Parser: `ad3cb49` (2026-05-27) added `splitParagraphOnDoubleBreaks` →
  **separate** on markdown-string import.
- Author's Voice + agent TipTap-JSON writes: still emitted **fused**, and
  JSON content bypasses the parser's split entirely.

A fused node entering canonical does not survive serialize→reparse: the
serializer emits `<br>`, the parser splits the run back into separate
paragraphs. That non-idempotent round-trip fails the save-time sync-check,
destabilizes the node-identity matcher (block count changes between save
and reload → id-rewrites), and corrupts the nodeId-keyed pending overlay
(decorations re-anchor to shifted nodes → phantom single-word original
highlight + duplicated/orphaned nodes). Observed live on the QT "Immigrant
parents" doc: a single-node rewrite absorbed the next paragraph's text via
double-`<br>` with no delete of the absorbed node.

## Current invariants

- **Canonical form is separate `paragraph` nodes for every doc type**,
  including X templates. One node = one review unit = one fingerprint =
  one pending decoration.
- **Single `<br>` is preserved.** A lone `hardBreak` is a legitimate
  intra-paragraph soft line break (tweet line break, poem line). Only runs
  of **2+** consecutive `hardBreak`s are paragraph breaks to be split.
- **The split is enforced at every node-creating ingress**, not just one:
  - markdown-string parse → `splitParagraphOnDoubleBreaks` (per paragraph,
    inside `tokensToTiptap`).
  - structured/TipTap-JSON agent writes → `splitFusedParagraphs` in
    `write_to_pad` (per change) and `populate_document` (on `doc.content`).
  - editor typing → `TweetEnterHardBreak` keymap already produces separate
    nodes.
- `splitFusedParagraphs` is **idempotent**: already-split content is
  returned unchanged, original node attrs/id preserved when no fusion is
  present; on a fused node, the first chunk inherits the original attrs/id
  and the rest get fresh ids.
- The visual/editing experience is unchanged: single Enter still renders a
  tight `<br>` line break; double Enter still yields a paragraph gap (now
  via separate nodes + CSS, which looks identical).

## Open / not-yet-closed

- **Author's Voice client ingress.** Right-click rewrites apply
  `responseNodes` (TipTap JSON from the v1 backend) directly in the browser
  via `applyNodeChangesFromBridge`, bypassing the server heal above. If v1
  ever returns a single response node containing a 2+ `hardBreak` run, it
  would still inject a fused node. v1 is the only proven model and must not
  be broken — see [[authors-voice-backend]]. Tracking as a separate ingress
  to close client-side (idempotent split on `responseNodes`).

## Decision log

- **2026-05-28** — Chose "separate nodes everywhere" over "fused tweet
  node." Rationale: it is where the editor, parser, and (post-`6d0a75e`)
  write path already sit; it preserves per-paragraph review and matcher
  stability; and it requires **no** change to Author's Voice (whose apply
  path already emits separate blocks), whereas the fused direction would
  force new merging logic onto the only-proven v1 output. Added
  `splitFusedParagraphs` (markdown-parse.ts) and wired it into
  `write_to_pad` + `populate_document` to close the JSON-ingress hole that
  corrupted the QT "Immigrant parents" doc. Editor keymap, parser heal, and
  serializer left unchanged.
