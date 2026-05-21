/**
 * Tests for listDirtyDocs() and crawlDocs() in documents.ts.
 *
 * v0.19.0 schema: crawl filters by `status` (canonical / draft) instead of
 * the dropped domain / docRole / concepts. crawlDocs no longer returns
 * those fields even when they exist on disk (legacy data is invisible).
 *
 * Scenarios:
 *   1. listDirtyDocs returns docs with no lastEnrichedAt as never_enriched.
 *   2. listDirtyDocs returns docs with enrichmentStale=true as stale_flag.
 *   3. listDirtyDocs excludes docs in workspaces with enrichmentDisabled=true.
 *   4. listDirtyDocs scoped to a workspace returns only that workspace's docs.
 *   5. crawlDocs returns the v0.19.0 three-field shape (logline, status, stale).
 *   6. crawlDocs hides legacy fields (domain / concepts / docRole) even when
 *      they exist on disk.
 *   7. crawlDocs filters by status / tags / hasLogline.
 *   8. crawlDocs scoped to a workspace returns only that workspace's docs.
 *
 * See brief 2026-05-21-simplify-enrichment-schema-three-fields.
 *
 * Run: `node scripts/test-list-dirty-and-crawl.mjs`
 */

import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

import { listDirtyDocs, crawlDocs } from '../dist/server/documents.js';
import { setActiveProfile, ensureDataDir, getDataDir, getWorkspacesDir, ensureWorkspacesDir } from '../dist/server/helpers.js';

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) { passed++; console.log(`  PASS: ${msg}`); }
  else      { failed++; console.error(`  FAIL: ${msg}`); }
}

const TEST_PROFILE = `test-dirty-crawl-${Date.now()}`;
const TEST_PROFILE_DIR = join(homedir(), '.openwriter', 'profiles', TEST_PROFILE);

function cleanup() {
  try { rmSync(TEST_PROFILE_DIR, { recursive: true, force: true }); } catch { /* best-effort */ }
}

function seedDoc(filename, frontmatter, body = 'Body content.') {
  const fm = JSON.stringify(frontmatter);
  writeFileSync(join(getDataDir(), filename), `---\n${fm}\n---\n\n${body}\n`, 'utf-8');
}

function seedWorkspace(filename, workspace) {
  writeFileSync(join(getWorkspacesDir(), filename),
    JSON.stringify(workspace, null, 2), 'utf-8');
}

