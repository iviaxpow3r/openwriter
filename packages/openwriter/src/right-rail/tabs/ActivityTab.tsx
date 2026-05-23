/**
 * Activity tab — workspace-wide log of agent-attributed actions.
 *
 * Reads from the module-level activity store (so live events captured while
 * the rail is closed survive). Relative timestamps auto-update every 30s.
 * Entries with `freshKeys` get an accent bar that fades over ~30s via CSS.
 *
 * adr: adr/right-rail.md
 */
import { useEffect, useMemo, useState } from 'react';
import type { RightRailTabProps } from '../types';
import { useActivity, eventKey, type ActivityEvent } from '../activity-store';

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
  const { entries, freshKeys } = useActivity();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  const groups = useMemo(() => groupByDay(entries, now), [entries, now]);

  if (entries.length === 0) {
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
            const fresh = freshKeys.has(key);
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
