/**
 * Single-debouncedSave test: verifies that the process-wide debouncedSave
 * timer (exported from state.ts) coalesces multiple calls into one save,
 * and that cancelDebouncedSave aborts a pending save.
 *
 * Replaces the previous two-timer arrangement (state.ts 500ms + ws.ts 2s).
 *
 * adr: adr/pending-overlay-model.md
 *
 * Run: `node scripts/test-debounced-save.mjs`
 */

import { mkdirSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import {
  setActiveDocument,
  debouncedSave,
  cancelDebouncedSave,
  bumpDocVersion,
} from '../dist/server/state.js';
import { setActiveProfile, ensureDataDir } from '../dist/server/helpers.js';

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) { passed++; console.log(`  PASS: ${msg}`); }
  else      { failed++; console.error(`  FAIL: ${msg}`); }
}

const TEST_PROFILE = `test-debounced-save-${Date.now()}`;
const TEST_PROFILE_DIR = join(homedir(), '.openwriter', 'profiles', TEST_PROFILE);

function cleanup() {
  cancelDebouncedSave();
  try { rmSync(TEST_PROFILE_DIR, { recursive: true, force: true }); } catch { /* best-effort */ }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeNode(id, text) {
  return { type: 'paragraph', attrs: { id }, content: [{ type: 'text', text }] };
}

try {
  setActiveProfile(TEST_PROFILE);
  ensureDataDir();
  mkdirSync(TEST_PROFILE_DIR, { recursive: true });

  const filePath = join(TEST_PROFILE_DIR, 'debounce.md');
  const seed = { type: 'doc', content: [makeNode('p1', 'hello')] };
  setActiveDocument(seed, 'debounce', filePath, false, new Date(), { docId: 'dbnc001', title: 'debounce' }, null);

  // --- Scenario 1: single debouncedSave fires after ~500ms ---
  console.log('\nScenario 1: single debouncedSave fires within 600ms');

  // Initial write at setActiveDocument may have already armed/fired a save.
  // Wait past that, then test our own fire.
  await sleep(700);
  // Reset by removing the file to make the next save observable.
  try { rmSync(filePath, { force: true }); } catch { /* */ }

  bumpDocVersion(); // mutate state so save has work to do
  debouncedSave();
  assert(!existsSync(filePath), 'file does not exist immediately after debouncedSave (timer pending)');

  await sleep(600);
  assert(existsSync(filePath), 'file exists after ~600ms (timer fired)');

  // --- Scenario 2: rapid debouncedSave calls coalesce into one save ---
  console.log('\nScenario 2: rapid calls coalesce — last one wins');

  try { rmSync(filePath, { force: true }); } catch { /* */ }

  // Call 5 times in quick succession. Only the last timer arm should fire.
  for (let i = 0; i < 5; i++) {
    bumpDocVersion();
    debouncedSave();
    await sleep(80); // each call < 500ms apart, resetting the timer
  }
  // Total elapsed: ~400ms. Timer should still be pending.
  assert(!existsSync(filePath), 'file does not exist mid-burst (timer keeps getting reset)');

  // Wait for the timer to fire after the last call.
  await sleep(600);
  assert(existsSync(filePath), 'file exists after burst settled');

  // --- Scenario 3: cancelDebouncedSave aborts a pending save ---
  console.log('\nScenario 3: cancelDebouncedSave aborts the pending save');

  try { rmSync(filePath, { force: true }); } catch { /* */ }

  bumpDocVersion();
  debouncedSave();
  await sleep(100); // partway into the 500ms window
  cancelDebouncedSave();

  await sleep(700); // well past when it would have fired
  assert(!existsSync(filePath), 'file does not exist — cancel aborted the save');

  console.log('\n============================================================');
  console.log(`Debounced-save: ${passed} passed, ${failed} failed`);
  console.log('============================================================');
} finally {
  cleanup();
}

if (failed > 0) process.exit(1);
