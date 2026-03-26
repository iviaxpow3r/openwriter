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
  version: "0.4.4"
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

The user has this skill but hasn't set up the MCP server yet. One command does everything:

```bash
npx openwriter install-skill
```

This installs openwriter globally, configures the MCP server for Claude Code, and copies this skill — all in one step. After it finishes, the user just needs to restart their Claude Code session.

**Fallback (if the command above fails):** Do it manually:

```bash
npm install -g openwriter
claude mcp add -s user openwriter -- openwriter --no-open
```

If `claude mcp add` can't run (e.g. nested session error), edit `~/.claude.json` directly. Add `openwriter` as the **first entry** in `mcpServers`:

```json
{
  "mcpServers": {
    "openwriter": {
      "command": "openwriter",
      "args": ["--no-open"]
    }
  }
}
```

After setup, tell the user:
1. Restart your Claude Code session (MCP servers load on startup)
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
| `switch_document` | `docId` | Switch to a different document by docId |
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
| `get_workspace_structure` | Get full workspace tree: containers, docs, tags, context |
| `get_item_context` | Get progressive disclosure context for a doc in a workspace |
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

### Agent Marks

| Tool | Key Params | Description |
|------|-----------|-------------|
| `get_agent_marks` | `docId?` | Get inline feedback marks left by the user (optional docId — omit for all docs) |
| `resolve_agent_marks` | `mark_ids` | Remove marks after addressing feedback (pass mark IDs) |

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
- Decoration colors: **blue** = rewrite, **green** = insert, **red** = delete
- **Never re-populate a document to fix it.** `populate_document` re-sends the entire document body — extremely token-expensive. To remove nodes, use `write_to_pad` with `{ operation: "delete", nodeId: "..." }`. To fix content, use `rewrite`. Only use `populate_document` once during initial creation, or as a last resort if the document is severely broken.

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
- Step 2 (`populate_document`) — writes content to the active doc, marks as pending decorations, switches the editor, clears the spinner
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
- Both are optional — omit for standalone docs outside any workspace.

This eliminates the need for separate `create_workspace`, `create_container`, and `move_item` calls when building up a workspace.

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
2. read_pad          → read active doc (or switch_document({ docId }) first)
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

### Agent marks (inline feedback)

Users can select text in the browser, right-click, and leave an "Agent Mark" — a note attached to a specific text range. Marks appear as dotted underlines in the editor. This is the user's way of marking up a document with feedback for you to address.

```
1. User says "check my marks" (or you see the hint in read_pad output)
2. get_agent_marks              → all marks across all docs, grouped by document
3. Address each mark            → rewrite, insert, delete via write_to_pad (use docId)
4. resolve_agent_marks([ids])   → clears decorations in browser
```

- `read_pad` automatically shows mark counts: this doc + other docs
- Always resolve marks after addressing them — the dotted underlines clear immediately
- A mark with an empty note means "fix this" — use your judgment
- A mark with a note is specific feedback — follow the instruction

### Book workspace guidelines

When importing or organizing book-length projects, read the source material first and **follow the grain** — break content into the categories the author is already thinking in, don't impose a template.

- **One concept per doc.** Don't create one giant reference doc. If the material covers characters, setting, plot, and themes, those are separate documents.
- **Preserve originals.** Keep raw drafts separate from revised versions (e.g. Drafts vs. Chapters containers). The author needs both.
- **Synthesize, don't just copy.** Reorganize messy notes into clean, scannable docs (headers, bullets, sections) while keeping the author's voice and prose verbatim.
- **Surface open threads.** Unanswered questions, brainstorm lists, and loose ideas get their own doc — don't bury them inside reference material.

## Tweet Compose Mode

OpenWriter doubles as a tweet compose surface. When `tweetContext` is set in a document's metadata, the editor switches to a pixel-accurate X/Twitter compose view — reply thread or quote tweet layout with embedded parent tweet, character counter, and action bar.

### Setting up a tweet document

```
1. create_document({ title: "Reply to @username", content_type: "reply", url: "https://x.com/user/status/123", empty: true })
```

- **`url`** — the tweet URL to reply to or quote
- **`mode`** — `"reply"` (thread layout with parent above) or `"quote"` (compose above, quoted card below)

