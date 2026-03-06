# Connections

Platform-owned OAuth connections for content distribution. Users authorize OpenWriter once, we store tokens securely (AES-256-GCM in Neon), and the scheduler posts on their behalf. This is the paid convenience — users can't easily set up API keys themselves, so they pay for the platform to handle it.

Part of the **OpenWriter Platform** — delivered via the platform plugin. See [ecosystem.md](ecosystem.md) for the unified architecture.

## Strategy

**Connections are the $9/mo hook.** All connections unlock at the Creator tier. Writers who already use Substack, ConvertKit, or Beehiiv connect those platforms and write in OpenWriter — we capture them as $9/mo customers. Writers who want the full stack (built-in newsletter, publication hosting, paid subscriptions) upgrade to $19-29/mo.

**Why we connect to competitors instead of blocking them:**
- Blocking Substack/Beehiiv users pushes them away from OpenWriter entirely
- Gives competitors incentive to build their own editor to replace us
- We capture more writers at $9/mo than we lose at $29/mo
- Writers who outgrow their platform may upgrade to our built-in newsletter later

**The built-in newsletter ($19+) competes on merit**, not lock-in: zero take rate, integrated editor, AI features, same subscriber pool as the publication. It's the better option for new creators — but existing platform users keep their tools.

## Connection Types

### Social Media (reach)

| Provider | Auth | Post API | Status |
|----------|------|----------|--------|
| **X (Twitter)** | OAuth 2.0 + PKCE | `POST /2/tweets` | Built |
| **LinkedIn** | OAuth 2.0 | UGC Post API | Built |
| **Facebook Pages** | OAuth 2.0 (Meta) | Graph API `POST /{page-id}/feed` | Planned |

### Blog / CMS (cross-post)

| Provider | Auth | Post API | Notes |
|----------|------|----------|-------|
| **GitHub** | OAuth 2.0 | Contents API `PUT /repos/{owner}/{repo}/contents/{path}` | Covers all static sites: Astro, Hugo, Jekyll, Next.js, Eleventy, Gatsby |
| **WordPress** | OAuth 2.0 (wp.com) or App Password (self-hosted) | `POST /wp-json/wp/v2/posts` | Massive market, two auth paths |
| **Shopify** | OAuth 2.0 | `POST /admin/api/blogs/{id}/articles.json` | Store blog posts |
| **Medium** | OAuth 2.0 | `POST /v1/users/{id}/posts` | Limited but functional API |
| **Ghost** | Admin API Key (JWT) | `POST /ghost/api/admin/posts/` | Self-hosted blogs |

### Newsletter / Email Platforms (connect existing)

| Provider | Auth | Post API | Notes |
|----------|------|----------|-------|
| **Substack** | No public API | N/A | Possible via import/RSS workaround — limited |
| **ConvertKit** | OAuth 2.0 | `POST /v4/broadcasts` | Creator-focused |
| **Beehiiv** | API Key | `POST /v2/publications/{id}/posts` | Growing fast |
| **Mailchimp** | OAuth 2.0 | `POST /campaigns` + send | Largest market |

### Built-in Newsletter (core product, not a connection)

Our own newsletter infrastructure — SendGrid-backed, zero take rate. See [newsletter.md](newsletter.md).

**12 connections + built-in newsletter** (2 built, 10 planned).

## Architecture

All connections live on the platform (Neon), not locally. The local app proxies through the platform API.

```
Local App (ConnectionsPanel)
  -> POST /api/connections/oauth/:provider/start  (local Express proxy)
    -> GET /connections/oauth/:provider/url        (platform Worker)
    -> Returns { url, state }
  -> window.open(url)                              (user authorizes in browser)
  -> Platform callback stores tokens               (encrypted in Neon)
  -> Poll /api/connections/oauth/status            (local -> platform)
  -> Connection appears in list
```

### Token Storage

- Encrypted with AES-256-GCM using `TOKEN_ENCRYPTION_KEY` Worker secret
- Stored as base64(iv + ciphertext + tag) in `platform_connections.access_token_enc`
- Decrypted on-demand before posting, never exposed to the client
- Refresh tokens stored separately in `refresh_token_enc`

### Token Refresh

On-demand before posting: if `token_expires_at < now + 5min`, refresh first. Uses `UPDATE ... WHERE access_token_enc = $current` as optimistic lock to prevent race conditions.

## GitHub Connection — Blog Publishing

GitHub is unique among connections because it requires a **destination config** on top of the OAuth token:

