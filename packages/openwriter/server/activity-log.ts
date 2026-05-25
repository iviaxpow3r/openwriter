/**
 * Activity log — persistent record of agent-attributed actions.
 *
 * The right-rail Activity tab reads this log. Entries are appended on the
 * happy path of agent broadcasts (writing-finished, enrichment, backlinks
 * propagation, agent-attributed doc create/delete). Human edits do NOT
 * record entries — they aren't surprising to the user, so they're noise.
 *
 * Disk: JSONL at `<profile-dir>/activity.log`. Append-only with rotation
 * at 10 MB / 5 files. ~150 bytes per entry, so 10 MB ≈ 70k entries — years
 * of heavy use before the first rotation.
 *
 * Memory: a ring buffer of the most recent MAX_BUFFER_ENTRIES used to
 * answer "give me the last 500 for the new client" without ever touching
 * disk on the hot path.
 *
 * adr: adr/right-rail.md
 */

import { existsSync, mkdirSync, statSync, renameSync, unlinkSync, appendFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { getDataDir } from './helpers.js';

const MAX_BUFFER_ENTRIES = 500;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const KEEP_ROTATIONS = 5;

export type ActivityKind =
  | 'writing-started'
  | 'writing-finished'
  | 'enrichment'
  | 'backlinks-added'
  | 'doc-created'
  | 'doc-deleted';

export interface ActivityEvent {
  ts: number;
  kind: ActivityKind;
  headline: string;
  detail?: string;
  /** Stable id of the doc the entry points at. Resolved to a current filename
   *  at click time so renames don't break navigation. Preferred over `filename`
   *  for new entries; `filename` stays for back-compat with older log lines. */
  docId?: string;
  filename?: string;
  nodeId?: string;
}

let buffer: ActivityEvent[] = [];
let bufferSeeded = false;

function getLogPath(): string {
  return join(getDataDir(), 'activity.log');
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
    for (let i = KEEP_ROTATIONS; i >= 1; i--) {
      const oldPath = i === 1 ? path : `${path}.${i - 1}`;
      const newPath = `${path}.${i}`;
      if (existsSync(oldPath)) {
        if (i === KEEP_ROTATIONS && existsSync(newPath)) {
          try { unlinkSync(newPath); } catch { /* best-effort */ }
        }
        try { renameSync(oldPath, newPath); } catch { /* best-effort */ }
      }
    }
  } catch { /* best-effort */ }
}

/**
 * Read the tail of the on-disk log into the in-memory buffer the first
 * time someone asks for it. Subsequent calls are pure memory.
 *
 * The file is small enough that a one-shot full read on first access is
 * fine; if it ever stops being small the rotation logic above keeps it
 * bounded.
 */
function seedBuffer(): void {
  if (bufferSeeded) return;
  bufferSeeded = true;
  try {
    const path = getLogPath();
    if (!existsSync(path)) {
      buffer = [];
      return;
    }
    const raw = readFileSync(path, 'utf-8');
    const lines = raw.split('\n').filter((l) => l.length > 0);
    // File is oldest-first; the buffer carries newest-first to match what
    // the client expects (and what every push extends).
    const parsed: ActivityEvent[] = [];
    for (let i = lines.length - 1; i >= 0 && parsed.length < MAX_BUFFER_ENTRIES; i--) {
      try {
        const evt = JSON.parse(lines[i]);
        if (evt && typeof evt.ts === 'number' && typeof evt.kind === 'string' && typeof evt.headline === 'string') {
          parsed.push(evt as ActivityEvent);
        }
      } catch { /* skip malformed line */ }
    }
    buffer = parsed;
  } catch {
    buffer = [];
  }
}

/** Append an event. Records to memory + disk; returns the stamped event. */
export function recordActivity(partial: Omit<ActivityEvent, 'ts'> & { ts?: number }): ActivityEvent {
  seedBuffer();
  const evt: ActivityEvent = {
    ts: partial.ts ?? Date.now(),
    kind: partial.kind,
    headline: partial.headline,
  };
  if (partial.detail) evt.detail = partial.detail;
  if (partial.docId) evt.docId = partial.docId;
  if (partial.filename) evt.filename = partial.filename;
  if (partial.nodeId) evt.nodeId = partial.nodeId;

  buffer.unshift(evt);
  if (buffer.length > MAX_BUFFER_ENTRIES) buffer.length = MAX_BUFFER_ENTRIES;

  try {
    ensureLogDir();
    rotateIfNeeded();
    appendFileSync(getLogPath(), JSON.stringify(evt) + '\n');
  } catch { /* logging must never throw */ }

  return evt;
}

/** Tail of the activity log, newest-first. Used to seed clients on connect. */
export function loadActivityTail(limit = MAX_BUFFER_ENTRIES): ActivityEvent[] {
  seedBuffer();
  return buffer.slice(0, Math.min(limit, buffer.length));
}

/**
 * Drop the in-memory buffer and force the next read to re-seed from disk.
 * Called on profile switch — without this, the new profile inherits the
 * previous profile's activity entries because `seedBuffer()` short-circuits
 * when `bufferSeeded === true`. Disk writes are always per-profile (via
 * getDataDir), so only the memory side leaks; this resets that side.
 * adr: adr/right-rail.md
 */
export function clearActivityBuffer(): void {
  buffer = [];
  bufferSeeded = false;
}