try {
  setActiveProfile(TEST_PROFILE);
  mkdirSync(TEST_PROFILE_DIR, { recursive: true });
  ensureDataDir();
  ensureWorkspacesDir();

  // Seed docs with varying enrichment states + legacy fields.
  seedDoc('never.md', { title: 'Never', docId: 'never001' });
  seedDoc('flagged.md', {
    title: 'Flagged',
    docId: 'flag0001',
    lastEnrichedAt: '2026-01-01T00:00:00Z',
    lastEnrichedCharCount: 50,
    lastEnrichedSentences: ['x'],
    enrichmentStale: true,
  });
  // clean.md uses the v0.19.0 three-field shape.
  seedDoc('clean.md', {
    title: 'Clean',
    docId: 'clean001',
    logline: 'A clean canonical doc.',
    tags: ['tagA', 'tagB'],
    status: 'canonical',
    lastEnrichedAt: '2026-01-01T00:00:00Z',
    lastEnrichedCharCount: 50,
    lastEnrichedSentences: ['x'],
    enrichmentStale: false,
  });
  // draft.md is the agent-flagged draft counterpart.
  seedDoc('draft.md', {
    title: 'Draft',
    docId: 'draft001',
    logline: 'A draft doc.',
    status: 'draft',
    lastEnrichedAt: '2026-01-01T00:00:00Z',
    lastEnrichedCharCount: 50,
    lastEnrichedSentences: ['x'],
    enrichmentStale: false,
  });
  // legacy.md has v0.18 fields still on disk — crawl must hide them.
  seedDoc('legacy.md', {
    title: 'Legacy',
    docId: 'legacy01',
    logline: 'Legacy doc with old fields.',
    domain: 'LegacyDomain',
    concepts: ['old-concept'],
    docRole: 'reference',
    status: 'canonical',
    lastEnrichedAt: '2026-01-01T00:00:00Z',
    lastEnrichedCharCount: 50,
    lastEnrichedSentences: ['x'],
    enrichmentStale: false,
  });
  seedDoc('archived.md', {
    title: 'Archived',
    docId: 'arch0001',
    archivedAt: '2026-02-01T00:00:00Z',
  });
  seedDoc('opted-out.md', { title: 'Opted Out', docId: 'opt00001' });

  // Workspace A: never, flagged, clean, draft, legacy. Enrichment on.
  seedWorkspace('ws-a.json', {
    version: 2,
    title: 'Workspace A',
    root: [
      { type: 'doc', file: 'never.md', title: 'Never' },
      { type: 'doc', file: 'flagged.md', title: 'Flagged' },
      { type: 'doc', file: 'clean.md', title: 'Clean' },
      { type: 'doc', file: 'draft.md', title: 'Draft' },
      { type: 'doc', file: 'legacy.md', title: 'Legacy' },
    ],
  });

  // Workspace B: opted-out.md, enrichment off.
  seedWorkspace('ws-b.json', {
    version: 2,
    title: 'Workspace B',
    enrichmentDisabled: true,
    root: [
      { type: 'doc', file: 'opted-out.md', title: 'Opted Out' },
    ],
  });

  // ---------------------------------------------------------------------
  // Scenario 1+2: listDirtyDocs identifies never_enriched + stale_flag
  // ---------------------------------------------------------------------

  console.log('\nScenario 1+2: listDirtyDocs surfaces never-enriched + flagged');
  {
    const dirty = listDirtyDocs();
    const byFilename = new Map(dirty.map((d) => [d.filename, d]));

    assert(byFilename.has('never.md'),
      'never-enriched doc listed');
    assert(byFilename.get('never.md')?.reason === 'never_enriched',
      'never.md reason = never_enriched');

    assert(byFilename.has('flagged.md'),
      'flagged doc listed');
    assert(byFilename.get('flagged.md')?.reason === 'stale_flag',
      'flagged.md reason = stale_flag');

    assert(!byFilename.has('clean.md'),
      'clean doc NOT in dirty list');
    assert(!byFilename.has('archived.md'),
      'archived doc NOT in dirty list');
  }

  // ---------------------------------------------------------------------
  // Scenario 3: enrichmentDisabled workspace's docs are filtered out
  // ---------------------------------------------------------------------

  console.log('\nScenario 3: opt-out workspaces are excluded');
  {
    const dirty = listDirtyDocs();
    const filenames = new Set(dirty.map((d) => d.filename));
    assert(!filenames.has('opted-out.md'),
      'doc in enrichmentDisabled workspace NOT listed');
  }

  // ---------------------------------------------------------------------
  // Scenario 4: workspace scoping
  // ---------------------------------------------------------------------

  console.log('\nScenario 4: listDirtyDocs scoped to one workspace');
  {
    const dirty = listDirtyDocs('ws-a.json');
    const filenames = new Set(dirty.map((d) => d.filename));
    assert(filenames.has('never.md'), 'scope=ws-a: never.md included');
    assert(filenames.has('flagged.md'), 'scope=ws-a: flagged.md included');
    assert(!filenames.has('opted-out.md'), 'scope=ws-a: opted-out.md excluded');

    assert(dirty.find((d) => d.filename === 'never.md')?.workspaceFile === 'ws-a.json',
      'workspaceFile attribution = ws-a.json');
  }

  // ---------------------------------------------------------------------
  // Scenario 5: crawl returns the v0.19.0 three-field shape
  // ---------------------------------------------------------------------

  console.log('\nScenario 5: crawl returns logline + status + stale (three-field shape)');
  {
    const docs = crawlDocs({});
    const byFilename = new Map(docs.map((d) => [d.filename, d]));

    const clean = byFilename.get('clean.md');
    assert(clean !== undefined, 'clean doc in crawl results');
    assert(clean?.logline === 'A clean canonical doc.', 'crawl returns logline');
    assert(clean?.status === 'canonical', 'crawl returns status');
    assert(Array.isArray(clean?.tags) && clean.tags.length === 2, 'crawl returns tags');

    const never = byFilename.get('never.md');
    assert(never !== undefined, 'never-enriched doc included (no filters)');
    assert(never?.logline === undefined, 'never doc has no logline');

    assert(!byFilename.has('archived.md'), 'archived doc excluded from crawl');
  }

  // ---------------------------------------------------------------------
  // Scenario 6: crawl hides legacy fields even when on disk
  // ---------------------------------------------------------------------

  console.log('\nScenario 6: crawl hides legacy fields (domain / concepts / docRole)');
  {
    const docs = crawlDocs({});
    const legacy = docs.find((d) => d.filename === 'legacy.md');
    assert(legacy !== undefined, 'legacy doc present in crawl results');
    assert(legacy?.logline === 'Legacy doc with old fields.',
      'legacy doc still returns logline');
    assert(legacy?.status === 'canonical',
      'legacy doc still returns status');
    // The legacy fields exist on disk but the crawl output must not include
    // them in v0.19.0 — they're invisible until mark_enriched retires them.
    assert(legacy?.domain === undefined,
      'crawl output omits legacy domain field');
    assert(legacy?.concepts === undefined,
      'crawl output omits legacy concepts field');
    assert(legacy?.docRole === undefined,
      'crawl output omits legacy docRole field');
  }

  // ---------------------------------------------------------------------
  // Scenario 7: crawl filters
  // ---------------------------------------------------------------------

  console.log('\nScenario 7: crawl filter semantics');
  {
    {
      const docs = crawlDocs({ status: 'canonical' });
      const filenames = new Set(docs.map((d) => d.filename));
      assert(filenames.has('clean.md'),
        'status=canonical: clean.md matches');
      assert(filenames.has('legacy.md'),
        'status=canonical: legacy.md matches (status survives the legacy-fields purge)');
      assert(!filenames.has('draft.md'),
        'status=canonical: draft.md excluded');
      assert(!filenames.has('never.md'),
        'status=canonical: never.md excluded (no status set)');
    }

    {
      const docs = crawlDocs({ status: 'draft' });
      const filenames = new Set(docs.map((d) => d.filename));
      assert(filenames.has('draft.md'),
        'status=draft: draft.md matches');
      assert(!filenames.has('clean.md'),
        'status=draft: clean.md excluded');
    }

    {
      const docs = crawlDocs({ tags: ['tagA'] });
      const filenames = new Set(docs.map((d) => d.filename));
      assert(filenames.has('clean.md'), 'tags filter: clean.md has tagA');
      assert(!filenames.has('never.md'), 'tags filter: never.md has no tags');
    }

    {
      const docs = crawlDocs({ tags: ['tagA', 'nonexistent'] });
      const filenames = new Set(docs.map((d) => d.filename));
      assert(!filenames.has('clean.md'),
        'tags filter AND semantics: clean.md missing one tag, excluded');
    }

    {
      const docs = crawlDocs({ hasLogline: true });
      const filenames = new Set(docs.map((d) => d.filename));
      assert(filenames.has('clean.md'), 'hasLogline=true: clean.md has logline');
      assert(!filenames.has('never.md'), 'hasLogline=true: never.md excluded');
    }

    {
      const docs = crawlDocs({ hasLogline: false });
      const filenames = new Set(docs.map((d) => d.filename));
      assert(!filenames.has('clean.md'), 'hasLogline=false: clean.md excluded');
      assert(filenames.has('never.md'), 'hasLogline=false: never.md included');
    }
  }

  // ---------------------------------------------------------------------
  // Scenario 8: crawl scoped to workspace
  // ---------------------------------------------------------------------

  console.log('\nScenario 8: crawl scoped to workspace');
  {
    const docs = crawlDocs({ workspaceFile: 'ws-a.json' });
    const filenames = new Set(docs.map((d) => d.filename));
    assert(filenames.has('clean.md'), 'workspace scope: clean.md in ws-a');
    assert(filenames.has('never.md'), 'workspace scope: never.md in ws-a');
    assert(!filenames.has('opted-out.md'),
      'workspace scope: opted-out.md NOT in ws-a');
  }
} catch (err) {
  failed++;
  console.error(`  FATAL: ${err.message}`);
  console.error(err.stack);
} finally {
  cleanup();
}

console.log('\n============================================================');
console.log(`list_dirty_docs + crawl: ${passed} passed, ${failed} failed`);
console.log('============================================================');
if (failed > 0) process.exit(1);
