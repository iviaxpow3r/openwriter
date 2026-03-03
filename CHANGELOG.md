# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and this project adheres to [Semantic Versioning](https://semver.org/).

## [0.5.3] - 2026-03-03

### Added
- `insert_image` MCP tool for inline image generation
- Sidebar search bar with full-text search across titles, tags, and content
- Archive feature — soft-delete docs with metadata flag
- Copy button in tweet compose for manual paste workflow
- Auto-tag tweet/article docs with mode label (quote, reply, post, article)
- Connection banner + WebSocket resilience
- Crash guards to survive MCP pipe disconnect

### Changed
- MCP tools switched from `filename` to `docId` as primary identifier
- Thread char limit raised from 280 to 25k for X Premium long-form
- Archived docs only surface via search (removed sidebar section)
- Auto-merge paragraphs to hardBreaks for tweet compose docs
- Quoted tweet card now clickable (opens original in new tab)

### Fixed
- `create_document` hijacking user's active editor focus
- Cover image race condition — scope to pre-await document
- Agent mark decorations not rendering (stale nodeIds + wrapper block matching)
- Cover image leaking across documents when switching
- Copy button — use DOM extraction instead of getText()
- Workspace rename + auto-expand on `switch_document`
- Silent HTTP server failure + listen retry
- Orphaned server detection via health check

## [0.5.2] - 2026-02-28

### Added
- Agent Marks — inline feedback system for user→agent communication (select text, right-click, leave a note)
- `get_agent_marks` and `resolve_agent_marks` MCP tools (32 → 34 total tools)
- `read_pad` now shows mark counts (active doc + other docs) as a passive hint for agents
- Context menu "Agent Mark" action with inline note input (hidden when selection overlaps pending changes)
- Dotted underline decorations for marked text, synced via WebSocket

### Fixed
- Template docs created with `create_document({ empty: true })` now rename from `_untitled-xxx.md` to title-based filename when `set_metadata` sets a title
- File promotion also updates workspace references, marks sidecars, and caches

## [0.5.1] - 2026-02-28

### Added
- `rename_item` MCP tool for renaming workspaces, containers, and documents
- `filename` parameter on `write_to_pad` and `edit_text` for async agent writes to non-active docs
- In-memory document cache for stable node IDs across doc switches

### Fixed
- "End" sentinel insert — resolve to real node ID before browser broadcast (fixes lost inserts)
- Green decoration for empty-node rewrites (was incorrectly showing blue)
- Ghost pending cache entries for files deleted between server restarts
- `populate_document` race condition — write to disk by filename without switching active doc
- SKILL.md updated to document required `filename` parameter

## [0.5.0] - 2026-02-27

### Added
- Thread compose mode — multi-editor tweet threads with reply chain posting (`/api/x/post-thread`)
- Document reordering via drag-and-drop with `_doc-order.json` manifest
- Duplicate document action in sidebar right-click menu
- Card density dropdown — full/compact/minimal doc card sizes
- Plugin sidebar actions infrastructure with Focus Instructions modal
- Image support in X/Twitter posting flow
- Selection-range decoration system for right-click rewrites (atomic range replacement)
- Prompt debug inspector — writes full AV prompt to timestamped `.md` file
- Plugin attribution in context menus with section headers and dividers

### Changed
- Sidebar redesigned — unified cards style, removed style picker, separator-based sections
- Color palettes simplified to light/dark mode only
- Image gen upgraded from Imagen 4 to Nano Banana 2, works from any node
- Context menus gain viewport-aware positioning
- Templates stored as named docs instead of ephemeral temp files
- Doc-switch flicker eliminated — stable editor with `setContent()`
- Thread footer follows focused tweet, matching X behavior

### Fixed
- Tweet thread loss on refresh — flush was sending only first tweet
- Ctrl+R refresh bug — thread docs only showing first tweet
- Stale pending cache after resolving changes on active doc
- Duplicate link/underline extensions — StarterKit v3 includes them
- Floating toolbar persisting after editor blur with pending decorations
- Right-click selection capture — preserve sub-paragraph selection
- Review panel navigation across all tweet editors in thread
- Pending decorations missing in tweet template editors
- Sidebar reorder triggered by redundant save/mtime changes

### Security
- Localhost hardening — bind 127.0.0.1, WS origin check, block cross-origin flush
- Atomic writes + path traversal hardening + git sync flush

## [0.4.0] - 2026-02-24

### Added
- Marketing site at openwriter.io — Astro 5 + Cloudflare Workers, dark monochromatic design
- Skill v0.4.0 — all 30 MCP tools documented, tweet compose mode, article templates
- `generate_image` and 4 version tools now documented in SKILL.md
- First-position MCP config advice and slow-to-load troubleshooting in skill
- Copy button on skill install command (site hero)

