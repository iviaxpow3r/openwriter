# Platform Transforms

> Architecture decision: sidebar transforms move to OpenWriter Publish. Author's Voice stays standalone.
> Decided: 2026-04-05 (revised from 2026-04-03 full-collapse plan)

---

## Why

The original plan collapsed all of Authors Voice into the publish worker. That was wrong — AV's voice engine (profiles, content samples, RAG, analysis, rewriting) is a different product from document transforms. Transforms take content and reshape it for a channel. Voice takes content and rewrites it to sound like you. Different jobs, different infrastructure.

Sidebar transforms don't need voice profiles, writing samples, or RAG search. They work immediately with zero setup — Claude + action-specific prompts. That's what belongs in publish.

## What Moves to Publish

The 7 sidebar document transforms:

| Transform | Output | What It Does |
|-----------|--------|-------------|
| **Vary** | Same format, different expression | Authentic variation preserving voice + specificity |
| **Shrinkify** | 40-60% shorter | Condense while preserving meaning and scannability |
| **Expandify** | 50-100% longer | Add depth, examples, context, elaboration |
| **Threadify** | X/Twitter thread | JSON tweet array, 265-char limit, viral-optimized |
| **Storify** | Social story | Punchy single-sentence paragraphs, first-person |
| **Emailify** | Newsletter email | Subject + HR + body (follows Storify rules) |
| **Postify** | 5 standalone tweets | Different angles/hooks on same source content |

### Endpoint

```
POST https://publish.openwriter.io/transforms
Authorization: Bearer ow_live_xxx
```

Gated by `requirePlan` middleware — any paid subscription tier gets access.

## What Stays in Authors Voice

Everything voice-related stays at `api.authors-voice.com`:

- Voice profiles (CRUD, analysis, guidelines)
- Writing sample management (upload, index, categories)
- GrepRAG pipeline (FTS retrieval, chunk scoring)
- Voice rewrite/generate (in-editor right-click actions)
- Content voice analysis

The AV plugin's context menu actions (Enhance, Modify, Shrink, Expand, Insert, Fill) continue routing to AV standalone.

## Plugin Routing Split

The `authors-voice` plugin (`plugins/authors-voice/src/index.ts`) routes to two backends:

| Handler | Target | Why |
|---------|--------|-----|
| Sidebar action (`/api/voice/sidebar-action`) | Publish `/transforms` | Document transforms, no voice needed |
| Wildcard (`/api/voice/*`) | AV `api.authors-voice.com` | Voice rewriting, profiles, content |

## Implementation

Publish module: `src/modules/transforms/` — 7 files, ~980 lines. No DB, no voice profiles, no RAG.

Source files ported from AV (`C:\authors-voice\packages\api\src\services\`):
- `DocumentTransformPrompts.ts` → `transform-prompts.ts` (remove RAG params)
- `DocumentTransformService.ts` → `transforms.ts` (remove profiles, RAG, usage)
- `ThreadifyPromptRules.ts` + `StorifyBodyRules.ts` → `thread-rules.ts`
- `ThreadParserService.ts` → `thread-parser.ts`
- `ThreadTypes.ts` → `thread-types.ts`
- `AVModelService.ts` → `model.ts`

Full implementation plan: `~/.claude/plans/gentle-riding-lark.md`

## Action Configs

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

Note: In AV, shrinkify/expandify/postify optionally inject voice profiles and expandify optionally uses RAG. In publish, these are omitted — transforms work standalone. Quality is maintained by ANTI_AI_RULES (enforced across all prompts).
