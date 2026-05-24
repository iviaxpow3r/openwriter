---
name: openwriter
description: |
  OpenWriter — the writing surface for AI agents. A markdown-native rich text
  editor where agents write via MCP tools and users accept or reject changes
  in-browser. 40 core MCP tools for document editing, multi-doc workspaces,
  and organization, plus 21 publish platform tools for newsletter, social
  posting, and scheduling. Tweet compose mode for drafting replies/QTs with
  pixel-accurate X/Twitter UI. Plain .md files on disk — no database, no lock-in.

  Use when user says: "open writer", "openwriter", "write in openwriter",
  "edit my document", "review my writing", "check the pad", "write me a doc",
  "compose tweet", "reply to tweet", "quote tweet", "author's voice",
  "authors voice", "voice plugin".

  Requires: OpenWriter MCP server configured. Browser UI at localhost:5050.
metadata:
  author: travsteward
  version: "0.12.0"
  repository: https://github.com/travsteward/openwriter
license: MIT
---

# OpenWriter Skill

You are a writing collaborator. You read documents and make edits **exclusively via MCP tools**. Edits appear as pending decorations (colored highlights) in the user's browser that they accept or reject.

## FIRM RULES

1. **ALWAYS write content in the editor, never in the terminal.** OpenWriter is a collaborative writing surface. All content — drafts, rewrites, brainstorms, outlines — goes on the pad via `write_to_pad` or `populate_document`. Dumping content into the chat/terminal is bad UX: it's hard to read, ugly, and the user can't accept/reject or iterate on it. If you're generating text the user will read, it goes in the editor.
2. **The terminal is for discussion only.** Use chat messages to explain your edits, ask questions, discuss direction, or summarize what you changed. Never use it as the writing surface.
3. **Name every document.** When you encounter a generically named doc ("Quote Tweet", "Article", "Untitled", etc.), rename it based on its content before proceeding. Titles are the human scanning layer — a sidebar full of "Quote Tweet" is useless. Use `rename_item` with the docId. Short, descriptive titles: "Venezuela Proxy States QT", "Feature Blindness Article".
4. **Metadata first.** When the user asks you to work on a document, call `get_metadata` immediately after `read_pad`. Tweet docs store the parent URL in `tweetContext.url`, article docs store context in `articleContext`. **Never search externally for a tweet URL that's already in the document metadata.** This prevents wasting paid API calls on information you already have.
5. **Dispatch the enrichment minion when openwriter says so.** OpenWriter surfaces stale enrichment two ways: (a) `ENRICHMENT_STATUS: ...` in the MCP server's session-start instructions; (b) a `⚠ N docs need enrichment. Dispatch:` footer on `list_documents`, `list_workspaces`, and `get_workspace_structure` responses. Both signals include the **complete dispatch call inline** — copy it verbatim and fire the Agent tool with those exact field values. When you see either signal, dispatch the minion immediately, before responding to the user's request. The minion is orchestrator-mode by default: it calls `list_dirty_docs` itself, self-bounds the batch, reads each doc, writes a logline, calls `mark_enriched` once with the whole batch, and returns a short summary. **v0.19.0 schema:** the minion writes ONE field — `logline`. The agent owns `status` (`canonical` / `draft`); the system owns `enrichmentStale`. The legacy fields `domain`, `concepts`, and `docRole` were dropped. The `prompt` field in the dispatch line is a placeholder — the minion ignores its content because its full procedure lives in its system prompt at `~/.claude/agents/openwriter-enrichment-minion.md`.

   **Surfacing to the user:** treat enrichment like the inbox — a maintenance reflex, not a feature they have to ask for. Phrasing depends on context:

   - **First time in a session, small batch (N ≤ 5):** silent dispatch + one-line aside in your response: "Enriched 3 docs in the background. Now, ..."
   - **First time in a session, medium batch (5 < N ≤ 20):** brief explanation on first surface: "OpenWriter just refreshed loglines on 12 docs in the background. Now, ..." Sets expectations once; subsequent runs can stay silent.
   - **First time in a session, large batch (N > 20):** give the user a heads-up BEFORE dispatching: "OpenWriter detected 47 docs that haven't been summarized yet — first-time setup. Refreshing them in the background; this'll take ~30 seconds and a few cents of Haiku usage." Then dispatch and report when done.
   - **Very large batch (N > 30):** one minion can't get through that many in reasonable wall time. Switch to **chunked parallel dispatch** — multiple minions, each given an explicit docId list, all dispatched in a single message with `run_in_background: true`. Full procedure (chunking strategy, explicit-list prompt format, failure modes) lives in this skill's `docs/enrichment.md`. Read that doc before dispatching anything over 30 docs.

   **If the subagent isn't installed** (older openwriter, or the user skipped install-skill): the Agent call returns `Agent type 'openwriter-enrichment-minion' not found`. Tell the user once: "OpenWriter has stale docs but the enrichment minion isn't installed yet — run `npx openwriter install-skill` and restart Claude Code." Then proceed with their original request without enriching; don't loop on the failure.

   **If the user opts out** ("stop nagging me about enrichment for X workspace"): call `update_workspace_context` with `enrichmentDisabled: true` for that workspace. The footer + ENRICHMENT_STATUS will drop those docs from their counts immediately.
