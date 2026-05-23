---
name: book-writer
description: |
  Orchestration skill for book-scale long-form writing (fiction or
  nonfiction). Owns the SHAPE of a book project — chapter architecture,
  beats methodology, workspace management, book mode, scene/science
  split, vignette library, long-form orchestration. Delegates VOICE
  (prose generation) to /authors-voice via the Apply Protocol minion
  dispatch. Loads as governing context at session start when a book
  project is detected, OR via explicit invocation.

  Use when: "/book-writer", "/book", "write a book", "book project",
  "chapter beats", "chapter architecture", "beat map", "TOC", "table
  of contents", "book outline", "book reshape", "draft a chapter",
  "long-form", "multi-chapter", "book mode", "book workspace", any work
  involving multi-chapter book structure.

  NOT for: single-chapter essays, blog posts, tweets — those go to
  /authors-voice directly. Voice-only setup (anchor blend, NEVER rules,
  fingerprints, corpus analysis) lives in /authors-voice.
metadata:
  author: travsteward
  version: "0.2.2"
license: MIT
---

# Book Writer

Book-scale orchestration skill. Pairs with `/authors-voice` (voice pipeline). Together: this skill specifies WHAT must land in each beat; `/authors-voice` specifies HOW the prose sounds.

## FIRM RULES

### 1. Book orchestration loads BEFORE per-chapter work.

The book-class question, chapter architecture, and workspace management must commit before any per-chapter beat work begins. Per-chapter beats without committed chapter containers land in arbitrary places, spill across boundaries, and produce a book the reader can't carry.

If the user asks for chapter-level work and the book hasn't run through architecture: **STOP** and run architecture first. Architecture passes are cheap; beat work in wrong containers is expensive.

### 2. Prose generation always delegates to /authors-voice.

This skill owns SHAPE — chapter containers, beats, workspace organization, vignette slots, the TASK brief. `/authors-voice` owns VOICE — anchor blend, NEVER rules, fingerprints, minion dispatch, post-write audit. When a chapter draft or any prose pour is needed, this skill's job ends at "the brief is locked"; the prose call goes through `/authors-voice`'s Apply Protocol with the brief as the TASK.

**If this skill catches itself drafting prose: STOP and spawn a authors-voice minion** — even for one sentence, one transition, one closer. Same Rule 1 as authors-voice, applied at the orchestration layer.

Two carve-outs (mirroring authors-voice):
- **Beat structure text** (declarative claim names, commitment paragraphs, chapter briefs, vignette slot descriptions) is editor territory — these are commitments, not prose.
- **Doc metadata** (frontmatter, structural flags, reshape history entries, source provenance notes, TODO lists) is editor territory.

### 3. Workspace management is enforced at creation, not retrofitted.

Every doc created during book work goes into its lifecycle-correct container at creation time. Per `docs/workspace-management.md` (v2 chapter-first lock 2026-05-20):
- **Book Spine** (top-level) — architectural docs (Thesis, TOC, Argument Arc, Voice & Form, etc.)
- **Working Notes** (top-level) — scratch, pilot tests, ephemera
- **Ch N — <Title>** (one container per chapter) — holds the chapter's Beats doc + Research Notes doc + a Drafts sub-container
- **Drafts** (sub-container under each chapter) — one per-beat prose doc (`Ch N — Bk: <Name>`)

**Ascending-order convention:** sidebar containers and ordered doc lists go ascending top-to-bottom (Ch 1 at top, Ch N at bottom; B1 at top, BN at bottom). Fix sidebar order in the same pass as any insert/reorder.

Creating in the wrong container, skipping the container parameter, or leaving newest-first ordering produces sidebar mess that takes a full pass to clean up.

### 4. Catalogue citations in `Ch N — Research Notes` as you find them.

Every chapter has a Research Notes doc alongside Beats. Sources land there the moment you find them — academic citations, URLs, supporting data, key quotes. Beats docs reference Research Notes by docId; never inline citations. Catalogue during build, not at the end.

### 5. Every doc-to-doc reference is declared via `link_to` at create/edit time.

