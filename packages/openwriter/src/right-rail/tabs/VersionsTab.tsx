/**
 * Versions tab — attributed git-history for the active document.
 *
 * Shows COMMITS (boundary cuts: agent-finished / accept / manual), not the raw
 * 30s auto-snapshots. Each row is one commit: when, who contributed (author
 * badges), and a one-line changeset. Expand a row for the per-actor breakdown +
 * Restore. A "Save version" button creates a manual commit.
 *
 * adr: adr/document-history-attribution.md · adr: adr/right-rail.md
 */
import { useCallback, useEffect, useState } from 'react';
import type { RightRailTabProps } from '../types';

type Actor = 'human' | 'agent' | 'unknown';
interface ActorTally { added: number; edited: number; removed: number; }
interface CommitRow {
  ts: number;
  parent: number | null;
  trigger: 'agent-finished' | 'accept' | 'manual';
  actors: Actor[];
  note?: string;
  snapshotTs: number;
  summary: { added: number; edited: number; removed: number; byActor: Record<string, ActorTally> };
  label: string;
  restorable: boolean;
}

const TRIGGER_LABEL: Record<string, string> = {
  'agent-finished': 'Agent finished',
  accept: 'Accepted',
  manual: 'Saved',
};

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const s = Math.floor(diff / 1000);
  if (s < 60) return 'Just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(ts).toLocaleDateString();
}

function actorLabel(a: Actor): string { return a === 'human' ? 'you' : a; }

export default function VersionsTab({ docId }: RightRailTabProps) {
  const [commits, setCommits] = useState<CommitRow[]>([]);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  const fetchCommits = useCallback(() => {
    if (!docId) { setCommits([]); return; }
    fetch(`/api/commits/${docId}`)
      .then((r) => (r.ok ? r.json() : { commits: [] }))
      .then((data) => setCommits(Array.isArray(data.commits) ? data.commits : []))
      .catch(() => setCommits([]));
  }, [docId]);

  useEffect(() => { fetchCommits(); }, [fetchCommits]);

  const handleSaveVersion = useCallback(async () => {
    if (!docId || busy) return;
    const note = window.prompt('Save version — optional note (e.g. "first full draft"):') ?? undefined;
    setBusy(true);
    try {
      const res = await fetch('/api/commit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ docId, note: note || undefined }),
      });
      const data = await res.json().catch(() => ({}));
      if (!data.committed) {
        // Nothing changed since the last commit — surface gently, no error.
        window.setTimeout(() => {}, 0);
      }
      fetchCommits();
    } catch { /* ignore */ }
    setBusy(false);
  }, [docId, busy, fetchCommits]);

  const handleRestore = useCallback(async (snapshotTs: number) => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/versions/${snapshotTs}/restore`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'full' }),
      });
      if (res.ok) fetchCommits();
    } catch { /* ignore */ }
    setBusy(false);
  }, [busy, fetchCommits]);

  return (
    <div className="versions-tab">
      <div className="versions-tab__actions">
        <button className="versions-tab__save-btn" disabled={!docId || busy} onClick={handleSaveVersion}>
          + Save version
        </button>
      </div>
      <div className="versions-tab__list">
        {commits.length === 0 ? (
          <div className="versions-tab__empty">
            No versions yet. A version is committed when an agent finishes writing,
            when you accept changes, or when you hit "Save version."
          </div>
        ) : (
          commits.map((c) => (
            <div
              key={c.ts}
              className={`commit-row${expanded === c.ts ? ' commit-row--expanded' : ''}`}
              onClick={() => setExpanded(expanded === c.ts ? null : c.ts)}
            >
              <div className="commit-row__head">
                <span className="commit-row__time">{relativeTime(c.ts)}</span>
                <span className="commit-row__authors">
                  {c.actors.map((a) => (
                    <span key={a} className={`commit-badge commit-badge--${a}`}>{actorLabel(a)}</span>
                  ))}
                </span>
              </div>
              <div className="commit-row__label">{c.label}</div>
              {c.note && <div className="commit-row__note">&ldquo;{c.note}&rdquo;</div>}
              {expanded === c.ts && (
                <div className="commit-row__detail" onClick={(e) => e.stopPropagation()}>
                  <div className="commit-row__trigger">{TRIGGER_LABEL[c.trigger] ?? c.trigger}</div>
                  <ul className="commit-row__breakdown">
                    {Object.keys(c.summary.byActor).map((a) => {
                      const t = c.summary.byActor[a];
                      return (
                        <li key={a}>
                          <span className={`commit-badge commit-badge--${a}`}>{actorLabel(a as Actor)}</span>
                          {t.added > 0 && <span> {t.added} added</span>}
                          {t.edited > 0 && <span> {t.edited} edited</span>}
                          {t.removed > 0 && <span> {t.removed} removed</span>}
                        </li>
                      );
                    })}
                  </ul>
                  <button
                    className="commit-row__restore"
                    disabled={busy || !c.restorable}
                    title={c.restorable ? 'Restore the document to this version' : 'Snapshot pruned — cannot restore'}
                    onClick={() => handleRestore(c.snapshotTs)}
                  >
                    Restore this version
                  </button>
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
