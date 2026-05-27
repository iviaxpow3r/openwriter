# populate_document silent-drop — architectural diagnosis

**Status:** parent's hypothesis refuted; actual bug found and reproduced empirically.
**Worktree:** `C:\openwriter\.claude\worktrees\friendly-gauss-ea7f5c` (branch `claude/friendly-gauss-ea7f5c`)
**Author:** chip session, 2026-05-27.

## TL;DR

The parent diagnosed this as a WS handler / lock-window race in the **active-doc** path. The empirical reproduction (which uses `create_document` without `empty:true` followed by `populate_document` with `docId`) does **not exercise the active path at all** — it routes through the **non-active** `populateDocumentFile` branch (mcp.ts:733-749). The bug is server-internal, requires no browser, and has nothing to do with `ws.ts:339`.

**The actual architectural fault:** when the May 17 canonical+overlay refactor (`fb666e6`) moved pending state out of the .md frontmatter and into the per-docId sidecar at `_pending/{docId}.json`, every **write** path that serializes a non-active doc was updated to save the sidecar, but the **read** path that resolves a non-active doc was **never updated to read the sidecar**. `populateDocumentFile` saves the 6 pending entries correctly; `read_pad`'s non-active path then reads disk via `markdownToTiptap` which knows nothing about sidecars, returns the bare canonical body (one stub paragraph), and reports `words: 0, pending: 0`.

`write_to_pad` survives this bug **by accident**: `applyChangesToFile` calls `updateCacheEntry` after `flushDocToFile`, and the cache stores the merged view (canonical + applied overlay). `populateDocumentFile` omits the `updateCacheEntry` call, so the cache never gets the merged view — and even a cache hit isn't guaranteed (mtime invalidation would still drop us back to the broken disk-only read).

**One-sentence architectural fix:** the on-disk representation of any doc is the pair `(canonical .md, sidecar overlay)`, so the function that loads a doc by filename must read both — `markdownToTiptap`-via-`resolveDocTarget` must apply the sidecar overlay before returning the document.

## 1. Lifecycle trace (the non-active branch)

The empirical reproduction:

```
create_document(content_type: "document", title: "X")
  → mcp.ts:707-705  (the "Two-step flow" branch, lines 666-700)
  → documents.ts:906 createDocumentFile
      → atomicWriteFileSync(filePath, "---\n{minimal frontmatter}\n---\n\n[empty stub para]")
      → markAsAgentStub(filename)
      ✗ NO updateCacheEntry call — no cache entry exists for the new doc
  → spinner broadcast; does NOT switch the active view
  → returns docId

populate_document(docId, content: "## A\n\npara\n...")
  → mcp.ts:714 handler entry
  → mcp.ts:715  filename = resolveDocId(docId)   // the just-created file
  → mcp.ts:719  parseMarkdownContent(content) → 6 nodes with generated IDs
  → mcp.ts:734  targetIsNonActive = (filename !== getActiveFilename())
                = TRUE (create_document never switched)
  → mcp.ts:735  populateDocumentFile(filename, doc)
      → state.ts:3164  raw = readFileSync(targetPath)   // the empty stub
      → state.ts:3165  parsed = markdownToTiptap(raw)   // 1 stub paragraph
      → state.ts:3170  markAllNodesAsPending(doc, 'insert')
                       // all 6 nodes now have attrs.pendingStatus='insert'
      → state.ts:3183  canonical-preserve (4d78be0/b5119e5):
                       doc.content = [6 pending] + [stub paragraph]
      → state.ts:3198  flushDocToFile(filename, doc, ...)
          → tiptapToMarkdown(doc, ...)
              → revertPendingForSerialization(doc)
                  → pending-insert nodes are FILTERED OUT (line 216)
                  → returns { content: [stub paragraph] }
              → emits frontmatter (no `pending:` key — sidecar-only model)
              → body has ONLY the stub paragraph
          → atomicWriteFileSync(targetPath, markdown)
              // Disk now: empty stub body, frontmatter has no overlay info
          → extractOverlay(doc) → 6 PendingEntry objects (correct anchors)
          → saveOverlay(docId, overlay) → writes _pending/{docId}.json
              // Sidecar now correctly holds all 6 entries
          → setPendingCacheEntry(filename, 6)
              // Pending COUNT cache updated (used by sidebar / list_documents)
          ✗ NO updateCacheEntry call — the document CACHE is untouched
      → returns { wordCount: 18, pendingCount: 6 }   // computed from in-memory `doc`
  → broadcasts (irrelevant to the bug)
  → returns "Populated 'X' — 18 words"

read_pad(docId, force: true)
  → mcp.ts:325  resolveDocTarget(docId)
      → mcp.ts:127  filename === activeFilename ? NO (still non-active)
      → mcp.ts:144  cached = getCachedDocument(filePath)
                    // No cache entry was ever written for this docId.
                    // Returns null.
      → mcp.ts:163  raw = readFileSync(filePath)
      → mcp.ts:164  parsed = markdownToTiptap(raw)
                    // Reads body (one stub paragraph) + frontmatter.
                    // markdownToTiptap line 176-178 rehydrates pending state
                    // from `data.pending` IF PRESENT in frontmatter — but
                    // the sidecar-only model means data.pending is never
                    // written, so rehydrate is a no-op.
                    // markdownToTiptap NEVER reads _pending/{docId}.json.
      → mcp.ts:166-167  countPending(parsed.document.content) → 0
      → returns { document: 1 stub paragraph, pendingCount: 0, wordCount: 0 }
  → response: "words: 0, pending: 0, [p:adee210a]"
```

