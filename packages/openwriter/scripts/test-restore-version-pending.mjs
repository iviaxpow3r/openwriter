/**
 * Regression test for the v0.14.1 restore_version cascade bugs.
 *
 * Inbox briefs:
 *   - 2026-05-17-restore-version-safety-checkpoint-captures-wrong-state.md
 *   - 2026-05-17-restore-version-reject-pending-deletes-doc.md
 *
 * Three compound failures:
 *
 *   Bug A (safety checkpoint = wrong state). `restore_version`'s safety
 *     checkpoint copied the on-disk file, which has pending rewrites flattened
 *     into the body. The user (or a recovery agent) reading the snapshot saw a
 *     state that never actually rendered in their view — canonical+pending
 *     rolled into a single prose body.
 *
 *   Bug B (pending decorations survive restore). After canonical reverted to
 *     the snapshot, the pending decorations from the abandoned revision pass
 *     stayed attached. `get_pad_status` reported a non-zero pendingChanges
 *     count even though the canonical state had been replaced.
 *
 *   Bug C (reject-all deletes the file). The `agentCreated: true` flag, set on
 *     create_document, is sticky — it survives past initial stub usage when
 *     batched accepts don't route through `pending-resolved`. A later
 *     reject-all on stale pending decorations triggered the
 *     "clean up the agent stub" path, which deleted the doc file off disk
 *     even though the doc had hours of accepted content.
 *
 * Fixes shipped:
 *   - `cloneWithPendingReverted(doc)` produces a canonical-only deep clone.
 *   - `writeSnapshotMarkdown(docId, md)` exposes the snapshot writer so the
 *     restore handler can checkpoint canonical-only markdown directly.
 *   - `restore_version` MCP handler: writes canonical-only safety snapshot,
 *     clears agentCreated in both parsed metadata and live state, clears
 *     pending cache entry, broadcasts pending-docs-changed.
 *   - `writeToDisk` auto-clears the agentCreated flag once the doc has any
 *     accepted (non-pending) content, so the flag can never persist past the
 *     initial stub state.
 *   - `ws.ts` reject-all-deletes path now simulates reject-all in a clone and
 *     refuses to delete if the doc would still have content after rejection.
 *
 * Run: `node scripts/test-restore-version-pending.mjs`
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import matter from 'gray-matter';
import {
  setActiveDocument,
  getDocument,
  getMetadata,
  save,
  cancelDebouncedSave,
  cloneWithPendingReverted,
  hasAcceptedContent,
} from '../dist/server/state.js';
import { writeSnapshotMarkdown, listVersions, getVersionContent } from '../dist/server/versions.js';
import { tiptapToMarkdown, markdownToTiptap } from '../dist/server/markdown.js';
import { setActiveProfile, ensureDataDir } from '../dist/server/helpers.js';

let passed = 0;
let failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log(`  PASS: ${msg}`); }
  else      { failed++; console.error(`  FAIL: ${msg}`); }
}

const TEST_PROFILE = `test-restore-${Date.now()}`;
const TEST_PROFILE_DIR = join(homedir(), '.openwriter', 'profiles', TEST_PROFILE);
function cleanup() {
  cancelDebouncedSave();
  try { rmSync(TEST_PROFILE_DIR, { recursive: true, force: true }); } catch { /* best-effort */ }
}
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(1); });

setActiveProfile(TEST_PROFILE);
mkdirSync(TEST_PROFILE_DIR, { recursive: true });
ensureDataDir();

