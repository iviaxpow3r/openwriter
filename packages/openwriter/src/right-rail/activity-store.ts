/**
 * Activity event store. Module-level state so live events captured while
 * the rail is CLOSED (or sitting on a different tab) survive until the
 * Activity tab mounts and can render them.
 *
 * Sources:
 *   - ow-activity-seed (initial connect) replaces the entire list
 *   - ow-activity-event (live arrivals) prepends one entry + tags as fresh
 *
 * Subscribers re-render whenever the list or fresh-set changes.
 *
 * adr: adr/right-rail.md
 */

import { useEffect, useState } from 'react';

export interface ActivityEvent {
  ts: number;
  kind:
    | 'writing-started'
    | 'writing-finished'
    | 'enrichment'
    | 'backlinks-added'
    | 'doc-created'
    | 'doc-deleted';
  headline: string;
  detail?: string;
  /** Stable id of the doc the entry points at. Preferred over `filename` —
   *  the row resolves it to the current filename at click time via the live
   *  doc map, so renames don't break navigation and deleted docs (absent
   *  from the map) naturally render as non-clickable. */
  docId?: string;
  filename?: string;
  nodeId?: string;
}

export interface ActivityState {
  entries: ActivityEvent[];
  freshKeys: Set<string>;
}

const FRESH_TTL_MS = 30_000;
const MAX_ENTRIES = 500;

let state: ActivityState = { entries: [], freshKeys: new Set() };
const listeners = new Set<(s: ActivityState) => void>();

export function eventKey(e: ActivityEvent): string {
  return `${e.ts}:${e.kind}:${e.headline}`;
}

function notify(): void {
  for (const l of listeners) l(state);
}

function setState(next: ActivityState): void {
  state = next;
  notify();
}

/** Subscribe to store updates. Returns an unsubscribe function. */
export function subscribe(cb: (s: ActivityState) => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

export function getState(): ActivityState {
  return state;
}

function handleSeed(e: Event): void {
  const detail = (e as CustomEvent<{ entries: ActivityEvent[] }>).detail;
  if (!detail?.entries) return;
  setState({ entries: detail.entries, freshKeys: new Set() });
}

function handleEvent(e: Event): void {
  const detail = (e as CustomEvent<{ event: ActivityEvent }>).detail;
  if (!detail?.event) return;
  const evt = detail.event;
  const key = eventKey(evt);
  const next: ActivityState = {
    entries: [evt, ...state.entries].slice(0, MAX_ENTRIES),
    freshKeys: new Set([...state.freshKeys, key]),
  };
  setState(next);
  window.setTimeout(() => {
    if (state.freshKeys.has(key)) {
      const fresh = new Set(state.freshKeys);
      fresh.delete(key);
      setState({ ...state, freshKeys: fresh });
    }
  }, FRESH_TTL_MS);
}

// Module init — wire to window once. The bridge in ws/client.ts dispatches
// these events; the store consumes them whether or not any tab is mounted.
if (typeof window !== 'undefined') {
  window.addEventListener('ow-activity-seed', handleSeed);
  window.addEventListener('ow-activity-event', handleEvent);
}

/** React hook: returns the current store state and re-renders on update. */
export function useActivity(): ActivityState {
  const [snapshot, setSnapshot] = useState<ActivityState>(getState);
  useEffect(() => subscribe(setSnapshot), []);
  return snapshot;
}
