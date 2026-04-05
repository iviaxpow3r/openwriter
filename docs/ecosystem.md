# OpenWriter Ecosystem

OpenWriter is the **Basecamp for content creation** — a free editor that's the hub for a unified platform of monetized modules. The editor is free and open source. The platform is a single cloud service with modules that unlock by plan.

Write once. Publish everywhere. Keep 100% of your revenue.

## Architecture: Two Products

```
OpenWriter (free, open source editor)    OpenWriter Platform (unified service)
Local TipTap 3.0 + plugin API           platform.openwriter.io
├── Profiles                             ├── One key (ow_live_xxx)
├── Workspaces                           ├── One subscription ($9-49/mo)
├── Editor                               ├── Modules:
├── Plugin system                        │   ├── scheduler/   Content scheduling
└── Variant tree (sidebar)               │   ├── newsletter/  Email newsletters
                                         │   ├── publish/     Publication hosting
                                         │   ├── transforms/  Threadify, Postify, Storify, etc.
                                         │   └── image-gen/   Gemini image generation
                                         ├── Profile-scoped (complete context switch)
                                         └── Platform plugin is the primary client
```

**Why one service?** Transforms and distribution are one pipeline: write → transform to format → publish to channel. Sidebar transforms (Threadify, Postify, Storify, etc.) live in the platform because they don't need voice profiles — they reshape content for a channel using Claude. Voice rewriting (profiles, samples, RAG) stays in Authors Voice as a standalone product. See [platform-voice-transforms.md](platform-voice-transforms.md) for the architecture decision.

> **Authors Voice**: AV operates independently at `api.authors-voice.com`. The AV plugin's context menu actions (Enhance, Shrink, Expand, etc.) route to AV. Sidebar transforms route to the platform. Both coexist in the same plugin with split routing.

### The Editor + Platform Model

```
OpenWriter (free, open source editor)
│
│  Core features (always free)
│  ├── Profiles               Complete context switching (files, workspaces, settings)
│  ├── Workspaces             Document organization within a profile
│  └── Editor                 TipTap 3.0 rich text + markdown
│
│  Free plugins (user brings their own keys)
│  ├── X API                  X developer keys (power users)
│  └── Authors Voice          av_live_xxx (standalone SaaS, transitional)
│
│  Platform plugin (one plugin, one key)
│  ├── Voice                  Authors Voice (standalone, via AV plugin)
│  ├── Transforms             Threadify, Postify, Storify, Emailify, Vary, etc.
│  ├── Scheduler              Content scheduling + social posting
│  ├── Newsletter             Email newsletters + subscriber management
│  ├── Publish                Publication hosting + paid subscriptions
│  ├── Image Gen              Gemini-powered image generation
│  ├── Connections            OAuth accounts, verified domains (per-profile)
│  └── Profile switcher       Scopes all platform features to active profile
│
│  Platform features (emerge from multiple modules)
│  ├── Content Repurposing    One essay → variant per channel → publish all
│  ├── Variant Tree           Master doc + nested format variants in sidebar
│  ├── Unified Analytics      Cross-channel performance
│  └── Audience CRM           Unified subscriber view
```

### Principles

1. **OpenWriter is free.** Always. The editor gets people in. The platform makes money.
2. **One plugin, one key.** The platform plugin brings all modules. Tiers unlock capabilities.
3. **Authors Voice is standalone.** It has its own identity, keys, and billing. Plugin routes voice actions to AV, sidebar transforms to platform.
4. **Modular.** Pick the plan that fits. Don't pay for what you don't use.
5. **Profile-scoped.** Profiles are a core editor feature — complete context switching. The platform plugin scopes all its features (connections, schedule, subscribers, channels) to the active profile.
6. **Zero take rate.** Creators keep 100% of subscriber revenue. We charge flat fees, not cuts.

## Profiles (Core Editor Feature)

Profiles are a **core OpenWriter feature** — same level as the sidebar, workspaces, or the file tree. A profile is a complete context switch: its own files, workspaces, settings, and voice profiles. Switching profiles reloads the entire editor view.

```
OpenWriter
├── Profile: "Personal"
│   ├── Workspaces: Blog, Novel, Notes
│   ├── Files: ~/openwriter/personal/
│   └── Voice: my personal voice
│
├── Profile: "TechCorp" (client)
│   ├── Workspaces: Blog Posts, Newsletter Drafts, Product Updates
│   ├── Files: ~/openwriter/techcorp/
│   └── Voice: TechCorp brand voice
│
└── Profile: "FoodBlog"
    ├── Workspaces: Recipes, Food Reviews
    ├── Files: ~/openwriter/foodblog/
    └── Voice: casual food writing voice
```

