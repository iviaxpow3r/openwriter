import { useCallback, useEffect, useRef, useState } from 'react';
import type { Editor } from '@tiptap/react';
import type { SyncStatus } from '../ws/client';
import { useRightRail } from '../right-rail/RightRailContext';
import { BellIcon, VersionsIcon, ExportsIcon, PluginsIcon, AppearanceIcon, ConnectionsIcon } from '../right-rail/icons';
import type { TabId } from '../right-rail/types';

interface PendingFile {
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  file: string;
}

interface TitlebarProps {
  title: string;
  onTitleChange: (title: string) => void;
  syncStatus: SyncStatus;
  onSync: () => void;
  onToggleSidebar?: () => void;
  canGoBack?: boolean;
  canGoForward?: boolean;
  onGoBack?: () => void;
  onGoForward?: () => void;
  editor?: Editor | null;
  onToggleToolbar?: () => void;
  toolbarOpen?: boolean;
}

// Cloud SVG icons for sync states
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

interface UpdateInfo {
  currentVersion: string;
  latestVersion: string;
}

export default function Titlebar({ title, onTitleChange, syncStatus, onSync, onToggleSidebar, canGoBack, canGoForward, onGoBack, onGoForward, editor, onToggleToolbar, toolbarOpen }: TitlebarProps) {
  const [editing, setEditing] = useState(false);
  const [, setTick] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const [showPending, setShowPending] = useState(false);
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([]);
  const [loadingPending, setLoadingPending] = useState(false);
  const pendingRef = useRef<HTMLDivElement>(null);
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const { open: railOpen, activeTab, openTab, closeRail } = useRightRail();
  const [bellPulse, setBellPulse] = useState(false);

  // Pulse the bell briefly whenever a live activity event arrives AND the
  // user isn't already looking at Activity. The seed CustomEvent uses a
  // separate name (ow-activity-seed) so initial-load events don't pulse.
  // adr: adr/right-rail.md
  useEffect(() => {
    const handler = () => {
      const activeOnRail = railOpen && activeTab === 'activity';
      if (activeOnRail) return;
      setBellPulse(true);
      window.setTimeout(() => setBellPulse(false), 500);
    };
    window.addEventListener('ow-activity-event', handler);
    return () => window.removeEventListener('ow-activity-event', handler);
  }, [railOpen, activeTab]);

  const onBellClick = useCallback(() => {
    // Bell toggles Activity. If the rail is already open at Activity, close.
    // Anything else → open Activity tab.
    if (railOpen && activeTab === 'activity') {
      closeRail();
    } else {
      openTab('activity');
    }
  }, [railOpen, activeTab, openTab, closeRail]);

  /**
   * Open a specific rail tab from a titlebar shortcut. Same toggle semantics
   * as the bell: clicking the icon for the active tab closes the rail; any
   * other state opens (or switches to) that tab. adr: adr/right-rail.md
   */
  const onTabIconClick = useCallback((tab: TabId) => {
    if (railOpen && activeTab === tab) {
      closeRail();
    } else {
      openTab(tab);
    }
  }, [railOpen, activeTab, openTab, closeRail]);

  // Check for updates on mount
  useEffect(() => {
    fetch('/api/update-info')
      .then(r => r.json())
      .then(data => {
        if (data.updateAvailable) {
          setUpdateInfo({ currentVersion: data.currentVersion, latestVersion: data.updateAvailable });
        }
      })
      .catch(() => {});
  }, []);

  const handleDoubleClick = useCallback(() => {
    setEditing(true);
    setTimeout(() => inputRef.current?.select(), 0);
  }, []);

  const handleBlur = useCallback(() => {
    setEditing(false);
  }, []);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      setEditing(false);
    }
    if (e.key === 'Escape') {
      setEditing(false);
    }
  }, []);

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

  // Re-render when editor state changes so undo/redo disabled states update
  useEffect(() => {
    if (!editor) return;
    const onTransaction = () => setTick((n) => n + 1);
    editor.on('transaction', onTransaction);
    return () => { editor.off('transaction', onTransaction); };
  }, [editor]);

  return (
    <div className="titlebar">
      <div className="titlebar-left">
        {onToggleSidebar && (
          <button className="titlebar-menu-btn" onClick={onToggleSidebar} title="Open sidebar">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
              <rect x="3" y="3" width="18" height="18" rx="2" stroke="currentColor" strokeWidth="2" />
              <path d="M9 3v18" stroke="currentColor" strokeWidth="2" />
              <path d="M14 10l2 2-2 2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        )}
        {onGoBack && (
          <button className="titlebar-nav-btn" onClick={onGoBack} disabled={!canGoBack} title="Go back (Alt+Left)">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <path d="M10 3L5 8l5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        )}
        {onGoForward && (
          <button className="titlebar-nav-btn" onClick={onGoForward} disabled={!canGoForward} title="Go forward (Alt+Right)">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <path d="M6 3l5 5-5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        )}
        {editor && (
          <>
            <div className="titlebar-divider" />
            <button
              className="titlebar-nav-btn"
              onClick={() => editor.chain().focus().undo().run()}
              disabled={!editor.can().undo()}
              title="Undo (Ctrl+Z)"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                <path d="M3 10h10a5 5 0 0 1 0 10H9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M7 6L3 10l4 4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
            <button
              className="titlebar-nav-btn"
              onClick={() => editor.chain().focus().redo().run()}
              disabled={!editor.can().redo()}
              title="Redo (Ctrl+Y)"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                <path d="M21 10H11a5 5 0 0 0 0 10h4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M17 6l4 4-4 4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          </>
        )}
      </div>
      <div className="titlebar-center">
        {editing ? (
          <input
            ref={inputRef}
            className="titlebar-input"
            value={title}
            onChange={(e) => onTitleChange(e.target.value)}
            onBlur={handleBlur}
            onKeyDown={handleKeyDown}
            autoFocus
          />
        ) : (
          <span className="titlebar-title" onDoubleClick={handleDoubleClick}>
            {title}
          </span>
        )}
        {updateInfo && (
          <span
            className="titlebar-update-badge"
            title={`Update available: v${updateInfo.currentVersion} → v${updateInfo.latestVersion}\nRun: npm update -g openwriter`}
          >
            v{updateInfo.latestVersion}
          </span>
        )}
      </div>
      <div className="titlebar-right">
        {onToggleToolbar && (
          <button
            className={`titlebar-nav-btn${toolbarOpen ? ' titlebar-nav-btn--active' : ''}`}
            onClick={onToggleToolbar}
            title="Toggle format toolbar"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 20h16" />
              <path d="m6 16 6-12 6 12" />
              <path d="M8 12h8" />
            </svg>
          </button>
        )}
        <button
          type="button"
          className={`titlebar-bell${railOpen && activeTab === 'activity' ? ' titlebar-bell--active' : ''}${bellPulse ? ' titlebar-bell--pulsing' : ''}`}
          onClick={onBellClick}
          title="Activity"
          aria-label="Activity"
        >
          <BellIcon />
        </button>
        <button
          type="button"
          className={`titlebar-nav-btn${railOpen && activeTab === 'plugins' ? ' titlebar-nav-btn--active' : ''}`}
          onClick={() => onTabIconClick('plugins')}
          title="Plugins"
          aria-label="Plugins"
        >
          <PluginsIcon />
        </button>
        <button
          type="button"
          className={`titlebar-nav-btn${railOpen && activeTab === 'connections' ? ' titlebar-nav-btn--active' : ''}`}
          onClick={() => onTabIconClick('connections')}
          title="Connections"
          aria-label="Connections"
        >
          <ConnectionsIcon />
        </button>
        <button
          type="button"
          className={`titlebar-nav-btn${railOpen && activeTab === 'appearance' ? ' titlebar-nav-btn--active' : ''}`}
          onClick={() => onTabIconClick('appearance')}
          title="Appearance"
          aria-label="Appearance"
        >
          <AppearanceIcon />
        </button>
        <button
          type="button"
          className={`titlebar-nav-btn${railOpen && activeTab === 'versions' ? ' titlebar-nav-btn--active' : ''}`}
          onClick={() => onTabIconClick('versions')}
          title="Version history"
          aria-label="Version history"
        >
          <VersionsIcon />
        </button>
        <button
          type="button"
          className={`titlebar-nav-btn${railOpen && activeTab === 'exports' ? ' titlebar-nav-btn--active' : ''}`}
          onClick={() => onTabIconClick('exports')}
          title="Export document"
          aria-label="Export document"
        >
          <ExportsIcon />
        </button>
        <div className="sync-btn-group" ref={pendingRef}>
          <button
            className={`titlebar-btn sync-btn-state sync-${syncStatus.state}`}
            onClick={onSync}
            disabled={syncStatus.state === 'syncing'}
            title={syncStatus.lastSyncTime ? `Last synced: ${new Date(syncStatus.lastSyncTime).toLocaleString()}` : 'Sync to GitHub'}
          >
            {syncStatus.state === 'unconfigured' && <><CloudIcon /> Sync</>}
            {syncStatus.state === 'synced' && <><CloudCheckIcon /> Synced</>}
            {syncStatus.state === 'pending' && <><CloudUpIcon /> Sync{syncStatus.pendingFiles ? ` (${syncStatus.pendingFiles})` : ''}</>}
            {syncStatus.state === 'syncing' && <><div className="sync-btn-spinner" /> Syncing...</>}
            {syncStatus.state === 'error' && <><CloudErrorIcon /> Retry</>}
          </button>
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
              <div className="sync-pending-header">Changes to push</div>
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
      </div>
    </div>
  );
}
