import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { isExternal } from './sidebar-utils';

export interface SidebarMenuItem {
  label: string;
  action: string;
  promptForFocus?: boolean;
  pluginDisplayName?: string;
}

interface SidebarContextMenuProps {
  x: number;
  y: number;
  filename: string;
  title: string;
  onClose: () => void;
  onDuplicate: () => void;
  onRename: () => void;
  onArchive: () => void;
  onDelete: () => void;
  onPluginAction: (action: string, item: SidebarMenuItem) => void;
  pluginItems: SidebarMenuItem[];
  onSchedulePost?: () => void;
  onViewAnalytics?: () => void;
  viewAnalyticsLabel?: string;
  onMarkSent?: () => void;
  isAlreadySent?: boolean;
}

export default function SidebarContextMenu({ x, y, filename, title, onClose, onDuplicate, onRename, onArchive, onDelete, onPluginAction, pluginItems, onSchedulePost, onViewAnalytics, viewAnalyticsLabel, onMarkSent, isAlreadySent }: SidebarContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [adjustedPos, setAdjustedPos] = useState<{ left: number; top: number }>({ left: x, top: y });

  // Adjust position to keep menu within viewport
  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const rect = menu.getBoundingClientRect();
    const pad = 8;
    let left = x;
    let top = y;
    if (y + rect.height + pad > window.innerHeight) top = y - rect.height;
    if (x + rect.width + pad > window.innerWidth) left = x - rect.width;
    if (top < pad) top = pad;
    if (left < pad) left = pad;
    setAdjustedPos({ left, top });
  }, [x, y]);

  // Close on click outside
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  const handlePluginAction = useCallback((item: SidebarMenuItem) => {
    onPluginAction(item.action, item);
    onClose();
  }, [onPluginAction, onClose]);

  return (
    <div
      ref={menuRef}
      className="context-menu"
      style={{ left: adjustedPos.left, top: adjustedPos.top }}
    >
      <button className="context-menu-item" onClick={() => { onDuplicate(); onClose(); }}>
        <span>Duplicate</span>
      </button>
      <button className="context-menu-item" onClick={() => { onRename(); onClose(); }}>
        <span>Rename</span>
      </button>
      {confirmArchive ? (
        <div className="context-menu-item sidebar-ctx-confirm" onClick={(e) => e.stopPropagation()}>
          <span>Archive?</span>
          <button onClick={() => { onArchive(); onClose(); }}>Yes</button>
          <button onClick={() => setConfirmArchive(false)}>No</button>
        </div>
      ) : (
        <button className="context-menu-item" onClick={() => setConfirmArchive(true)}>
          <span>Archive</span>
        </button>
      )}
      {confirmDelete ? (
        <div className="context-menu-item sidebar-ctx-confirm" onClick={(e) => e.stopPropagation()}>
          <span>{isExternal(filename) ? 'Remove?' : 'Delete?'}</span>
          <button onClick={() => { onDelete(); onClose(); }}>Yes</button>
          <button onClick={() => setConfirmDelete(false)}>No</button>
        </div>
      ) : (
        <button className="context-menu-item sidebar-ctx-delete" onClick={() => setConfirmDelete(true)}>
          <span>{isExternal(filename) ? 'Remove' : 'Delete'}</span>
        </button>
      )}
      {onSchedulePost && (
        <>
          <div className="context-menu-divider" />
          <button className="context-menu-item" onClick={() => { onSchedulePost(); onClose(); }}>
            <span>Schedule Post</span>
          </button>
        </>
      )}
      {onMarkSent && !isAlreadySent && (
        <>
          <div className="context-menu-divider" />
          <button className="context-menu-item" onClick={() => { onMarkSent(); onClose(); }}>
            <span>Mark as Sent</span>
          </button>
        </>
      )}
      {onViewAnalytics && (
        <>
          <div className="context-menu-divider" />
          <button className="context-menu-item" onClick={() => { onViewAnalytics(); onClose(); }}>
            <span>{viewAnalyticsLabel || 'View Analytics'}</span>
          </button>
        </>
      )}
      {pluginItems.length > 0 && (
        <>
          {(() => {
            let lastPluginName: string | undefined;
            return pluginItems.map((item) => {
              const showHeader = item.pluginDisplayName && item.pluginDisplayName !== lastPluginName;
              lastPluginName = item.pluginDisplayName;
              return (
                <span key={item.action}>
                  {showHeader && <div className="context-menu-divider" />}
                  {showHeader && <div className="context-menu-section-header">{item.pluginDisplayName}</div>}
                  <button
                    className="context-menu-item"
                    onClick={() => handlePluginAction(item)}
                  >
                    <span>{item.label}</span>
                  </button>
                </span>
              );
            });
          })()}
        </>
      )}
    </div>
  );
}
