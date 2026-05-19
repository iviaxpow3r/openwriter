/**
 * Tests for listDirtyDocs() and crawlDocs() in documents.ts.
 *
 * Scenarios:
 *   1. listDirtyDocs returns docs with no lastEnrichedAt as never_enriched.
 *   2. listDirtyDocs returns docs with enrichmentStale=true as stale_flag.
 *   3. listDirtyDocs excludes docs in workspaces with enrichmentDisabled=true.
 *   4. listDirtyDocs scoped to a workspace returns only that workspace's docs.
 *   5. crawlDocs returns enrichment fields per doc.
 *   6. crawlDocs filters by domain / tags / docRole / hasLogline.
 *   7. crawlDocs scoped to a workspace returns only that workspace's docs.
 *
 * See brief 2026-05-18-frontmatter-enrichment-system.
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

  // Seed five docs with varying enrichment states.
  seedDoc('never.md', { title: 'Never', docId: 'never001' });
  seedDoc('flagged.md', {
    title: 'Flagged',
    docId: 'flag0001',
    lastEnrichedAt: '2026-01-01T00:00:00Z',
    lastEnrichedCharCount: 50,
    lastEnrichedSentences: ['x'],
    enrichmentStale: true,
  });
  seedDoc('clean.md', {
    title: 'Clean',
    docId: 'clean001',
    logline: 'A clean doc.',
    domain: 'TestDomain',
    concepts: ['c1', 'c2'],
    docRole: 'reference',
    tags: ['tagA', 'tagB'],
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

  // Workspace A: contains never.md + flagged.md + clean.md, enrichment on.
  seedWorkspace('ws-a.json', {
    version: 2,
    title: 'Workspace A',
    root: [
      { type: 'doc', file: 'never.md', title: 'Never' },
      { type: 'doc', file: 'flagged.md', title: 'Flagged' },
      { type: 'doc', file: 'clean.md', title: 'Clean' },
    ],
  });

  // Workspace B: contains opted-out.md, enrichment off.
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

    // Doc workspace attribution
    assert(dirty.find((d) => d.filename === 'never.md')?.workspaceFile === 'ws-a.json',
      'workspaceFile attribution = ws-a.json');
  }

  // ---------------------------------------------------------------------
  // Scenario 5: crawl returns enrichment fields
  // ---------------------------------------------------------------------

  console.log('\nScenario 5: crawl returns enrichment fields per doc');
  {
    const docs = crawlDocs({});
    const byFilename = new Map(docs.map((d) => [d.filename, d]));

    const clean = byFilename.get('clean.md');
    assert(clean !== undefined, 'clean doc in crawl results');
    assert(clean?.logline === 'A clean doc.', 'crawl returns logline');
    assert(clean?.domain === 'TestDomain', 'crawl returns domain');
    assert(Array.isArray(clean?.concepts) && clean.concepts.length === 2,
      'crawl returns concepts');
    assert(clean?.docRole === 'reference', 'crawl returns docRole');
    assert(clean?.status === 'canonical', 'crawl returns status');

    const never = byFilename.get('never.md');
    assert(never !== undefined, 'never-enriched doc included (no filters)');
    assert(never?.logline === undefined, 'never doc has no logline');

    assert(!byFilename.has('archived.md'), 'archived doc excluded from crawl');
  }

  // ---------------------------------------------------------------------
  // Scenario 6: crawl filters
  // ---------------------------------------------------------------------

  console.log('\nScenario 6: crawl filter semantics');
  {
    {
      const docs = crawlDocs({ domain: 'TestDomain' });
      const filenames = new Set(docs.map((d) => d.filename));
      assert(filenames.has('clean.md'), 'domain filter: clean.md matches');
      assert(!filenames.has('never.md'), 'domain filter: never.md excluded (no domain)');
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

    {
      const docs = crawlDocs({ docRole: 'reference' });
      const filenames = new Set(docs.map((d) => d.filename));
      assert(filenames.has('clean.md'), 'docRole filter: clean.md matches');
      assert(!filenames.has('flagged.md'), 'docRole filter: flagged.md has no docRole');
    }

    {
      const docs = crawlDocs({ concepts: ['c1'] });
      const filenames = new Set(docs.map((d) => d.filename));
      assert(filenames.has('clean.md'), 'concepts filter: c1 matches');
    }
  }

  // ---------------------------------------------------------------------
  // Scenario 7: crawl scoped to workspace
  // ---------------------------------------------------------------------

  console.log('\nScenario 7: crawl scoped to workspace');
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
