/**
 * Sync button cluster — sync state pill + (optional) details chevron + pending
 * changes dropdown. Lives in the right-rail topbar (post-2026-05-23 refactor).
 * Was previously in the titlebar; moved to mirror the left sidebar's pattern
 * where chrome controls live in the panel's own topbar, not in the global
 * titlebar.
 *
 * adr: adr/right-rail.md
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
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
  /** Open the explicit GitHub account setup flow without attempting a backup. */
  onReconnectGitHub: () => void;
  /** Update the shared status immediately after restoring a saved sign-in. */
  onSyncStatusChange: (status: SyncStatus) => void;
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

/**
 * The right rail can deliberately become compact. Keep the visual status
 * useful at each size without letting a partial label imply a broken control.
 * The button itself supplies the accessible name from its full tooltip.
 */
function SyncButtonLabel({ full, compact }: { full: string; compact: string }) {
  return (
    <>
      <span className="sync-btn-label sync-btn-label--full" aria-hidden="true">{full}</span>
      <span className="sync-btn-label sync-btn-label--compact" aria-hidden="true">{compact}</span>
    </>
  );
}

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

export default function SyncButton({ syncStatus, localSavePending = false, onSync, onReconnectGitHub, onSyncStatusChange, onManage, onChangeWritingSpace }: SyncButtonProps) {
  const [showPending, setShowPending] = useState(false);
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([]);
  const [loadingPending, setLoadingPending] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [confirmChange, setConfirmChange] = useState(false);
  const [changingWritingSpace, setChangingWritingSpace] = useState(false);
  const [changeError, setChangeError] = useState('');
  const [restoringSavedSignIn, setRestoringSavedSignIn] = useState(false);
  const [restoreError, setRestoreError] = useState('');
  const pendingRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [popoverPosition, setPopoverPosition] = useState<{
    top: number;
    left: number;
    width: number;
    maxHeight: number;
  } | null>(null);

  const updatePopoverPosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;

    const margin = 12;
    const preferredWidth = 288;
    const rect = trigger.getBoundingClientRect();
    const width = Math.min(preferredWidth, window.innerWidth - margin * 2);
    const top = Math.max(margin, Math.min(rect.bottom + 6, window.innerHeight - margin - 44));
    const left = Math.max(margin, Math.min(rect.right - width, window.innerWidth - width - margin));
    setPopoverPosition({
      top,
      left,
      width,
      maxHeight: Math.max(160, window.innerHeight - top - margin),
    });
  }, []);

  // The rail intentionally clips its own contents while it collapses. Render
  // the status panel above that boundary so its full width stays usable even
  // when a writer has made the rail narrower than the panel.
  useLayoutEffect(() => {
    if (!showPending) {
      setPopoverPosition(null);
      return;
    }
    const frame = window.requestAnimationFrame(updatePopoverPosition);
    window.addEventListener('resize', updatePopoverPosition);
    window.addEventListener('scroll', updatePopoverPosition, true);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener('resize', updatePopoverPosition);
      window.removeEventListener('scroll', updatePopoverPosition, true);
    };
  }, [showPending, updatePopoverPosition]);

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
      const target = e.target as Node;
      if (!pendingRef.current?.contains(target) && !popoverRef.current?.contains(target)) {
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
  const backupAuthentication = syncStatus.backupAuthentication;
  const backupNeedsAuthentication = backupAuthentication === 'restore-required' || backupAuthentication === 'reconnect-required';
  const canRestoreSavedSignIn = backupAuthentication === 'restore-required';
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

  const buttonTitle = backupNeedsAuthentication
    ? 'Reconnect GitHub before this Mac can back up your writing'
    : syncStatus.state === 'attention' || syncStatus.state === 'error'
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

  const restoreSavedGitHubSignIn = async () => {
    setRestoreError('');
    setRestoringSavedSignIn(true);
    try {
      const response = await fetch('/api/sync/github/session/restore', { method: 'POST' });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.status) {
        throw new Error(payload.error || 'OpenWriter could not restore the saved GitHub sign-in.');
      }
      onSyncStatusChange(payload.status as SyncStatus);
    } catch (error: any) {
      setRestoreError(error?.message || 'OpenWriter could not restore the saved GitHub sign-in.');
    } finally {
      setRestoringSavedSignIn(false);
    }
  };

  const authenticationActions = backupNeedsAuthentication ? (
    <div className="sync-status-actions sync-status-actions--authentication">
      <button type="button" className="sync-status-change-space" onClick={() => { setShowPending(false); onReconnectGitHub(); }} disabled={restoringSavedSignIn}>
        {canRestoreSavedSignIn ? 'Use a different account' : 'Change writing space'}
      </button>
      {canRestoreSavedSignIn ? (
        <button type="button" className="sync-status-backup-now" onClick={() => void restoreSavedGitHubSignIn()} disabled={restoringSavedSignIn}>
          {restoringSavedSignIn ? 'Restoring sign-in…' : 'Use saved GitHub sign-in'}
        </button>
      ) : (
        <button type="button" className="sync-status-backup-now" onClick={() => { setShowPending(false); onReconnectGitHub(); }}>
          Reconnect GitHub
        </button>
      )}
    </div>
  ) : null;

  return (
    <div className="sync-btn-group" ref={pendingRef}>
      <button
        type="button"
        className={`titlebar-btn sync-btn-state ${backupNeedsAuthentication ? 'sync-attention' : localSavePending ? 'sync-local-saving' : `sync-${syncStatus.state}`}`}
        onClick={handleMainAction}
        ref={triggerRef}
        aria-expanded={syncStatus.state === 'unconfigured' ? undefined : showPending}
        aria-haspopup={syncStatus.state === 'unconfigured' ? undefined : 'dialog'}
        aria-controls={syncStatus.state === 'unconfigured' ? undefined : 'cloud-backup-status'}
        aria-label={buttonTitle}
        title={buttonTitle}
      >
        {syncStatus.state === 'unconfigured' && <><CloudIcon /><SyncButtonLabel full="Set up backup" compact="Set up" /></>}
        {backupNeedsAuthentication && <><CloudErrorIcon /><SyncButtonLabel full="Reconnect GitHub" compact="Reconnect" /></>}
        {!backupNeedsAuthentication && syncStatus.state !== 'unconfigured' && localSavePending && <><CloudIcon /><SyncButtonLabel full="Saving on this Mac" compact="Saving" /></>}
        {!backupNeedsAuthentication && syncStatus.state === 'synced' && !localSavePending && <><CloudCheckIcon /><SyncButtonLabel full={isContributor ? (hasReviewRequest ? 'Review ready' : 'Contributor') : 'Backed up'} compact={isContributor ? (hasReviewRequest ? 'Review' : 'Contributor') : 'Backed up'} /></>}
        {!backupNeedsAuthentication && syncStatus.state === 'pending' && !localSavePending && <><CloudUpIcon /><SyncButtonLabel full="Saved on this Mac" compact="Saved" /></>}
        {!backupNeedsAuthentication && syncStatus.state === 'syncing' && !localSavePending && <><div className="sync-btn-spinner" /><SyncButtonLabel full="Backing up" compact="Saving" /></>}
        {!backupNeedsAuthentication && syncStatus.state === 'attention' && !localSavePending && <><CloudErrorIcon /><SyncButtonLabel full="Needs attention" compact="Attention" /></>}
        {!backupNeedsAuthentication && syncStatus.state === 'error' && !localSavePending && <><CloudErrorIcon /><SyncButtonLabel full="Backup failed" compact="Failed" /></>}
      </button>
      {showPending && syncStatus.state !== 'unconfigured' && popoverPosition && createPortal(
        <div
          id="cloud-backup-status"
          ref={popoverRef}
          className="sync-status-popover"
          role="dialog"
          aria-label={isContributor ? 'Contributor workspace status' : 'Cloud backup status'}
          style={popoverPosition}
        >
          <div className="sync-status-popover-heading">{isContributor ? 'Contributor workspace' : 'Cloud backup'}</div>
          {isContributor && (
            <div className="sync-status-role-summary">
              You contribute changes for {primaryWriter}. Your writing stays on a review branch until it is ready for review.
            </div>
          )}
          <div className="sync-status-summary">
            {backupNeedsAuthentication ? 'Reconnect GitHub to resume cloud backup.' :
              localSavePending ? 'Saving this change on this Mac.' :
              syncStatus.state === 'pending' ? 'Saved on this Mac.' :
                syncStatus.state === 'syncing' ? 'Saving to GitHub now.' :
                  syncStatus.state === 'attention' || syncStatus.state === 'error' ? 'Cloud backup needs your attention.' :
                    'Saved on this Mac and backed up to GitHub.'}
          </div>
          {backupNeedsAuthentication && (
            <div className="sync-status-detail sync-status-auth-detail">
              OpenWriter is still connected to this writing space, but this app session cannot sign in to GitHub yet. Your writing and local history remain on this Mac.
            </div>
          )}
          {syncStatus.state === 'pending' && <div className="sync-status-detail">{checkpointSummary}</div>}
          {syncStatus.state === 'pending' && <div className="sync-status-detail">{pendingSummary}</div>}
          {isContributor && hasReviewRequest && (
            <div className="sync-status-detail">This backup also updates your review request.</div>
          )}
          {!backupNeedsAuthentication && (syncStatus.state === 'attention' || syncStatus.state === 'error') && syncStatus.error && (
            <div className="sync-status-error">{syncStatus.error}</div>
          )}
          {backupNeedsAuthentication && restoreError && (
            <div className="sync-status-error" role="alert">{restoreError}</div>
          )}
          {authenticationActions}
          {syncStatus.collaboration && onManage && (
            <button type="button" className="sync-status-writing-roles" onClick={openWritingRoles}>
              <span>
                <strong>Manage people &amp; roles</strong>
                <small>{isContributor ? 'View your contributor role and primary-writer handoff options.' : 'View contributors and primary-writer transfer options.'}</small>
              </span>
              <span aria-hidden="true">›</span>
            </button>
          )}
          {!backupNeedsAuthentication && <div className="sync-status-detail sync-status-last-backup">{formatLastBackup(syncStatus.lastSyncTime)}</div>}
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
        </div>,
        document.body,
      )}
    </div>
  );
}