Verified end-to-end against the live MCP — the test doc is at
`~/.openwriter/profiles/Default/Diag Populate Bug Test.md` (docId `0dd4ab4c`),
disk body is one empty `[adee210a]` paragraph, sidecar
`~/.openwriter/profiles/Default/_pending/0dd4ab4c.json` contains all 6 inserts
with correct anchors. **The data is on disk and intact; the read path can't see
it.**

The lifecycle has no ambiguity: every step is synchronous, sequenced, and observable on disk. There is no race. The bug is structural.

## 2. Commit archeology

Filtered to the populate path. Earliest → latest:

| Hash | Date | Author / Subject | Structural effect |
|------|------|------------------|-------------------|
| `09e8693` | (early) | wip: Add empty flag to create_document for instant template docs | Introduced the `empty:true` shortcut; the default `empty:false` path remained "create stub on disk, populate later." |
| `5d960e7` | | fix: populate_document desync + rename import_gdoc to import_content | First desync fix; populate writing into active state. |
| `8062caa` | | fix: populate_document desync + clarify import_gdoc purpose | Iterates on the same desync class. |
| `79aba43` | 2026-02-27 | wip: fix populate_document race — write to disk by filename without switching active doc | **Created `populateDocumentFile` and the non-active branch in the MCP handler.** At this time, `tiptapToMarkdown` still wrote `pending:` into frontmatter, so disk-only reads via `markdownToTiptap` did see the pending state. populateDocumentFile worked end-to-end *because the disk file carried the overlay*. |
| `b65b0af` | | wip: fix create_document hijacking user's active editor focus | Refined two-step flow; the non-active populate path became the **default** for content docs. |
| `3d7ee36` | | wip: switch MCP tools from filename to docId as primary identifier | Renamed param to docId; non-active path now resolves filename from docId. |
| `fb666e6` | 2026-05-17 | refactor(state): canonical + overlay as primary, document as derived | **Load-bearing.** Moves pending state from frontmatter `pending:` field to a sidecar at `_pending/{docId}.json`. Updates writeToDisk + flushDocToFile to write the sidecar. Updates the *active-doc* read path (the in-memory `state.document` is the merged view). **Does NOT update the non-active read path** — `markdownToTiptap` is never taught to load the sidecar, and `resolveDocTarget`'s disk-fallback branch is untouched. Latent bug introduced here. |
| `4867963` | | fix: symmetric overlay save on non-active write paths | Confirms `flushDocToFile` saves the sidecar for non-active writes. Half-symmetry: writes are correct, reads still aren't. |
| `f6247ae` | | fix(overlay): container nodes become first-class pending entries | Doesn't touch the cache/sidecar read split. |
| `89a548a` | 2026-05-20 | wip(state): drop transferPendingAttrs safety net — fixes accept-all content loss | Tangential — removes the active-path defensive net. |
| `4d78be0` | 2026-05-21 | fix(populate_document): preserve canonical state across populate | Adds the **active-path** canonical-preserve. Commit message explicitly names a separate deferred issue, "Bug #1b — the agent-write lock window race" — but that's the parent's hypothesis, **not the bug we're chasing**. |
| `b5119e5` | 2026-05-21 | fix(populate_document): preserve canonical state in non-active path | Mirrors the active-path canonical-preserve into `populateDocumentFile`. Touches `populateDocumentFile` directly without noticing the missing cache update or the sidecar-blind read path. |
| `d133912` | 2026-05-25 | wip(state): bump docVersion before applying changes in applyChanges | Closes the `applyChanges` (write_to_pad) version-stamp race. ADR entry explicitly defers `updateDocument()` — i.e. the **active** populate path — as out of scope. **Confirms that no fix yet exists for either populate path's known issues; my findings here add a third, distinct fault that none of the prior fixes touched.** |
| `03fa773` | 2026-05-25 | Merge chip/delete-silent-failure | Lands the d133912 fix. |

