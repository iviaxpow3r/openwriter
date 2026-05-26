import { useCallback, useEffect, useRef, useState } from 'react';
import type { Editor } from '@tiptap/react';
import { useRightRail } from '../right-rail/RightRailContext';
import { OpenRailIcon, FocusModeIcon } from '../right-rail/icons';

interface TitlebarProps {
  title: string;
  onTitleChange: (title: string) => void;
  onToggleSidebar?: () => void;
  canGoBack?: boolean;
  canGoForward?: boolean;
  onGoBack?: () => void;
  onGoForward?: () => void;
  editor?: Editor | null;
  /** Toggle for the format toolbar. Always passed; the titlebar renders the
   *  button only when the rail is closed (otherwise the rail topbar owns it). */
  onToggleToolbar?: () => void;
  toolbarOpen?: boolean;
  /** Focus mode toggle. Same pattern as the format toggle: titlebar renders
   *  it only when the rail is closed; the rail topbar owns it when open. */
  focusMode?: boolean;
  onToggleFocusMode?: () => void;
  /** Active doc's docId. Used to filter pending-metadata broadcasts so the
   *  title bar only renders a proposal that's for THIS doc.
   *  adr: adr/pending-overlay-model.md */
  docId?: string;
  /** Bridge to the WS hook, so the ✓/✗ buttons can send accept/reject
   *  messages without the title bar holding a websocket reference itself. */
  sendMessage?: (msg: Record<string, any>) => void;
}

interface PendingTitle {
  from: string;
  to: string;
}

interface UpdateInfo {
  currentVersion: string;
  latestVersion: string;
}

/**
 * Titlebar. After the 2026-05-23 right-rail refactor, this is intentionally
 * lean: navigation, undo/redo, title, update badge.
 *
 * Right side of the titlebar — slight asymmetry vs. the left side:
 *   - rail OPEN: empty (HideRail + format toggle + sync all live inside
 *     the rail topbar)
 *   - rail CLOSED: format-toolbar toggle + OpenRail icon
 *
 * The format-toggle "moves" between the rail topbar (when rail open) and
 * the titlebar (when rail closed) so the user can still collapse the
 * formatting bar without first reopening the rail. This is the one place
 * where the rail asymmetrically differs from the left sidebar (which has
 * no equivalent always-on control).
 *
 * Sync stays inside the rail topbar — opening the rail is required to
 * trigger a sync, matching how the left sidebar gates search + tree.
 *
 * adr: adr/right-rail.md
 */
export default function Titlebar({ title, onTitleChange, onToggleSidebar, canGoBack, canGoForward, onGoBack, onGoForward, editor, onToggleToolbar, toolbarOpen, focusMode, onToggleFocusMode, docId, sendMessage }: TitlebarProps) {
  const { open: railOpen, openTab, activeTab } = useRightRail();
  const [editing, setEditing] = useState(false);
  const [, setTick] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [pendingTitle, setPendingTitle] = useState<PendingTitle | null>(null);

  // Pending-title proposals arrive as DOM events from the WS client. We
  // accept only events whose docId matches the active doc — proposals on
  // other docs are surfaced by the sidebar indicator instead.
  // adr: adr/pending-overlay-model.md
  useEffect(() => {
    function handler(e: Event) {
      const detail = (e as CustomEvent).detail as { docId?: string; pendingMetadata?: { title?: PendingTitle } | null } | null;
      if (!detail) return;
      if (docId && detail.docId && detail.docId !== docId) return;
      const next = detail.pendingMetadata?.title ?? null;
      setPendingTitle(next);
    }
    window.addEventListener('ow-pending-metadata-changed', handler);
    return () => window.removeEventListener('ow-pending-metadata-changed', handler);
  }, [docId]);

  // Drop any stale pending-title when the active doc changes.
  useEffect(() => {
    setPendingTitle(null);
  }, [docId]);

  const handleAcceptPendingTitle = useCallback(() => {
    if (!docId || !sendMessage) return;
    sendMessage({ type: 'accept-pending-title', docId });
    // Optimistic: clear the local pending state immediately so the diff
    // dismisses without waiting for the server round-trip.
    setPendingTitle(null);
  }, [docId, sendMessage]);

  const handleRejectPendingTitle = useCallback(() => {
    if (!docId || !sendMessage) return;
    sendMessage({ type: 'reject-pending-title', docId });
    setPendingTitle(null);
  }, [docId, sendMessage]);

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
        ) : pendingTitle ? (
          <span className="titlebar-title-pending" title={`Agent proposed rename: "${pendingTitle.from}" → "${pendingTitle.to}"`}>
            <span className="titlebar-title-pending__old">{pendingTitle.from}</span>
            <span className="titlebar-title-pending__arrow" aria-hidden="true">→</span>
            <span className="titlebar-title-pending__new">{pendingTitle.to}</span>
            <button
              type="button"
              className="titlebar-title-pending__btn titlebar-title-pending__btn--accept"
              onClick={handleAcceptPendingTitle}
              title="Accept proposed title"
              aria-label="Accept proposed title"
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                <path d="M3 8l3 3 7-7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
            <button
              type="button"
              className="titlebar-title-pending__btn titlebar-title-pending__btn--reject"
              onClick={handleRejectPendingTitle}
              title="Reject proposed title"
              aria-label="Reject proposed title"
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          </span>
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
        {!railOpen && onToggleFocusMode && (
          <button
            className={`titlebar-nav-btn${focusMode ? ' titlebar-nav-btn--active' : ''}`}
            onClick={onToggleFocusMode}
            title="Focus mode"
            aria-label="Focus mode"
            aria-pressed={focusMode}
          >
            <FocusModeIcon />
          </button>
        )}
        {!railOpen && onToggleToolbar && (
          <button
            className={`titlebar-nav-btn${toolbarOpen ? ' titlebar-nav-btn--active' : ''}`}
            onClick={onToggleToolbar}
            title="Toggle format toolbar"
            aria-label="Toggle format toolbar"
            aria-pressed={toolbarOpen}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 20h16" />
              <path d="m6 16 6-12 6 12" />
              <path d="M8 12h8" />
            </svg>
          </button>
        )}
        {!railOpen && (
          <button
            className="titlebar-nav-btn"
            onClick={() => openTab(activeTab || 'activity')}
            title="Show right rail"
            aria-label="Show right rail"
          >
            <OpenRailIcon />
          </button>
        )}
      </div>
    </div>
  );
}
