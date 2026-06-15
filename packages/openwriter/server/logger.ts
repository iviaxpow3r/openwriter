/**
 * Structured event logger for openwriter.
 *
 * Architectural model:
 *   - One JSON-per-line file at `~/.openwriter/profiles/<profile>/events.log`.
 *     One file (not per-category) so grep/jq covers everything in one place.
 *   - Levels: error < warn < info < debug < trace. Default `error` — safe
 *     for public installs. The operator's machine overrides to `trace` via
 *     `~/.openwriter/log-config.json`.
 *   - Document text is redacted unless `includeText: true` is set in the
 *     config file. Public users never have text content land in logs.
 *   - Request IDs flow through async chains via AsyncLocalStorage. One
 *     external trigger (MCP tool call, WS message) gets one ID; every
 *     event emitted while processing inherits it. "What did this request
 *     cause" is a single jq query.
 *   - 50 MB rotation, keep last 5. No manual cleanup ever needed.
 *   - File handle owned by us (not stdout) so logs survive MCP kill+
 *     restart. The current `diagnostic.log` proved this works.
 *
 * Public users see: errors only, no text, small file, share freely for
 * bug reports without privacy concern. The operator sees: everything, with text.
 *
 * adr: adr/logging-system.md
 */

import { existsSync, mkdirSync, statSync, renameSync, unlinkSync, appendFileSync, readFileSync, watch, type FSWatcher } from 'fs';
import { join } from 'path';
import { AsyncLocalStorage } from 'async_hooks';
import { homedir } from 'os';
import { getDataDir } from './helpers.js';

// ============================================================================
// TYPES
// ============================================================================

export type LogLevel = 'error' | 'warn' | 'info' | 'debug' | 'trace';
export type LogCategory =
  | 'mcp'         // MCP tool handler entries/exits
  | 'ws'          // WebSocket messages in/out
  | 'state'       // State mutations (updateDocument, setActiveDocument, etc.)
  | 'overlay'     // Pending overlay saves/loads/applies
  | 'save'        // Disk writes (canonical .md)
  | 'watch'       // fs.watch external write events
  | 'lock'        // Agent lock transitions
  | 'plugin'      // Plugin lifecycle / errors
  | 'lifecycle'   // Doc create/delete/archive/rename
  | 'error';      // Caught errors (always logged regardless of level)

const LEVEL_RANK: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
  trace: 4,
};

interface LogConfig {
  level: LogLevel;
  includeText: boolean;
}

interface LogEvent {
  ts: string;
  level: LogLevel;
  category: LogCategory;
  event: string;
  requestId?: string;
  msg?: string;
  fields?: Record<string, any>;
  err?: { message: string; stack?: string };
}

// ============================================================================
// CONFIG
// ============================================================================

const CONFIG_PATH = join(homedir(), '.openwriter', 'log-config.json');

const DEFAULT_CONFIG: LogConfig = {
  level: 'error',     // safe-for-public: errors only
  includeText: false, // safe-for-public: no document content
};

let currentConfig: LogConfig = { ...DEFAULT_CONFIG };
let configWatcher: FSWatcher | null = null;