**No commit between fb666e6 and today has updated `markdownToTiptap`, `resolveDocTarget`, or any non-active read path to read the per-docId sidecar.** The cache-update omission in `populateDocumentFile` has also gone unnoticed since fb666e6.

## 3. Architectural diagnosis (independent)

**Architectural fix (one sentence):** the persistent representation of an OpenWriter doc is the pair `(canonical .md body, _pending/{docId}.json overlay)`, and the read function that materializes a doc by filename must load and apply both — not the body alone.

**The bug class this closes.** Any code path that:
1. Reads a non-active doc via `resolveDocTarget` → cache-miss → `markdownToTiptap` fallback, AND
2. Whose doc currently has a non-empty sidecar overlay,

will see canonical without the overlay. Today that surfaces in `read_pad`. Tomorrow it'll surface in any other MCP tool that resolves a target via `resolveDocTarget` (search_docs, get_metadata when it pulls the doc, etc.). Right now the only mitigation is "warm the cache via `updateCacheEntry`" — which `applyChangesToFile` does and `populateDocumentFile` does not. The cache is best-effort (mtime-validated, evictable), so even paths that warm it still expose the same fault when the cache misses.

**Compared to the parent's proposed fix.** Parent proposed reordering `ws.ts` so version-merge runs before lock-block. That fix is aimed at a **different** bug entirely: the browser-bounce silent-drop where a stale browser doc-update wipes server overlay after the lock expires. The lock-window race is real — `d133912`'s ADR entry explicitly flags `updateDocument` as having the same off-by-one as the already-fixed `applyChanges`, and that bug *would* fire if a browser were connected, the active path were used, and a browser doc-update arrived with `browserVersion=preBump`. It is **worth fixing**, but it is **not the cause** of the parent's empirical reproduction.

The reproduction the parent ran:
- create_document without `empty:true` → file created, **not active**
- populate_document with docId → routes to **non-active** populateDocumentFile
- read_pad → server-internal, no browser, no WS, no lock involved

This is verifiable empirically (I reproduced it twice in this chip session — see §4) and structurally (the lock check at ws.ts:339 sits in the `'doc-update'` message handler, which is only reachable via WebSocket from a browser).

**Convergence/divergence with parent.** Diverges. The parent identified a real architectural concern (the lock-window race for the active path) but mis-attributed the empirical symptom to it. The parent's proposed reorder would NOT fix the empirical symptom. The fix this chip proposes is in a different file (state.ts / pending-overlay.ts), addresses a different bug class, and is the actual cause of the parent's reproduction.

## 4. Live reproduction verification