**Solo creator** (90% of users) — one profile. Never sees a profile switcher. Zero overhead.
**Copywriter / power user** (10%) — multiple profiles. Click dropdown to switch. Complete isolation between clients.

Profiles exist without the platform plugin. A copywriter who just writes can use profiles to separate client work with no platform subscription.

### Workspaces (Within a Profile)

Workspaces are **document organizers** within a profile. A workspace groups related documents, provides writing context (characters, settings, rules), and links a voice profile. No services, no connections.

```
Workspace: "Blog Posts" (workspace.json)
├── context:
│   ├── characters: { "CEO": "Sarah Chen, direct communicator..." }
│   ├── settings: { "tone": "professional but approachable" }
│   └── rules: ["No jargon", "Short paragraphs"]
├── voiceProfileId: "voice_techcorp"
└── root:
    ├── Q1 Product Update
    ├── AI in Enterprise
    └── Cloud Migration Guide
```

A workspace with no documents is an empty folder. A workspace with documents is a writing project. That's it.

## Platform Plugin

The **platform plugin** (`@openwriter/plugin-platform`) is a single plugin that brings the entire OpenWriter Platform into the editor. Install it once — the free tier works immediately. Paid tiers unlock more.

### What the Plugin Adds

```
@openwriter/plugin-platform (free to install)
│
│  UI (always present once installed)
│  ├── Connections icon (top nav)     — manage OAuth accounts, verified domains
│  ├── Schedule icon (top nav)        — queue dropdown, slot settings
│  ├── Editor panels                  — Schedule, Connections, Newsletter, Publish
│  ├── Sidebar actions                — right-click: transforms (Threadify, Postify, etc.), Schedule, Send, Publish
│  ├── Context menu actions           — Rewrite, Shrink, Expand, Insert, Fill (via AV standalone)
│  └── Profile integration            — all platform features scoped to active profile
│
│  MCP tools (for agents)
│  ├── schedule_post, list_schedule, manage_schedule, configure_slots
│  ├── compose_newsletter, send_newsletter, list_subscribers, manage_lists
│  ├── publish_post, unpublish_post, list_published, publication_stats
│  └── list_connections
```

### How It Uses Profiles

The platform plugin reads the active profile from the core editor and scopes everything to it:

```
Profile: "TechCorp" (active)
│
├── Connections (platform plugin)
│   ├── @TechCorp (X, OAuth)
│   ├── techcorp.com (verified domain)
│   └── Stripe Connect (for paid subs)
│
├── Channels (platform plugin)
│   ├── "TechCorp Updates" newsletter → updates@techcorp.com, 2.4k subs
│   └── blog.techcorp.com publication → 12 posts, paid subs
│
├── Schedule (platform plugin)
│   ├── @TechCorp slots: Mon-Fri 9am, 12pm
│   └── Newsletter slot: Tue 10am
│
└── Workspaces (core editor)
    ├── Blog Posts
    ├── Newsletter Drafts
    └── Product Updates
```

Switch to "Personal" profile → completely different connections, channels, schedule, files.

### Connections

External accounts and verified resources linked to the active profile:

- **Social accounts** — X, LinkedIn via OAuth
- **Email domains** — DNS verification (SPF/DKIM/DMARC)
- **Stripe Connect** — For paid subscriptions (Publish module)

### Channels

Operational identities created using connections, scoped to the active profile:

- **Newsletters** — Name, from-address (uses verified domain), subscriber list, branding
- **Publications** — Domain (subdomain or custom), theme, subscriber list, paywall config

Social accounts function as both connections and channels — connecting your X account makes it immediately available for scheduling.

### UI: Top Navigation

Two new icons added by the platform plugin:

**Connections** (plug icon) — Manage connections and channels for the active profile:
- Add/remove social accounts (OAuth flows)
- Verify email domains (DNS setup)
- Create/configure newsletters (name, from-address, branding)
- Create/configure publications (domain, theme, paywall)

**Schedule** (calendar icon) — Quick queue dropdown for the active profile:
- Today's slots and upcoming items across all connections
- Each connection shows its own slot lane
- Quick glance at what's queued, posted, and empty
- "View Full Schedule" opens the schedule **editor panel** for full calendar view

