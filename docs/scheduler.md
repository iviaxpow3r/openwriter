# Scheduler

Platform module for content scheduling. Connect your social accounts, schedule when and where content goes. Posts fire on schedule whether OpenWriter is open or not.

Part of the **OpenWriter Platform** (`platform.openwriter.io`) — delivered via the platform plugin (`@openwriter/plugin-platform`). Shares auth, billing, and profile scoping with Newsletter and Publish modules. See [ecosystem.md](ecosystem.md) for the unified architecture.

**The scheduler is the platform's delivery backbone.** Every content type — tweets, LinkedIn posts, newsletters — flows through the same queue and cron. Other modules add content to the queue; the scheduler fires it.

## Product

### Positioning

OpenWriter Scheduler is a **hosted scheduling service**. Users connect their social accounts via OAuth (no API keys needed), schedule content, and it posts automatically. Accessed through the OpenWriter plugin, platform dashboard, agent skill, or direct API.

Competitors charge $12-25/mo (Buffer, Typefully, Later). Our cost basis is near-zero (Cloudflare Workers + existing Neon instance), so we undercut aggressively.

### Pricing

Scheduler pricing is part of the unified platform subscription:

| Plan | Price | Scheduler Features |
|---|---|---|
| **Free** | $0 | 2 connections, 15 scheduled posts/month, 3 slots/day |
| **Creator** | $9/mo | Unlimited connections, unlimited posts, unlimited slots, post history, analytics |

See [ecosystem.md](ecosystem.md) for full platform pricing across all modules.