When any workspace doc draws from another workspace doc, call `link_to(source_doc_id, target_doc_id)` at the moment the connection is made. Writes the target into the source's `references:` frontmatter — metadata only, no prose mutation. Idempotent. The target's inbound list (backlinks) is computed live by scanning every doc's references, so the target picks the connection up without any work on its end.

Applies to:
- **Every beat-prose draft** → links to its Beats doc + Research Notes + any Concept doc whose content it draws on.
- **Every Beats doc** → links to its Research Notes + every Concept doc it references + sibling chapter Beats it does callbacks to.
- **Every Research Notes doc** → links to every Concept doc it cites in the source list.
- **Any later edit that pulls in a new Concept doc** → link in the same pass as the edit lands.

**External references** (papers, DOIs, web URLs) stay inline markdown `[Author Year, Journal](URL)` in Research Notes. They don't need `link_to` — backlinks are an internal-workspace primitive.

If the editor skips `link_to` as the workspace fills in, the graph drifts. Downstream context-recovery crawls (`get_graph`) miss load-bearing connections, and the agent loses the ability to walk from a chapter back to its concept sources or its sibling chapter beats.

## The book-class question (run FIRST, every book project)

Before any chapter work, answer two questions:

### Question 1 — Fiction or nonfiction?

| Signal | Class |
|---|---|
| Narrative, scene-structured, character-driven | Fiction |
| Argument, mechanism, evidence, source-material-driven | Nonfiction |
| Memoir / personal essay collection | Nonfiction (treat as domain-driven, the domains are life-themes) |
| Hybrid (Sebastian Junger, John McPhee — narrative nonfiction) | Nonfiction with fiction-style scene structure inside chapters |

### Question 2 — Nonfiction only: argument-driven or domain-driven?

Detail in `docs/chapter-architecture.md` (the book-class question section runs the full decision logic). Quick form:

| Signal | Class |
|---|---|
| Author has one extended argument to make; no rich knowledge graph yet | Argument-driven |
| Author has concept docs / research notes / prior drafts / a domain library | Domain-driven |
| Prescriptive transformation popular science | Domain-driven default |
| One big idea unpacked | Argument-driven |
| "Complete picture of X domain" | Domain-driven |

**Fiction handling:** this skill currently ships nonfiction methodology (beats as declarative-claim commitments, 4-act chapter pattern, vignette library). Fiction beat methodology (scene structure, Save the Cat / McKee 22 Steps / story-spine patterns) will live in `docs/beats-fiction.md` and `docs/scene-structure-fiction.md` once added. Current version is nonfiction-only by default.

## Architecture

```
book-writer/
├── SKILL.md                       (this file — router + firm rules + book-class question)
└── docs/                          (loaded on routing match)
    ├── chapter-architecture.md    (chunk-to-container commit; substantive-name rule; 2 pipelines)
    ├── beats.md                   (per-chapter beat methodology; nonfiction default — declarative claims)
    ├── long-form-orchestration.md (book-scale workflow pipeline; multi-minion patterns)
    ├── book-mode.md               (per-session book-writing workflow + openwriter integration)
    ├── workspace-management.md    (container hierarchy + doc naming + rename discipline)
    └── shape-table.md             (canonical project dashboard — chapters × beats × drafts × % done)
```

These docs are canonical in this skill. The `/authors-voice` skill may reference them during the transition period — when in doubt, the copy here is authoritative.

## Routing

| User intent | Action |
|---|---|
| "/book-writer" / "/book" / "start a book project" | Run **Book-Class Question** → **Workspace Setup** (`docs/workspace-management.md`) → **Chapter Architecture** (`docs/chapter-architecture.md`) → **Per-Chapter Beat Work** (`docs/beats.md`) |
| "chapter architecture" / "TOC" / "chapter list" / "book outline" | `docs/chapter-architecture.md` |
| "chapter beats" / "beat map" / "beat draft" / "beat sheet" | `docs/beats.md` |
| "workspace organize" / "where does X go" / "container structure" / "rename chapter" | `docs/workspace-management.md` |
| "shape table" / "project shape" / "where are we" / "% done" / "book status" / "progress" / "dashboard" | `docs/shape-table.md` |
| "book mode" / "session workflow" / "openwriter book setup" | `docs/book-mode.md` |
| Book-scale orchestration / multi-minion patterns | `docs/long-form-orchestration.md` |
| "draft this chapter" / "write the beat as prose" / any PROSE work | **Delegate to /authors-voice Apply Protocol.** This skill's job ends at the locked brief. |