### Editor Panels

The editor area renders **panels** alongside documents — non-document views that use the full editor space. Panels open as tabs next to document tabs, same as VS Code renders settings, diffs, or extension views in the editor area.

```
Tab bar: [TechCorp Blog ×] [March Issue ×] [📅 Schedule ×] [⚡ Connections ×]
         ─────────────────  ──────────────  ──────────────  ─────────────────
         document (TipTap)  document        panel (React)   panel (React)
```

**MVP Panels:**
- **Schedule** — Full calendar view of all slots across all connections. Week/month view, drag to reorder, manage queue.
- **Connections** — Setup/manage connections and channels. OAuth flows, domain verification, newsletter config.

**Future Panels:**
- **Newsletter Compose** — Rich email editor with preview and subscriber targeting
- **Analytics** — Cross-channel content performance
- **Publication Settings** — Theme, domain, paywall config

The top nav icons serve as quick-access dropdowns. Complex workflows open the full editor panel.

### Free Plugins vs Platform Plugin

Free plugins are thin API key passthroughs — no managed infrastructure, no tiers:
- **Image Gen** — calls Gemini with your key
- **X API** — calls X with your developer keys (power user escape hatch)
- **Authors Voice** — calls AV with your key

The platform plugin is a **service** — we hold OAuth tokens, run the cron, fire posts, store subscribers, send emails, host publication sites. That's why it has tiers and free plugins don't.

## Authors Voice — $5/mo (Standalone, Transitional)

*Make AI write like you.*

| | |
|---|---|
| **What** | Voice rewriting — import your writing, build a voice profile, rewrite AI content in your authentic voice |
| **Revenue model** | Flat subscription |
| **Surfaces** | Skill, Plugin, API |
| **Domain** | `authors-voice.com` / `api.authors-voice.com` |
| **Repo** | `C:\authors-voice` |
| **Status** | Live (standalone — voice features stay here, sidebar transforms moved to platform) |
| **Cost driver** | Anthropic API (~$0.02-0.05/rewrite) |

**Architecture split**: Sidebar transforms (Vary, Threadify, Storify, etc.) moved to the platform — they don't need voice profiles. Voice features (profiles, content samples, rewriting, analysis) stay in AV. The AV plugin routes context menu actions to AV and sidebar transforms to the platform. See [platform-voice-transforms.md](platform-voice-transforms.md).

## OpenWriter Platform — $19–$79/mo

One Cloudflare Worker. One Neon database. One API key. One plugin. No free tier — the editor is free, the platform requires a subscription.

**Domain:** `publish.openwriter.io`
**Repo:** `openwriter-publish/`
**Status:** Live (billing, scheduler, newsletter, connections, autoplugs)

### Platform Modules

#### Scheduler

*Schedule content everywhere.*

| | |
|---|---|
| **What** | Connect social accounts via OAuth, schedule posts across platforms, reliable cloud delivery |
| **Cost driver** | Near-zero |
| **Doc** | [docs/scheduler.md](scheduler.md) |

#### Newsletter

*Write, send, grow.*

| | |
|---|---|
| **What** | Email newsletters — write in OpenWriter (TipTap JSON → HTML), manage subscribers, send via provider-agnostic email backend, track analytics |
| **Cost driver** | Email delivery (SendGrid/SES) |
| **Doc** | [docs/newsletter.md](newsletter.md) |

#### Publish

*Host, monetize, own your audience.*

| | |
|---|---|
| **What** | Hosted publication platform — beautiful reader site, free + paid content, Stripe Connect payouts |
| **Cost driver** | R2 storage + SSR compute (minimal) |
| **Dependency** | Shares subscriber infrastructure with Newsletter module |
| **Unique surface** | Reader site (serves readers, not just creators) |
| **Doc** | [docs/monetization.md](monetization.md) |

### Platform Pricing

No free tier. The editor is free — the platform is the product. Subscription required for all features.

| Plan | Monthly | Annual | What's Included |
|---|---|---|---|
| **Creator** | $9/mo | $90/yr | Unlimited connections + posts, transforms, image gen. No newsletter, no custom domains. |
| **Growth** | $19/mo | $190/yr | Everything in Creator + newsletter (5k subs), custom domains |
| **Publisher** | $49/mo | $490/yr | Everything in Growth + publication hosting, paid subscriptions (0% take), Stripe Connect |

