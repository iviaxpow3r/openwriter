/**
 * Versions tab — version history for the active document.
 * Migrated from src/versions/VersionPanel.tsx (which lived as a titlebar dropdown).
 * adr: adr/right-rail.md
 */
import { useCallback, useEffect, useState } from 'react';
import type { RightRailTabProps } from '../types';

interface VersionInfo {
  timestamp: number;
  date: string;
  size: number;
  wordCount: number;
}

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return 'Just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(ts).toLocaleDateString();
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

export default function VersionsTab({ currentFilename }: RightRailTabProps) {
  const [versions, setVersions] = useState<VersionInfo[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);

  const fetchVersions = useCallback(() => {
    fetch('/api/versions')
      .then((res) => res.json())
      .then((data) => {
        setVersions(Array.isArray(data) ? data : []);
        setSelected(null);
      })
      .catch(() => setVersions([]));
  }, []);

  // Refetch whenever the active doc changes — versions are per-doc.
  useEffect(() => {
    fetchVersions();
  }, [currentFilename, fetchVersions]);

  const handleRestore = useCallback(async (mode: 'review' | 'full') => {
    if (selected === null) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/versions/${selected}/restore`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode }),
      });
      if (res.ok) fetchVersions();
    } catch { /* ignore */ }
    setLoading(false);
  }, [selected, fetchVersions]);

  return (
    <div className="versions-tab">
      <div className="versions-tab__list">
        {versions.length === 0 ? (
          <div className="versions-tab__empty">
            No versions yet. Versions are created automatically when you save.
          </div>
        ) : (
          versions.map((v) => (
            <div
              key={v.timestamp}
              className={`versions-tab__item${selected === v.timestamp ? ' versions-tab__item--selected' : ''}`}
              onClick={() => setSelected(v.timestamp === selected ? null : v.timestamp)}
            >
              <span className="versions-tab__item-time">{relativeTime(v.timestamp)}</span>
              <span className="versions-tab__item-meta">
                {v.wordCount.toLocaleString()} words &middot; {formatSize(v.size)}
              </span>
            </div>
          ))
        )}
      </div>
      {versions.length > 0 && (
        <div className="versions-tab__footer">
          <button
            className="versions-tab__review-btn"
            disabled={selected === null || loading}
            onClick={() => handleRestore('review')}
          >
            Review
          </button>
          <button
            className="versions-tab__restore-btn"
            disabled={selected === null || loading}
            onClick={() => handleRestore('full')}
          >
            Restore
          </button>
        </div>
      )}
    </div>
  );
}
