/**
 * Activity tab — workspace-wide log of agent-attributed actions.
 *
 * Reads from the module-level activity store (so live events captured while
 * the rail is closed survive). Relative timestamps auto-update every 30s.
 * Entries with `freshKeys` get an accent bar that fades over ~30s via CSS.
 *
 * Click-to-navigate uses a live docId → current-filename map fetched from
 * /api/documents and refreshed on ow-documents-changed. Resolving at click
 * time keeps the link stable across renames, and entries pointing at docs
 * that no longer exist (absent from the map) silently render as
 * non-clickable. Legacy entries without docId fall back to a filename
 * existence check against the same fetched list.
 *
 * adr: adr/right-rail.md
 */
import { useEffect, useMemo, useState } from 'react';
import type { RightRailTabProps } from '../types';
import { useActivity, eventKey, type ActivityEvent } from '../activity-store';

interface DocsIndex {
  byDocId: Map<string, string>;
  filenameSet: Set<string>;
}

function useDocsIndex(): DocsIndex {
  const [index, setIndex] = useState<DocsIndex>(() => ({ byDocId: new Map(), filenameSet: new Set() }));
  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      fetch('/api/documents')
        .then((r) => r.json())
        .then((docs: Array<{ filename: string; docId?: string }>) => {
          if (cancelled || !Array.isArray(docs)) return;
          const byDocId = new Map<string, string>();
          const filenameSet = new Set<string>();
          for (const d of docs) {
            if (d.filename) filenameSet.add(d.filename);
            if (d.docId && d.filename) byDocId.set(d.docId, d.filename);
          }
          setIndex({ byDocId, filenameSet });
        })
        .catch(() => { /* leave the prior map in place */ });
    };
    refresh();
    window.addEventListener('ow-documents-changed', refresh);
    return () => {
      cancelled = true;
      window.removeEventListener('ow-documents-changed', refresh);
    };
  }, []);
  return index;
}

function resolveEntryFilename(entry: ActivityEvent, docs: DocsIndex): string | null {
  if (entry.docId) {
    const fn = docs.byDocId.get(entry.docId);
    return fn ?? null;
  }
  if (entry.filename && docs.filenameSet.has(entry.filename)) return entry.filename;
  return null;
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
  const { entries, freshKeys } = useActivity();
  const docs = useDocsIndex();
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
            // Resolve docId → current filename (or fall back to entry.filename
            // if it still exists). Missing from the live doc map = deleted or
            // never resolvable → no click affordance, click is a no-op.
            // doc-deleted entries are always non-clickable because the doc is
            // gone by definition. adr: adr/right-rail.md
            const resolvedFilename = entry.kind === 'doc-deleted' ? null : resolveEntryFilename(entry, docs);
            const clickable = resolvedFilename !== null;
            // Dim non-clickable rows so the eye reads them as history-only.
            // Doc-deleted entries skip the explanatory tooltip — the headline
            // already says the doc was deleted. Other unresolved rows get a
            // tooltip so the user knows why click does nothing.
            const muted = !clickable;
            const mutedTooltip = muted && entry.kind !== 'doc-deleted' ? 'Doc no longer available' : undefined;
            const navigate = () => {
              if (resolvedFilename) onSwitchDocument(resolvedFilename);
            };
            return (
              <div
                key={key}
                className={`activity-tab__entry${fresh ? ' activity-tab__entry--fresh' : ''}${clickable ? ' activity-tab__entry--clickable' : ''}${muted ? ' activity-tab__entry--muted' : ''}`}
                role={clickable ? 'button' : undefined}
                tabIndex={clickable ? 0 : undefined}
                title={mutedTooltip}
                onClick={navigate}
                onKeyDown={(e) => {
                  if (clickable && (e.key === 'Enter' || e.key === ' ')) {
                    e.preventDefault();
                    navigate();
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