All tiers are per-user, not per-profile. A copywriter with 5 profiles pays one subscription — all profiles share the plan limits.

### Platform Architecture

```
platform.openwriter.io (Cloudflare Worker)
┌──────────────────────────────────────────────┐
│ Hono API                                     │
│  ├── /auth          Clerk JWT + API keys     │
│  ├── /billing       Stripe subscription      │
│  ├── /scheduler/*   Scheduling module        │
│  ├── /newsletter/*  Newsletter module        │
│  ├── /publish/*     Publication module       │
│  └── /webhooks/*    Stripe, email provider   │
│                                              │
│ Neon Postgres (one DB, shared tables)        │
│  ├── platform_users     (billing entity)     │
│  ├── platform_api_keys  (one key per user)   │
│  ├── platform_profiles  (per-user profiles)  │
│  ├── platform_connections (per-profile)      │
│  ├── platform_subscribers (per-channel)      │
│  ├── platform_lists     (email segmentation) │
│  ├── scheduler_*        (module tables)      │
│  ├── newsletter_*       (module tables)      │
│  └── publish_*          (module tables)      │
│                                              │
│ R2 (images, publication assets)              │
└──────────────────────────────────────────────┘
```

API calls use profile context:
```
Authorization: Bearer ow_live_xxx
X-Profile: prof_techcorp    ← scopes all operations to this profile
```

The key authenticates the user. The profile header scopes which connections, channels, subscribers, schedule, etc. to use. Within a profile, connection ID or channel ID further scopes specific operations (passed in request body).

### Shared Data Model

Subscribers belong to **channels** (newsletters or publications) within a **profile**. A channel that has both newsletter sending and a publication site shares one subscriber pool — this mirrors Substack's model. A subscriber is either free or paid. There's no separate "email subscriber" vs "site reader" — they're the same person. Lists are a segmentation layer on top for targeted email campaigns.

```sql
-- Profiles (platform-side record linking to local profile directory)
CREATE TABLE platform_profiles (
  id            TEXT PRIMARY KEY,
  user_id       TEXT REFERENCES platform_users(id),
  name          TEXT NOT NULL,              -- 'Personal', 'TechCorp', 'FoodBlog'
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- Connections (social accounts, verified domains — scoped to profile)
CREATE TABLE platform_connections (
  id            TEXT PRIMARY KEY,
  user_id       TEXT REFERENCES platform_users(id),
  profile_id    TEXT REFERENCES platform_profiles(id),
  type          TEXT NOT NULL,              -- 'x' | 'linkedin' | 'email_domain' | 'stripe'
  name          TEXT NOT NULL,              -- '@TechCorp' | 'techcorp.com'
  avatar_url    TEXT,
  config        JSONB,                      -- encrypted OAuth tokens, domain verification status
  status        TEXT DEFAULT 'active',      -- active | needs_reconnect | pending_verification
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- Subscribers (scoped to channel within a profile)
CREATE TABLE platform_subscribers (
  id              TEXT PRIMARY KEY,
  user_id         TEXT REFERENCES platform_users(id),
  profile_id      TEXT REFERENCES platform_profiles(id),
  channel_id      TEXT NOT NULL,            -- newsletter or publication ID
  channel_type    TEXT NOT NULL,            -- 'newsletter' | 'publication'
  email           TEXT NOT NULL,
  name            TEXT,
  type            TEXT DEFAULT 'free',      -- free | paid
  status          TEXT DEFAULT 'pending',   -- pending | active | unsubscribed | bounced
  stripe_subscription_id TEXT,              -- for paid subs (Publish Stripe Connect)
  stripe_customer_id TEXT,
  confirmed_at    TIMESTAMPTZ,              -- double opt-in
  subscribed_at   TIMESTAMPTZ DEFAULT NOW(),
  cancelled_at    TIMESTAMPTZ,
  metadata        JSONB,                    -- custom fields
  UNIQUE(channel_id, email)
);

-- Lists (segmentation for newsletter targeting)
CREATE TABLE platform_lists (
  id            TEXT PRIMARY KEY,
  user_id       TEXT REFERENCES platform_users(id),
  profile_id    TEXT REFERENCES platform_profiles(id),
  channel_id    TEXT NOT NULL,              -- scoped to a newsletter channel
  name          TEXT NOT NULL,              -- 'Main List', 'VIP', 'Product Updates'
  description   TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- List memberships (many-to-many)
CREATE TABLE platform_list_members (
  list_id       TEXT REFERENCES platform_lists(id),
  subscriber_id TEXT REFERENCES platform_subscribers(id),
  added_at      TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (list_id, subscriber_id)
);

CREATE INDEX idx_profiles_user ON platform_profiles (user_id);
CREATE INDEX idx_connections_profile ON platform_connections (profile_id, type);
CREATE INDEX idx_subscribers_channel ON platform_subscribers (channel_id, status);
CREATE INDEX idx_subscribers_profile ON platform_subscribers (profile_id, email);
CREATE INDEX idx_lists_channel ON platform_lists (profile_id, channel_id);
```

