# Blog Compose View — no bidirectional state-mirror

## Context

`BlogComposeView` renders structured fields (description, date, tags, author,
slug, draft, style) backed by `blogContext` in the active doc's metadata. The
view receives `blogContext` as a prop and persists changes via
`POST /api/metadata` → `broadcastMetadataChanged` → all clients receive a
fresh `metadata` object.

The naive shape — mirror every field into `useState`, sync from props on
`[blogContext]`, auto-save from `useEffect` on each mirrored state — creates
a feedback loop:

1. Sync effect runs `setStyle({ ...DEFAULT_STYLE, ...ctx.style })`. The spread
   always produces a new object reference, so `useState`'s `Object.is` bailout
   fails and `style` updates.
2. Style auto-save effect fires → `POST /api/metadata`.
3. Server saves, calls `broadcastMetadataChanged(getMetadata())`. The
   broadcast is `JSON.stringify(metadata)`, so the client always receives
   a fresh object graph.
4. `setMetadata(m)` in `App.tsx` hands a new `metadata` ref to the view.
   `blogContext = metadata?.blogContext` is a new ref. The `[blogContext]`
   sync effect fires again → goto 1.

The same applies to `tags` (array ref churns through JSON round-trip) and
`draft` (boolean is fine but still re-fires the sync effect).

Symptoms observed: openwriter Express server burning ~85% CPU for as long
as any blog doc was open, hundreds of MB of accumulated process memory,
constant WS broadcasts, constant disk writes. Commit 33809cb tried to fix
this by adding "skip first-run auto-save" guards, but the guards only reset
on `filename` change — once the user touched any field, the loop self-sustained.

## Current invariants

- **Fields that change via discrete actions** (`tags`, `style`, `draft`) are
  read **directly from `ctx`**. No `useState` mirror. Save happens in the
  event handler that triggered the action (`TagInput onChange`,
  `StyleControls onChange`, draft-toggle `onClick`).
- **Fields that need a typing buffer** (`description`, `date`, `author`,
  `slug`) keep local `useState` and save on `onBlur`. Their re-init effect
  depends on `[filename]`, **not** `[blogContext]` — so metadata broadcasts
  do not reset typing buffers mid-edit.
- `EMPTY_TAGS` is a module-level constant so `ctx.tags || EMPTY_TAGS` returns
  a stable reference when no tags are set.
- `style` is derived via `useMemo([ctx.style])` so callers get a stable ref
  between metadata broadcasts that don't actually change style.
- **Do not re-introduce a `useEffect` that writes to `/api/metadata` from a
  dependency on state that mirrors `blogContext`.** That is the loop.

## Decision log (append-only)

### 2026-05-25 — Root-cause fix
- Incident: openwriter localhost extremely slow; server process (PID 8680)
  at 280 MB / ~57 min accumulated CPU, the events log otherwise quiet.
  User suspected a recent commit.
- Change: removed `tags`/`style`/`draft` `useState` mirrors + the three
  auto-save effects + the `[blogContext]` sync effect + the `tagsFirst` /
  `styleFirst` / `draftFirst` first-run guards.
  `packages/openwriter/src/blog-compose/BlogComposeView.tsx` — see commit.
- Why: 33809cb's first-run-guard fix only suppressed the mount-time save;
  it did not break the structural cycle. Once any field was touched the
  loop self-sustained.

### 2026-06-01 — Per-doc `style` axis removed
- Change: removed the `StyleControls` footer UI, the `style` `useMemo`, and the
  `blog--font/width/spacing` wrapper classes. The blog editor now inherits the
  global Appearance panel's typeface + spacing (`data-typeface` / `data-spacing`
  on `<html>`), like every other editor; the card keeps a fixed 720px measure.
- Why: the per-doc font/width/spacing only ever restyled the *editor* — the
  published Astro output ignores it — so the controls misrepresented what they
  did. `tags` and `draft` still follow the read-directly-from-`ctx` invariant
  above; this change only drops the `style` consumer, so the no-feedback-loop
  invariant is unaffected (one fewer field, same pattern).
