/**
 * Logger module: levels, redaction, request IDs, rotation.
 *
 * Architectural model under test:
 *   - Default config (missing file): error-only, no text. Safe for public.
 *   - Verbose config (file present with trace+includeText): full logs with text.
 *   - Errors always log regardless of level (a crash trace is non-negotiable).
 *   - Request IDs flow through async chains via AsyncLocalStorage.
 *   - Text redaction is enforced by the `redactText` helper.
 *
 * adr: adr/logging-system.md
 *
 * Run: `node scripts/test-logger.mjs`
 */

import { mkdirSync, readFileSync, rmSync, existsSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import {
  initLogger,
  logger,
  redactText,
  generateRequestId,
  withRequestId,
  getCurrentRequestId,
  getLogConfig,
} from '../dist/server/logger.js';
import { setActiveProfile, ensureDataDir, getDataDir } from '../dist/server/helpers.js';

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) { passed++; console.log(`  PASS: ${msg}`); }
  else      { failed++; console.error(`  FAIL: ${msg}`); }
}

const TEST_PROFILE = `test-logger-${Date.now()}`;
const TEST_PROFILE_DIR = join(homedir(), '.openwriter', 'profiles', TEST_PROFILE);
const CONFIG_PATH = join(homedir(), '.openwriter', 'log-config.json');
const SAVED_CONFIG_BACKUP = existsSync(CONFIG_PATH) ? readFileSync(CONFIG_PATH, 'utf-8') : null;

function cleanup() {
  try { rmSync(TEST_PROFILE_DIR, { recursive: true, force: true }); } catch { /* best-effort */ }
  // Restore original config file (the operator's verbose config)
  if (SAVED_CONFIG_BACKUP !== null) {
    try { writeFileSync(CONFIG_PATH, SAVED_CONFIG_BACKUP); } catch { /* best-effort */ }
  } else {
    try { rmSync(CONFIG_PATH, { force: true }); } catch { /* best-effort */ }
  }
}

function readEvents() {
  const path = join(TEST_PROFILE_DIR, 'events.log');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(1); });

setActiveProfile(TEST_PROFILE);
mkdirSync(TEST_PROFILE_DIR, { recursive: true });
ensureDataDir();