**How modules use shared subscribers:**
- **Newsletter** — sends to a list (or all channel subscribers, or paid-only filter). Compose, preview, analytics are module-specific.
- **Publish** — checks subscriber `type` for paywall access. Free subscriber = free content. Paid subscriber = all content.
- **Both** — if a newsletter and publication share a channel within the same profile, subscribe forms feed the same `platform_subscribers` pool. No double sign-up.
- **Profile isolation** — subscribers in the "TechCorp" profile are completely separate from "Personal" profile subscribers. No cross-contamination.

### Newsletter → Scheduler Queue

Newsletter doesn't have its own scheduling mechanism. All sending routes through the **Scheduler queue**:

- **Send Now** → adds to scheduler queue with `mode: 'now'` (immediate)
- **Schedule** → adds to scheduler queue with `mode: 'custom'` or `mode: 'queue'` (next slot)
- The scheduler cron fires it like any other content type (`content_type: 'newsletter'`)
- The newsletter "publisher" calls the email provider instead of a social API

This means one cron, one queue, one firing mechanism for everything. The schedule view shows tweets AND newsletters in the same timeline.

### Platform Repo Structure

```
openwriter-platform/
├── src/
│   ├── modules/
│   │   ├── scheduler/       # Queue, cron, connections, publishers, slots
│   │   ├── newsletter/      # Compose, issues, analytics (sends via scheduler queue)
│   │   └── publish/         # Publications, posts, reader site, paywall
│   ├── shared/
│   │   ├── auth/            # Clerk + API key middleware
│   │   ├── billing/         # Stripe subscription + feature flags
│   │   ├── profiles/        # Profile management + profile scoping middleware
│   │   ├── connections/     # Social accounts, domains (per-profile)
│   │   ├── subscribers/     # Per-channel subscriber + list management
│   │   └── email/           # Provider-agnostic email (SendGrid/SES)
│   └── index.ts             # Hono app entry
├── site/                    # Astro marketing site
├── dashboard/               # React dashboard (Vite)
├── skill/                   # Public Claude Code skill
└── docs/
```

## Consumer Surfaces

### Platform Surfaces

| Surface | What | Who |
|---|---|---|
| **Skill** | Claude Code skill with MCP tools | AI agents |
| **Plugin** | `@openwriter/plugin-platform` — one plugin, all modules, free tier included | Writers using OW |
| **API** | REST endpoints at `platform.openwriter.io` | Developers, automations |
| **Dashboard** | Web UI at `platform.openwriter.io` | Everyone (standalone usage) |

Publish adds a fifth: the **Reader site** — a public-facing surface that serves readers, not creators.

### AV Surfaces (Separate)

| Surface | What | Who |
|---|---|---|
| **Skill** | Claude Code skill | AI agents |
| **Plugin** | OpenWriter plugin (standalone) | Writers using OW |
| **API** | REST at `api.authors-voice.com` | Developers, any tool |

The skill is the discovery channel:
```
Install skill → Agent discovers platform → Agent configures plugin
  → User sees integrated experience → Upgrades plan → More modules unlock
```

## Competitive Landscape

| Incumbent | Their Price | What They Do | Our Attack | Our Price |
|---|---|---|---|---|
| Substack | 10% of revenue | Write + host + email | Publisher plan, 0% cut | $49/mo flat |
| Beehiiv | $43-96/mo | Email + monetize + host | Integrated editor + AI voice | $19-49/mo |
| Buffer | $12/mo | Schedule social | Creator plan + AI transforms | $9/mo |
| Typefully | $12.50/mo | Schedule tweets | Creator plan + Threadify/Postify | $9/mo |
| ConvertKit | $29+/mo | Email + landing pages | Growth plan, cheaper entry | $19/mo |
| Ghost | $9-199/mo | Self-hosted blog + email | Publisher plan, zero ops | $49/mo |
| Jasper/Copy.ai | $49+/mo | Generic AI writing | Transforms + AV voice | $9/mo |
| Medium | Revenue pool | Hosted writing | Publisher plan (creator owns everything) | $49/mo |