function readConfig(): LogConfig {
  if (!existsSync(CONFIG_PATH)) return { ...DEFAULT_CONFIG };
  try {
    const raw = readFileSync(CONFIG_PATH, 'utf-8');
    const data = JSON.parse(raw);
    const level: LogLevel = (typeof data.level === 'string' && data.level in LEVEL_RANK) ? data.level : DEFAULT_CONFIG.level;
    const includeText = data.includeText === true;
    return { level, includeText };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

/** Initialize the logger. Reads config file, sets up live-reload watcher. */
export function initLogger(): void {
  currentConfig = readConfig();
  // Live-reload on config changes — flip verbosity without restarting.
  if (existsSync(CONFIG_PATH)) {
    try {
      configWatcher?.close();
      configWatcher = watch(CONFIG_PATH, { persistent: false }, () => {
        const next = readConfig();
        const changed = next.level !== currentConfig.level || next.includeText !== currentConfig.includeText;
        currentConfig = next;
        if (changed) {
          // Log the config change itself so it's traceable in the log.
          writeEvent({
            ts: new Date().toISOString(),
            level: 'info',
            category: 'state',
            event: 'log-config-reloaded',
            fields: { level: next.level, includeText: next.includeText },
          });
        }
      });
    } catch { /* best-effort */ }
  }
}

export function getLogConfig(): LogConfig {
  return { ...currentConfig };
}

// ============================================================================
// REQUEST ID CONTEXT
// ============================================================================

const requestContext = new AsyncLocalStorage<{ requestId: string }>();

/** Generate a short, greppable request ID. */
export function generateRequestId(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Run an async chain with a request ID attached. Every log call within
 *  fn (and its async descendants) automatically inherits the requestId. */
export function withRequestId<T>(requestId: string, fn: () => T): T {
  return requestContext.run({ requestId }, fn);
}

/** Current request ID, if any. Undefined outside a withRequestId scope. */
export function getCurrentRequestId(): string | undefined {
  return requestContext.getStore()?.requestId;
}

// ============================================================================
// TEXT REDACTION
// ============================================================================

/** Wrap any text content that should be redacted in public logs. When
 *  `includeText: true` in config, returns the original. Otherwise returns
 *  `<redacted:Nchars>`. Use this for any document text excerpt before
 *  passing it to a log call's `fields`. */
export function redactText(text: string | undefined | null): string {
  if (text == null) return '<null>';
  if (currentConfig.includeText) return text;
  return `<redacted:${text.length}chars>`;
}

// ============================================================================
// FILE I/O + ROTATION
// ============================================================================

const MAX_FILE_BYTES = 50 * 1024 * 1024; // 50 MB
const KEEP_ROTATIONS = 5;

function getLogPath(): string {
  return join(getDataDir(), 'events.log');
}

function ensureLogDir(): void {
  const dir = getDataDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function rotateIfNeeded(): void {
  const path = getLogPath();
  if (!existsSync(path)) return;
  let size: number;
  try { size = statSync(path).size; } catch { return; }
  if (size < MAX_FILE_BYTES) return;
  try {
    // Shift events.log.4 → .5 → discard, .3 → .4, ..., .log → .log.1
    for (let i = KEEP_ROTATIONS; i >= 1; i--) {
      const oldPath = i === 1 ? path : `${path}.${i - 1}`;
      const newPath = `${path}.${i}`;
      if (existsSync(oldPath)) {
        if (i === KEEP_ROTATIONS && existsSync(newPath)) {
          try { unlinkSync(newPath); } catch { /* best-effort */ }
        }
        if (existsSync(oldPath)) {
          try { renameSync(oldPath, newPath); } catch { /* best-effort */ }
        }
      }
    }
  } catch { /* best-effort */ }
}

function writeEvent(evt: LogEvent): void {
  try {
    ensureLogDir();
    rotateIfNeeded();
    appendFileSync(getLogPath(), JSON.stringify(evt) + '\n');
  } catch { /* logging must never throw — swallow */ }
}

// ============================================================================
// CORE LOG FUNCTIONS
// ============================================================================

function shouldLog(level: LogLevel): boolean {
  // Errors always log regardless of level (a crash trace is non-negotiable).
  if (level === 'error') return true;
  return LEVEL_RANK[level] <= LEVEL_RANK[currentConfig.level];
}

function log(level: LogLevel, category: LogCategory, event: string, msg?: string, fields?: Record<string, any>, err?: Error): void {
  if (!shouldLog(level)) return;
  const evt: LogEvent = {
    ts: new Date().toISOString(),
    level,
    category,
    event,
  };
  const reqId = getCurrentRequestId();
  if (reqId) evt.requestId = reqId;
  if (msg) evt.msg = msg;
  if (fields && Object.keys(fields).length > 0) evt.fields = fields;
  if (err) evt.err = { message: err.message, stack: err.stack };
  writeEvent(evt);
}

export const logger = {
  error(category: LogCategory, event: string, msg?: string, fields?: Record<string, any>, err?: Error): void {
    log('error', category, event, msg, fields, err);
  },
  warn(category: LogCategory, event: string, msg?: string, fields?: Record<string, any>): void {
    log('warn', category, event, msg, fields);
  },
  info(category: LogCategory, event: string, msg?: string, fields?: Record<string, any>): void {
    log('info', category, event, msg, fields);
  },
  debug(category: LogCategory, event: string, msg?: string, fields?: Record<string, any>): void {
    log('debug', category, event, msg, fields);
  },
  trace(category: LogCategory, event: string, msg?: string, fields?: Record<string, any>): void {
    log('trace', category, event, msg, fields);
  },
};

// ============================================================================
// MIGRATION SHIM — `diagLog` callsites get a clean migration path
// ============================================================================

/** Legacy shim — preserves the diagLog(line) API but routes through the
 *  structured logger as a plain `info`-level event. New code should use
 *  `logger.info/warn/etc(category, event, ...)` directly. */
export function diagLog(line: string): void {
  // Categorize based on prefix heuristics for free re-tagging.
  let category: LogCategory = 'state';
  if (line.startsWith('[Overlay]')) category = 'overlay';
  else if (line.startsWith('[WS]')) category = 'ws';
  else if (line.startsWith('[Lock]')) category = 'lock';
  else if (line.startsWith('[MCP]')) category = 'mcp';
  else if (line.startsWith('[Save]') || line.startsWith('[Disk]')) category = 'save';
  else if (line.startsWith('[Watch]') || line.startsWith('[fs.watch]')) category = 'watch';
  logger.info(category, 'legacy-diag', line);
}