1. User connects GitHub account (OAuth, `repo` scope)
2. User configures a destination: repo, branch, content directory, frontmatter template
3. On publish: commit .md file via GitHub Contents API
4. User's CI/CD (Vercel, Netlify, Cloudflare Pages, etc.) detects push and rebuilds

```
PUT /repos/{owner}/{repo}/contents/src/content/blog/my-post.md
Authorization: Bearer {decrypted_token}
{
  "message": "Add: My Blog Post Title",
  "content": base64(frontmatter + markdown),
  "branch": "main"
}
```

One GitHub connection can have multiple destinations (different repos or directories). Framework auto-detection possible by inspecting `package.json` or config files.

## Scoping

**Connections are global** — added once, available across all profiles. Organized into user-defined categories. Profile scoping happens in the scheduler via category + individual connection selection. See [scheduler.md](scheduler.md) for profile scoping details.

## Database Schema

```sql
-- User-defined categories for organizing connections
CREATE TABLE connection_categories (
  id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id     TEXT NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  sort_order  INT DEFAULT 0,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- OAuth connections (X, LinkedIn, GitHub, etc.)
CREATE TABLE platform_connections (
  id                TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id           TEXT NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
  category_id       TEXT REFERENCES connection_categories(id) ON DELETE SET NULL,
  provider          TEXT NOT NULL,          -- 'x', 'linkedin', 'github', 'facebook', etc.
  provider_user_id  TEXT,                   -- external account ID
  display_name      TEXT,                   -- '@handle' or 'John Doe'
  status            TEXT DEFAULT 'pending', -- 'pending', 'active', 'expired', 'revoked'
  access_token_enc  TEXT,                   -- AES-256-GCM encrypted, base64
  refresh_token_enc TEXT,                   -- AES-256-GCM encrypted, base64
  token_expires_at  TIMESTAMPTZ,
  scopes            TEXT,                   -- space-separated granted scopes
  config            JSONB,                  -- provider-specific config (e.g. GitHub destinations)
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, provider, provider_user_id)
);

-- Short-lived OAuth flow state (10-min TTL)
CREATE TABLE oauth_states (
  id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id       TEXT NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
  profile_id    TEXT NOT NULL REFERENCES platform_profiles(id) ON DELETE CASCADE,
  provider      TEXT NOT NULL,
  state         TEXT UNIQUE NOT NULL,
  code_verifier TEXT,                       -- PKCE (X, GitHub)
  status        TEXT DEFAULT 'pending',     -- 'pending', 'completed', 'failed'
  error         TEXT,
  connection_id TEXT,
  expires_at    TIMESTAMPTZ NOT NULL,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);
```

## Unified Connections Endpoint

`GET /connections/unified` merges OAuth connections with newsletter domains into one list:

```json
{
  "connections": [
    { "id": "conn_x1", "provider": "x", "display_name": "@techcorp", "status": "active" },
    { "id": "conn_li1", "provider": "linkedin", "display_name": "TechCorp Inc", "status": "active" },
    { "id": "dom_1", "provider": "newsletter", "display_name": "updates@techcorp.com", "status": "active", "domain": "techcorp.com" }
  ]
}
```

Newsletter domains appear as connections in the UI but are stored in `newsletter_domains` table.

## Platform Routes

### Protected (Bearer + profile middleware)

| Route | Purpose |
|-------|---------|
| `GET /connections` | List connections for profile |
| `GET /connections/unified` | Merge OAuth + newsletter domains |
| `GET /connections/oauth/:provider/url` | Generate OAuth URL + state |
| `GET /connections/oauth/:provider/status/:state` | Poll OAuth completion |
| `DELETE /connections/:id` | Revoke connection, clear tokens |
| `POST /connections/:id/post` | Post content via connection |

### Public (OAuth callbacks)

| Route | Purpose |
|-------|---------|
| `GET /oauth/:provider/callback` | Exchange code, encrypt tokens, store, return HTML |

## Local Proxy Routes

All local routes proxy to the platform:

| Local Route | Platform Route |
|-------------|---------------|
| `GET /api/connections` | `GET /connections/unified` |
| `POST /api/connections/oauth/:provider/start` | `GET /connections/oauth/:provider/url` |
| `GET /api/connections/oauth/:provider/status/:state` | `GET /connections/oauth/:provider/status/:state` |
| `DELETE /api/connections/:id` | `DELETE /connections/:id` |
| `POST /api/connections/:id/post` | `POST /connections/:id/post` |

## MCP Tools

| Tool | Purpose |
|------|---------|
| `list_connections` | List all connected accounts |
| `post_to_x` | Post to X via connection |
| `post_to_linkedin` | Post to LinkedIn via connection |

Future tools added per provider (e.g. `post_to_github`, `post_to_wordpress`).

