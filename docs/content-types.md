# Content Types

Typed document creation with specialized compose views. Documents carry `*Context` metadata in frontmatter that activates the appropriate view.

## Content Types

| Type | Metadata Key | Compose View | Status |
|------|-------------|--------------|--------|
| **Document** | (none) | Default PadEditor | Built |
| **Tweet** | `tweetContext` | TweetComposeView | Built |
| **Article** | `articleContext` | ArticleComposeView | Built |
| **Blog** | `blogContext` | BlogComposeView | Built |
| **LinkedIn** | `linkedinContext` | (default for now) | Metadata only |
| **Newsletter** | `newsletterContext` | (default for now) | Metadata only |

## How It Works

1. User clicks "+" in sidebar → `CreateDocDropdown` shows all content types
2. Selection creates doc via `POST /api/documents` with `{ metadata: { *Context: { active: true } } }`
3. `App.tsx` checks metadata → renders appropriate compose view
4. `state.ts` auto-tags doc in sidebar (e.g. `blog`, `linkedin`, `newsletter`)

## BlogComposeView

Full blog compose view with metadata fields for static site publishing.

**Fields:** title, description (SEO), date, tags, author, slug, draft toggle, style preset (minimal/magazine/editorial)

**Key design:** `canSave = !!blogContext?.active` guard prevents metadata contamination during doc-switch transitions. Server-side guard in `setMetadata()` rejects blogContext writes without `active:true` as defense-in-depth.

**Files:** `src/blog-compose/BlogComposeView.tsx`, `BlogComposeView.css`

## Sidebar Integration

- `CreateDocDropdown.tsx` — dropdown on "+" buttons, shows all content types
- `sidebar-actions.ts` — `handleCreateInWorkspace` and `handleCreateDocumentWithType` accept optional metadata
- Auto-tagging: `state.ts` adds `blog`/`linkedin`/`newsletter` tags via `addDocTag()` when context metadata is set

## Publishing Pipeline (Blog via GitHub)

1. Blog doc created with `blogContext` metadata
2. User writes content, fills metadata fields (title, description, tags, etc.)
3. Post via connection: `POST /api/connections/:id/post` → platform proxy → GitHub Contents API
4. Commits `.md` file with YAML frontmatter to configured repo/branch/path
5. Site CI/CD rebuilds (Netlify, Vercel, Cloudflare Pages, etc.)

**GitHub connection config** (stored in `platform_connections.config` JSONB): `repo`, `owner`, `branch`, `contentDir`, `imageDir`, `installationId`

## Current State

- CreateDocDropdown built and wired into all sidebar "+" buttons
- BlogComposeView built with cover image, metadata fields, style presets
- blogContext contamination fixed (client `canSave` guard + server `setMetadata` guard)
- Auto-tagging works for blog/linkedin/newsletter
- GitHub posting pipeline tested end-to-end (file commits successfully)
- `data-view="blog"` attribute on `<html>` for CSS scoping

## Pending

- `inferContentType` in SchedulePostModal: add linkedin/newsletter/blog detection
- `ws.ts` `create-template` handler: add linkedin/newsletter/blog cases for MCP agents
- Remove TemplatePanel from Titlebar (old dropdown, replaced by sidebar CreateDocDropdown)
- LinkedIn/Newsletter compose views (currently use default editor)
- Blog publish transform: generate clean YAML frontmatter from blogContext metadata
- `imagePrefix` field in GitHub connection config for correct frontmatter image paths

## Key Files

| File | Purpose |
|------|---------|
| `src/blog-compose/BlogComposeView.tsx` | Blog compose view component |
| `src/blog-compose/BlogComposeView.css` | Blog compose styles |
| `src/sidebar/CreateDocDropdown.tsx` | Content type dropdown on "+" buttons |
| `src/sidebar/sidebar-actions.ts` | Doc creation with metadata |
| `src/App.tsx` | View routing: `hasBlogContext()` → BlogComposeView |
| `server/state.ts` | Auto-tagging + blogContext contamination guard |
