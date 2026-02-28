---
name: openwriter
description: |
  OpenWriter — the writing surface for AI agents. A markdown-native rich text
  editor where agents write via MCP tools and users accept or reject changes
  in-browser. 31 MCP tools for document editing, multi-doc workspaces, and
  organization. Tweet compose mode for drafting replies/QTs with pixel-accurate
  X/Twitter UI. Plain .md files on disk — no database, no lock-in.

  Use when user says: "open writer", "openwriter", "write in openwriter",
  "edit my document", "review my writing", "check the pad", "write me a doc",
  "compose tweet", "reply to tweet", "quote tweet".

  Requires: OpenWriter MCP server configured. Browser UI at localhost:5050.
metadata:
  author: travsteward
  version: "0.5.0"
  repository: https://github.com/travsteward/openwriter
license: MIT
---

# OpenWriter Skill

You are a writing collaborator. You read documents and make edits **exclusively via MCP tools**. Edits appear as pending decorations (colored highlights) in the user's browser that they accept or reject.

## Setup — Which Path?

Check whether the `openwriter` MCP tools are available (e.g. `read_pad`, `write_to_pad`). This determines setup state:

### MCP tools ARE available (ready to use)

The user already has OpenWriter configured — either they ran `npx openwriter install-skill` (which installed this skill) and added the MCP server, or they set it up manually. You're good to go.

**First action:** Share the browser URL:
> OpenWriter is at **http://localhost:5050** — open it in your browser to see and review changes.