## Pricing Integration

| Plan | Connections | Newsletter |
|------|------------|------------|
| **Free** | 2 connections | Not available |
| **Creator ($9/mo)** | All 12 connections | Not available |
| **Growth ($19/mo)** | All 12 connections | Built-in newsletter (1k-5k subs) |
| **Publisher ($29/mo)** | All 12 connections | Built-in newsletter + publication hosting + paid subscriptions |

The $9 tier is the volume play — every writer who uses any external platform becomes a Creator subscriber. The $19+ tiers are the upgrade path for writers who want to own their audience.

## Launch Priority

| Tier | Providers | Status |
|------|-----------|--------|
| **Tier 1** | X, LinkedIn | Built (OAuth + posting) |
| **Tier 2** | GitHub, WordPress, Shopify | High value — next to build |
| **Tier 3** | ConvertKit, Beehiiv, Mailchimp | Newsletter platform connections |
| **Tier 4** | Facebook Pages, Medium, Ghost, Substack | Growth phase |

## OAuth App Registration

Each provider requires registering an OAuth app with callback URL `https://publish.openwriter.io/oauth/:provider/callback`:

| Provider | Developer Portal | Callback URL |
|----------|-----------------|--------------|
| X | developer.twitter.com | `https://publish.openwriter.io/oauth/x/callback` |
| LinkedIn | linkedin.com/developers | `https://publish.openwriter.io/oauth/linkedin/callback` |
| GitHub | github.com/settings/developers | `https://publish.openwriter.io/oauth/github/callback` |
| Facebook | developers.facebook.com | `https://publish.openwriter.io/oauth/facebook/callback` |
| WordPress | developer.wordpress.com | `https://publish.openwriter.io/oauth/wordpress/callback` |
| Shopify | partners.shopify.com | `https://publish.openwriter.io/oauth/shopify/callback` |
| Medium | medium.com/me/applications | `https://publish.openwriter.io/oauth/medium/callback` |
| ConvertKit | app.convertkit.com/account/edit | `https://publish.openwriter.io/oauth/convertkit/callback` |
| Mailchimp | admin.mailchimp.com/account/oauth2/ | `https://publish.openwriter.io/oauth/mailchimp/callback` |
| Beehiiv | N/A (API Key, no OAuth) | N/A |
| Ghost | N/A (Admin API Key, no OAuth) | N/A |
| Substack | N/A (no public API) | N/A |

## Current State

- **Platform infrastructure**: Deployed — schema migrated to Neon, Worker live at `publish.openwriter.io`
- **OAuth flow code**: Built for X, LinkedIn, and GitHub (providers, callbacks, token encryption, posting)
- **Local proxy**: All connection routes proxy to platform API
- **ConnectionsPanel UI**: Shows unified list (OAuth + newsletter), connect buttons, disconnect flow
- **Newsletter domains**: Appear as `provider: 'newsletter'` in unified endpoint — integrated into connections UI
- **X connection**: OAuth 2.0 registered and working. Platform-first posting via `/api/connections/:id/post`
- **LinkedIn connection**: OAuth 2.0 registered and working
- **GitHub connection**: OAuth 2.0 + GitHub App. Blog posting tested end-to-end (commits .md to repo via Contents API). Config: repo, owner, branch, contentDir, imageDir, installationId
- **Scheduler**: Built — slots, queue, cron-fired posts. See [scheduler.md](scheduler.md)

## Next Steps

1. Blog publish transform: generate clean YAML frontmatter from blogContext metadata fields
2. Add `imagePrefix` to GitHub connection config for correct frontmatter image paths
3. Build WordPress, Shopify, Medium connection providers
4. Newsletter platform connections (ConvertKit, Beehiiv, Mailchimp)

## Key Files

| File | Purpose |
|------|---------|
| `openwriter-publish/src/modules/connections/crypto.ts` | AES-256-GCM encrypt/decrypt |
| `openwriter-publish/src/modules/connections/providers/` | Provider implementations (x.ts, linkedin.ts, etc.) |
| `openwriter-publish/src/modules/connections/routes.ts` | Protected connection routes |
| `openwriter-publish/src/modules/connections/callbacks.ts` | OAuth callback handlers |
| `openwriter-publish/src/modules/connections/posting.ts` | Post to X/LinkedIn |
| `openwriter/server/connections.ts` | Platform proxy helper |
| `openwriter/server/connection-routes.ts` | Local proxy routes |
| `openwriter/src/connections/ConnectionsPanel.tsx` | OAuth UI |
| `openwriter/plugins/publish/src/index.ts` | MCP tools |
