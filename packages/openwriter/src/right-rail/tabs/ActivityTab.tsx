/**
 * Activity tab — workspace-wide log of agent-attributed actions.
 *
 * Reads the seeded log via WS `activity-log` message on connect, then consumes
 * live `activity-event` broadcasts. Relative timestamps auto-update every 30s.
 * New entries arriving live render an accent bar that fades over ~30s.
 *
 * adr: adr/right-rail.md
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { RightRailTabProps } from '../types';

export interface ActivityEvent {
  /** Unix ms timestamp. */
  ts: number;
  /** Event kind. Future kinds can be added without breaking older clients. */
  kind:
    | 'writing-started'
    | 'writing-finished'
    | 'enrichment'
    | 'backlinks-added'
    | 'doc-created'
    | 'doc-deleted';
  /** Short headline rendered as the entry's title. Plain text, no markup. */
  headline: string;
  /** Optional detail line below the headline. */
  detail?: string;
  /** Filename to switch to when clicked. Optional — events like enrichment may not target a doc. */
  filename?: string;
  /** Optional nodeId for paragraph-level deep-link (future use). */
  nodeId?: string;
}

interface ActivityTabState {
  entries: ActivityEvent[];
  /** Keys (ts:kind:headline) of entries that arrived live this session. Drives the arrival animation. */
  freshKeys: Set<string>;
}

const FRESH_TTL_MS = 30_000;

function eventKey(e: ActivityEvent): string {
  return `${e.ts}:${e.kind}:${e.headline}`;
}

function relativeTime(ts: number, now: number): string {
  const diff = Math.max(0, now - ts);
  const seconds = Math.floor(diff / 1000);
  if (seconds < 45) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export default function ActivityTab({ onSwitchDocument }: RightRailTabProps) {
  const [state, setState] = useState<ActivityTabState>({ entries: [], freshKeys: new Set() });
  const [now, setNow] = useState(() => Date.now());

  // Subscribe to the bridge events emitted by ws/client.ts on connect (seed)
  // and on live arrivals. The bridge dispatches CustomEvents on window so the
  // rail doesn't need to hook into useWebSocket's option callbacks (those are
  // owned by App.tsx). adr: adr/right-rail.md
  useEffect(() => {
    const handleSeed = (e: Event) => {
      const detail = (e as CustomEvent<{ entries: ActivityEvent[] }>).detail;
      if (!detail?.entries) return;
      setState({ entries: detail.entries, freshKeys: new Set() });
    };

    const handleEvent = (e: Event) => {
      const detail = (e as CustomEvent<{ event: ActivityEvent }>).detail;
      if (!detail?.event) return;
      const key = eventKey(detail.event);
      setState((s) => ({
        entries: [detail.event, ...s.entries].slice(0, 500),
        freshKeys: new Set([...s.freshKeys, key]),
      }));
      // Drop the fresh key after the accent bar finishes fading
      setTimeout(() => {
        setState((s) => {
          const next = new Set(s.freshKeys);
          next.delete(key);
          return { ...s, freshKeys: next };
        });
      }, FRESH_TTL_MS);
    };

    window.addEventListener('ow-activity-seed', handleSeed);
    window.addEventListener('ow-activity-event', handleEvent);
    return () => {
      window.removeEventListener('ow-activity-seed', handleSeed);
      window.removeEventListener('ow-activity-event', handleEvent);
    };
  }, []);

  // Tick once every 30s so relative timestamps decay without each row owning a timer.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  const groups = useMemo(() => groupByDay(state.entries, now), [state.entries, now]);

  if (state.entries.length === 0) {
    return (
      <div className="activity-tab__empty">
        <div className="activity-tab__empty-title">No activity yet</div>
        <div className="activity-tab__empty-note">Agent actions — writes, enrichment, backlink propagation — will appear here as they happen.</div>
      </div>
    );
  }

  return (
    <div className="activity-tab">
      {groups.map((group) => (
        <div key={group.label} className="activity-tab__group">
          <div className="activity-tab__group-label">{group.label}</div>
          {group.entries.map((entry) => {
            const key = eventKey(entry);
            const fresh = state.freshKeys.has(key);
            const clickable = Boolean(entry.filename);
            return (
              <div
                key={key}
                className={`activity-tab__entry${fresh ? ' activity-tab__entry--fresh' : ''}${clickable ? ' activity-tab__entry--clickable' : ''}`}
                role={clickable ? 'button' : undefined}
                tabIndex={clickable ? 0 : undefined}
                onClick={() => {
                  if (entry.filename) onSwitchDocument(entry.filename);
                }}
                onKeyDown={(e) => {
                  if (clickable && (e.key === 'Enter' || e.key === ' ')) {
                    e.preventDefault();
                    if (entry.filename) onSwitchDocument(entry.filename);
                  }
                }}
              >
                <span className={`activity-tab__kind-dot activity-tab__kind-dot--${entry.kind}`} aria-hidden="true" />
                <div className="activity-tab__entry-body">
                  <div className="activity-tab__headline">{entry.headline}</div>
                  {entry.detail && <div className="activity-tab__detail">{entry.detail}</div>}
                </div>
                <div className="activity-tab__ts" title={new Date(entry.ts).toLocaleString()}>
                  {relativeTime(entry.ts, now)}
                </div>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

interface DayGroup {
  label: string;
  entries: ActivityEvent[];
}

function groupByDay(entries: ActivityEvent[], now: number): DayGroup[] {
  if (entries.length === 0) return [];
  const today = startOfDay(now);
  const yesterday = today - 24 * 60 * 60 * 1000;
  const result: DayGroup[] = [];
  let current: DayGroup | null = null;
  for (const entry of entries) {
    const day = startOfDay(entry.ts);
    let label: string;
    if (day === today) label = 'Today';
    else if (day === yesterday) label = 'Yesterday';
    else label = new Date(entry.ts).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
    if (!current || current.label !== label) {
      current = { label, entries: [] };
      result.push(current);
    }
    current.entries.push(entry);
  }
  return result;
}

function startOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