6. **Emit deep links whenever you cite a docId.** Any time you reference a specific document in chat — naming it, summarizing it, pointing the user at a beat or paragraph inside it — call `get_doc_link` and render the result using this exact presentation pattern:

   **Doc level** (one link, header bold):
   ```
   **Doc level:**
   [open Title](url)
   ```

   **Node level** (header + bulleted list, each bullet is one cited block):
   ```
   **Node level (scrolls + flashes the specific beat):**
   - [B1 — Label](url#node=nodeId)
   - [B11 — Label](url#node=nodeId)
   ```

   Use the doc title as the link label for doc-level links. Use the beat label or a short description of the block for node-level bullets — never just "node" or a raw ID. When citing multiple nodes from the same doc, group them under one **Node level** header. When citing nodes across multiple docs, use a separate block per doc. The cost is one `get_doc_link` call per cited doc; the payoff is the user goes from "where is that?" to "right there" in one click.

## Setup — Which Path?

Check whether the `openwriter` MCP tools are available (e.g. `read_pad`, `write_to_pad`). This determines setup state:

### MCP tools ARE available (ready to use)

The user already has OpenWriter configured. You're good to go.

**First action:** Share the browser URL:
> OpenWriter is at **http://localhost:5050** — open it in your browser to see and review changes.

**Onboarding (first use only):** Call `list_documents`. If the workspace is empty (zero documents), create a welcome doc to orient the user:

1. Read the welcome template from this skill's `docs/welcome.md`
2. `create_document` with title "Welcome to OpenWriter"
3. `populate_document` with the template content (arrives as pending changes — green highlights)
4. Tell the user: "I've created a welcome doc in your browser. Check it out — the green highlights are my changes. Use the review panel to accept or reject them."

This teaches the user the core workflow (pending changes, review panel) by experiencing it. After the first run, docs exist and this step is skipped forever.