## Delegation to /authors-voice

For any prose generation (chapter draft, beat-as-prose translation, transition pour, vignette draft, opener, closer, bridge):

1. **This skill produces:**
   - Locked beat structure (declarative claims per `docs/beats.md`)
   - TASK brief (outcome-shape commitments per `docs/beats.md` — NOT content prescription)
   - Chapter-context summary (where the beat sits in the chapter; what came before; what comes after)
   - Voice-anchor selection (if a book-specific anchor exists in `voice/anchor-<book>.md`, name it; otherwise default `voice/anchor.md`)
   - Length target
2. **Delegate:** call /authors-voice Apply Protocol with the assembled brief as the TASK
3. **/authors-voice produces:** voice-matched prose via Opus minion, NEVER-patched, post-write-audited, integrated into the openwriter doc
4. **This skill receives** the integrated prose and:
   - Runs cross-section coherence review if multi-section
   - Updates chapter-level doc structure (move to Chapter Drafts container if it landed elsewhere)
   - Updates beat doc to mark which beats have been drafted
   - Captures any author feedback as agent marks for next-pass refinement

The two skills compose cleanly: book-writer specifies WHAT must land; authors-voice specifies HOW the prose sounds. Neither does the other's job.

## Workflow phases for a new book project

1. **Book-Class Question** — fiction or nonfiction; argument or domain (nonfiction)
2. **Workspace Setup** — create workspace + project-level containers (Book Spine, Working Notes) + per-chapter containers as chapters lock (each chapter container holds Beats doc + Research Notes + Drafts sub-container) per `docs/workspace-management.md` v2 chapter-first scheme
3. **Architectural Docs in Book Spine** — Thesis, Audience & Reader Journey, Voice & Form, Source Material inventory, Argument Arc (or Global Beat Sheet for argument-driven; Domain Identification for domain-driven), Concept Dump, Open Questions, Decisions Log
4. **Chapter Architecture** — 5-pass commit (argument-driven) or 7-phase pipeline (domain-driven). Output: committed TOC with substantive chapter names per the convention
5. **Per-Chapter Beat Draft** — for each chapter, run beats methodology. Output: locked beat structure per chapter (declarative claims)
6. **Pilot Chapter** — pick densest chapter; run full draft loop via /authors-voice delegation. Validates the 4-act pattern and beat-as-commitment shape
7. **Parallel Chapter Drafts** — after pilot validates, remaining chapters draft in parallel via /authors-voice
8. **Cross-chapter coherence** — blinder audit, transitions, redundancy elimination
9. **Polish + /anti-ai pass** — global fingerprint scrub (via authors-voice + /anti-ai)

Each phase commits before the next begins. Returns to earlier phases when needed (e.g., chapter beats consistently feel "too much" or "too thin" → return to chapter architecture).

## Companion skills

- **/authors-voice** — voice pipeline (anchor + minion + post-write audit + analysis + tiers). REQUIRED for any prose generation. This skill cannot draft prose without it.
- **/anti-ai** — final AI-tells fingerprint scrub. Recommended for book-class work after each chapter polish pass.
- **openwriter** — the workspace/document MCP. REQUIRED for the workspace management this skill governs (create_document with container parameter, move_item, rename_item, etc.).

## When to skip this skill

- Single-chapter essays, blog posts, tweets, threads — go directly to /authors-voice
- Pure analysis or research with no draft target — go directly to /authors-voice or use research-only tools
- Voice-only setup (building anchor blend, adding corpus samples, regenerating voice profile) — /authors-voice
- One-off scenes or vignettes outside a book context — /authors-voice