try {
  // ==========================================================================
  // T1: Default config (no file) = error-only + no text. Safe for public.
  // ==========================================================================
  console.log('T1: default config is safe-for-public (error-only, no text)');
  {
    try { rmSync(CONFIG_PATH, { force: true }); } catch { /* best-effort */ }
    initLogger();
    const cfg = getLogConfig();
    assert(cfg.level === 'error', `default level is error (got ${cfg.level})`);
    assert(cfg.includeText === false, `default includeText is false (got ${cfg.includeText})`);

    logger.info('state', 'noisy-info', 'should not land at default level');
    logger.warn('state', 'noisy-warn', 'also should not land');
    logger.error('state', 'real-error', 'errors always land');

    const events = readEvents();
    assert(events.length === 1, `only 1 event landed (got ${events.length})`);
    assert(events[0].event === 'real-error', `the landed event is the error (got ${events[0].event})`);

    // redactText returns redacted form when includeText:false
    const redacted = redactText('SECRET_DOCUMENT_TEXT');
    assert(redacted === '<redacted:20chars>', `redactText hides text by default (got "${redacted}")`);
  }

  // ==========================================================================
  // T2: Verbose config (level=trace, includeText=true) = full logs with text.
  //     This is the operator's local setup.
  // ==========================================================================
  console.log('\nT2: verbose config logs everything with text');
  {
    try { rmSync(join(TEST_PROFILE_DIR, 'events.log'), { force: true }); } catch { /* best-effort */ }
    writeFileSync(CONFIG_PATH, JSON.stringify({ level: 'trace', includeText: true }), 'utf-8');
    initLogger();
    const cfg = getLogConfig();
    assert(cfg.level === 'trace', `verbose level is trace (got ${cfg.level})`);
    assert(cfg.includeText === true, `verbose includeText is true (got ${cfg.includeText})`);

    logger.trace('state', 'trace-event', 'lowest level');
    logger.debug('state', 'debug-event', 'still on');
    logger.info('state', 'info-event', 'still on');
    logger.warn('state', 'warn-event', 'still on');
    logger.error('state', 'error-event', 'still on');

    const events = readEvents();
    assert(events.length === 5, `all 5 levels landed (got ${events.length})`);

    // redactText returns original text when includeText:true
    const visible = redactText('SECRET_DOCUMENT_TEXT');
    assert(visible === 'SECRET_DOCUMENT_TEXT', `redactText passes text through (got "${visible}")`);
  }

  // ==========================================================================
  // T3: Request IDs propagate through async chains.
  // ==========================================================================
  console.log('\nT3: request IDs flow through async work');
  {
    try { rmSync(join(TEST_PROFILE_DIR, 'events.log'), { force: true }); } catch { /* best-effort */ }
    const reqId = generateRequestId('test');
    assert(reqId.startsWith('test-'), `generateRequestId uses prefix (got ${reqId})`);

    assert(getCurrentRequestId() === undefined, 'outside withRequestId: no current ID');

    await withRequestId(reqId, async () => {
      assert(getCurrentRequestId() === reqId, 'inside withRequestId: current ID matches');
      logger.info('state', 'inside-scope', 'should have requestId attached');
      // Async work inherits the scope.
      await new Promise((r) => setTimeout(r, 10));
      assert(getCurrentRequestId() === reqId, 'request ID survives async boundary');
      logger.info('state', 'after-await', 'still in scope');
    });

    assert(getCurrentRequestId() === undefined, 'after withRequestId: no current ID');

    const events = readEvents();
    assert(events.length === 2, `2 events landed (got ${events.length})`);
    assert(events.every((e) => e.requestId === reqId),
      `every event in the scope carries the requestId (got ${events.map((e) => e.requestId).join(',')})`);
  }

  // ==========================================================================
  // T4: Errors always log regardless of level (even at level=error).
  //     This is non-negotiable — a crash trace must always survive.
  // ==========================================================================
  console.log('\nT4: errors always log regardless of level');
  {
    try { rmSync(join(TEST_PROFILE_DIR, 'events.log'), { force: true }); } catch { /* best-effort */ }
    writeFileSync(CONFIG_PATH, JSON.stringify({ level: 'error', includeText: false }), 'utf-8');
    initLogger();

    const err = new Error('something broke');
    logger.error('error', 'unexpected-throw', 'caught at boundary', { extra: 'detail' }, err);

    const events = readEvents();
    assert(events.length === 1, `1 error event landed (got ${events.length})`);
    assert(events[0].err?.message === 'something broke',
      `error message preserved (got "${events[0].err?.message}")`);
    assert(typeof events[0].err?.stack === 'string',
      'stack trace preserved');
    assert(events[0].fields?.extra === 'detail', 'extra fields preserved');
  }

  // ==========================================================================
  // T5: Malformed config falls back to safe defaults silently.
  // ==========================================================================
  console.log('\nT5: malformed config falls back to safe defaults');
  {
    writeFileSync(CONFIG_PATH, 'this is not json {{{ malformed', 'utf-8');
    initLogger();
    const cfg = getLogConfig();
    assert(cfg.level === 'error', `malformed config → error level (got ${cfg.level})`);
    assert(cfg.includeText === false, `malformed config → no text (got ${cfg.includeText})`);
  }

} catch (err) {
  console.error('TEST CRASH:', err);
  process.exitCode = 1;
} finally {
  cleanup();
}

console.log('\n' + '='.repeat(60));
console.log(`Logger: ${passed} passed, ${failed} failed`);
console.log('='.repeat(60));
process.exit(failed > 0 ? 1 : 0);
