# Vault Bridge — Obsidian-style features for OpenWriter

> Features that turn OpenWriter into a viable second-brain surface
> alongside its writing-and-shipping wedge. Most reuse plumbing that
> already exists (search_docs MCP, get_graph, doc: link click router,
> paragraph picker). The data model needs almost nothing new — this
> is mostly UI work.

---

## Bucket A — half day or less each

Status legend: `[ ]` not started · `[x]` shipped · `[~]` partial.

- [ ] **Search dropdown.** Wire the existing sidebar search input to a new `/api/search` HTTP route that wraps `searchDocuments` (server/documents.ts:322). Render results as a dropdown; click → switch doc + scroll to nodeId via the same mechanism `handleLinkClick` uses in App.tsx. The MCP tool `search_docs` already exists; only the HTTP route + dropdown component are new.
- [ ] **Outline panel.** Walk the editor's heading nodes, render a collapsible TOC (sidebar section or right-side slide-out). Click → scroll to the heading. Same scroll-to-nodeId plumbing as link clicks. Pure UI on existing state.
- [ ] **Bookmarks.** Add `bookmarked: true` flag in frontmatter; sidebar gets a "Bookmarks" section that filters on it. Two hours.
- [ ] **Aliases in search.** Add `aliases: [...]` to frontmatter, expand `searchDocuments` to match against them too. Few lines.
- [ ] **Daily notes button.** One button creates `YYYY-MM-DD.md` (or opens it). Reuses `createDocument`.

## Bucket B — day or two each

- [ ] **`[[` wikilink picker.** TipTap input rule on `[[` opens the same doc picker we built for the right-click "Link to doc" flow (with the paragraph drill). Auto-completes against titles + aliases, emits a `doc:DOCID#NODEID?q=...` link under the hood — same data, same renderer, just faster to type.
- [ ] **Backlinks panel below the editor.** Backlinks already live in `metadata.backlinks` (drives the dotted underline). Render them as a collapsible strip beneath the doc with click-to-jump.
- [ ] **Hover preview on `doc:` links.** Tooltip with target title + first paragraph. Needs a small fetch endpoint (or reuse `/api/documents/by-doc-id/:docId/paragraphs`) plus a tooltip component.
- [ ] **Command palette (Cmd+P).** Fuzzy finder over the actions the right-click menu already enumerates in ContextMenu.tsx.
- [ ] **Templates.** `_templates/` folder, picker on doc creation, seed via `create_document`'s existing content param.

## Skip for now

- **Markdown-it freebies** (callouts, KaTeX, mermaid, footnotes) — each is its own day because every node needs both a markdown-it rule, a TipTap node spec, and a serializer round-trip. Not the "hours of work" the back-of-envelope claims.
- **Tag browser sidebar** — depends on how cross-cutting tags are stored across the workspace schema; verify before scoping.
- **Unlinked mentions** — cross-doc title scan + UX for promote-to-link. Needs design thinking.
- **Transclusion** (`![[doc#section]]`) — new TipTap node type that fetches and renders read-only content + invalidation on source change. Medium lift, not easy.
- **Multi-pane editing** — the state model assumes one active doc; the WS layer broadcasts a single switch event. Architectural push, not feature work.

## Recommended starting pair

`Search dropdown + Outline panel`. Together they turn the app into something you'd reach for to navigate a vault, both reuse plumbing already shipped (search_docs server-side, scroll-to-nodeId from link clicks), single afternoon of work.

## Why this exists

OpenWriter and Obsidian solve different problems. Obsidian is where you keep what you know; OpenWriter is where you write what you ship. But the storage layer is shared shape — plain .md files, frontmatter, doc-to-doc links, backlinks via `get_graph`, workspace tree, version history. The gap is UI, not foundation. The features above close enough of that gap to make OpenWriter usable as a vault without forking the writing-and-shipping focus.
