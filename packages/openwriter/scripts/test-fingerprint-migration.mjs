/**
 * Verify v0.14 -> v0.15 fingerprint format migration.
 *
 * v0.14 disk format: sentence tuples {c, f, l, t, wls, w} with word arrays.
 * v0.15 disk format: sentence tuples {c, h, t} with content hashes.
 *
 * Migration: at load time AND save time, if disk frontmatter carries legacy
 * format, re-fingerprint positionally from the freshly-parsed body so the
 * matcher can pin via hash equality. Graveyard legacy entries are dropped.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import matter from 'gray-matter';
import { isLegacyFingerprint, migrateLegacyEntries, dropLegacyGraveyard } from '../dist/server/node-fingerprint.js';
import { markdownToTiptap } from '../dist/server/markdown.js';
import {
  setActiveDocument,
  save,
  cancelDebouncedSave,
} from '../dist/server/state.js';
import { setActiveProfile, ensureDataDir } from '../dist/server/helpers.js';

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) { passed++; console.log(`  PASS: ${msg}`); }
  else      { failed++; console.error(`  FAIL: ${msg}`); }
}

const TEST_PROFILE = `test-fp-migration-${Date.now()}`;
const TEST_PROFILE_DIR = join(homedir(), '.openwriter', 'profiles', TEST_PROFILE);

function cleanup() {
  cancelDebouncedSave();
  try { rmSync(TEST_PROFILE_DIR, { recursive: true, force: true }); } catch {}
}
process.on('exit', cleanup);

setActiveProfile(TEST_PROFILE);
mkdirSync(TEST_PROFILE_DIR, { recursive: true });
ensureDataDir();

try {
  console.log('T1: isLegacyFingerprint detects v0.14 format');
  const legacyFp = {
    type: 'paragraph', position: 0, parentPosition: null,
    charCount: 12, sentenceCount: 1, wordCount: 2,
    sentences: [{ c: 12, f: 'Hel', l: 'rld', t: 'D', wls: [5, 5], w: ['Hello', 'world'] }],
    structureSig: { bold: 0, italic: 0, links: 0, code: 0 },
    prevType: null, nextType: null, parentType: null,
    firstWords: ['Hello', 'world'], lastWords: ['Hello', 'world'],
  };
  const compactFp = {
    type: 'paragraph', position: 0, parentPosition: null,
    charCount: 12, sentenceCount: 1, wordCount: 2,
    sentences: [{ c: 12, h: 'abc12345', t: 'D' }],
    structureSig: { bold: 0, italic: 0, links: 0, code: 0 },
    prevType: null, nextType: null, parentType: null,
  };
  assert(isLegacyFingerprint(legacyFp) === true, 'detects v0.14 fingerprint as legacy');
  assert(isLegacyFingerprint(compactFp) === false, 'compact v0.15 fingerprint is NOT legacy');
  assert(isLegacyFingerprint(null) === false, 'null is not legacy');
  assert(isLegacyFingerprint(undefined) === false, 'undefined is not legacy');

  console.log('\nT2: migrateLegacyEntries re-fingerprints positionally from fresh blocks');
  const legacyEntries = [
    { id: 'abc11111', fingerprint: legacyFp },
    { id: 'abc22222', fingerprint: legacyFp },
  ];
  const freshBlocks = [
    { type: 'paragraph', position: 0, text: 'Hello world.', parentPosition: null, ordinalInParent: 0, inlineMarks: { bold: 0, italic: 0, links: 0, code: 0 } },
    { type: 'paragraph', position: 1, text: 'Second paragraph here.', parentPosition: null, ordinalInParent: 1, inlineMarks: { bold: 0, italic: 0, links: 0, code: 0 } },
  ];
  const migrated = migrateLegacyEntries(legacyEntries, freshBlocks);
  assert(migrated.length === 2, 'migration preserves entry count');
  assert(migrated[0].id === 'abc11111', 'first id preserved');
  assert(migrated[1].id === 'abc22222', 'second id preserved');
  assert(isLegacyFingerprint(migrated[0].fingerprint) === false, 'first fp is now v0.15');
  assert(isLegacyFingerprint(migrated[1].fingerprint) === false, 'second fp is now v0.15');
  assert(migrated[0].fingerprint.sentences[0].h !== undefined, 'sentence has h field');
  assert(migrated[0].fingerprint.sentences[0].w === undefined, 'sentence has no w field');

  console.log('\nT3: migrateLegacyEntries passes through compact entries unchanged');
  const compactEntries = [{ id: 'xyz12345', fingerprint: compactFp }];
  const compactResult = migrateLegacyEntries(compactEntries, freshBlocks);
  assert(compactResult === compactEntries, 'compact entries returned as-is (no allocation)');

  console.log('\nT4: dropLegacyGraveyard removes legacy entries');
  const mixedGraveyard = [
    { id: 'grv11111', fingerprint: legacyFp },
    { id: 'grv22222', fingerprint: compactFp },
    { id: 'grv33333', fingerprint: legacyFp },
  ];
  const cleaned = dropLegacyGraveyard(mixedGraveyard);
  assert(cleaned.length === 1, 'only compact graveyard entry kept');
  assert(cleaned[0].id === 'grv22222', 'kept entry is the compact one');

  console.log('\nT5: end-to-end — legacy file on disk migrates on first save');
  const legacyFm = {
    title: 'Legacy Doc',
    docId: 'leg00001',
    nodes: [
      { id: 'old11111', fp: {
        type: 'heading', position: 0, parentPosition: null, ordinalInParent: 0,
        charCount: 11, sentenceCount: 1, wordCount: 2,
        sentences: [{ c: 11, f: 'Leg', l: 'oc.', t: 'D', wls: [6, 4], w: ['Legacy', 'Doc'] }],
        structureSig: { bold: 0, italic: 0, links: 0, code: 0 },
        prevType: null, nextType: 'paragraph', parentType: null,
        firstWords: ['Legacy', 'Doc'], lastWords: ['Legacy', 'Doc'],
        level: 1,
      }},
      { id: 'old22222', fp: {
        type: 'paragraph', position: 1, parentPosition: null, ordinalInParent: 1,
        charCount: 21, sentenceCount: 1, wordCount: 4,
        sentences: [{ c: 21, f: 'Som', l: 'xt.', t: 'D', wls: [4, 4, 5, 3], w: ['Some', 'body', 'text', 'yes'] }],
        structureSig: { bold: 0, italic: 0, links: 0, code: 0 },
        prevType: 'heading', nextType: null, parentType: null,
        firstWords: ['Some', 'body', 'text', 'yes'], lastWords: ['Some', 'body', 'text', 'yes'],
      }},
    ],
    graveyard: [
      { id: 'grv99999', fp: {
        type: 'paragraph', position: 0, parentPosition: null, ordinalInParent: 0,
        charCount: 7, sentenceCount: 1, wordCount: 1,
        sentences: [{ c: 7, f: 'Del', l: 'ed.', t: 'D', wls: [7], w: ['Deleted'] }],
        structureSig: { bold: 0, italic: 0, links: 0, code: 0 },
        prevType: null, nextType: null, parentType: null,
        firstWords: ['Deleted'], lastWords: ['Deleted'],
      }},
    ],
  };
  const legacyMarkdown = '---\n' + JSON.stringify(legacyFm) + '\n---\n\n# Legacy Doc\n\nSome body text yes.\n';

  const filePath = join(TEST_PROFILE_DIR, 'legacy.md');
  writeFileSync(filePath, legacyMarkdown);

  // Load via parsing path (matcher runs here)
  const parsed = markdownToTiptap(legacyMarkdown);
  const headingId = parsed.document.content[0].attrs.id;
  const paraId = parsed.document.content[1].attrs.id;
  assert(headingId === 'old11111', `load-time matcher preserved heading id (got ${headingId})`);
  assert(paraId === 'old22222', `load-time matcher preserved paragraph id (got ${paraId})`);

  // Set active and save — should write v0.15 format
  setActiveDocument(parsed.document, parsed.title, filePath, false, undefined, parsed.metadata);
  save();

  const fmAfter = matter(readFileSync(filePath, 'utf-8')).data;
  assert(fmAfter.nodes.length === 2, 'saved doc has 2 nodes');
  assert(fmAfter.nodes[0].fp.sentences[0].h !== undefined, 'saved fp has h field (v0.15)');
  assert(fmAfter.nodes[0].fp.sentences[0].w === undefined, 'saved fp has no w field (v0.14)');
  assert(fmAfter.nodes[0].fp.sentences[0].wls === undefined, 'saved fp has no wls field');
  assert(fmAfter.nodes[0].fp.sentences[0].f === undefined, 'saved fp has no f field');
  assert(fmAfter.nodes[0].fp.firstWords === undefined, 'saved fp has no firstWords');
  assert(fmAfter.nodes[0].fp.lastWords === undefined, 'saved fp has no lastWords');
  assert(fmAfter.nodes[0].id === 'old11111', 'heading id preserved through migration save');
  assert(fmAfter.nodes[1].id === 'old22222', 'paragraph id preserved through migration save');
  // Legacy graveyard dropped
  assert(!fmAfter.graveyard || fmAfter.graveyard.length === 0,
    'legacy graveyard entries dropped (got ' + JSON.stringify(fmAfter.graveyard) + ')');

  console.log('\nT6: size shrinkage on real-ish content');
  const beforeBytes = legacyMarkdown.length;
  const afterBytes = readFileSync(filePath, 'utf-8').length;
  console.log(`  Before migration: ${beforeBytes} bytes`);
  console.log(`  After migration:  ${afterBytes} bytes`);
  console.log(`  Reduction: ${(100 * (1 - afterBytes / beforeBytes)).toFixed(1)}%`);
  assert(afterBytes < beforeBytes * 0.7, `>= 30% shrinkage (got ${(100 * (1 - afterBytes / beforeBytes)).toFixed(1)}%)`);

  console.log('\n' + '='.repeat(60));
  console.log(`Fingerprint migration: ${passed} passed, ${failed} failed`);
  console.log('='.repeat(60));
  if (failed > 0) process.exit(1);
} catch (e) {
  console.error('Test error:', e);
  process.exit(1);
}