**Key differentiator**: integrated editor + transforms + scheduling + newsletter + publication in one tool. No other platform has the full stack. Creator at $9 undercuts everything. Transforms work immediately — no setup, no separate AI subscription. AV voice available separately for users who want personal voice rewriting.

## Platform Features

These emerge when multiple modules are active. Not separate products — they're the value of higher-tier plans.

### Content Repurposing (via Variants)

Write one master doc → right-click → create variants per channel → publish each:

| Transform | Output | Distribution |
|---|---|---|
| Threadify | Tweet thread variant | → Schedule to X |
| Postify | 3 standalone tweet variants | → Schedule individually to X |
| Emailify | Newsletter variant | → Send to subscribers |
| Blogify | Blog post variant | → Push to GitHub |
| LinkedIn-ify | LinkedIn post variant | → Post to LinkedIn |
| Storify | Social story variant | → Post to any channel |

ANTI_AI_RULES in transform prompts ensure each version sounds professional, not AI slop. One master doc, variants for every channel, all nested in the sidebar tree.

### Unified Analytics

The platform dashboard shows cross-channel performance for a single piece of content:

- Publication post: 12k views, 3.2min avg read time
- Tweet thread: 45k impressions, 1.2k likes
- Newsletter: 68% open rate, 15% click rate
- LinkedIn: 200 reactions

One content piece, one performance view.

### Audience CRM

Subscribers unified across modules:

- Newsletter email subscribers
- Publication free + paid readers
- Social followers who engage (via Scheduler analytics)

"Sarah is a paid publication subscriber who also opened your last 4 newsletters and engaged with your tweets." This is the CRM layer that emerges naturally from shared infrastructure.

## Infrastructure

### Platform Stack

| Layer | Technology |
|---|---|
| Runtime | Cloudflare Workers |
| Framework | Hono (TypeScript) |
| Database | Neon Postgres (one DB, module table prefixes) |
| Auth | Clerk + platform API keys (`ow_live_*`) |
| Billing | Stripe (one subscription per user, feature flags) |
| Email delivery | Provider-agnostic (SendGrid or SES, not Resend) |
| CDN/Storage | Cloudflare R2 |
| Marketing | Astro static site |
| CI/CD | GitHub Actions → wrangler |

### AV Stack (Separate)

Same technology choices, separate deployment. Own Clerk org, own Stripe product, own Neon tables. The OW plugin bridges them by storing both keys — `av_live_*` for voice, `ow_live_*` for platform.

### Email Backend

Provider-agnostic `EmailProvider` interface. Neon owns subscriber data. The email service is a delivery pipe only.

**Recommended:** SendGrid (1,000 recipients/call, 10k req/sec, $19.95/mo for 50k) or Amazon SES ($5/mo for 50k, highest margin). Resend eliminated — broadcast feature costs +$40/mo, batch API limited to 100/call at 2 req/sec.

See [docs/newsletter.md](newsletter.md) for full provider comparison.

## Revenue Model

### Per-User Revenue

| Persona | Plan | Monthly |
|---|---|---|
| Content mill / marketer | Creator ($9) | $9 |
| Newsletter creator | Growth ($19) | $19 |
| Serious writer / personal brand | Publisher ($49) | $49 |

### Projections

| Users | Avg Revenue | MRR |
|---|---|---|
| 100 | $20 | $2,000 |
| 500 | $25 | $12,500 |
| 1,000 | $30 | $30,000 |
| 5,000 | $35 | $175,000 |

Lower entry price ($9) drives adoption. Avg revenue rises as users upgrade for newsletter and publishing features.

### Cost Structure

| Component | Primary Cost | Per-User/Mo |
|---|---|---|
| Authors Voice | Anthropic API | ~$1-3 |
| Scheduler (X posts) | X API $0.01/post | ~$0.50-1.00 |
| Newsletter (email) | SendGrid $0.0004/email | ~$0.80-16 |
| Publish module | R2 + SSR compute | ~$0.10-0.50 |
| **Infrastructure** | Neon + CF Workers + SendGrid Essentials | ~$45/mo total |

