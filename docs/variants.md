# Document Variants

> Core editor feature. Master/child document relationships with sidebar tree nesting.
> Status: Spec (not yet implemented)

## Problem

Content gets repurposed across formats — a newsletter becomes a blog post, a thread becomes a tweet, an article becomes a LinkedIn post. Today these derivatives are disconnected docs scattered across workspaces. Finding all versions of a piece of content requires manual memory.

## Concept

Every document can have **variants** — derivative documents in different formats, created from the master doc. The master doc owns a tree of its variants. When you click a doc, you see an indented tree of all its variants below it in the sidebar.

```
The Territory Report #1          [newsletter]  ← master
  ├─ The Territory Report #1     [blog]        ← variant (blogify)
  ├─ TR#1 Summary Thread         [tweet]       ← variant (threadify)
  ├─ TR#1 — hook angle           [tweet]       ← variant (postify)
  ├─ TR#1 — data angle           [tweet]       ← variant (postify)
  └─ TR#1 — Working Notes        [document]    ← variant (doc-ify)
```

## Ownership

**Core editor** owns the variant data model and sidebar UI. This is a generic document relationship — no cloud service needed for the basic operations.

**Publish plugin** uses variants when creating AI-powered transforms (Threadify, Postify, etc.). The transform creates a variant doc with `masterDocId` set, and the core editor renders it nested in the sidebar. See [platform-voice-transforms.md](platform-voice-transforms.md).

## Data Model

Frontmatter fields on variant docs:

```yaml
masterDocId: "6e52ca05"    # parent document (null/absent = this IS the master)
variantType: "blog"        # what kind of variant (blog, tweet, thread, linkedin, newsletter, document)
```

The master doc doesn't store a list of variants. The relationship is discovered by querying all docs where `masterDocId` matches. No bidirectional sync.

## Sidebar UI

When a doc has variants, it renders as an expandable tree node (like a mini-container, but doc-level). Click the chevron to expand/collapse the variant list. Variants are indented and show their format badge.

The variant tree replaces the need to:
- Create containers just to group content + its derivatives
- Manually move blog conversions to the right workspace
- Remember which docs are related

## Core Operations (No Cloud Service)

- **Create empty variant** — right-click master → pick format → empty doc nested under master
- **Duplicate as variant** — clone master content into a new variant
- **Delete variant** — variant is removed; master unaffected
- **Delete master** — variants become orphaned masters (promote to top-level)

## Workspace Behavior

Variants live with their master doc. If the master is in the Newsletter workspace, its variants appear nested under it. A variant CAN also appear in another workspace (e.g., the blog variant also shows in "TM Blog Posts"), but its primary home is under the master.

## Open Questions

1. **Can a variant have variants?** Probably yes — just chain masterDocId. The tree renders recursively.
2. **Should variant creation auto-populate content?** For core editor: no (empty doc). For publish transforms: yes (AI-generated content).
3. **Should variants sync with master edits?** No. Once created, a variant is independent. The master is the source of truth for the original; variants diverge intentionally.