Skip to [Writing Strategy](#writing-strategy) below.

### MCP tools are NOT available (needs setup)

The user hasn't set up the MCP server yet. See `docs/setup.md` for install commands and platform-specific config (Claude Code, OpenCode, etc.).

After setup, tell the user:
1. Restart your Claude Code or OpenCode session (MCP servers load on startup)
2. Open http://localhost:5050 in your browser

## Document Identity: Titles vs DocIds

Every document has an immutable **docId** (8-char hex, e.g. `a1b2c3d4`) in its YAML frontmatter. Titles are for human communication and agent reasoning. DocIds are for agent action.

- `list_documents` and `read_pad` always show both title and docId
- All doc-targeting tools take `docId` as their parameter (not filename, not frontmatter read from disk)
- Two documents can have the same title — the docId disambiguates
- Filenames contain UUIDs unrelated to docIds — the first segment of a filename UUID looks like a docId but is not

**MCP params:** `metadata`, `changes`, `content` are objects — never stringify them.

## MCP Tools Reference (40 core + 21 publish platform)

### Document Operations

| Tool | Key Params | Description |
|------|-----------|-------------|
| `read_pad` | — | Read the current document (compact tagged-line format with `id:` in header) |
| `write_to_pad` | `docId`, `changes` | Apply edits as pending decorations (rewrite, insert, delete) |
| `populate_document` | `docId?`, `content` | Populate an empty doc with content (two-step creation flow) |
| `get_pad_status` | — | Lightweight poll: word count, pending changes, userSignaledReview |
| `get_nodes` | `nodeIds` | Fetch specific nodes by ID |
| `get_metadata` | — | Get frontmatter metadata for the active document |
| `set_metadata` | `metadata` | Update frontmatter metadata (merge, set key to null to remove) |

### Document Lifecycle

| Tool | Key Params | Description |
|------|-----------|-------------|
| `list_documents` | — | List all documents with title, docId, word count, active status |
| `switch_document` | `docId` | Change the user's view to a different document. **Rarely needed** — every tool targets docs by docId directly, so reads, writes, and creations never require switching. Use ONLY when you want to pull the user's attention to a specific doc (e.g. "I've loaded this up for your review"). The user may be perusing other docs — don't yank their view as part of normal work. |
| `create_document` | `content_type`, `title?`, ... | Create a new document. `content_type` is required: "document", "tweet", "reply", "quote", "article", "linkedin", "newsletter", or "blog" |
| `open_file` | `path` | Open an existing .md file from any location on disk |
| `delete_document` | `docId` | Delete a document file (moves to OS trash, recoverable) |
| `archive_document` | `docId` | Archive a document (hides from sidebar, keeps on disk) |
| `unarchive_document` | `docId` | Restore an archived document back to the sidebar |

### Import

| Tool | Description |
|------|-------------|
| `import_gdoc` | Import structured Google Doc JSON (auto-splits multi-chapter docs) |

### Workspace Management

| Tool | Description |
|------|-------------|
| `list_workspaces` | List all workspaces with title and doc count |
| `create_workspace` | Create a new workspace |
| `delete_workspace` | Delete a workspace and all its document files (moves to OS trash) |
| `get_workspace_structure` | Get full workspace tree: containers, docs, per-doc enrichment (logline, status, STALE marker), workspace-level vocab/schema, plus context (characters, settings, rules) |
| `get_item_context` | Get progressive disclosure context for a doc — workspace context + the doc's own enrichment (logline, status, enrichmentStale) |
| `update_workspace_context` | Update workspace context (characters, settings, rules) |

### Workspace Organization

| Tool | Description |
|------|-------------|
| `create_container` | Create a folder inside a workspace (max depth: 3) |
| `delete_container` | Delete a container from a workspace (doc files stay on disk) |
| `tag_doc` | Add a tag to a document by docId (stored in doc frontmatter) |
| `untag_doc` | Remove a tag from a document by docId |
| `move_item` | Move or reorder a doc, container, or workspace (type: doc/container/workspace) |
| `rename_item` | Rename a workspace, container, or document (type: workspace/container/document) |

### Enrichment (three-field schema — v0.19.0)

OpenWriter detects when a doc has drifted past enrichment thresholds (sentence-hash Jaccard drift, character-count volume ratio) on every save and stamps `enrichmentStale: true`. The agent's job is to dispatch the enrichment minion (see firm rule 5 + `docs/enrichment.md` in this skill) to refresh the logline.

**The three-field schema** — each field has exactly one owner:

| Field | Owner | Set how |
|-------|-------|---------|
| `logline` | LLM (minion) | `mark_enriched({ docs: [{ docId, logline }] })` |
| `status` (`canonical` / `draft`) | Agent | `create_document({ status })` on create; `set_metadata({ status })` on lifecycle change |
| `enrichmentStale` | System | OpenWriter sets on save; minion clears on `mark_enriched` |

**Lifecycle convention for `status`:**
- Default to `draft` on new docs (omit `status` from `create_document` and it lands as `draft`).
- Flip to `canonical` when the doc commits to the workspace spine (Beats locked, Research Note is now load-bearing, Master Reference is the source of truth).
- Flip back to `draft` when superseded (e.g. Ch 7 Beats v3 ships → demote v1/v2 to `draft`).
- The common crawl pattern is `crawl({ status: "canonical" })` — that's the trusted-shelf query.

| Tool | Key Params | Description |
|------|-----------|-------------|
| `list_dirty_docs` | `workspaceFile?` | List docs that need enrichment (never enriched OR explicitly flagged stale). Returns identity + reason only — no bodies. Optionally scoped to one workspace. Docs in opted-out workspaces (`enrichmentDisabled: true`) are excluded. |
| `mark_enriched` | `docs: [{docId, logline}]` | Stamp one or more docs as freshly enriched. **Strict schema** — passing `domain` / `concepts` / `docRole` / `status` fails validation. OpenWriter auto-computes baselines (`lastEnrichedAt`, `lastEnrichedCharCount`, `lastEnrichedSentences`), clears `enrichmentStale`, and retires legacy fields from frontmatter. The minion calls this once at the end of its run with the full batch. |
| `crawl` | `workspaceFile?`, `tags?`, `status?` (`canonical`/`draft`), `hasLogline?` | Bulk-read enrichment fields per doc with AND-composed filters. The agent's "scan the shelf" primitive — ~60 tokens per doc, no bodies. v0.19.0 dropped `domain` / `concepts` / `docRole` filters (their fields had no authority discipline); `status` is the replacement axis for the common load-bearing-vs-working query. |

### Comments

| Tool | Key Params | Description |
|------|-----------|-------------|
| `get_comments` | `docId?`, `scope?` | Get comments left by the user. Default scope is `workspace` when a docId is given (returns comments for every doc in the same project); pass `scope: "document"` to narrow, or `scope: "all"` for every doc on disk |
| `resolve_comments` | `comment_ids` | Remove comments after addressing feedback (pass comment IDs) |

The older names `get_agent_marks` and `resolve_agent_marks` remain as deprecated aliases.

### Task Management

| Tool | Key Params | Description |
|------|-----------|-------------|
| `list_tasks` | — | List all tasks for the current profile |
| `add_task` | `text` | Add a new task to the checklist |
| `update_task` | `id`, `text?`, `completed?` | Update a task (text or completion status) |
| `remove_task` | `id` | Remove a task from the checklist |

Call `list_tasks` at session start to check for pending work from previous sessions.

### Text Operations

| Tool | Key Params | Description |
|------|-----------|-------------|
| `edit_text` | `docId`, `nodeId`, `edits` | Fine-grained text edits within a node (find/replace, add/remove marks). **`edits` must be a JSON array, not a string.** Example: `edits: [{ find: "old text", replace: "new text" }]` |

### Image Generation

| Tool | Description |
|------|-------------|
| `insert_image` | Generate image via Gemini. Three modes: (1) `docId` + `afterNodeId` → inline insert with pending decoration. (2) `set_cover: true` → set as article cover. (3) Neither → generate to disk only. Requires GEMINI_API_KEY. |

### Version Management

| Tool | Description |
|------|-------------|
| `list_versions` | List version history for the active document (timestamps, word counts, sizes) |
| `create_checkpoint` | Force a version snapshot right now — use before risky operations |
| `restore_version` | Restore to a previous version by timestamp (auto-creates safety checkpoint first) |
| `reload_from_disk` | Re-read the active document from its file on disk (for external modifications) |

## Writing Strategy

OpenWriter has two distinct modes: **editing** existing documents and **creating** new content. Use the right approach for each.

### Editing (write_to_pad)

For making changes to existing documents — rewrites, insertions, deletions:

- Use `write_to_pad` for all edits — **`docId` is required** (8-char hex from `list_documents` or `read_pad`)
- Send **3-8 changes per call** for a responsive, streaming feel
- Always `read_pad` before editing to get fresh node IDs
- Respect `pendingChanges > 0` — wait for the user to accept/reject before sending more
- Content accepts markdown strings (preferred) or TipTap JSON
- **`rewrite` preserves the target node's type.** Sending plain prose to rewrite a heading keeps it a heading; the same for list items and blockquotes. To intentionally change a node's type, use `delete` + `insert`. For surgical text-only edits inside a node (no risk of restructuring), `edit_text` is the smaller hammer.
- Decoration colors: **blue** = rewrite, **green** = insert, **red** = delete
- **Never re-populate a document to fix it.** `populate_document` re-sends the entire document body — extremely token-expensive. To remove nodes, use `write_to_pad` with `{ operation: "delete", nodeId: "..." }`. To fix content, use `rewrite`. Only use `populate_document` once during initial creation, or as a last resort if the document is severely broken.

### Auto-accept mode (no pending review)

The user can turn on **auto-accept** on a per-doc basis (right-click the doc in the sidebar). When on, your edits commit directly — no pending decorations, no review panel for that doc. Used during fast drafting where the user isn't reviewing as you go.

- `get_pad_status` returns `autoAccept: true` when the active doc has it on. Use this to decide your cadence.
- **When autoAccept is true:** keep writing without polling for review. Don't wait between batches. Send the next 3-8 changes the moment you're ready.
- **When autoAccept is false (default):** respect `pendingChanges > 0` — wait for the user to accept/reject before sending more.
- You don't toggle this flag yourself — only the user does, from the sidebar. If you think the user wants it, ask first.
- The flag is persisted in the doc's frontmatter as `autoAccept: true`. Visible in `get_metadata`.

### Creating New Documents (two-step flow)

**Always use the two-step flow** when creating new content:

```
1. create_document({ title: "My Doc", content_type: "document" })  ← fires instantly, shows spinner
2. populate_document({ content: "..." })                           ← delivers content, clears spinner
```

**Why two steps?** MCP tool calls are atomic — the server doesn't receive the call until ALL parameters are fully generated. For a document with hundreds or thousands of words, the user would wait 30+ seconds with zero feedback while you generate content tokens. The two-step flow shows a sidebar spinner immediately (step 1 has no content to generate), then the spinner persists while you generate and deliver the content (step 2).

**Rules:**
- `create_document` does NOT accept a `content` parameter — it always creates an empty doc
- Step 1 (`create_document`) — shows spinner, creates empty doc, does NOT switch the editor
- Step 2 (`populate_document`) — pass the `docId` from step 1 to write content directly to that doc, marks as pending decorations, clears the spinner. Does NOT switch the user's view — they keep working wherever they are.
- Never use `write_to_pad` for the initial population — use `populate_document` exclusively

### Workspace-Integrated Creation

`create_document` accepts optional `workspace` and `container` parameters for direct workspace placement:

```
create_document({
  title: "Opening Chapter",
  content_type: "document",          ← REQUIRED: "document" for plain, or "tweet"/"article"/etc.
  workspace: "The Immortal",        ← creates workspace if it doesn't exist
  container: "Chapters"             ← creates container if it doesn't exist
})
```

- **`workspace`** (string) — workspace title to add the doc to. Auto-creates if not found (case-insensitive match).
- **`container`** (string) — container name within the workspace (e.g. "Chapters", "Notes", "References"). Auto-creates if not found. Requires `workspace`.
- **`afterId`** (string, optional) — docId (8-char hex) or containerId to place the new doc immediately after. Omit and the doc lands at the **bottom** of its parent (the default since 0.18.0, matching the ascending-order convention: oldest at top, newest at bottom). Use `afterId` when you need surgical placement — e.g. inserting a new chapter doc immediately after the chapter's Beats doc.
- All three are optional — omit `workspace` for standalone docs outside any workspace.

This eliminates the need for separate `create_workspace`, `create_container`, and `move_item` calls when building up a workspace. The default-bottom landing also eliminates the need for a follow-up `move_item` pass to fix sidebar order after every create — the doc lands in convention position the first time.

`create_container` accepts the same `afterId` parameter with identical semantics — new containers default to the bottom of their parent and can be precisely placed via `afterId`. The Drafts sub-container that goes under every chapter container, for example, can be created with `afterId` set to the chapter's Research Notes docId so it lands at the very bottom in one call.

### Batched Creation (multiple docs at once)

When creating **two or more documents together** — a tweet thread saved as separate docs, a series of blog drafts, newsletter variants, a workspace populated with several files — use `declare_writes` instead of looping `create_document`. It's one tool call, registers all sidebar spinners atomically, and survives app refreshes.

```
1. declare_writes({
     writes: [
       { title: "Post 1", content_type: "tweet" },
       { title: "Post 2", content_type: "tweet" },
       { title: "Post 3", content_type: "tweet" },
     ]
   })
   → returns [{ docId, filename, title }, ...]

2. populate_document({ docId: "...", content: "..." })  ← one call per doc, parallel is fine
```

**Rules:**
- Each write in the batch gets its own sidebar spinner keyed to its filename — a spinner only clears when you `populate_document` that specific `docId`
- Spinners persist across app refreshes (server-side registry)
- Same per-write fields as `create_document`: `title`, `content_type`, optional `workspace`/`container`/`url`/`path`/`afterId`
- `reply` / `quote` types still require `url`
- For a **single** document, use `create_document` — don't reach for `declare_writes` just to wrap one entry

### Citations & footnotes

Long-form writing (especially academic-adjacent nonfiction) uses CommonMark / Pandoc footnote syntax:

- **Reference** (inline in prose): `text[^1]` — renders as a superscript chip
- **Definition** (anywhere in the markdown body): `[^1]: footnote text` — automatically corralled into a "Footnotes" section at end-of-doc on save
- **Mnemonic labels** allowed: `[^sapolsky2017]` survives round-trip on disk; the editor shows auto-sequential display numbers regardless

Just include the syntax in `populate_document` content or `write_to_pad` content — no special tool needed. The parser handles the tokenization, the editor handles the rendering, the serializer enforces the constrained end-of-doc shape.

**Scope is per-doc.** Each chapter has its own `[^1]` … `[^N]` numbering; cross-doc references aren't supported at the editor level. Full guide → `docs/footnotes.md`.

## Companion Skills (optional)

All companion skills install from the same openwriter GitHub repo unless noted:

```bash
# X/Twitter content — writing format, image gen, full pipeline
npx skills add https://github.com/travsteward/openwriter --skill x-writer

# Book-scale long-form — chapter architecture, beats, workspace management
npx skills add https://github.com/travsteward/openwriter --skill book-writer

# Author's Voice — voice matching, minion dispatch, anti-AI (required by both above)
claude install github:travsteward/authors-voice
```

For voice-matched drafting without a custom voice profile, install **voice-presets** — 5 pre-built frames (authority, provocateur, logical, storyteller, business). For an AI-detection pass without full authors-voice setup, install **anti-ai**. Both are optional.

## Workflow

### Single document

```
1. get_pad_status  → check pendingChanges and userSignaledReview
2. read_pad        → get full document with node IDs + docId
3. get_metadata    → check tweetContext/articleContext for URLs, mode, tags
4. write_to_pad({ docId: "a1b2c3d4", changes: [...] })
5. Wait            → user accepts/rejects in browser
```

**For tweet/article docs:** step 3 gives you the parent tweet URL (in `tweetContext.url`) and mode (`reply`/`quote`/`tweet`). Use this URL with fxtwitter to read the parent tweet for free — never search externally for it.

### Multi-document

```
1. list_documents    → see all docs with title + [docId]
2. read_pad({ docId: "e5f6a7b8" })  → reads that doc directly, no switch needed
3. write_to_pad({ docId: "e5f6a7b8", changes: [...] })
                     → edits go to the identified doc, no view switch needed
```

### Creating new content (two-step)

```
1. create_document({ title: "My Doc", content_type: "document", workspace: "Project", container: "Chapters" })
                                                → returns docId "a1b2c3d4", spinner appears
2. populate_document({ docId: "a1b2c3d4", content: "# ..." })
                                                → content delivered, spinner clears
3. read_pad                                     → get node IDs + docId if further edits needed
4. write_to_pad({ docId: "a1b2c3d4", ... })    → refine with edits
```

### Building a workspace (multiple docs)

```
1. create_document({ title: "Ch 1", content_type: "document", workspace: "My Book", container: "Chapters" })
                                                → returns docId "ch1docid"
2. populate_document({ docId: "ch1docid", content: "..." })
3. create_document({ title: "Ch 2", content_type: "document", workspace: "My Book", container: "Chapters" })
                                                → returns docId "ch2docid"
4. populate_document({ docId: "ch2docid", content: "..." })
5. create_document({ title: "Character Bible", content_type: "document", workspace: "My Book", container: "References" })
6. populate_document({ docId: "<from step 5>", content: "..." })
7. tag_doc + update_workspace_context           → organize and add context
```

The workspace and containers are auto-created on the first `create_document` call. Subsequent calls reuse the existing workspace/containers (matched case-insensitively).

### Comments (inline feedback)

Users can select text in the browser, right-click, and leave a comment — a note attached to a specific text range. Comments appear as dotted underlines in the editor. This is the user's way of marking up a document with feedback for you to address.

```
1. User says "check my comments" (or you see the hint in read_pad output)
2. get_comments({ docId })       → comments for the current workspace by default
3. Address each comment          → rewrite, insert, delete via write_to_pad (use docId)
4. resolve_comments([ids])       → clears decorations in browser
```

- `read_pad` automatically shows comment counts: this doc + other docs
- Default scope is `workspace` when a docId is provided — you see comments across every doc in the user's current project, not just the one they're viewing
- Pass `scope: "document"` to narrow to one doc, `scope: "all"` to span everything on disk
- Always resolve comments after addressing them — `resolve_comments` is a state change ("addressed, archive it"), not a destructive delete. The record stays in storage; only the decoration disappears. `get_comments` skips resolved ones by default
- A comment with an empty note means "fix this" — use your judgment
- A comment with a note is specific feedback — follow the instruction

### Book workspace guidelines

When importing or organizing book-length projects, read the source material first and **follow the grain** — break content into the categories the author is already thinking in, don't impose a template.

- **One concept per doc.** Don't create one giant reference doc. If the material covers characters, setting, plot, and themes, those are separate documents.
- **Preserve originals.** Keep raw drafts separate from revised versions (e.g. Drafts vs. Chapters containers). The author needs both.
- **Synthesize, don't just copy.** Reorganize messy notes into clean, scannable docs (headers, bullets, sections) while keeping the author's voice and prose verbatim.
- **Surface open threads.** Unanswered questions, brainstorm lists, and loose ideas get their own doc — don't bury them inside reference material.

## X Content (Tweets, Threads, Articles)

For composing X content in OpenWriter — `tweetContext` and `articleContext` metadata, `content_type` (`tweet` / `reply` / `quote` / `article`), thread HR rules, image handling, paragraph spacing, parent-tweet workflow — see the `/x-writer` skill.

## Review Etiquette

1. **Share the URL.** Always tell the user: http://localhost:5050
2. **Read before writing.** Always fetch the document before suggesting changes
3. **Don't overwhelm.** 1-3 changes at a time for reviews, 3-8 for drafting
4. **Explain your edits.** Tell the user what you changed and why
5. **Respect pending changes.** If `pendingChanges > 0`, wait for the user
6. **Watch for the review signal.** When `userSignaledReview` is true, the user is asking for your input — reading status clears it (one-shot)

## Publish Platform (21 tools)

Requires authentication via `request_login_code` + `verify_login`. All publish tools are provided by the `@openwriter/plugin-publish` plugin.

### Authentication

| Tool | Description |
|------|-------------|
| `request_login_code` | Send a 6-digit login code to an email address (signup or key recovery) |
| `verify_login` | Verify the code → API key issued + auto-saved to plugin config |

```
1. request_login_code({ email: "user@example.com" })   → 6-digit code sent to email
2. User reads code from inbox (or agent reads via gmail skill)
3. verify_login({ email: "user@example.com", code: "123456" })
   → API key issued + auto-saved to plugin config
```

- **Agents with email access** (e.g. gmail skill) can fully automate this — zero user involvement
- **Key recovery:** Same flow. Old keys are automatically revoked when a new one is issued
- Codes expire in 10 minutes, max 3 attempts per code, rate-limited to 1 request per 60 seconds

### Custom Domains

| Tool | Description |
|------|-------------|
| `setup_custom_domain` | Configure a custom domain + from_email for newsletter sending |
| `check_domain_status` | Check DNS and sender verification status |
| `resend_domain_verification` | Re-send the SendGrid sender verification email |

**Setup flow:**
1. Call `setup_custom_domain` with domain + from_email
2. Cloudflare domains: DNS auto-added. Non-CF: show DNS records for manual setup
3. User checks email for SendGrid sender verification
4. Wait ~30-60s, call `check_domain_status` to confirm
5. Both `dns_verified` + `sender_verified` = domain ready

### Social Posting & Connections

| Tool | Description |
|------|-------------|
| `list_connections` | List connected social accounts (X, LinkedIn, etc.) |
| `post_to_x` | Post current document to X/Twitter |
| `post_to_linkedin` | Post current document to LinkedIn |

### Scheduling

| Tool | Description |
|------|-------------|
| `schedule_post` | Schedule a post for a specific time |
| `list_schedule` | List all scheduled posts |
| `manage_schedule` | Update or cancel a scheduled post |
| `list_slots` | List recurring time slots |
| `create_slot` | Create a recurring posting slot |
| `edit_slot` | Modify an existing slot |
| `delete_slot` | Remove a recurring slot |

**Timezones:** `scheduled_at` is UTC. Convert local times using IANA names (e.g. `America/Los_Angeles`), never fixed offsets — DST shifts automatically.

### Newsletter

| Tool | Key Params | Description |
|------|-----------|-------------|
| `send_newsletter` | `subject?`, `format?`, `test_email?`, `subscriber_ids?`, `exclude_issue_id?` | Send current document as newsletter to all subscribers, a subset, or a test address |
| `list_subscribers` | `limit?`, `offset?` | List newsletter subscribers with IDs, emails, names |
| `add_subscriber` | `email`, `name?` | Add a single subscriber |
| `import_subscribers` | `file?`, `csv_text?` | Bulk import from CSV (auto-detects ConvertKit, Mailchimp, Substack, Beehiiv formats) |
| `list_newsletter_issues` | `limit?` | List past sends with open/click stats — returns issue IDs |
| `get_newsletter_analytics` | `issue_id` | Detailed drill-down: delivery stats, per-subscriber events, recipient list |
| `get_subscribe_embed` | *(none)* | Get public subscribe URL + HTML/JS embed snippets for signup forms on external sites |

**Subscriber selection** — `send_newsletter` supports targeting:
- **All subscribers** (default) — omit both params
- **Specific subscribers** — pass `subscriber_ids: ["id1", "id2"]` (use `list_subscribers` for IDs)
- **Send to remaining** — pass `exclude_issue_id: "..."` to send to everyone who did NOT receive that issue (use `list_newsletter_issues` for issue IDs)

**Analytics workflow:**
```
1. list_newsletter_issues()                    → see past sends with open/click counts
2. get_newsletter_analytics({ issue_id })      → drill into a specific send
   → returns: stats (delivered, opens, clicks, bounces), per-subscriber events, recipient list
```

## Author's Voice Plugin

When the user enables the Author's Voice plugin in Settings, install the skill — see [authors-voice.com](https://www.authors-voice.com) for install methods. The skill handles API key setup and everything else.

## Updating

```bash
npm install -g openwriter@latest
npx openwriter install-skill
```

Then restart your Claude Code session (`/mcp` to reconnect).

## Troubleshooting

**MCP tools not available** — The OpenWriter MCP server isn't configured yet. Follow the [setup instructions](#mcp-tools-are-not-available-skill-first-install) above. After adding the MCP config, the user must restart their Claude Code session.

**Browser dies mid-session** — The MCP stdio pipe can break during context compaction or session resets. The HTTP server survives (crash guards), but MCP tools stop working. Reconnect by [restarting the MCP server](#restarting-the-mcp-server) (see below). The new process enters client mode and proxies MCP calls to the surviving HTTP server. The browser will auto-reconnect.

### Restarting the MCP server

Both Claude Code and Claude Desktop work the same way: there's no explicit restart button. Call `list_documents` (zero params, read-only, fast). If the previous process is dead, Claude auto-spawns a fresh one to satisfy the call. After code changes, kill the old process first (`taskkill /F /PID <pid>` on Windows, `kill <pid>` on macOS/Linux) so the spawn picks up the new build. Only fall back to `/mcp` (Claude Code) if tool calls keep returning `Connection error: fetch failed`.

**Port 5050 busy** — Another OpenWriter instance owns the port. New sessions auto-enter client mode (proxying via HTTP) — tools still work. No action needed.

**Edits don't appear** — Stale node IDs. Always `read_pad` before `write_to_pad` to get fresh IDs.

**"pendingChanges" never clears** — User needs to accept/reject changes in the browser at http://localhost:5050.

**Server not starting** — Ensure `openwriter` works from your terminal (`npm install -g openwriter` first). If on Windows and the global command isn't found, the MCP config may need `"command": "cmd"` with `"args": ["/c", "openwriter", "--no-open"]`.

**After code changes** — Run `npm run build` in `packages/openwriter`, kill the running openwriter process, then [restart the MCP server](#restarting-the-mcp-server). `/mcp` alone only reconnects to the existing process; it won't pick up new code unless the old process dies first.

**Slow to load / loads last** — MCP servers load sequentially in config order. Move `openwriter` to the first position in `mcpServers` in `~/.claude.json`. See setup instructions above.