Why subscription over usage-based:
- Schedulers are habitual — users batch 20 tweets for the week. Per-post pricing punishes the power behavior we want.
- Marginal cost per post is ~$0 (DB read + API call on user's OAuth tokens). Every subscription dollar is margin.
- Platform Free tier undercuts Buffer (100%) and Typefully (100%). Creator tier at $9/mo covers all modules.

### Consumer Surfaces

Scheduler is accessed through the unified platform surfaces:

| Surface | Consumer | Interface |
|---|---|---|
| **Skill** | AI agents (Claude Code, etc.) | MCP tools via JSON-RPC |
| **Plugin** | OpenWriter users | Schedule view + sidebar actions |
| **API** | Developers, automations | REST at `platform.openwriter.io/scheduler/*` |
| **Dashboard** | Everyone | Web UI at `platform.openwriter.io` (scheduler section) |

The dashboard is important — scheduling needs daily visual management (what's going out today?).

### Auth

Shared platform auth — one key for all modules:

- **Clerk JWT** — dashboard login
- **Platform API key** — agents, plugin, API (`ow_live_*` Bearer tokens)

No separate scheduler keys. The platform key authenticates the user. The profile header (`X-Profile`) scopes connections and schedule to the active profile.

## Architecture

Scheduler is a module within the unified platform Worker. The Cron Trigger runs on the same Worker.

```
Clients                            platform.openwriter.io (Cloudflare Worker)
┌──────────────────┐              ┌──────────────────────────────────────┐
│ OpenWriter Plugin│              │ Hono API                             │
│ Web Dashboard    │  ──HTTP───→  │  ├── /auth          (shared)         │
│ Agent Skill      │  ←────────   │  ├── /billing       (shared)         │
│ Direct API       │              │  ├── /scheduler/*    ← this module   │
│                  │              │  ├── /newsletter/*   (sibling module) │
└──────────────────┘              │  ├── /publish/*      (sibling module) │
                                  │  ├── /webhooks/*     (shared)         │
                                  │  └── Cron Trigger (1 min) ← fires queue │
                                  │                                       │
                                  │ Neon Postgres                         │
                                  │  ├── platform_users  (shared)         │
                                  │  ├── platform_api_keys (shared)       │
                                  │  ├── platform_connections (shared)    │
                                  │  ├── scheduler_queue                  │
                                  │  ├── scheduler_slots                  │
                                  │  └── scheduler_history                │
                                  └───────────────────────────────────────┘
```

### Module Location

```
openwriter-publish/
└── src/
    ├── modules/
    │   └── scheduler/          # This module
    │       ├── routes.ts       # Hono route group mounted at /scheduler
    │       ├── queue.ts        # Add, list, cancel, reschedule
    │       ├── slots.ts        # Slot preset management
    │       ├── cron.ts         # The core loop — fires due posts every 60s
    │       ├── history.ts      # Post history + analytics
    │       └── publishers/     # Platform-specific publishers
    │           ├── interface.ts
    │           ├── x.ts
    │           ├── linkedin.ts
    │           └── newsletter.ts  # Calls EmailProvider for newsletter sends
    ├── shared/
    │   ├── auth/               # Clerk + API key middleware (shared)
    │   ├── billing/            # Stripe subscription + feature flags (shared)
    │   ├── profiles/           # Profile management + scoping middleware (shared)
    │   ├── connections/        # Social accounts, domains — per-profile (shared)
    │   ├── subscribers/        # Per-channel subscriber + list management (shared)
    │   └── email/              # Provider-agnostic EmailProvider (shared)
    └── index.ts                # Hono app entry
```

## Connections

Connections are **global** — added once via the titlebar dropdown, available across all profiles. OAuth flow, token storage, and token refresh are handled by the connections module. See [connections.md](connections.md) for full details.

### Connection Categories

Users organize connections into custom categories in the global connections dropdown:

```
┌─ Connections ──────────────────┐
│ TECHCORP                       │
│  ✓ X @TechCorp                 │
│  ✓ LinkedIn TechCorp Inc       │
│  ✓ noreply@techcorp.com        │
│ PERSONAL                       │
│  ✓ X @metatrav                 │
│  ✓ LinkedIn Travis Steward     │
│ FOOD BLOG                      │
│  ✓ X @FoodBlog                 │
│  ● hello@thefoodblog.com       │
│ [+ Connect Account]            │
└────────────────────────────────┘
```

Categories are user-defined labels for grouping connections. A connection belongs to one category (or none).

### Profile Connection Scoping

The scheduler is profile-scoped. Each profile selects which connections are available via two mechanisms:

1. **Categories** — bulk-enable all connections in a category
2. **Individual connections** — cherry-pick any connection (categorized or not)

```
Scheduler Settings (profile: TechCorp)
┌──────────────────────────────┐
│ Categories                   │
│ ☑ TechCorp                   │
│ ☐ Personal                   │
│ ☐ Food Blog                  │
│                              │
│ Individual Connections       │
│ ☑ Medium @travis             │
│ ☑ X @metatrav                │
│ ☐ LinkedIn Travis Steward    │
│ ☐ X @FoodBlog                │
│ ...all connections listed    │
└──────────────────────────────┘
```

Available connections for a profile = connections in enabled categories UNION individually added connections. Slot filter dropdowns and queue routing only offer connections from this pool.

### Schema (Connection Scoping)

```sql
-- User-defined categories for organizing connections
CREATE TABLE connection_categories (
  id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id     TEXT NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  sort_order  INT DEFAULT 0,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Connection belongs to a category (nullable = uncategorized)
ALTER TABLE platform_connections
  ADD COLUMN category_id TEXT REFERENCES connection_categories(id) ON DELETE SET NULL;

-- Profile enables categories (bulk)
CREATE TABLE profile_categories (
  profile_id  TEXT REFERENCES platform_profiles(id) ON DELETE CASCADE,
  category_id TEXT REFERENCES connection_categories(id) ON DELETE CASCADE,
  PRIMARY KEY (profile_id, category_id)
);

-- Profile enables individual connections (fine-grained)
CREATE TABLE profile_connections (
  profile_id    TEXT REFERENCES platform_profiles(id) ON DELETE CASCADE,
  connection_id TEXT REFERENCES platform_connections(id) ON DELETE CASCADE,
  PRIMARY KEY (profile_id, connection_id)
);
```

**Query: available connections for a profile:**
```sql
SELECT DISTINCT c.* FROM platform_connections c
LEFT JOIN connection_categories cat ON c.category_id = cat.id
LEFT JOIN profile_categories pc ON cat.id = pc.category_id AND pc.profile_id = $1
LEFT JOIN profile_connections pi ON c.id = pi.connection_id AND pi.profile_id = $1
WHERE pc.category_id IS NOT NULL OR pi.connection_id IS NOT NULL;
```

The scheduler references connections by `connection_id` from the shared `platform_connections` table. Before posting, it decrypts tokens, refreshes if expired, and calls the appropriate publisher.

## Schema

Scheduler module tables in the shared platform database. Connections are shared infrastructure (`platform_connections`) — see [ecosystem.md](ecosystem.md). User and API key tables are also shared.

Social connections (X, LinkedIn) live in `platform_connections` with encrypted OAuth tokens. The scheduler references them by `connection_id`.

```sql
-- Slot templates (recurring time patterns)
CREATE TABLE scheduler_slots (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  profile_id      TEXT NOT NULL REFERENCES platform_profiles(id) ON DELETE CASCADE,
  time            TIME NOT NULL,          -- e.g. '08:04:00', '11:30:00'
  days            TEXT[] NOT NULL,        -- ['monday','tuesday',...] or ['default'] for every day
  filter_type     TEXT NOT NULL DEFAULT 'any',  -- 'any' | 'category' | 'connection'
  filter_value    TEXT,                   -- NULL for 'any', 'social'|'newsletter'|'blog' for category, connection_id for connection
  timezone        TEXT DEFAULT 'America/New_York',
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Scheduled posts (ALL content types — tweets, newsletters, etc.)
CREATE TABLE scheduler_queue (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  profile_id      TEXT NOT NULL REFERENCES platform_profiles(id) ON DELETE CASCADE,
  slot_id         TEXT REFERENCES scheduler_slots(id) ON DELETE SET NULL,  -- which slot template spawned this (nullable for custom-time)
  connection_id   TEXT REFERENCES platform_connections(id),  -- NULL for built-in newsletter
  content_type    TEXT NOT NULL,        -- 'tweet', 'thread', 'linkedin', 'newsletter', 'blog'
  content         JSONB NOT NULL,       -- { text, mediaUrls, threadParts, issueId, etc. }
  scheduled_at    TIMESTAMPTZ NOT NULL, -- concrete time, independent of slot after booking
  status          TEXT DEFAULT 'queued', -- queued | posting | posted | failed
  result          JSONB,                -- { url, platformId, error }
  retries         INT DEFAULT 0,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  posted_at       TIMESTAMPTZ
);

-- Post history (for analytics, persists after queue cleanup)
CREATE TABLE scheduler_history (
  id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  profile_id      TEXT NOT NULL REFERENCES platform_profiles(id) ON DELETE CASCADE,
  connection_id   TEXT REFERENCES platform_connections(id),
  content_type    TEXT NOT NULL,
  content         JSONB NOT NULL,
  scheduled_at    TIMESTAMPTZ,
  posted_at       TIMESTAMPTZ NOT NULL,
  result          JSONB NOT NULL,       -- { url, platformId, delivered, opened, etc. }
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_sched_slots_profile ON scheduler_slots (profile_id);
CREATE INDEX idx_sched_queue_due ON scheduler_queue (scheduled_at)
  WHERE status = 'queued';
CREATE INDEX idx_sched_queue_profile ON scheduler_queue (profile_id, status);
CREATE INDEX idx_sched_queue_slot ON scheduler_queue (slot_id)
  WHERE status = 'queued';
CREATE INDEX idx_sched_history_profile ON scheduler_history (profile_id, posted_at DESC);
```

### Key Design: Slots Are Templates, Queue Items Are Independent

**Slots** are recurring time patterns — "every weekday at 8:04 AM." They define where future content *can* land. Each slot has a filter controlling what's eligible:

| `filter_type` | `filter_value` | What can queue into it |
|---|---|---|
| `any` | NULL | Anything — tweets, newsletters, blog posts |
| `category` | `social` / `newsletter` / `blog` | Only that content category |
| `connection` | connection_id | Only that specific connection |

**Queue items** are concrete scheduled records. When you hit "Queue," the system finds the next matching slot template, computes the `scheduled_at` timestamp, and creates an independent record. The `slot_id` is a back-reference for bulk operations, but the queue item lives on its own.

**After booking, queue items are standalone:**
- Change a slot from 8 AM → 9 AM? Already-booked items stay at 8 AM.
- Delete a slot? Already-booked items still fire (`ON DELETE SET NULL`).
- The queue view renders from `scheduler_queue` ordered by `scheduled_at`.
- Slots only provide the "empty/available" markers between booked items.

### Queue Timeline View

The queue view merges booked items with empty slot markers:

```
Monday 8:04 AM    [any]        ● Tweet: "AI launch..."     → X @metatrav
Monday 8:04 AM    [any]        ● Post: "Excited to..."     → LinkedIn
Monday 11:30 AM   [any]        ○ Empty
Monday 6:00 PM    [social]     ● Tweet: "Thread on..."     → X @TechCorp
Saturday 8:00 AM  [newsletter] ● Newsletter #12            → noreply@openwriter.io
Saturday 8:00 AM  [newsletter] ○ Empty (next newsletter queues here)
```

Same time slot, multiple items — because they're different connections. The slot filter determines what's eligible to land there. Multiple items at the same time = different connections, no conflict.

### Slot Editing and Queue Migration

When a slot template changes, the user chooses whether to migrate existing queue items.

**Individual slot edit** (edit button on a slot in the timeline):
- Change 9 AM → 8 AM → prompt: "Move N queued items from 9 AM to 8 AM?"
- Change filter → prompt: "N items no longer match this filter. Remove from queue?"

**Master slot settings** (settings panel for all slots):
- On save, diff old slots vs new slots
- Removed slot → "N items scheduled here. Keep at current time / Delete / Move to nearest slot?"
- Changed time → "Move N items to new time?"
- Added slot → no prompt, just opens for future queuing

The migration query: `UPDATE scheduler_queue SET scheduled_at = <new_time> WHERE slot_id = <slot_id> AND scheduled_at > NOW() AND status = 'queued'`

## Worker Cron (The Core Loop)

Every 60 seconds, the platform Worker's Cron Trigger fires:

```sql
SELECT q.*, c.access_token_enc, c.refresh_token_enc, c.provider, c.token_expires_at
FROM scheduler_queue q
LEFT JOIN platform_connections c ON q.connection_id = c.id
WHERE q.scheduled_at <= NOW()
  AND q.status = 'queued'
  AND (c.status = 'active' OR q.connection_id IS NULL)
ORDER BY q.scheduled_at
LIMIT 10
FOR UPDATE OF q SKIP LOCKED;
```

Note: `LEFT JOIN` on connections (not `JOIN`) because newsletter items have `connection_id = NULL`. Tokens are encrypted — decrypt in-memory before use.

For each due item:
1. Set `status = 'posting'`
2. Route by `content_type`:
   - **tweet/thread/linkedin** → decrypt tokens, refresh if expired, call social publisher
   - **newsletter** → load issue from `newsletter_issues`, call `EmailProvider.sendBroadcast()`
3. On success: set `status = 'posted'`, insert into `scheduler_history`
4. On failure: set `status = 'failed'`, increment `retries`

Free tier enforcement: check user's plan and monthly post count before accepting new queue items (at `POST /scheduler/queue` time, not at cron time).

## Module API

All endpoints are prefixed with `/scheduler` on the platform Worker. Auth is shared — `Authorization: Bearer ow_live_xxx` + `X-Profile: prof_techcorp`. The profile header scopes which connections and schedule to show. Connection ID passed in request body or URL where needed.

```
# Connections — shared module, not scheduler-specific
# See connections.md for /connections/* routes

# Slots (profile-scoped)
GET    /scheduler/slots                        — list all slot templates
POST   /scheduler/slots                        — create slot { time, days, filter_type, filter_value }
PATCH  /scheduler/slots/:id                    — edit slot (with optional queue migration)
DELETE /scheduler/slots/:id                    — delete slot (with optional queue migration)

# Queue
GET    /scheduler/queue                        — list upcoming items (with slot mapping)
POST   /scheduler/queue                        — add { content, connectionId, mode: queue|now|custom }
PATCH  /scheduler/queue/:id                    — reschedule, reorder
DELETE /scheduler/queue/:id                    — remove

# History & Analytics
GET    /scheduler/history                      — past posts with results
GET    /scheduler/analytics                    — post counts, success rate, by platform
```

Billing and auth endpoints are shared across all modules — see [ecosystem.md](ecosystem.md).

## Slot Presets

Slots are profile-scoped templates. Each slot has a time, active days, and a filter controlling what content can queue into it.

**Example slot configuration:**

| Time | Days | Filter | Purpose |
|---|---|---|---|
| 8:04 AM | Mon-Fri | `any` | Morning social post — anything goes |
| 11:30 AM | Mon-Fri | `any` | Midday slot |
| 6:00 PM | Mon-Fri | `category:social` | Evening social only |
| 9:00 AM | Tue only | `connection:X @TechCorp` | TechCorp weekly update |
| 8:00 AM | Saturday | `category:newsletter` | Weekly newsletter |

**Queue routing:** "Add to Queue" finds the next slot whose filter matches the content being queued, walks forward through days, skips occupied slots (for that connection), and books the item. Multiple items from different connections can share the same slot time — no conflict.

**The writer's workflow:**
1. Set up slots once in settings
2. Write stuff, hit Queue
3. System auto-fills the right slots based on content type and connection
4. Glance at the timeline to see what's going out when

## Three Posting Modes

1. **Post Now** — Immediate. Worker posts right away.
2. **Add to Queue** — Next available slot. Zero friction. Primary workflow.
3. **Custom Time** — Specific date/time. Campaigns, time-sensitive content.

All three modes work for any content type — tweets, LinkedIn posts, newsletters.

## Publisher Modules (Worker-side)

```typescript
interface Publisher {
  platform: string;
  publish(context: PublishContext, content: QueueContent): Promise<PublishResult>;
  validate(content: QueueContent): ValidationResult;
}

// Social publishers also implement:
interface SocialPublisher extends Publisher {
  getAuthUrl(state: string): string;
  handleCallback(code: string): Promise<TokenSet>;
  refreshToken(tokens: TokenSet): Promise<TokenSet>;
}
```

Adding a new social platform = one publisher module + OAuth app registration.

The newsletter publisher is different — it doesn't use OAuth. It calls the shared `EmailProvider`:

```typescript
// publishers/newsletter.ts
const newsletterPublisher: Publisher = {
  platform: 'newsletter',
  async publish(ctx, content) {
    const issue = await getIssue(content.issueId);
    const subscribers = await getListSubscribers(issue.listId);
    return ctx.emailProvider.sendBroadcast({
      html: issue.content_html,
      subject: issue.subject,
      from: issue.from_email,
      recipients: subscribers,
    });
  },
  validate(content) { /* check issue exists, list has subscribers */ },
};
```

## OpenWriter Plugin

Scheduler tools are part of the platform plugin (`@openwriter/plugin-platform`). One plugin, one API key, all modules. Free tier included.

### Config

```typescript
// Part of the platform plugin config
configSchema: {
  'api-url': { type: 'string', env: 'PLATFORM_API_URL', description: 'Platform API URL' },
  'api-key': { type: 'string', env: 'PLATFORM_API_KEY', description: 'Platform API key (ow_live_xxx)' },
}
```

One key for all modules. The plugin reads the active profile from the core editor and passes it as `X-Profile` header. Connection context is passed in request bodies.

### MCP Tools

| Tool | Purpose |
|---|---|
| `schedule_post` | Queue current doc. Modes: `queue`, `now`, `custom` |
| `list_schedule` | Show upcoming queued items with slot times |
| `list_connections` | Show connected platform accounts |
| `manage_schedule` | Cancel, reschedule, reorder |
| `list_slots` | Show all slot templates with filters |
| `create_slot` | Add slot { time, days, filter_type, filter_value } |
| `edit_slot` | Change slot time/days/filter, optionally migrate queued items |
| `delete_slot` | Remove slot, optionally migrate or keep queued items |

### Sidebar Actions

Right-click any document:
- **Schedule Post** — modal (queue / now / custom)
- **Post Now** — immediate

### Schedule UI

The scheduler lives in the **sidebar** (profile-scoped). A calendar icon in the sidebar topbar (next to ProfileSwitcher and DensityDropdown) toggles the sidebar between document tree and queue view.

**UI scoping hierarchy:**
- Titlebar = global (connections live here)
- Sidebar topbar = profile-scoped (profile switcher, density, **scheduler toggle**)
- Sidebar content = profile-scoped (documents OR queue timeline)
- Toolbar = document-scoped

**Queue View** (sidebar content when scheduler mode is active):

```
┌─ Schedule ─────────────────────────────────┐
│                                             │
│  Today (Monday)                             │
│  ┌─────────────────────────────────────┐   │
│  │ 8:04 AM  ✓  Tweet: AI launch        │   │
│  │          → X @metatrav · posted      │   │
│  ├─────────────────────────────────────┤   │
│  │ 8:04 AM  ●  Post: Excited to...     │   │
│  │          → LinkedIn · queued         │   │
│  ├─────────────────────────────────────┤   │
│  │ 11:30 AM ○  [any] · empty           │   │
│  ├─────────────────────────────────────┤   │
│  │ 6:00 PM  ○  [social] · empty        │   │
│  └─────────────────────────────────────┘   │
│                                             │
│  Saturday                                   │
│  ┌─────────────────────────────────────┐   │
│  │ 8:00 AM  ●  Newsletter: March recap  │   │
│  │          → noreply@ow.io · queued    │   │
│  └─────────────────────────────────────┘   │
│                                             │
│  ─────────────────────────────────         │
│  View Full Schedule    ⚙ Slot Settings     │
└─────────────────────────────────────────────┘
```

Empty slots show their filter type ([any], [social], [newsletter], [blog], or connection name). Filled slots show the target connection. Multiple items at the same time = different connections sharing a slot.

**Full Schedule Page** (loads in the editor area — not a document):

Opens as a custom page type in the editor area (like VS Code's Settings tab). Contains the full queue timeline, slot settings, and history. This is the primary scheduler interface — all scheduling workflows happen here. Entry point TBD (sidebar item, context menu, or both).

**Slot Settings** (master settings — from ⚙ in dropdown or full panel):

```
┌─ Slot Settings ────────────────────────────┐
│                                             │
│  Timezone: America/New_York            [v] │
│                                             │
│  ┌─────────────────────────────────────┐   │
│  │ 8:04 AM   Mon-Fri  [Any       v] ✎ ✕│   │
│  │ 11:30 AM  Mon-Fri  [Any       v] ✎ ✕│   │
│  │ 6:00 PM   Mon-Fri  [Social    v] ✎ ✕│   │
│  │ 9:00 AM   Tue      [X @Tech.. v] ✎ ✕│   │
│  │ 8:00 AM   Sat      [Newsletter v] ✎ ✕│   │
│  │                                     │   │
│  │ [+ Add Slot]                        │   │
│  └─────────────────────────────────────┘   │
│                                             │
│  On save: prompts to migrate queued items  │
│  if any slots were changed or removed.     │
│                                             │
└─────────────────────────────────────────────┘
```

Each slot has: time, active days, and a filter (Any / Social / Newsletter / Blog / specific connection). The ✎ button edits inline, ✕ deletes with migration prompt if items are queued.

**Filter dropdown options:**
- Any — all content types
- Social — tweets, LinkedIn, Facebook
- Newsletter — email sends only
- Blog — GitHub, WordPress, Shopify, Medium, Ghost
- *[Each connected account]* — e.g., "X @metatrav", "LinkedIn Travis"

## Relationship to x-api Plugin

`@openwriter/plugin-x-api` stays for power users with their own developer credentials (OAuth 1.0a, 4 keys). The scheduler uses OAuth 2.0 via the hosted Worker — users just authorize.

Both coexist. Scheduler becomes the primary posting path. x-api becomes the escape hatch.

## Relationship to Newsletter Module

The scheduler is the **delivery backbone** for newsletters:
- Newsletter module handles compose, preview, list management, analytics
- When ready to send, the issue is added to the scheduler queue as `content_type: 'newsletter'`
- The scheduler cron fires the newsletter publisher, which calls `EmailProvider.sendBroadcast()`
- One cron, one queue, one unified schedule view

## Relationship to Publish Module

Creators who use both modules can:
- Write a post → Publish it at a scheduled time (Scheduler fires the publish action)
- Auto-generate social posts promoting the published essay
- Unified queue: tweets, newsletters, and publication posts in one schedule view

## Platforms

Publisher priority aligned with connection tiers (see [connections.md](connections.md)):

| Priority | Platform | Auth | Notes |
|---|---|---|---|
| 1 | X/Twitter | OAuth 2.0 PKCE | MVP — built |
| 2 | LinkedIn | OAuth 2.0 | MVP — built |
| 3 | Newsletter | EmailProvider | No OAuth — uses shared email backend |
| 4 | GitHub | OAuth 2.0 | Blog publishing via Contents API |
| 5 | WordPress | OAuth 2.0 / App Password | Largest CMS market |
| 6 | Shopify | OAuth 2.0 | Store blog posts |
| 7 | ConvertKit | OAuth 2.0 | Creator newsletter platform |
| 8 | Beehiiv | API Key | Growing newsletter platform |
| 9 | Mailchimp | OAuth 2.0 | Largest email market |
| 10 | Facebook Pages | OAuth 2.0 (Meta) | Social reach |
| 11 | Medium | OAuth 2.0 | Blog cross-posting |
| 12 | Ghost | Admin API Key | Self-hosted blogs |

## MVP Scope

1. **Module** — `scheduler/` module within `openwriter-platform` repo
2. **Routes** — Hono route group + Cron Trigger + X publisher + newsletter publisher
3. **Schema** — Three tables in shared Neon database (queue, slots, history) + shared `platform_connections` + `platform_profiles`
4. **Auth** — Shared platform API keys + profile scoping (Clerk deferred to dashboard phase)
5. **X OAuth 2.0** — Connect/disconnect, encrypted token storage + refresh (per-profile)
6. **Queue API** — Add, list, cancel, reschedule (all content types, profile-scoped)
7. **Slot presets** — Filtered slot templates (any/category/connection) with timezone
8. **Platform plugin** — `@openwriter/plugin-platform`: schedule dropdown, schedule panel, MCP tools, sidebar actions (free tier included)
9. **Editor panels** — Panel system for rendering non-document views (Schedule, Connections) in the editor area

X/Twitter is the first social publisher. Newsletter publisher ships alongside it since Newsletter module depends on the scheduler queue for delivery.

## Implementation Status

### Done
- **DB schema** — `scheduler_slots`, `scheduler_queue`, `scheduler_history` tables in Neon
- **Platform routes** — `/scheduler/slots`, `/scheduler/queue`, `/scheduler/history`, `/scheduler/connections`
- **Queue logic** — `addToQueue` (3 modes: queue/now/custom), `listQueue`, `cancelItem`, `rescheduleItem`, `listHistory`
- **Slot management** — `createSlot`, `updateSlot`, `deleteSlot`, `listSlots`, `getAvailableConnections`
- **Cron handler** — `handleCron` fires every 60s, processes due items, routes to publishers
- **Publishers** — X (`x.ts`) and LinkedIn (`linkedin.ts`) publisher stubs with `PublishContext` interface
- **Plugin MCP tools** — 7 tools: `schedule_post`, `list_schedule`, `list_connections`, `manage_schedule`, `list_slots`, `create_slot`, `edit_slot`, `delete_slot`
- **Plugin module loading** — ESM dynamic `import()` with caching for server modules from plugin context
- **Sidebar UI** — 7-day timeline view with empty slot markers, back chevron, slot settings panel
- **Cron end-to-end** — Verified: queue item → cron pickup → status transition (queued → posting → failed with no connection)

### Not Yet Built
- **OAuth connections** — No social accounts connected yet (need OAuth flow in browser)
- **Real posting** — X and LinkedIn publishers need OAuth tokens to actually post
- **Newsletter publisher** — Stub only, needs EmailProvider integration
- **Queue migration** — Slot edit/delete doesn't yet prompt to migrate queued items
- **History UI** — No history view in sidebar yet
- **Full schedule page** — Editor-area panel for expanded schedule management

## Future

- **Dashboard** — Scheduler section in platform web UI
- **Publishers** — GitHub, WordPress, Shopify, ConvertKit, Beehiiv, Mailchimp (see [connections.md](connections.md) for full priority list)
- **Cross-posting** — Same content to multiple platforms with format adaptation
- **Analytics** — Post performance metrics, optimal time suggestions
- **Media pipeline** — Images stored in R2, referenced by queue items
- **Smart scheduling** — Auto-pick optimal times based on engagement data
- **Empty slot automation** — OpenWriter auto-generates content for empty slots using Authors Voice + recent writing
