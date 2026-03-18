# Publish

Platform module for publication hosting. Write in OpenWriter, host on a beautiful site, monetize with paid subscriptions. Substack/Beehiiv competitor with zero revenue cut.

Part of the **OpenWriter Platform** (`platform.openwriter.io`) — delivered via the platform plugin (`@openwriter/plugin-platform`). Shares auth, billing, profile scoping, and subscriber data with Scheduler and Newsletter modules. Builds on their shared infrastructure. See [ecosystem.md](ecosystem.md) for the unified architecture.

## Product

### Positioning

OpenWriter Publish is a **hosted publication platform**. Creators get a beautiful site where readers can discover, read, and subscribe to their content. Free essays are public. Paid essays are paywalled. Creators keep 100% of subscription revenue (minus Stripe's 2.9% + 30c).

**The pitch**: "Substack takes 10% of everything you earn. We take 0%. Flat $79/mo."

| Incumbent | Their Model | Our Attack |
|---|---|---|
| Substack | Free to start, 10% of revenue | $79/mo flat, 0% take rate |
| Beehiiv | $43-96/mo, 0% take | Integrated editor + AI voice |
| Ghost | $9-199/mo, self-hosted option | Zero ops, better AI integration |
| Medium | Revenue pool, no control | Creator owns everything |
| ConvertKit | $29+/mo | Cheaper, better writing experience |

### Pricing

Publish is unlocked at the Publisher tier. No free tier — the editor is free, the platform requires a subscription.

| Plan | Monthly | Annual | Publish Features |
|---|---|---|---|
| **Creator** | $19/mo | $190/yr | Not available |
| **Growth** | $49/mo | $490/yr | Not available |
| **Publisher** | $79/mo | $790/yr | Full Publish: paid subscriptions, custom domain, Stripe Connect, custom themes, unlimited posts |

See [ecosystem.md](ecosystem.md) for full platform pricing across all modules.

**Zero take rate.** Creators keep 100% of subscriber revenue. Stripe fees (2.9% + 30c) are the only deduction. Our revenue comes from the platform subscription ($79/mo), not creator revenue.

### Revenue to Creators

Stripe Connect handles payments. Readers subscribe → Stripe charges them → Stripe deposits directly to creator's connected Stripe account → OpenWriter takes nothing.

### Consumer Surfaces

Publish is accessed through the unified platform surfaces, plus a unique reader-facing surface:

| Surface | Consumer | Interface |
|---|---|---|
| **Skill** | AI agents | MCP tools (publish, unpublish, stats) |
| **Plugin** | OpenWriter users | Publish actions in editor |
| **API** | Developers | REST at `platform.openwriter.io/publish/*` |
| **Dashboard** | Creators | Web UI at `platform.openwriter.io` (publish section) |
| **Reader Site** | Readers | Hosted publication at `yourname.openwriter.pub` or custom domain |

The **Reader Site** is unique in the ecosystem. Scheduler and Newsletter are creator-facing only. Publish serves two audiences: creators (dashboard, plugin, API) and readers (the publication website).

### Auth

Shared platform auth — one key for all modules:

- **Clerk JWT** — dashboard login
- **Platform API key** — agents, plugin, API (`ow_live_*` Bearer tokens)
- **Profile header** — `X-Profile: prof_techcorp` scopes which publication to use

Reader auth is separate — magic link email login for readers to access paywalled content.

## Architecture

Publish is a module within the unified platform Worker. The reader-facing site is SSR on the same Worker, routed by hostname.

```
Readers                             platform.openwriter.io (Cloudflare Worker)
┌──────────────────┐               ┌──────────────────────────────────────┐
│ yourname.         │               │ Hono API                             │
│   openwriter.pub │  ──────────→  │  ├── /auth          (shared)         │
│                  │               │  ├── /billing       (shared)         │
│ or custom domain │               │  ├── /publish/*      ← this module   │
└──────────────────┘               │  ├── /scheduler/*   (sibling module) │
                                   │  ├── /newsletter/*  (sibling module) │
Creators                           │  ├── /webhooks/*     (shared)         │
┌──────────────────┐               │  └── Publication SSR (hostname-routed)│
│ OpenWriter Plugin│  ──HTTP────→  │                                       │
│ Web Dashboard    │  ←─────────   │ Neon Postgres                         │
│ Agent Skill      │               │  ├── platform_users       (shared)   │
│ Direct API       │               │  ├── platform_subscribers (shared)   │
└──────────────────┘               │  ├── publish_publications             │
                                   │  ├── publish_posts                    │
                                   │  ├── publish_views                    │
                                   │  └── newsletter_*                     │
                                   │                                       │
                                   │ R2                                    │
                                   │  ├── post images                      │
                                   │  ├── publication assets (logo)        │
                                   │  └── OG images (auto-generated)       │
                                   └───────────────────────────────────────┘
```

The reader-facing site is SSR on Cloudflare Workers. Each publication gets a subdomain (`yourname.openwriter.pub`) or custom domain. The Worker routes by hostname → looks up publication → renders the page.

### Module Location

```
openwriter-platform/
└── src/
    ├── modules/
    │   └── publish/             # This module
    │       ├── routes.ts        # Hono route group mounted at /publish
    │       ├── publications.ts  # Publication CRUD
    │       ├── posts.ts         # Post management (draft, publish, unpublish)
    │       ├── reader.ts        # Reader auth (magic link), subscription flows
    │       ├── stripe-connect.ts # Stripe Connect onboarding + payouts
    │       ├── analytics.ts     # Page views, revenue tracking
    │       ├── domains.ts       # Custom domain management
    │       └── ssr/             # Publication renderer (SSR templates)
    │           ├── layout.ts
    │           ├── home.ts
    │           ├── post.ts
    │           └── subscribe.ts
    ├── shared/
    │   ├── auth/                # Clerk + API key middleware (shared)
    │   ├── billing/             # Stripe subscription + feature flags (shared)
    │   ├── profiles/            # Profile management + scoping middleware (shared)
    │   ├── connections/         # Social accounts, domains — per-profile (shared)
    │   ├── subscribers/         # platform_subscribers + platform_lists (shared)
    │   └── email/               # Provider-agnostic email (shared with Newsletter)
    └── index.ts                 # Hono app entry
```

## Core Features

### 1. Publication Site

Every creator gets a publication:

```
yourname.openwriter.pub (or custom domain)
├── /                    Homepage (latest posts, about, subscribe CTA)
├── /archive             All posts, paginated
├── /p/post-slug         Individual post (public or paywalled)
├── /subscribe           Subscribe page (free + paid options)
├── /login               Reader login (email magic link)
├── /rss                 RSS feed (public posts only)
└── /sitemap.xml         SEO sitemap
```

**Reading experience**: Clean, fast, typography-focused. No sidebar clutter. Think Substack's reader but lighter. Dark/light mode. Mobile-first.

**Customization**:
- Logo, colors, bio
- Custom CSS (Publisher tier)
- Custom domain with SSL (Publisher tier)

### 2. Free + Paid Content

Posts are either:
- **Public** — anyone can read, indexed by search engines, in RSS
- **Subscribers only** — requires free email signup
- **Paid only** — requires paid subscription

The paywall is soft by default (show first few paragraphs, then gate). Creators can choose hard paywall (title only visible).

### 3. Paid Subscriptions (Stripe Connect)

Readers pay creators directly via Stripe:

1. Creator connects their Stripe account (Stripe Connect onboarding)
2. Creator sets pricing: monthly ($X/mo) and/or annual ($Y/yr)
3. Reader clicks Subscribe → Stripe Checkout → payment to creator's Stripe
4. Platform records the subscription, grants access
5. Creator receives funds directly (minus Stripe's 2.9% + 30c)

OpenWriter takes zero cut. Revenue model is the platform subscription fee ($29/mo), not transaction fees.

### 4. Newsletter Integration

Both modules read from `platform_subscribers` — one subscriber pool, not two synced lists:
- **New post → auto-email subscribers** — creates a newsletter issue, adds to scheduler queue (free posts to all subs, paid posts to paid subs only)
- **One subscriber pool** — a subscriber is a subscriber. Newsletter and Publish both read the same rows
- **Same email backend** — unified provider-agnostic delivery, all routed through the scheduler queue
- **Analytics bridge** — email opens (`newsletter_events`) + page views (`publish_views`) in one dashboard

Newsletter and Scheduler are built first (step 2). Publish extends their shared subscriber and delivery infrastructure.

### 5. AI-Generated Assets

Integrated with OpenWriter's image-gen:
- **OG images** — auto-generated per post for social sharing
- **Header images** — AI-generated based on post content
- **Publication branding** — consistent visual style across all posts
- Stored in R2, served via Cloudflare CDN

### 6. SEO

- Server-side rendered (not SPA — search engines see full content)
- Structured data (Article schema, author, publish date)
- Auto-generated sitemap
- Clean URLs (`/p/post-slug`)
- OG tags with generated images
- RSS feed for aggregators

## Schema

Publish module tables in the shared platform database. Subscribers are managed in the shared `platform_subscribers` table — see [ecosystem.md](ecosystem.md) for subscriber, list, user, and API key schemas.

```sql
-- Publications (one per profile, or multiple on Publisher tier)
CREATE TABLE publish_publications (
  id              TEXT PRIMARY KEY,
  user_id         TEXT REFERENCES platform_users(id),
  profile_id      TEXT REFERENCES platform_profiles(id),
  slug            TEXT UNIQUE NOT NULL,       -- 'yourname' → yourname.openwriter.pub
  name            TEXT NOT NULL,              -- 'The Monday Newsletter'
  description     TEXT,
  avatar_url      TEXT,
  cover_url       TEXT,
  custom_domain   TEXT,                       -- 'blog.yourdomain.com'
  domain_verified BOOLEAN DEFAULT FALSE,
  theme           JSONB,                      -- { primaryColor, fontFamily, darkMode }
  stripe_account_id TEXT,                     -- Stripe Connect account
  pricing         JSONB,                      -- { monthly: 500, annual: 5000 } (cents)
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Published posts
CREATE TABLE publish_posts (
  id              TEXT PRIMARY KEY,
  publication_id  TEXT REFERENCES publish_publications(id),
  user_id         TEXT REFERENCES platform_users(id),
  profile_id      TEXT REFERENCES platform_profiles(id),
  slug            TEXT NOT NULL,               -- URL slug
  title           TEXT NOT NULL,
  subtitle        TEXT,
  content_json    JSONB NOT NULL,              -- source TipTap JSON
  content_html    TEXT NOT NULL,               -- rendered HTML
  cover_image_url TEXT,                        -- R2 URL
  og_image_url    TEXT,                        -- auto-generated OG image
  access          TEXT DEFAULT 'public',       -- public | subscribers | paid
  status          TEXT DEFAULT 'draft',        -- draft | published | unlisted
  published_at    TIMESTAMPTZ,
  seo_title       TEXT,
  seo_description TEXT,
  tags            TEXT[],
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(publication_id, slug)
);

-- Page views / analytics
CREATE TABLE publish_views (
  id          TEXT PRIMARY KEY,
  post_id     TEXT REFERENCES publish_posts(id),
  viewer_hash TEXT,                         -- hashed IP for unique counts (no PII)
  referrer    TEXT,
  country     TEXT,                         -- from CF headers
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_pub_posts_publication ON publish_posts (publication_id, status, published_at DESC);
CREATE INDEX idx_pub_posts_slug ON publish_posts (publication_id, slug) WHERE status = 'published';
CREATE INDEX idx_pub_views_post ON publish_views (post_id, created_at);
CREATE INDEX idx_pub_publications_profile ON publish_publications (profile_id);
```

No module-specific subscriber table. Publish reads from `platform_subscribers` (shared) to check access: `type = 'paid'` grants paywalled content, `type = 'free'` grants subscriber-only content. Stripe Connect metadata (subscription_id, customer_id) lives on the shared subscriber record. See [ecosystem.md](ecosystem.md) for the full schema.

Note: `publish_posts` stores `content_json` (TipTap JSON) instead of `content_md` (markdown). TipTap JSON is the source of truth; HTML is generated via `generateHTML()` — consistent with the Newsletter module's approach.

## Module API

All endpoints are prefixed with `/publish` on the platform Worker. Auth is shared — `Authorization: Bearer ow_live_xxx` + `X-Profile: prof_techcorp`.

```
# Publication management
GET    /publish/publications                    — list creator's publications (for active profile)
POST   /publish/publications                    — create publication
PATCH  /publish/publications/:id               — update (name, theme, pricing)
DELETE /publish/publications/:id               — delete publication

# Custom domains
POST   /publish/publications/:id/domain        — add custom domain
GET    /publish/publications/:id/domain/verify — check DNS verification
DELETE /publish/publications/:id/domain        — remove custom domain

# Posts
GET    /publish/publications/:id/posts         — list posts (drafts + published)
POST   /publish/publications/:id/posts         — create post (from TipTap JSON)
PATCH  /publish/posts/:id                      — update post
POST   /publish/posts/:id/publish              — publish (draft → published)
POST   /publish/posts/:id/unpublish            — unpublish
DELETE /publish/posts/:id                      — delete

# Stripe Connect
POST   /publish/stripe/connect                 — start Stripe Connect onboarding
GET    /publish/stripe/connect/callback        — OAuth callback
GET    /publish/stripe/account                 — account status + balance

# Reader-facing (public, no creator auth)
GET    /publish/r/:publication/feed            — RSS feed
GET    /publish/r/:publication/posts           — public post list (JSON)
GET    /publish/r/:publication/posts/:slug     — single post (JSON, respects paywall)
POST   /publish/r/:publication/subscribe       — reader subscribes (free)
POST   /publish/r/:publication/subscribe/paid  — reader subscribes (paid → Stripe Checkout)
POST   /publish/r/:publication/login           — magic link login for readers
GET    /publish/r/:publication/verify/:token   — magic link verification

# Analytics
GET    /publish/analytics/overview             — total views, subscribers, revenue
GET    /publish/analytics/posts/:id            — per-post views, reads, conversions
GET    /publish/analytics/revenue              — MRR, churn, growth

# Webhooks (shared endpoint)
POST   /webhooks/stripe                        — subscription events, payouts
```

Billing and auth endpoints are shared across all modules — see [ecosystem.md](ecosystem.md).

## OpenWriter Plugin

Publish tools are part of the platform plugin (`@openwriter/plugin-platform`). One plugin, one API key, all modules. Free tier included.

### Config

```typescript
// Part of the platform plugin config
configSchema: {
  'api-url': { type: 'string', env: 'PLATFORM_API_URL', description: 'Platform API URL' },
  'api-key': { type: 'string', env: 'PLATFORM_API_KEY', description: 'Platform API key (ow_live_xxx)' },
}
```

The plugin reads the active profile from the core editor and passes it as `X-Profile` header. No per-module config needed.

### MCP Tools

| Tool | Purpose |
|---|---|
| `publish_post` | Publish current document to publication |
| `unpublish_post` | Take down a published post |
| `list_published` | Show all published posts with stats |
| `set_access` | Set post access level (public/subscribers/paid) |
| `publication_stats` | Subscriber count, revenue, top posts |

### Sidebar Actions

Right-click a document:
- **Publish** — publish to publication (select access level)
- **Publish as Paid** — publish behind paywall
- **Update Published** — push edits to an already-published post

## Relationship to Newsletter Module

Both modules read from the same `platform_subscribers` table (see [ecosystem.md](ecosystem.md)). One subscriber pool per channel within a profile — no separate "newsletter subscribers" vs "publication readers."

| Feature | Newsletter Module | Publish Module |
|---|---|---|
| Subscriber data | `platform_subscribers` (shared) | `platform_subscribers` (shared) |
| List segmentation | `platform_lists` (shared) | `platform_lists` (shared) |
| Email sending | Provider-agnostic backend | Same backend (via scheduler queue) |
| Subscribe forms | Free signup | Extends with paid option (Stripe Connect) |
| Analytics | Email events (`newsletter_events`) | Email events + page views (`publish_views`) |
| Content hosting | None | Hosted publication site (SSR) |
| Monetization | None | Stripe Connect (zero take rate) |

When a creator publishes a post:
1. Post goes live on the publication site
2. If auto-email is enabled, a newsletter issue is created and added to the scheduler queue
3. Both modules track engagement on the same subscriber records

A newsletter subscriber is a publication reader. A paid subscriber gets paywalled content and email. No double sign-up, no sync needed — it's the same row in `platform_subscribers`.

## Relationship to Scheduler Module

Creators who use both modules can:
- Write a post → Publish it at a scheduled time (Scheduler fires the publish action)
- Auto-generate social posts promoting the published essay
- Unified queue: tweets, newsletters, and publication posts in one schedule view

## Build Dependencies

```
Core: Profiles (step 2 — editor feature)
  └── profile switcher, local directories
        ↓
Shared infrastructure (step 3a)
  └── auth, billing, profiles, connections
        ↓
Scheduler + Newsletter (step 3, built together)
  └── shared: platform_profiles, platform_subscribers, platform_lists
  └── scheduler: queue, cron, publisher interface
  └── newsletter: issues, domains, email provider
        ↓
Publish module (step 4, extends shared infra)
  └── publication hosting (SSR)
  └── paywall + Stripe Connect
  └── analytics (page views)
  └── custom domains + Cloudflare for SaaS
```

Cannot start Publish until shared subscriber infrastructure and the scheduler queue are live. Profiles must ship first as a core editor feature. All platform modules are in the same Worker — the dependency is at the code level, not infrastructure.
