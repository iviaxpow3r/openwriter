import { useCallback, useEffect, useRef, useState } from 'react';

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
  onDelete: () => void;
  onPluginAction: (action: string, item: SidebarMenuItem) => void;
  pluginItems: SidebarMenuItem[];
}

export default function SidebarContextMenu({ x, y, filename, title, onClose, onDuplicate, onRename, onDelete, onPluginAction, pluginItems }: SidebarContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

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
      style={{ left: x, top: y }}
    >
      <button className="context-menu-item" onClick={() => { onDuplicate(); onClose(); }}>
        <span>Duplicate</span>
      </button>
      <button className="context-menu-item" onClick={() => { onRename(); onClose(); }}>
        <span>Rename</span>
      </button>
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
      {pluginItems.length > 0 && (
        <>
          <div className="context-menu-divider" />
          {(() => {
            let lastPluginName: string | undefined;
            return pluginItems.map((item) => {
              const showHeader = item.pluginDisplayName && item.pluginDisplayName !== lastPluginName;
              const showDivider = showHeader && lastPluginName !== undefined;
              lastPluginName = item.pluginDisplayName;
              return (
                <span key={item.action}>
                  {showDivider && <div className="context-menu-divider" />}
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
