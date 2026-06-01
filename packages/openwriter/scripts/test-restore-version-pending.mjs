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

import { mkdirSync, readFileSync, rmSync, writeFileSync as fsWriteFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import matter from 'gray-matter';
import {
  setActiveDocument,
  updateDocument,
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
  // Architectural fix: agentCreated is in-memory only, never on disk.
  // The class of bug — "stale on-disk flag triggers destructive reject-all"
  // — is structurally impossible because there is no on-disk flag.
  // adr: adr/agent-stub-model.md
  // ==========================================================================
  console.log('\nArch: agentCreated is never written to disk');
  {
    const filePath = join(TEST_PROFILE_DIR, 'arch-stub-disk.md');
    // Save a doc — regardless of input metadata, agentCreated must not survive.
    const doc = {
      type: 'doc',
      content: [
        { type: 'paragraph', attrs: { id: 'p_arch_1' }, content: [{ type: 'text', text: 'Real content.' }] },
      ],
    };
    setActiveDocument(doc, 'Arch Stub', filePath, false, undefined, {
      title: 'Arch Stub', docId: 'arc00001',
      // Caller passes the legacy flag — model strips it.
      agentCreated: true,
    });
    save();
    cancelDebouncedSave();

    const raw = readFileSync(filePath, 'utf-8');
    const { data: meta } = matter(raw);
    assert(!('agentCreated' in meta),
      `'agentCreated' field is absent from on-disk frontmatter (got ${JSON.stringify(meta)})`);
  }

  // ==========================================================================
  // Arch: the in-memory stub registry is the only authority for stub status.
  //   markAsAgentStub adds; saving with accepted content removes (graduation);
  //   unmarkAgentStub removes explicitly.
  // ==========================================================================
  console.log('\nArch: in-memory stub registry tracks status across lifecycle');
  {
    const { markAsAgentStub, unmarkAgentStub, isAgentStub } = await import('../dist/server/state.js');

    // Not in set initially
    assert(!isAgentStub('test-stub.md'), 'unknown file is not a stub');

    // Mark adds it
    markAsAgentStub('test-stub.md');
    assert(isAgentStub('test-stub.md'), 'mark adds to registry');

    // Unmark removes it
    unmarkAgentStub('test-stub.md');
    assert(!isAgentStub('test-stub.md'), 'unmark removes from registry');

    // Empty/falsy filename is a no-op (defensive)
    markAsAgentStub('');
    assert(!isAgentStub(''), 'empty filename never enters the registry');
  }

  // ==========================================================================
  // Arch: graduation — saving a doc with accepted content removes it
  //   from the stub registry.
  // ==========================================================================
  console.log('\nArch: save with accepted content graduates out of stub registry');
  {
    const { markAsAgentStub, isAgentStub } = await import('../dist/server/state.js');
    const filePath = join(TEST_PROFILE_DIR, 'arch-graduate.md');
    const filename = 'arch-graduate.md';

    markAsAgentStub(filename);
    assert(isAgentStub(filename), 'pre-save: registered as stub');

    const doc = {
      type: 'doc',
      content: [
        { type: 'paragraph', attrs: { id: 'p_grad_1' }, content: [{ type: 'text', text: 'Accepted prose, no pending.' }] },
      ],
    };
    setActiveDocument(doc, 'Arch Graduate', filePath, false, undefined, {
      title: 'Arch Graduate', docId: 'arc00002',
    });
    save();
    cancelDebouncedSave();

    assert(!isAgentStub(filename),
      'post-save with accepted content: stub status removed (graduation)');
  }

  // ==========================================================================
  // Arch: a pure stub (only pending-insert content) stays in the registry
  //   through save — graduation requires accepted content.
  // ==========================================================================
  console.log('\nArch: pure stub stays registered through save until accept');
  {
    const { markAsAgentStub, isAgentStub } = await import('../dist/server/state.js');
    const filePath = join(TEST_PROFILE_DIR, 'arch-pure-stub.md');
    const filename = 'arch-pure-stub.md';

    markAsAgentStub(filename);
    assert(isAgentStub(filename), 'pre-save: registered as stub');

    const doc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          attrs: { id: 'p_pure_1', pendingStatus: 'insert' },
          content: [{ type: 'text', text: 'Only pending content.' }],
        },
      ],
    };
    setActiveDocument(doc, 'Arch Pure Stub', filePath, false, undefined, {
      title: 'Arch Pure Stub', docId: 'arc00003',
    });
    save();
    cancelDebouncedSave();

    assert(isAgentStub(filename),
      'post-save with only pending: stub status preserved (no graduation yet)');

    // The on-disk file STILL has no agentCreated field
    const raw = readFileSync(filePath, 'utf-8');
    const { data: meta } = matter(raw);
    assert(!('agentCreated' in meta), 'pure stub frontmatter has no agentCreated field');
  }

  // ==========================================================================
  // Arch: legacy on-disk `agentCreated: true` from pre-fix files is stripped
  //   on load and not re-written. No in-memory stub registration — by
  //   definition, a flag that survived to disk is too stale to be a fresh stub.
  // ==========================================================================
  console.log('\nArch: legacy on-disk agentCreated is stripped on load');
  {
    const { isAgentStub } = await import('../dist/server/state.js');
    const filePath = join(TEST_PROFILE_DIR, 'legacy-stub.md');
    const filename = 'legacy-stub.md';
    // Manually write a file with the legacy flag, as if from a pre-fix version
    const legacyMd = '---\n{"title":"Legacy","docId":"lgy00001","agentCreated":true}\n---\n\nLegacy content.\n\n';
    fsWriteFileSync(filePath, legacyMd, 'utf-8');

    // Load via setActiveDocument with the parsed-from-disk metadata
    const raw = readFileSync(filePath, 'utf-8');
    const { data: parsedMeta, content: body } = matter(raw);
    assert(parsedMeta.agentCreated === true, 'pre-load: legacy flag was on disk');

    const doc = {
      type: 'doc',
      content: [{ type: 'paragraph', attrs: { id: 'p_leg_1' }, content: [{ type: 'text', text: 'Legacy content.' }] }],
    };
    // Load the legacy file. setActiveDocument strips agentCreated from the
    // in-memory metadata (the load-time half of the invariant), but loading
    // neither rewrites disk nor bumps docVersion.
    setActiveDocument(doc, 'Legacy', filePath, false, undefined, { ...parsedMeta });
    // A real edit is what cleans the legacy flag off DISK. The save-time strip
    // (stripLegacyAgentCreated in writeToDisk) lives downstream of the no-op
    // gate (docVersion === lastSavedDocVersion, added 26853c2 after this test):
    // a bare save() with no mutation short-circuits at that gate and never
    // rewrites the file. Mutate through the production path (updateDocument
    // bumps docVersion) so the strip-on-save runs — exactly as it would on the
    // user's next edit of a migrated file. (In production a legacy flag is inert
    // either way: it's stripped from memory at load and never promotes to the
    // in-memory stub registry, which is the only authority for the destructive
    // reject-delete — see adr/agent-stub-model.md.)
    updateDocument({
      type: 'doc',
      content: [{ type: 'paragraph', attrs: { id: 'p_leg_1' }, content: [{ type: 'text', text: 'Legacy content, now edited.' }] }],
    });
    save();
    cancelDebouncedSave();

    assert(!isAgentStub(filename),
      'legacy flag does NOT promote to in-memory stub registry (would be data loss to treat aged file as fresh stub)');

    const reread = readFileSync(filePath, 'utf-8');
    const { data: metaAfter } = matter(reread);
    assert(!('agentCreated' in metaAfter),
      `legacy flag stripped from disk on save (got ${JSON.stringify(metaAfter)})`);
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
