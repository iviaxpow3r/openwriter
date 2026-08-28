/**
 * Sync button cluster — sync state pill + (optional) details chevron + pending
 * changes dropdown. Lives in the right-rail topbar (post-2026-05-23 refactor).
 * Was previously in the titlebar; moved to mirror the left sidebar's pattern
 * where chrome controls live in the panel's own topbar, not in the global
 * titlebar.
 *
 * adr: adr/right-rail.md
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { SyncStatus } from '../ws/client';

interface PendingFile {
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  file: string;
}

interface SyncButtonProps {
  syncStatus: SyncStatus;
  onSync: () => void;
  onManage?: () => void;
}

const CloudIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
    <path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const CloudCheckIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
    <path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M9 14l2 2 4-4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const CloudUpIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
    <path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M12 16v-5M9.5 13.5L12 11l2.5 2.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const CloudErrorIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
    <path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M14 14l-4 4M10 14l4 4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export default function SyncButton({ syncStatus, onSync, onManage }: SyncButtonProps) {
  const [showPending, setShowPending] = useState(false);
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([]);
  const [loadingPending, setLoadingPending] = useState(false);
  const pendingRef = useRef<HTMLDivElement>(null);

  const togglePendingDetails = useCallback(() => {
    if (showPending) {
      setShowPending(false);
      return;
    }
    setShowPending(true);
    setLoadingPending(true);
    fetch('/api/sync/pending')
      .then(r => r.json())
      .then((files: PendingFile[]) => setPendingFiles(files))
      .catch(() => setPendingFiles([]))
      .finally(() => setLoadingPending(false));
  }, [showPending]);

  // Close dropdown when leaving pending state (e.g. sync starts or completes)
  useEffect(() => {
    if (syncStatus.state !== 'pending') setShowPending(false);
  }, [syncStatus.state]);

  // Close dropdown on click outside
  useEffect(() => {
    if (!showPending) return;
    const handler = (e: MouseEvent) => {
      if (pendingRef.current && !pendingRef.current.contains(e.target as Node)) {
        setShowPending(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showPending]);

  const automaticCheckpoints = syncStatus.collaboration?.automaticCheckpoints !== false;
  const isContributor = syncStatus.collaboration?.role === 'contributor';
  const hasReviewRequest = Boolean(syncStatus.collaboration?.pullRequestUrl);
  const handleMainAction = () => {
    if (syncStatus.state === 'synced' && isContributor && hasReviewRequest) {
      window.open(syncStatus.collaboration!.pullRequestUrl, '_blank', 'noopener,noreferrer');
      return;
    }
    onSync();
  };

  const buttonTitle = syncStatus.state === 'attention' || syncStatus.state === 'error'
    ? syncStatus.error || 'Backup needs attention'
    : syncStatus.state === 'synced' && isContributor && hasReviewRequest
      ? 'Open the review request for this contributor branch'
      : syncStatus.lastSyncTime
        ? `Last backed up: ${new Date(syncStatus.lastSyncTime).toLocaleString()}`
        : 'Back up this writing space now';

  return (
    <div className="sync-btn-group" ref={pendingRef}>
      <button
        className={`titlebar-btn sync-btn-state sync-${syncStatus.state}`}
        onClick={handleMainAction}
        disabled={syncStatus.state === 'syncing'}
        title={buttonTitle}
      >
        {syncStatus.state === 'unconfigured' && <><CloudIcon /> Set up backup</>}
        {syncStatus.state === 'synced' && <><CloudCheckIcon /> {isContributor && hasReviewRequest ? 'Review ready' : 'Backed up'}</>}
        {syncStatus.state === 'pending' && <><CloudUpIcon /> {automaticCheckpoints ? 'Saved locally' : 'Changes ready'}{syncStatus.pendingFiles ? ` (${syncStatus.pendingFiles})` : ''}</>}
        {syncStatus.state === 'syncing' && <><div className="sync-btn-spinner" /> Backing up…</>}
        {syncStatus.state === 'attention' && <><CloudErrorIcon /> Needs attention</>}
        {syncStatus.state === 'error' && <><CloudErrorIcon /> Retry backup</>}
      </button>
      {syncStatus.state !== 'unconfigured' && onManage && (
        <button
          className="sync-details-btn sync-manage-btn"
          onClick={onManage}
          title="Manage writing roles"
          aria-label="Manage writing roles"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <circle cx="9" cy="8" r="3" stroke="currentColor" strokeWidth="1.8" />
            <path d="M3.5 20c.6-3.2 2.5-5 5.5-5s4.9 1.8 5.5 5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            <path d="M16 11.2a2.7 2.7 0 1 0-1.6-4.9M17 15c1.9.1 3.3 1.2 4.1 3.1" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
        </button>
      )}
      {syncStatus.state === 'pending' && syncStatus.pendingFiles && syncStatus.pendingFiles > 0 && (
        <button
          className="sync-details-btn"
          onClick={togglePendingDetails}
          title="View pending changes"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path d={showPending ? 'M3 7.5L6 4.5L9 7.5' : 'M3 4.5L6 7.5L9 4.5'} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      )}
      {showPending && (
        <div className="sync-pending-dropdown">
          <div className="sync-pending-header">
            {automaticCheckpoints ? 'Changes waiting to back up' : 'Changes ready to back up'}
          </div>
          {loadingPending ? (
            <div className="sync-pending-loading">Loading...</div>
          ) : pendingFiles.length === 0 ? (
            <div className="sync-pending-loading">No changes</div>
          ) : (
            <div className="sync-pending-list">
              {pendingFiles.map((f, i) => (
                <div key={i} className={`sync-pending-item sync-file-${f.status}`}>
                  <span className="sync-file-badge">{f.status[0].toUpperCase()}</span>
                  <span className="sync-file-name">{f.file}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