Reproduced against the running openwriter MCP (this chip session's MCP transport).

**Test 1 — populate_document on a non-active doc:**

```
create_document(content_type: "document", title: "Diag Populate Bug Test")
  → "Created 'Diag Populate Bug Test' [0dd4ab4c] — empty.
     Call populate_document with docId '0dd4ab4c' to add content."

populate_document(docId: "0dd4ab4c", content:
  "## Section A\n\nparagraph alpha goes here\n\nparagraph beta with words\n\n
   ## Section B\n\nparagraph gamma now\n\nparagraph delta finally")
  → "Populated 'Diag Populate Bug Test' — 18 words"

read_pad(docId: "0dd4ab4c", force: true)
  → title: Diag Populate Bug Test
    words: 0
    pending: 0
    ---
    [p:adee210a]
```

**Disk state after the populate** (verified via direct filesystem read,
NOT through MCP):

```
~/.openwriter/profiles/Default/Diag Populate Bug Test.md:
---
{"title":"Diag Populate Bug Test","docId":"0dd4ab4c","status":"draft",
 "enrichmentStale":true,"nodes":[["adee210a"]]}
---

(empty body — only the stub paragraph's slot)
```

**Sidecar state** (also direct filesystem read):

```
~/.openwriter/profiles/Default/_pending/0dd4ab4c.json:
{
  "version": 1,
  "entries": [
    { "nodeId": "d5f2af11", "status": "insert", "afterNodeId": "adee210a", "newContent": { /* Section A */ } },
    { "nodeId": "9bda72ad", "status": "insert", "afterNodeId": "d5f2af11", "newContent": { /* paragraph alpha */ } },
    { "nodeId": "6a981af6", "status": "insert", "afterNodeId": "9bda72ad", "newContent": { /* paragraph beta */ } },
    { "nodeId": "3a2d8dfa", "status": "insert", "afterNodeId": "6a981af6", "newContent": { /* Section B */ } },
    { "nodeId": "b9664371", "status": "insert", "afterNodeId": "3a2d8dfa", "newContent": { /* paragraph gamma */ } },
    { "nodeId": "f2f9241b", "status": "insert", "afterNodeId": "b9664371", "newContent": { /* paragraph delta */ } }
  ]
}
```

Both halves of the persistent representation are present and correct. The bug
is entirely in the read path's failure to combine them.

**Test 2 — same content via write_to_pad (the control case):**

```
write_to_pad(docId: "0dd4ab4c", changes: [
  { operation: "insert", afterNodeId: "end", content: "## Section A\n\n..." }
])
  → { success: true, appliedCount: 1, lastNodeId: "f2f9241b" }

read_pad(docId: "0dd4ab4c", force: true)
  → title: Diag Populate Bug Test
    words: 18
    pending: 6
    ---
    [p:adee210a]
    [h2:d5f2af11] Section A
    [p:9bda72ad] paragraph alpha goes here
    [p:6a981af6] paragraph beta with words
    [h2:3a2d8dfa] Section B
    [p:b9664371] paragraph gamma now
    [p:f2f9241b] paragraph delta finally
```

**Why the control works:** `applyChangesToFile` (state.ts:3211) calls
`updateCacheEntry(targetPath, doc, ...)` at line 3242 after the write. The
cache entry is built by `splitMergedDoc` + `applyOverlayPure`, so the cache's
stored `document` is the full merged view — including the inserts that
otherwise only live in the sidecar. The next `read_pad` hits the cache and
gets the merged view back. `populateDocumentFile` (state.ts:3198) ends at
`flushDocToFile` and never touches the cache, so its writes are invisible to
the very next `read_pad`. The control is held together by a cache-update call
the populate path forgot.

## 5. Proposed fix

**Architectural fix (one sentence — repeated):** make the read function that
materializes a doc by filename load and apply the sidecar overlay, so
`(canonical .md, _pending/{docId}.json)` together define the doc state for
every read path, not just for writes and active-doc state.

**Files touched + LOC estimate:**

- `packages/openwriter/server/markdown-parse.ts` — extend `markdownToTiptap`
  (or add a `loadDocFromDisk(filename, docId)` companion) so the returned
  `document` field has the sidecar applied. Sidecar load is via
  `loadOverlay(docId)` (already exported from pending-overlay.ts). Apply with
  `applyOverlayPure(parsed.document, entries)`. **~15 LOC**.
- `packages/openwriter/server/mcp.ts` — `resolveDocTarget`'s disk-fallback
  branch (lines 161-173) needs to call the new sidecar-aware loader; the
  cache branch (lines 144-159) already returns merged. **~5 LOC**.
- `packages/openwriter/server/state.ts` — optional belt-and-braces: have
  `populateDocumentFile` mirror `applyChangesToFile`'s `updateCacheEntry`
  call so even pre-fix code paths warm the cache. **~3 LOC**.

Total: ~25 LOC across 3 files. No schema changes, no migration. Pure read-path
addition.

**Risk + mitigation:**
- *Risk:* `markdownToTiptap` is called from many places. Some callers want the
  canonical body only (e.g. `applyChangesToFile`'s cache-miss branch, the
  matcher's `readPersistedIdentity`). Auto-applying the sidecar from inside
  `markdownToTiptap` would mutate their input shape.
- *Mitigation:* add a parameter or a sibling function. `markdownToTiptap`
  keeps its current behavior; a new `markdownToTiptapWithOverlay(raw, docId)`
  composes `markdownToTiptap` + `loadOverlay` + `applyOverlayPure`. Only the
  read paths that want the user-visible merged view call the new function.

**Cost:** small; the building blocks (`loadOverlay`, `applyOverlayPure`) all
exist and are well-tested.

**Acid tests:**

- *Could the same bug class come from a different code path?* Yes — any
  future MCP tool that calls `resolveDocTarget` to materialize a non-active
  doc inherits the fault. Closing it at the read layer (markdown-parse +
  resolveDocTarget) eliminates the class for everyone, not just `read_pad`.
- *If the fix were deleted, would the bug return identically?* Yes —
  reverting either the markdown-parse change OR the resolveDocTarget change
  resurfaces the exact symptom in the exact same way.
- *Does this change a model/invariant or just add a conditional?* Changes the
  contract of `markdownToTiptap` (or its sidecar-aware sibling): the function
  now respects the **(canonical body, sidecar overlay)** invariant that
  fb666e6 introduced on the write side but never enforced on the read side.
  The invariant is "a doc's full state is body + sidecar; any function that
  exposes a doc must reflect both." That's a model statement, not a
  conditional guard.

## 6. Other relevant unfinished work

From a sweep of commit messages for `Bug #` markers and explicit deferrals:

- **`4d78be0` — "Bug #1b" — agent-write lock window race.** The active-path
  populate's `setAgentLock` + browser doc-update race that the parent thought
  was *this* bug. It is a real, separate concern. Not what the empirical repro
  exercises, but worth fixing on its own merits. Symptom would surface as:
  user typing in browser → agent populates active doc → browser's pending
  autosave fires inside 3s lock window → BLOCKED → after lock expires, browser
  fires its next autosave → wipes overlay via `syncBrowserDocUpdate`'s
  off-by-one filter (`addedAtVersion > browserVersion` is FALSE for entries
  stamped at the pre-bump version).

- **`d133912` ADR entry — `updateDocument()` version-bump-after-apply.**
  Explicitly out of scope for the chip/delete-silent-failure work. Same
  off-by-one as `applyChanges` (fixed in d133912) but for the browser-doc-update
  path in `updateDocument`. The ADR notes "the browser is the source of any
  new entries there, so a same-browser stale race is structurally rare. Leave
  for a follow-up if it bites." That follow-up is still open. Materially the
  same bug class as 1b above — they're both manifestations of the
  "overlay-entry's addedAtVersion stamped before the bump that publishes it"
  invariant violation.

- **`d133912` ADR entry — `appliedCount` success-response semantics.** The
  contract question: a write tool returns appliedCount synchronously, then the
  silent-drop fires later. ADR proposes a read-back assertion as a future
  hardening. Open.

- **Pre-fb666e6 callers of `markdownToTiptap`.** The refactor moved pending
  state to sidecars but didn't audit every call site of `markdownToTiptap` to
  decide which need sidecar-merge and which don't. The chip's proposed fix
  introduces an explicit sibling for the merge case — but a wider audit is
  warranted: search_docs, browse_docs, list_documents (when it pulls doc
  content), peek_doc, outline_doc, get_metadata, get_pad_status are all
  candidates that may have the same latent visibility gap. Not investigated
  in this chip.