Worst-case margins: Creator 90%, Growth 73%, Publisher 67%.

## Repo Map

```
travsteward/
├── openwriter/              # The editor (free, open source, npm)
├── openwriter-site/         # Marketing site (openwriter.io)
├── openwriter-publish/       # Platform service (billing + scheduler + newsletter + connections)
└── authors-voice/           # Voice rewriting SaaS ($5/mo, standalone)
```

## Build Order

```
1. Authors Voice        ✅ Live ($5/mo subscription)
    ↓
2. Core: Profiles       ✅ Live (local directories, profile switcher)
    ↓
3. Platform MVP         ✅ Live (openwriter-publish repo)
   ├── ✅ Auth: email OTP, API keys, profile scoping
   ├── ✅ Billing: Stripe subscriptions ($19/$49/$79), feature gates
   ├── ✅ Scheduler: queue, cron, slots, X/LinkedIn publishers
   ├── ✅ Newsletter: send, subscribers, domains, analytics
   ├── ✅ Connections: OAuth (X, LinkedIn, GitHub), posting
   ├── ✅ Autoplugs: engagement-triggered auto-replies
   └── ✅ Platform plugin: MCP tools + billing UI
    ↓
4. Publish module       ⬜ Publication hosting, paywall, Stripe Connect
    ↓
5. Dashboard            ⬜ Web UI at platform.openwriter.io
    ↓
6. Platform Features    ⬜ Repurposing, unified analytics, audience CRM
    ↓
7. Mobile App           ⬜ iOS/Android client for editor + platform
```

Profiles ship first as a core editor feature (step 2) — no platform dependency. The platform MVP (step 3) builds on profiles by scoping all its features to the active profile. Scheduler and Newsletter build together because Newsletter routes all sending through the scheduler queue. The scheduler provides the core queue + cron infrastructure; Newsletter provides subscriber management + email composition. Both establish the shared infrastructure that Publish builds on.

## Mobile App

OpenWriter Mobile — free iOS/Android app. Full editor on your phone with GitHub sync for remote access.

### App Store Strategy

The app is **free**. Apple gets nothing. Revenue comes from web subscriptions — the app is just another client.

```
OpenWriter Mobile (free, App Store)
│
│  Always free:
│  ├── Full editor (write, edit, organize)
│  ├── GitHub sync (pull/push files remotely)
│  └── Free tier of platform + AV
│
│  Paid integrations:
│  ├── User has web subscription? → Works. Apple gets $0.
│  ├── User doesn't have subscription? → "Set up at openwriter.io"
│  └── No IAP. No Apple billing. No 30% cut.
```

This is the **Notion/Figma/Slack model**: free app, SaaS subscriptions managed on the web, app detects subscription server-side and unlocks features. No IAP required.

### Prior Art

The deprecated BreeWriter mobile app (`C:\breewriter`) proved the editor works on mobile. OpenWriter Mobile rebuilds this on the current TipTap 3.0 stack with GitHub sync as the bridge between desktop and mobile.

### Build Order

Mobile comes after the platform modules are live. It's a client, not a platform.

```
Platform live (Newsletter, Scheduler, Publish)
  → Mobile app (client for editor + platform)
```

## Open Source Model

OpenWriter is MIT-licensed. The editor is free and open. The platform is a separate closed repo. Full details: [docs/open-source-model.md](open-source-model.md)

**Key points:**
- MIT license — anyone can fork, modify, use commercially
- We control what ships in our distribution
- No plugin marketplace. No third-party plugin directory.
- Platform and AV are proprietary (separate repos, no open source obligation)
- Open source is a distribution strategy, not a governance obligation

## The Endgame

A creator downloads OpenWriter (free). Their AI agent installs the skill. They write. They install the platform plugin — free tier, zero config. They connect their X account and start scheduling tweets. Their audience grows. They upgrade to Creator and launch a newsletter — same plugin, same profile, one click. They start a publication with paid subscribers. They add Authors Voice to make everything sound like them. A copywriter creates separate profiles for each client — complete isolation, one editor. They manage it all from their phone.

They're running their entire content business — writing, voice, social, email, publication, monetization — from one editor with one plugin. Every incumbent's feature is covered. The creator keeps 100% of their revenue. The infrastructure costs us pennies. Apple gets nothing.

That's the model.
