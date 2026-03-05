import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

export interface SidebarMenuItem {
  label: string;
  action: string;
  promptForFocus?: boolean;
  pluginDisplayName?: string;
}

interface ActiveConnection {
  id: string;
  type: string;
  name: string;
  credentials: Record<string, string>;
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
  onNewsletterSend?: (connectionId: string) => void;
}

export default function SidebarContextMenu({ x, y, filename, title, onClose, onDuplicate, onRename, onArchive, onDelete, onPluginAction, pluginItems, onNewsletterSend }: SidebarContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [adjustedPos, setAdjustedPos] = useState<{ left: number; top: number }>({ left: x, top: y });
  const [newsletterConnections, setNewsletterConnections] = useState<ActiveConnection[]>([]);
  const [showNewsletterSub, setShowNewsletterSub] = useState(false);

  // Fetch active newsletter connections
  useEffect(() => {
    fetch('/api/connections/active?type=newsletter')
      .then(r => r.json())
      .then(data => setNewsletterConnections(data.connections || []))
      .catch(() => {});
  }, []);

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

  const handleNewsletterClick = useCallback(() => {
    if (!onNewsletterSend) return;
    if (newsletterConnections.length === 1) {
      onNewsletterSend(newsletterConnections[0].id);
      onClose();
    } else {
      setShowNewsletterSub(!showNewsletterSub);
    }
  }, [onNewsletterSend, newsletterConnections, showNewsletterSub, onClose]);

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
          <span>Delete?</span>
          <button onClick={() => { onDelete(); onClose(); }}>Yes</button>
          <button onClick={() => setConfirmDelete(false)}>No</button>
        </div>
      ) : (
        <button className="context-menu-item sidebar-ctx-delete" onClick={() => setConfirmDelete(true)}>
          <span>Delete</span>
        </button>
      )}
      {newsletterConnections.length > 0 && onNewsletterSend && (
        <>
          <div className="context-menu-divider" />
          <button className="context-menu-item" onClick={handleNewsletterClick}>
            <span>Send as Newsletter</span>
          </button>
          {showNewsletterSub && newsletterConnections.length > 1 && (
            <div className="context-menu-sub">
              {newsletterConnections.map(conn => (
                <button
                  key={conn.id}
                  className="context-menu-item context-menu-sub-item"
                  onClick={() => { onNewsletterSend(conn.id); onClose(); }}
                >
                  <span>{conn.name}</span>
                </button>
              ))}
            </div>
          )}
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
