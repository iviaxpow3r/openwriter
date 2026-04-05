# Platform Transforms + Document Variants

> Architecture decision: sidebar transforms move to OpenWriter Publish. Variant tree is a core editor feature. Author's Voice stays standalone.
> Decided: 2026-04-05

---

## Why

Transforms take content and reshape it for a channel. Voice takes content and rewrites it to sound like you. Different jobs, different infrastructure. Sidebar transforms don't need voice profiles, writing samples, or RAG — they work immediately with Claude + action-specific prompts. That's what belongs in publish.

The variant tree (master doc → nested child docs) is a generic document relationship that benefits the entire editor, not just transforms. Core editor owns the data model and sidebar UI. Publish plugin uses it when creating transform results.

## Two Layers

### Layer 1: Document Variants (Core Editor)

A generic parent/child document relationship. Any doc can have variants nested under it in the sidebar.

**Data model** — frontmatter fields on variant docs:
```yaml
masterDocId: "6e52ca05"    # parent document (null/absent = this IS the master)
variantType: "tweet"       # content type of the variant
```

**Sidebar UI**:
- Master docs with variants render as expandable tree nodes (chevron to expand/collapse)
- Variants are indented under their master, showing format badge
- Master doesn't store a list of variants — relationship discovered by querying `masterDocId`

**Core operations** (no cloud service needed):
- Create empty variant (right-click master → "Create variant" → pick format)
- Duplicate as variant
- Delete variant (orphans promote to top-level)

### Layer 2: Transform Actions (Publish Plugin)

AI-powered transforms that create + populate variants via the publish worker. Requires paid subscription.

The publish plugin registers sidebar menu items and handles the transform → variant creation flow.

## Transform Actions

### Ported from AV (battle-tested prompts, exact port)

| Transform | Output | Content Type | What It Does |
|-----------|--------|-------------|-------------|
| **Vary** | Same format, different expression | (same as master) | Authentic variation preserving voice + specificity |
| **Shrinkify** | 40-60% shorter | (same as master) | Condense while preserving meaning and scannability |
| **Expandify** | 50-100% longer | (same as master) | Add depth, examples, context, elaboration |
| **Threadify** | X/Twitter thread | `tweet` (thread) | JSON tweet array, 265-char limit, viral-optimized |
| **Storify** | Social story | `document` | Punchy single-sentence paragraphs, first-person |
| **Emailify** | Newsletter email | `newsletter` | Subject + HR + body (follows Storify rules) |
| **Postify** | 5 standalone tweets | `tweet` (single) | Different angles/hooks, each a separate variant |

### New transforms (to build)

| Transform | Output | Content Type | What It Does |
|-----------|--------|-------------|-------------|
| **Blogify** | Blog post | `blog` | Strip newsletter/article framing, build blog metadata |
| **Articleify** | X Article (long-form) | `tweet` (article) | Thread/tweet → long-form X Article |
| **LinkedIn-ify** | LinkedIn post | `linkedin` | Any → LinkedIn post format |
| **Doc-ify** | Plain document | `document` | Working notes, companion docs, research — seeded or empty |

### Postify: Multiple Variants

Postify creates 5 separate tweet variants (not 1 doc with 5 posts). Each is individually editable and schedulable. Requires variant tree to work properly — each tweet is a child variant of the master. Known-broken until variants ship.

```
My Essay on AI Safety              [document]  ← master
  ├─ AI Safety — hook angle        [tweet]     ← postify variant 1
  ├─ AI Safety — data angle        [tweet]     ← postify variant 2
  ├─ AI Safety — contrarian angle  [tweet]     ← postify variant 3
  ├─ AI Safety — question angle    [tweet]     ← postify variant 4
  └─ AI Safety — story angle       [tweet]     ← postify variant 5
```

## Plugin Ownership

**Publish plugin** owns all sidebar transform actions. Registers `sidebarMenuItems()` and handles `POST /api/publish/sidebar-action`.

**AV plugin** keeps sidebar items temporarily during transition. Remove from AV only after publish transforms confirmed working. AV retains context menu items (Enhance, Modify, Shrink, Expand, Insert, Fill) permanently — those are voice-powered.

## What Stays in Authors Voice

Everything voice-related stays at `api.authors-voice.com`:

- Voice profiles (CRUD, analysis, guidelines)
- Writing sample management (upload, index, categories)
- GrepRAG pipeline (FTS retrieval, chunk scoring)
- Voice rewrite/generate (in-editor right-click actions)
- Content voice analysis

## Endpoint

```
POST https://publish.openwriter.io/transforms
Authorization: Bearer ow_live_xxx

{
  "action": "threadify",
  "content": "full document content",
  "title": "document title",
  "instructions": "optional focus"
}

→ { success, html, newTitle, thread?, rawResponse?, metadata }
```

Gated by `requirePlan` middleware — any paid subscription tier gets access.

## Implementation

### Publish worker (`src/modules/transforms/`)

7 files, ~980 lines. No DB, no voice profiles, no RAG.

Source files ported from AV (`C:\authors-voice\packages\api\src\services\`):
- `DocumentTransformPrompts.ts` → `transform-prompts.ts` (remove RAG params)
- `DocumentTransformService.ts` → `transforms.ts` (remove profiles, RAG, usage)
- `ThreadifyPromptRules.ts` + `StorifyBodyRules.ts` → `thread-rules.ts`
- `ThreadParserService.ts` → `thread-parser.ts`
- `ThreadTypes.ts` → `thread-types.ts`
- `AVModelService.ts` → `model.ts`

### Action Configs (exact from AV)

```typescript
const ACTION_CONFIGS = {
  vary:      { temperature: 0.4, maxTokens: 4096, titleSuffix: '(Variation)' },
  shrinkify: { temperature: 0.3, maxTokens: 4096, titleSuffix: '(Shrunk)' },
  expandify: { temperature: 0.7, maxTokens: 8192, titleSuffix: '(Expanded)' },
  threadify: { temperature: 0.3, maxTokens: 4096, titleSuffix: '(Thread)' },
  storify:   { temperature: 0.5, maxTokens: 4096, titleSuffix: '(Story)' },
  emailify:  { temperature: 0.3, maxTokens: 4096, titleSuffix: '(Email)' },
  postify:   { temperature: 0.4, maxTokens: 4096, titleSuffix: '(Posts)' },
};
```

Note: In AV, shrinkify/expandify/postify optionally inject voice profiles and expandify uses RAG. In publish, these are omitted — transforms work standalone. Quality maintained by ANTI_AI_RULES.

## Build Order

1. **Transforms backend** — `src/modules/transforms/` in publish worker, deploy
2. **Publish plugin sidebar** — register sidebar menu items, add sidebar-action handler routing to publish worker
3. **Variant data model** — `masterDocId`/`variantType` frontmatter support in core editor
4. **Variant sidebar UI** — expand/collapse tree rendering, format badges
5. **Wire transforms → variants** — transform results create variant docs with `masterDocId` set
6. **Postify fix** — create 5 separate variant docs instead of 1 combined doc
7. **New transforms** — Blogify, Articleify, LinkedIn-ify, Doc-ify
8. **Remove from AV** — delete sidebar items from AV plugin after publish confirmed working