try {
  // ==========================================================================
  // Bug A: cloneWithPendingReverted produces canonical-only doc
  // ==========================================================================
  console.log('Bug A: cloneWithPendingReverted reverts every pending status');
  {
    // A doc with one accepted paragraph + one insert + one rewrite + one delete.
    const doc = {
      type: 'doc',
      content: [
        // accepted: untouched
        { type: 'paragraph', attrs: { id: 'p0000001' }, content: [{ type: 'text', text: 'Accepted paragraph stays.' }] },
        // insert: pending fresh agent content — should drop on reject
        {
          type: 'paragraph',
          attrs: { id: 'p0000002', pendingStatus: 'insert' },
          content: [{ type: 'text', text: 'Inserted by agent, should drop.' }],
        },
        // rewrite: new prose with original stashed — should revert to original
        {
          type: 'paragraph',
          attrs: {
            id: 'p0000003',
            pendingStatus: 'rewrite',
            pendingOriginalContent: {
              type: 'paragraph',
              attrs: { id: 'p0000003' },
              content: [{ type: 'text', text: 'Original prose before agent rewrote.' }],
            },
          },
          content: [{ type: 'text', text: 'Agent rewrote this.' }],
        },
        // delete: node marked for deletion — reject keeps the node
        {
          type: 'paragraph',
          attrs: { id: 'p0000004', pendingStatus: 'delete' },
          content: [{ type: 'text', text: 'Marked for delete but reject keeps it.' }],
        },
      ],
    };

    const cleaned = cloneWithPendingReverted(doc);

    // Should have 3 blocks: accepted, reverted-rewrite, kept-delete. Insert dropped.
    assert(cleaned.content.length === 3, `clone has 3 blocks (got ${cleaned.content.length})`);

    // Block 1: accepted, identical
    assert(cleaned.content[0].attrs?.id === 'p0000001', 'block 0 id preserved');
    assert(cleaned.content[0].content[0].text === 'Accepted paragraph stays.', 'block 0 text intact');
    assert(!cleaned.content[0].attrs?.pendingStatus, 'block 0 has no pending status');

    // Block 2: the rewrite reverted to original
    assert(cleaned.content[1].attrs?.id === 'p0000003', 'rewrite reverted to original id');
    assert(cleaned.content[1].content[0].text === 'Original prose before agent rewrote.', 'rewrite reverted to original text');
    assert(!cleaned.content[1].attrs?.pendingStatus, 'reverted rewrite has no pending status');
    assert(!cleaned.content[1].attrs?.pendingOriginalContent, 'pendingOriginalContent stripped');

    // Block 3: the delete kept (reject means "no don't delete")
    assert(cleaned.content[2].attrs?.id === 'p0000004', 'delete-status block kept');
    assert(!cleaned.content[2].attrs?.pendingStatus, 'kept delete has pending status cleared');

    // Mutation safety: input doc still has its original 4 blocks with pending attrs intact
    assert(doc.content.length === 4, 'input doc not mutated (length)');
    assert(doc.content[1].attrs?.pendingStatus === 'insert', 'input doc not mutated (insert flag)');
    assert(doc.content[2].attrs?.pendingStatus === 'rewrite', 'input doc not mutated (rewrite flag)');
    assert(doc.content[3].attrs?.pendingStatus === 'delete', 'input doc not mutated (delete flag)');
  }

  // ==========================================================================
  // Bug A: rewrite with no pendingOriginalContent drops (vs leaving rewritten prose)
  // ==========================================================================
  console.log('\nBug A: rewrite without stashed original drops cleanly');
  {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          attrs: { id: 'p0000005', pendingStatus: 'rewrite' /* no pendingOriginalContent */ },
          content: [{ type: 'text', text: 'Agent rewrote this, no original.' }],
        },
        { type: 'paragraph', attrs: { id: 'p0000006' }, content: [{ type: 'text', text: 'Accepted.' }] },
      ],
    };
    const cleaned = cloneWithPendingReverted(doc);
    assert(cleaned.content.length === 1, 'rewrite with no original drops, 1 block remains');
    assert(cleaned.content[0].attrs?.id === 'p0000006', 'remaining block is the accepted one');
  }

  // ==========================================================================
  // Bug A: hasAcceptedContent reports correctly for stub vs real doc
  // ==========================================================================
  console.log('\nBug A: hasAcceptedContent distinguishes stub from real doc');
  {
    // Pure stub: only an insert-pending paragraph (post-create_document state)
    const stub = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          attrs: { id: 'p0000007', pendingStatus: 'insert' },
          content: [{ type: 'text', text: 'Only pending content.' }],
        },
      ],
    };
    assert(!hasAcceptedContent(stub), 'stub with only insert-pending has no accepted content');

    // Doc with one accepted paragraph
    const real = {
      type: 'doc',
      content: [
        { type: 'paragraph', attrs: { id: 'p0000008' }, content: [{ type: 'text', text: 'Real saved prose.' }] },
        {
          type: 'paragraph',
          attrs: { id: 'p0000009', pendingStatus: 'insert' },
          content: [{ type: 'text', text: 'Pending on top.' }],
        },
      ],
    };
    assert(hasAcceptedContent(real), 'real doc with accepted+pending has accepted content');

    // Doc with only delete-pending (reject keeps these)
    const onlyDeletes = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          attrs: { id: 'p0000010', pendingStatus: 'delete' },
          content: [{ type: 'text', text: 'Marked for delete.' }],
        },
      ],
    };
    assert(hasAcceptedContent(onlyDeletes), 'doc with only delete-pending counts as accepted (reject keeps)');

    // Empty doc
    const empty = { type: 'doc', content: [{ type: 'paragraph', attrs: { id: 'p0000011' }, content: [] }] };
    assert(!hasAcceptedContent(empty), 'empty doc has no accepted content');
  }

  // ==========================================================================
  // Bug A + B: end-to-end — save doc with pending → write snapshot → restore
  //   The canonical-only snapshot, written via writeSnapshotMarkdown, when
  //   parsed back, should have ZERO pending attrs.
  // ==========================================================================
  console.log('\nBug A+B: canonical-only snapshot has no pending state on parse');
  {
    const docWithPending = {
      type: 'doc',
      content: [
        { type: 'heading', attrs: { id: 'h0000001', level: 1 }, content: [{ type: 'text', text: 'Title' }] },
        { type: 'paragraph', attrs: { id: 'p0000020' }, content: [{ type: 'text', text: 'Accepted paragraph.' }] },
        {
          type: 'paragraph',
          attrs: { id: 'p0000021', pendingStatus: 'insert' },
          content: [{ type: 'text', text: 'Agent inserted, pending.' }],
        },
        {
          type: 'paragraph',
          attrs: {
            id: 'p0000022',
            pendingStatus: 'rewrite',
            pendingOriginalContent: {
              type: 'paragraph',
              attrs: { id: 'p0000022' },
              content: [{ type: 'text', text: 'Original before agent.' }],
            },
          },
          content: [{ type: 'text', text: 'Agent rewrote.' }],
        },
      ],
    };
    const meta = { title: 'Test Doc', docId: 'tst00001', agentCreated: true };

    // Build the canonical-only markdown the restore handler would write
    const cleaned = cloneWithPendingReverted(docWithPending);
    const cleanMeta = { ...meta };
    delete cleanMeta.pending;
    delete cleanMeta.agentCreated;
    const canonicalMd = tiptapToMarkdown(cleaned, 'Test Doc', cleanMeta);

    const ts = writeSnapshotMarkdown('tst00001', canonicalMd);
    assert(ts > 0, 'snapshot written with non-zero timestamp');

    const versions = listVersions('tst00001');
    assert(versions.length === 1, 'one version exists');

    const rawSnap = getVersionContent('tst00001', ts);
    assert(!!rawSnap, 'snapshot readable');

    const parsed = markdownToTiptap(rawSnap);
    // Should have heading + accepted paragraph + reverted rewrite (no insert).
    assert(parsed.document.content.length === 3, `snapshot has 3 blocks (got ${parsed.document.content.length})`);
    assert(parsed.document.content[2].content[0].text === 'Original before agent.', 'rewrite reverted to original');
    // No pending state in frontmatter
    assert(!parsed.metadata.pending, 'no pending state in snapshot frontmatter');
    // No agentCreated either
    assert(!parsed.metadata.agentCreated, 'agentCreated stripped from snapshot');
  }

  // ==========================================================================
  // Bug C: writeToDisk auto-clears agentCreated once accepted content exists
  //   Simulates: create_document writes stub with agentCreated=true →
  //   populate_document accepts content → save() should clear the flag so a
  //   later reject-all on stale pendings can't delete the file.
  // ==========================================================================
  console.log('\nBug C: save() clears agentCreated once accepted content exists');
  {
    const filePath = join(TEST_PROFILE_DIR, 'agent-stub.md');
    // Doc with accepted content (no pending) + agentCreated metadata.
    const doc = {
      type: 'doc',
      content: [
        { type: 'paragraph', attrs: { id: 'p0000040' }, content: [{ type: 'text', text: 'Real content saved.' }] },
      ],
    };
    setActiveDocument(doc, 'Agent Stub', filePath, false, undefined, {
      title: 'Agent Stub', docId: 'stb00001', agentCreated: true,
    });
    save();
    cancelDebouncedSave();

    // Reload metadata from disk
    const raw = readFileSync(filePath, 'utf-8');
    const { data: meta } = matter(raw);
    assert(!meta.agentCreated, 'agentCreated cleared after save with accepted content');
  }

  // ==========================================================================
  // Bug C: pure stub (only pending-insert content) keeps agentCreated until reject
  //   This preserves the original create_document → populate_document → reject
  //   cleanup flow.
  // ==========================================================================
  console.log('\nBug C: pure-stub doc keeps agentCreated (no accepted content yet)');
  {
    const filePath = join(TEST_PROFILE_DIR, 'pure-stub.md');
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          attrs: { id: 'p0000050', pendingStatus: 'insert' },
          content: [{ type: 'text', text: 'Agent pending insert only.' }],
        },
      ],
    };
    setActiveDocument(doc, 'Pure Stub', filePath, false, undefined, {
      title: 'Pure Stub', docId: 'stb00002', agentCreated: true,
    });
    save();
    cancelDebouncedSave();

    const raw = readFileSync(filePath, 'utf-8');
    const { data: meta } = matter(raw);
    assert(meta.agentCreated === true, 'agentCreated preserved for pure-stub (only pending insert)');
  }

  // ==========================================================================
  // Final summary
  // ==========================================================================
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed > 0 ? 1 : 0;
} catch (err) {
  console.error('TEST CRASH:', err);
  process.exitCode = 1;
}