Skip to [Writing Strategy](#writing-strategy) below.

### MCP tools are NOT available (skill-first install)

The user installed this skill from a directory but hasn't set up the MCP server yet. OpenWriter needs an MCP server to provide the 31 editing tools.

**Step 1:** Tell the user to install globally and add the MCP server:

```bash
# Install globally for instant startup (no npx resolution delay)
npm install -g openwriter

# Add the OpenWriter MCP server to Claude Code
claude mcp add -s user openwriter -- openwriter --no-open
```

Then restart the Claude Code session. The MCP tools become available on next launch.

**Step 2 (if the user can't run the command above):** Edit `~/.claude.json` directly. Add `openwriter` as the **first entry** in the `mcpServers` object — MCP servers load sequentially, so first in config = first to load:

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

**Why first?** Claude Code loads MCP servers sequentially in config order. If `openwriter` is last, it waits for every other server to finish connecting first. Putting it first makes it available instantly.

After editing, tell the user:
1. Restart your Claude Code session (MCP servers load on startup)
2. Open http://localhost:5050 in your browser

**Note:** You cannot run `claude mcp add` from inside a session (nested session error). That's why we edit the JSON directly when configuring from within Claude Code. Also, `claude mcp add` appends to the end — always verify the entry is first after adding.

## MCP Tools Reference (30 tools)

### Document Operations

| Tool | Description |
|------|-------------|
| `read_pad` | Read the current document (compact tagged-line format) |
| `write_to_pad` | Apply edits as pending decorations (rewrite, insert, delete) |
| `populate_document` | Populate an empty doc with content (two-step creation flow) |
| `get_pad_status` | Lightweight poll: word count, pending changes, userSignaledReview |
| `get_nodes` | Fetch specific nodes by ID |
| `get_metadata` | Get frontmatter metadata for the active document |
| `set_metadata` | Update frontmatter metadata (merge, set key to null to remove) |

### Document Lifecycle

| Tool | Description |
|------|-------------|
| `list_documents` | List all documents with filename, word count, active status |
| `switch_document` | Switch to a different document by filename |
| `create_document` | Create a new empty document (optional workspace + container placement) |
| `open_file` | Open an existing .md file from any location on disk |
| `delete_document` | Delete a document file (moves to OS trash, recoverable) |

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
| `add_doc` | Add a document to a workspace (optional container placement) |
| `create_container` | Create a folder inside a workspace (max depth: 3) |
| `tag_doc` | Add a tag to a document (stored in doc frontmatter) |
| `untag_doc` | Remove a tag from a document (stored in doc frontmatter) |
| `move_doc` | Move a document to a different container or root level |
| `rename_item` | Rename a workspace, container, or document (type: workspace/container/document) |

### Text Operations

| Tool | Description |
|------|-------------|
| `edit_text` | Fine-grained text edits within a node (find/replace, add/remove marks) |

### Image Generation

| Tool | Description |
|------|-------------|
| `generate_image` | Generate an image via Gemini Nano Banana 2 — optionally set as article cover (requires GEMINI_API_KEY) |

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

- Use `write_to_pad` for all edits — **`filename` is required**
- Send **3-8 changes per call** for a responsive, streaming feel
- Always `read_pad` before editing to get fresh node IDs
- Respect `pendingChanges > 0` — wait for the user to accept/reject before sending more
- Content accepts markdown strings (preferred) or TipTap JSON
- Decoration colors: **blue** = rewrite, **green** = insert, **red** = delete

### Creating New Documents (two-step flow)

**Always use the two-step flow** when creating new content:

```
1. create_document({ title: "My Doc" })      ← no content, fires instantly, shows spinner
2. populate_document({ content: "..." })      ← delivers content, clears spinner
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
  workspace: "The Immortal",        ← creates workspace if it doesn't exist
  container: "Chapters"             ← creates container if it doesn't exist
})
```

- **`workspace`** (string) — workspace title to add the doc to. Auto-creates if not found (case-insensitive match).
- **`container`** (string) — container name within the workspace (e.g. "Chapters", "Notes", "References"). Auto-creates if not found. Requires `workspace`.
- Both are optional — omit for standalone docs outside any workspace.

This eliminates the need for separate `create_workspace`, `create_container`, and `add_doc` calls when building up a workspace.

## Workflow

### Single document

```
1. get_pad_status  → check pendingChanges and userSignaledReview
2. read_pad        → get full document with node IDs
3. write_to_pad({ filename: "Doc.md", changes: [...] })
4. Wait            → user accepts/rejects in browser
```

### Multi-document

```
1. list_documents    → see all docs, find target
2. read_pad          → read active doc (or switch_document first)
3. write_to_pad({ filename: "Target.md", changes: [...] })
                     → edits go to the named file, no view switch needed
```

### Creating new content (two-step)

```
1. create_document({ title: "My Doc", workspace: "Project", container: "Chapters" })
                                                → spinner appears, doc placed in workspace
2. populate_document({ content: "# ..." })     → content delivered, spinner clears
3. read_pad                                     → get node IDs if further edits needed
4. write_to_pad                                 → refine with edits
```

### Building a workspace (multiple docs)

```
1. create_document({ title: "Ch 1", workspace: "My Book", container: "Chapters" })
2. populate_document({ content: "..." })
3. create_document({ title: "Ch 2", workspace: "My Book", container: "Chapters" })
4. populate_document({ content: "..." })
5. create_document({ title: "Character Bible", workspace: "My Book", container: "References" })
6. populate_document({ content: "..." })
7. tag_doc + update_workspace_context           → organize and add context
```

The workspace and containers are auto-created on the first `create_document` call. Subsequent calls reuse the existing workspace/containers (matched case-insensitively).

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
1. create_document({ title: "Reply to @username" })
2. populate_document({ content: " " })              ← empty content, compose area
3. set_metadata({ tweetContext: { url: "https://x.com/user/status/123", mode: "reply" } })
```

- **`url`** — the tweet URL to reply to or quote
- **`mode`** — `"reply"` (thread layout with parent above) or `"quote"` (compose above, quoted card below)

The view activates automatically when `tweetContext` is present — no manual toggle needed. Documents are auto-tagged `"x"` in the sidebar for discoverability.

### Reading the parent tweet

Use the x-reader skill or fxtwitter API to fetch tweet data before setting up:

```
WebFetch: https://api.fxtwitter.com/{username}/status/{tweet_id}
```

The compose view fetches and renders the parent tweet (text, author, avatar, media, metrics) automatically from the URL.

### Template Documents

Users can also create tweet and article templates directly from the browser UI using the **Templates** dropdown in the titlebar. For agent-initiated template creation, use the standard two-step flow:

**Tweet template:**
```
1. create_document({ empty: true })
2. set_metadata({ tweetContext: { mode: "tweet" }, title: "Tweet" })
```

**Reply template (with parent URL):**
```
1. create_document({ empty: true })
2. set_metadata({ tweetContext: { url: "https://x.com/user/status/123", mode: "reply" }, title: "Reply" })
```

**Quote tweet template:**
```
1. create_document({ empty: true })
2. set_metadata({ tweetContext: { url: "https://x.com/user/status/123", mode: "quote" }, title: "Quote Tweet" })
```

**Article template:**
```
1. create_document({ empty: true })
2. set_metadata({ articleContext: { active: true }, title: "Article" })
```

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

## Review Etiquette

1. **Share the URL.** Always tell the user: http://localhost:5050
2. **Read before writing.** Always fetch the document before suggesting changes
3. **Don't overwhelm.** 1-3 changes at a time for reviews, 3-8 for drafting
4. **Explain your edits.** Tell the user what you changed and why
5. **Respect pending changes.** If `pendingChanges > 0`, wait for the user
6. **Watch for the review signal.** When `userSignaledReview` is true, the user is asking for your input — reading status clears it (one-shot)

## Troubleshooting

**MCP tools not available** — The OpenWriter MCP server isn't configured yet. Follow the [setup instructions](#mcp-tools-are-not-available-skill-first-install) above. After adding the MCP config, the user must restart their Claude Code session.

**Port 5050 busy** — Another OpenWriter instance owns the port. New sessions auto-enter client mode (proxying via HTTP) — tools still work. No action needed.

**Edits don't appear** — Stale node IDs. Always `read_pad` before `write_to_pad` to get fresh IDs.

**"pendingChanges" never clears** — User needs to accept/reject changes in the browser at http://localhost:5050.

**Server not starting** — Ensure `openwriter` works from your terminal (`npm install -g openwriter` first). If on Windows and the global command isn't found, the MCP config may need `"command": "cmd"` with `"args": ["/c", "openwriter", "--no-open"]`.

**Slow to load / loads last** — MCP servers load sequentially in config order. Move `openwriter` to the first position in `mcpServers` in `~/.claude.json`. See setup instructions above.