### Changed
- Skill install command on site changed to `npx openwriter install-skill` (cleaner than long GitHub URL)
- SKILL.md synced across all three locations (bundled, repo, local) — tool count 24 → 30
- Decoration system upgrade — inline decorations, active gutter, original/modified toggle
- Themes split into independent colors + typography + spacing axes
- Site logo and favicon updated to app's pencil icon
- Release flow now includes SKILL.md version bump and sync steps

### Fixed
- Insert replaces empty node instead of appending after it

## [0.3.1] - 2026-02-22

### Added
- 4 version MCP tools: `list_versions`, `create_checkpoint`, `restore_version`, `reload_from_disk` — agent self-recovery without browser UI
- Article cover image carousel with save button
- Longform tweets — 280 char limit is now soft, not a gate

### Fixed
- Markdown round-trip preserving hardBreaks and empty paragraphs
- Tweet compose Enter now produces `<br>` not `<p>`
- Empty paragraphs visible in tweet compose mode
- Sidebar title updates live on article title change
- Reject-all cache desync, stuck spinner, workspace doc delete
- `populate_document` desync with `import_gdoc` clarification
- Ephemeral auto-delete removed for tweet/article templates

### Changed
- MCP pipeline speed optimizations (Phase 1)
- 29 core MCP tools (was 25)

## [0.3.0] - 2026-02-20

### Added
- X Article compose view — scoped editor matching X's article format with HTML copy for pasting
- Templates dropdown in titlebar for creating tweets, replies, quote tweets, and articles
- `generate_image` MCP tool — generate images via Gemini Nano Banana 2, optionally set as article cover atomically
- Image generation plugin (`@openwriter/plugin-image-gen`) — right-click empty paragraphs to generate AI images inline
- Plugin category system with `empty-node` context menu condition for category-specific actions
- Tweet Post button wired to X API via plugin system
- Canvas Paper mode with rounded/square corner options
- Live character counter and contextual placeholder text for tweet compose
- Ephemeral doc cleanup — posted tweets auto-trashed on next startup
- Built-in update check with global install recommendation
- Theme-aware scrollbar styling for dark mode

### Changed
- Tweet compose redesigned as document type (metadata-driven) instead of appearance style
- Pixel-accurate X/Twitter CSS overhaul for tweet compose — reply threads, quote cards, action bar
- `create_document` gains `empty` flag for instant template docs that skip the writing spinner
- Article title input shows placeholder instead of default text ("Article", "Untitled", "New Document")
- Ephemeral docs now move to OS trash instead of permanent delete
- MCP server renamed from `open-writer` to `openwriter`
- MCP stdio transport starts before Express/plugin setup for faster agent connection
- 25 core MCP tools (was 24)

### Fixed
- Floating toolbar hanging after text deselection
- Article footer clipped by flex stretch + overflow hidden
- Empty `articleContext` no longer incorrectly triggers article view
- Tweet compose wrapper no longer stretches full page height

## [0.2.2] - 2026-02-18

### Fixed
- Race condition where accepting changes on a populated document while agent creates another document caused accepted changes to revert
- Server now validates doc-update targets match active file, routes mismatched updates to correct file on disk

### Changed
- Tags are now document-scoped (stored in frontmatter) instead of workspace-scoped — tags travel with the document
- Simplified `tag_doc` and `untag_doc` MCP tools (no workspace parameter needed)
- Two-step document creation flow: `create_document` (shows spinner) then `populate_document` (delivers content)
- Documents deleted via OS trash (recoverable) instead of permanent delete

### Removed
- Workspace-level tag storage (`workspace-tags.ts` deleted)

## [0.2.1] - 2026-02-17

### Changed
- Updated SKILL.md for dual-entry orientation (skill-first and MCP-first discovery)
- Added `install-skill` CLI command for skill distribution

## [0.2.0] - 2026-02-17

### Added
- Skill distribution via `npx openwriter install-skill`
- Markdown-native README rewrite
- Plugin selector dropdown with dynamic enable/disable from UI
- Canvas style options in Appearance panel

## [0.1.0] - 2026-02-17

### Added

- TipTap 3.0 rich text editor with React frontend
- 24 MCP tools across document, multi-doc, workspace, and import operations
- Pending change decoration system (insert/rewrite/delete with accept/reject)
- Review panel with vim-style keyboard navigation (j/k/h/l/a/r)
- Multi-document workspaces with containers, tags, and shared context
- 4 sidebar views: tree, timeline, board, shelf
- Right-click context menu with plugin-provided AI actions
- 5 themes (Ink, Novel, Mono, Editorial, Studio) with light/dark modes
- Compact tagged-line wire format for token-efficient agent I/O
- Git sync (GitHub CLI, PAT, or existing repo)
- Version history with rollback
- Export to Markdown, HTML, Word, Plain Text, PDF
- Image upload via paste and drag-and-drop
- Internal document links with click-to-navigate
- Plugin system for extending MCP tools, HTTP routes, and context menu
- Google Doc import with auto-chapter splitting
- Multi-session support (additional instances proxy via HTTP)
- CLI with `--port`, `--no-open`, `--api-key`, `--plugins` flags
