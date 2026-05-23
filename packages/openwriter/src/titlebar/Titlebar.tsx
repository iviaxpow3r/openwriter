import { useCallback, useEffect, useRef, useState } from 'react';
import type { Editor } from '@tiptap/react';
import { useRightRail } from '../right-rail/RightRailContext';
import { OpenRailIcon } from '../right-rail/icons';

interface TitlebarProps {
  title: string;
  onTitleChange: (title: string) => void;
  onToggleSidebar?: () => void;
  canGoBack?: boolean;
  canGoForward?: boolean;
  onGoBack?: () => void;
  onGoForward?: () => void;
  editor?: Editor | null;
}

interface UpdateInfo {
  currentVersion: string;
  latestVersion: string;
}

/**
 * Titlebar. After the right-rail 2026-05-23 refactor, this is intentionally
 * lean: navigation, undo/redo, title, update badge. The right side of the
 * titlebar holds ONLY the "open right rail" toggle, and only when the rail
 * is closed — mirror of the left sidebar's collapse pattern (close the
 * sidebar, all its topbar icons disappear; only an "open sidebar" button
 * remains on the global titlebar).
 *
 * Format-toolbar toggle and the sync button cluster used to live here; they
 * moved into the right-rail topbar so closing the rail hides them along
 * with the rest of the rail chrome.
 *
 * adr: adr/right-rail.md
 */
export default function Titlebar({ title, onTitleChange, onToggleSidebar, canGoBack, canGoForward, onGoBack, onGoForward, editor }: TitlebarProps) {
  const { open: railOpen, openTab, activeTab } = useRightRail();
  const [editing, setEditing] = useState(false);
  const [, setTick] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);

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
