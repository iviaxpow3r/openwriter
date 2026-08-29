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
  /** A confirmed editor change is travelling to the local file before Git sees it. */
  localSavePending?: boolean;
  onSync: () => void;
  onManage?: () => void;
  /** Disconnect only the active profile, then open its writing-space setup. */
  onChangeWritingSpace?: () => Promise<{ success: boolean; error?: string }>;
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

function formatCountdown(deadline: string, now: number): string {
  const seconds = Math.max(0, Math.ceil((new Date(deadline).getTime() - now) / 1_000));
  if (seconds <= 5) return 'in a few seconds';
  const minutes = Math.floor(seconds / 60);
  return minutes > 0 ? `in ${minutes}:${String(seconds % 60).padStart(2, '0')}` : `in ${seconds} seconds`;
}

function formatLastBackup(value?: string): string {
  if (!value) return 'No cloud backup has completed yet.';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Cloud backup completed.';
  return `Last cloud backup ${date.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}.`;
}

export default function SyncButton({ syncStatus, localSavePending = false, onSync, onManage, onChangeWritingSpace }: SyncButtonProps) {
  const [showPending, setShowPending] = useState(false);
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([]);
  const [loadingPending, setLoadingPending] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [confirmChange, setConfirmChange] = useState(false);
  const [changingWritingSpace, setChangingWritingSpace] = useState(false);
  const [changeError, setChangeError] = useState('');
  const pendingRef = useRef<HTMLDivElement>(null);

  const togglePendingDetails = useCallback(() => {
    if (showPending) {
      setShowPending(false);
      return;
    }
    setShowPending(true);
    if (syncStatus.state !== 'pending') return;
    setLoadingPending(true);
    fetch('/api/sync/pending')
      .then(r => r.json())
      .then((files: PendingFile[]) => setPendingFiles(files))
      .catch(() => setPendingFiles([]))
      .finally(() => setLoadingPending(false));
  }, [showPending, syncStatus.state]);

  // The popover also shows the last completed backup, so only reset its
  // changed-file list when the workspace is no longer pending.
  useEffect(() => {
    if (syncStatus.state !== 'pending') setPendingFiles([]);
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
    const keyHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setShowPending(false);
    };
    document.addEventListener('keydown', keyHandler);
    return () => {
      document.removeEventListener('mousedown', handler);
      document.removeEventListener('keydown', keyHandler);
    };
  }, [showPending]);

  const automaticCheckpoints = syncStatus.collaboration?.automaticCheckpoints !== false;
  const isContributor = syncStatus.collaboration?.role === 'contributor';
  const hasReviewRequest = Boolean(syncStatus.collaboration?.pullRequestUrl);
  const checkpointDeadline = syncStatus.nextAutomaticCheckpointAt;
  const primaryWriter = syncStatus.primaryWriter?.githubLogin
    ? `@${syncStatus.primaryWriter.githubLogin}`
    : syncStatus.primaryWriter?.displayName || 'the primary writer';

  useEffect(() => {
    if (!checkpointDeadline || syncStatus.state !== 'pending') return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [checkpointDeadline, syncStatus.state]);

  const handleMainAction = () => {
    if (syncStatus.state === 'unconfigured') {
      onSync();
      return;
    }
    togglePendingDetails();
  };

  const buttonTitle = syncStatus.state === 'attention' || syncStatus.state === 'error'
    ? syncStatus.error || 'Backup needs attention'
    : localSavePending
      ? 'Saving this change on this Mac before cloud backup'
      : syncStatus.state === 'synced' && isContributor && hasReviewRequest
      ? 'View cloud backup and review-request status'
      : syncStatus.state === 'synced' && isContributor
        ? `You are contributing on a review branch for ${primaryWriter}. View writing-space status.`
      : syncStatus.lastSyncTime
        ? `View cloud backup status. Last backed up: ${new Date(syncStatus.lastSyncTime).toLocaleString()}`
        : 'View cloud backup status';

  const pendingSummary = syncStatus.pendingFiles
    ? `${syncStatus.pendingFiles} ${syncStatus.pendingFiles === 1 ? 'file' : 'files'} waiting to back up.`
    : 'Changes are waiting to back up.';
  const checkpointSummary = checkpointDeadline
    ? `Automatic cloud backup ${formatCountdown(checkpointDeadline, now)}.`
    : automaticCheckpoints
      ? 'Automatic cloud backup starts after you pause writing.'
      : 'Automatic cloud backup is off.';
  const backupAction = syncStatus.state === 'attention' || syncStatus.state === 'error' ? 'Try backup again' : 'Back up now';
  const openWritingRoles = () => {
    setShowPending(false);
    onManage?.();
  };

  const disconnectAndChooseWritingSpace = async () => {
    if (!onChangeWritingSpace) return;
    setChangingWritingSpace(true);
    setChangeError('');
    const result = await onChangeWritingSpace();
    setChangingWritingSpace(false);
    if (result.success) {
      setConfirmChange(false);
      setShowPending(false);
      return;
    }
    setChangeError(result.error || 'Cloud backup could not be disconnected.');
  };

  return (
    <div className="sync-btn-group" ref={pendingRef}>
      <button
        type="button"
        className={`titlebar-btn sync-btn-state ${localSavePending ? 'sync-local-saving' : `sync-${syncStatus.state}`}`}
        onClick={handleMainAction}
        aria-expanded={syncStatus.state === 'unconfigured' ? undefined : showPending}
        aria-haspopup={syncStatus.state === 'unconfigured' ? undefined : 'dialog'}
        title={buttonTitle}
      >
        {syncStatus.state === 'unconfigured' && <><CloudIcon /> Set up backup</>}
        {syncStatus.state !== 'unconfigured' && localSavePending && <><CloudIcon /> Saving on this Mac</>}
        {syncStatus.state === 'synced' && !localSavePending && <><CloudCheckIcon /> {isContributor ? (hasReviewRequest ? 'Review ready' : 'Contributor') : 'Backed up'}</>}
        {syncStatus.state === 'pending' && !localSavePending && <><CloudUpIcon /> Saved on this Mac</>}
        {syncStatus.state === 'syncing' && !localSavePending && <><div className="sync-btn-spinner" /> Backing up</>}
        {syncStatus.state === 'attention' && !localSavePending && <><CloudErrorIcon /> Needs attention</>}
        {syncStatus.state === 'error' && !localSavePending && <><CloudErrorIcon /> Backup failed</>}
      </button>
      {showPending && syncStatus.state !== 'unconfigured' && (
        <div className="sync-status-popover" role="dialog" aria-label={isContributor ? 'Contributor workspace status' : 'Cloud backup status'}>
          <div className="sync-status-popover-heading">{isContributor ? 'Contributor workspace' : 'Cloud backup'}</div>
          {isContributor && (
            <div className="sync-status-role-summary">
              You contribute changes for {primaryWriter}. Your writing stays on a review branch until it is ready for review.
            </div>
          )}
          <div className="sync-status-summary">
            {localSavePending ? 'Saving this change on this Mac.' :
              syncStatus.state === 'pending' ? 'Saved on this Mac.' :
                syncStatus.state === 'syncing' ? 'Saving to GitHub now.' :
                  syncStatus.state === 'attention' || syncStatus.state === 'error' ? 'Cloud backup needs your attention.' :
                    'Saved on this Mac and backed up to GitHub.'}
          </div>
          {syncStatus.state === 'pending' && <div className="sync-status-detail">{checkpointSummary}</div>}
          {syncStatus.state === 'pending' && <div className="sync-status-detail">{pendingSummary}</div>}
          {isContributor && hasReviewRequest && (
            <div className="sync-status-detail">This backup also updates your review request.</div>
          )}
          {(syncStatus.state === 'attention' || syncStatus.state === 'error') && syncStatus.error && (
            <div className="sync-status-error">{syncStatus.error}</div>
          )}
          <div className="sync-status-detail sync-status-last-backup">{formatLastBackup(syncStatus.lastSyncTime)}</div>
          {syncStatus.collaboration && onManage && (
            <button type="button" className="sync-status-writing-roles" onClick={openWritingRoles}>
              <span>
                <strong>Writing roles</strong>
                <small>{isContributor ? 'View your contributor role and handoff options.' : 'View contributors and transfer options.'}</small>
              </span>
              <span aria-hidden="true">›</span>
            </button>
          )}
          {changeError && <div className="sync-status-error">{changeError}</div>}
          {confirmChange ? (
            <div className="sync-change-writing-space-confirm">
              <div className="sync-change-writing-space-title">Change writing space?</div>
              <div className="sync-status-detail">
                {syncStatus.state === 'pending'
                  ? 'Your changed files stay on this Mac, but they will not be sent to GitHub until you connect a writing space again.'
                  : 'Your writing, local history, and GitHub repository stay intact. This only disconnects cloud backup from this profile.'}
              </div>
              <div className="sync-status-actions sync-status-actions--confirm">
                <button type="button" className="sync-status-change-space" onClick={() => { setConfirmChange(false); setChangeError(''); }} disabled={changingWritingSpace}>
                  Keep connected
                </button>
                <button type="button" className="sync-status-disconnect" onClick={() => void disconnectAndChooseWritingSpace()} disabled={changingWritingSpace}>
                  {changingWritingSpace ? 'Disconnecting…' : 'Disconnect backup'}
                </button>
              </div>
            </div>
          ) : syncStatus.state !== 'syncing' && (
            <div className="sync-status-actions">
              {onChangeWritingSpace && (
                <button type="button" className="sync-status-change-space" onClick={() => setConfirmChange(true)}>
                  Change writing space…
                </button>
              )}
              <button type="button" className="sync-status-backup-now" onClick={() => { setShowPending(false); onSync(); }}>
                {backupAction}
              </button>
            </div>
          )}
          {syncStatus.state === 'pending' && (
            <div className="sync-status-files">
              {loadingPending ? (
                <div className="sync-pending-loading">Loading changed files…</div>
              ) : pendingFiles.length === 0 ? (
                <div className="sync-pending-loading">Changed files will appear here.</div>
              ) : (
                <div className="sync-pending-list">
                  {pendingFiles.map((f, i) => (
                    <div key={`${f.file}-${i}`} className={`sync-pending-item sync-file-${f.status}`}>
                      <span className="sync-file-badge">{f.status[0].toUpperCase()}</span>
                      <span className="sync-file-name">{f.file}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