The view activates automatically when `tweetContext` is present — no manual toggle needed. Documents are auto-tagged `"x"` in the sidebar for discoverability.

### Working on an existing tweet document

When the user asks you to work on a tweet doc, follow this exact sequence:

```
1. read_pad              → get content + node IDs + docId
2. get_metadata          → get tweetContext (url, mode), tags
3. Extract tweet URL     → parse username + tweet ID from tweetContext.url
4. WebFetch fxtwitter    → read the parent tweet for FREE
5. Check workspaces      → find relevant reference docs for context
6. Write                 → now you have everything, edit the pad
```

**Step 3-4 in detail:** Parse the URL from `tweetContext.url` (e.g. `https://x.com/HustleBitch_/status/2033641235739496554`) → extract username and ID → fetch via fxtwitter:

```
WebFetch: https://api.fxtwitter.com/{username}/status/{tweet_id}
```

This returns full text, metrics, media, quoted tweets — all for FREE. **Never use paid X API search to find a tweet that's already in the document metadata.**

**Step 5:** If the tweet references concepts the user has written about (dimorphism, territory, frame, etc.), check their workspaces via `list_workspaces` → `get_workspace_structure` → `read_pad` on relevant reference docs. This gives you the user's framework to write from, not generic knowledge.

### Reading the parent tweet (when creating new tweet docs)

Use the x-reader skill or fxtwitter API to fetch tweet data before setting up:

```
WebFetch: https://api.fxtwitter.com/{username}/status/{tweet_id}
```

The compose view fetches and renders the parent tweet (text, author, avatar, media, metrics) automatically from the URL.

### Template Documents

Users can also create tweet and article templates directly from the browser UI using the **Templates** dropdown in the titlebar. For agent-initiated creation, `content_type` handles all metadata automatically:

**Tweet:** `create_document({ title: "Tweet", content_type: "tweet", empty: true })`

**Reply:** `create_document({ title: "Reply", content_type: "reply", url: "https://x.com/user/status/123", empty: true })`

**Quote tweet:** `create_document({ title: "Quote Tweet", content_type: "quote", url: "https://x.com/user/status/123", empty: true })`

**Article:** `create_document({ title: "Article", content_type: "article", empty: true })`

### Removing tweet mode

```
set_metadata({ tweetContext: null })
```

This restores the normal editor view and removes the "x" tag.

### Placeholder text

- Quote mode: "Add a comment"
- Reply mode: "What is happening?!"

### Compose avatar

Users set their X handle by clicking the avatar circle in the compose area. The handle is saved to localStorage and the pfp loads from `unavatar.io/twitter/{handle}`.

### Creating Tweet Threads

Threads are single documents with `horizontalRule` nodes separating each tweet. The compose view splits at HRs into separate tweet editors.

**Do NOT use `populate_document` for threads.** Use `create_document` with `content_type: "tweet"` + `empty: true`, then `write_to_pad` with `horizontalRule` JSON nodes between tweets. The `content_type` flag sets `tweetContext` metadata automatically.

**THREE RULES for thread HRs:**

1. **`horizontalRule` separators MUST use TipTap JSON `{ type: "horizontalRule" }`.** Markdown `---` does NOT create proper HR nodes.
2. **Each HR must be its own change.** Do NOT use content arrays `[{type: "horizontalRule"}, {type: "paragraph", ...}]` — this silently drops the HR.
3. **Send the ENTIRE thread in ONE `write_to_pad` call.** Do NOT split across multiple calls. Multiple calls create race conditions — if the user accepts changes between calls, pending HRs can be dropped. One call = atomic = no race conditions.

```
1. create_document({ title: "Thread title", content_type: "tweet", empty: true })
2. write_to_pad({ docId: "<docId>", changes: [
     { operation: "insert", afterNodeId: "end", content: "Tweet 1 paragraph 1" },
     { operation: "insert", afterNodeId: "end", content: "Tweet 1 paragraph 2" },
     { operation: "insert", afterNodeId: "end", content: { type: "horizontalRule" } },
     { operation: "insert", afterNodeId: "end", content: "Tweet 2 paragraph 1" },
     { operation: "insert", afterNodeId: "end", content: "Tweet 2 paragraph 2" },
     { operation: "insert", afterNodeId: "end", content: { type: "horizontalRule" } },
     { operation: "insert", afterNodeId: "end", content: "Tweet 3 paragraph 1" }
   ]})
```

**For long threads (many tweets):** still send in ONE call. The changes array can hold dozens of items. Atomicity matters more than streaming feel for threads — a half-built thread with missing HRs is worse than waiting for the full thread to arrive.

### Inserting New Tweets into Existing Threads

**Use separate changes within the same `write_to_pad` call.** Each HR must be its own change — do NOT use a content array `[{type: "horizontalRule"}, {type: "paragraph", ...}]` as it silently drops the HR and creates a broken paragraph instead.

```
write_to_pad({ docId: "...", changes: [
  { operation: "insert", afterNodeId: "<last-node-of-previous-tweet>",
    content: { type: "horizontalRule" } },
  { operation: "insert", afterNodeId: "end",
    content: "New tweet text" }
]})
```

**Why separate changes, not separate calls:** Two separate `write_to_pad` calls can fail because the browser resyncs on HR insertion and may overwrite the second call. But separate changes within the same call are atomic — they all apply together.

### Paragraph Spacing in Tweets

Tweet compose uses `<br>` (hardBreak) for line breaks within a paragraph. Double Enter in the browser creates a new `<p>` node (paragraph split) with visual spacing.

**For agents writing via `write_to_pad`:** use separate paragraph nodes for paragraph spacing. Each paragraph gets its own node ID, enabling independent editing.

```
// Correct: separate paragraph nodes for paragraph spacing
write_to_pad({ docId: "...", changes: [
  { operation: "insert", afterNodeId: "end", content: "First paragraph of tweet." },
  { operation: "insert", afterNodeId: "end", content: "Second paragraph — separate node, visual gap." }
]})
```

For line breaks WITHIN a single paragraph (no gap), use TipTap JSON with hardBreak:

```
{
  type: "paragraph",
  content: [
    { type: "text", text: "Line one" },
    { type: "hardBreak" },
    { type: "text", text: "Line two (same node, no gap)" }
  ]
}
```

This applies to all tweet modes — single tweets, replies, quotes, and individual tweets within threads.

### Inserting Images into Thread Tweets

After creating a thread, use `read_pad` to get node IDs, then `insert_image` to add images after specific tweets:

```
1. read_pad()                    → shows [p:abc123] for each tweet paragraph
2. insert_image({
     docId: "...",
     afterNodeId: "abc123",      ← paragraph node ID from read_pad
     prompt: "...",
     aspect_ratio: "16:9"
   })
```

All `insert_image` calls can run **in parallel** — no dependencies between them. Images appear with green pending decorations for user review.

### Inserting Existing Images (from disk)

Copy to `~/.openwriter/profiles/Default/_images/`, then use TipTap JSON in `write_to_pad`:

```
content: { "type": "image", "attrs": { "src": "/_images/my-image.png", "alt": "..." } }
```

**Markdown `![alt](path)` does NOT work** — creates an empty paragraph. Always use TipTap JSON.

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

**Browser dies mid-session** — The MCP stdio pipe can break during context compaction or session resets. The HTTP server survives (crash guards), but MCP tools stop working. Tell the user: **run `/mcp` to reconnect.** The new process enters client mode and proxies MCP calls to the surviving HTTP server. The browser will auto-reconnect.

**Port 5050 busy** — Another OpenWriter instance owns the port. New sessions auto-enter client mode (proxying via HTTP) — tools still work. No action needed.

**Edits don't appear** — Stale node IDs. Always `read_pad` before `write_to_pad` to get fresh IDs.

**"pendingChanges" never clears** — User needs to accept/reject changes in the browser at http://localhost:5050.

**Server not starting** — Ensure `openwriter` works from your terminal (`npm install -g openwriter` first). If on Windows and the global command isn't found, the MCP config may need `"command": "cmd"` with `"args": ["/c", "openwriter", "--no-open"]`.

**After code changes** — Run `npm run build` in `packages/openwriter`, then `/mcp` to restart with the new build.

**Slow to load / loads last** — MCP servers load sequentially in config order. Move `openwriter` to the first position in `mcpServers` in `~/.claude.json`. See setup instructions above.
