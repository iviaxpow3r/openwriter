import { useCallback, useEffect, useRef, useState } from 'react';

interface SidebarMenuItem {
  label: string;
  action: string;
}

interface SidebarContextMenuProps {
  x: number;
  y: number;
  filename: string;
  title: string;
  onClose: () => void;
  onRename: () => void;
  onDelete: () => void;
  pluginItems: SidebarMenuItem[];
}

export default function SidebarContextMenu({ x, y, filename, title, onClose, onRename, onDelete, pluginItems }: SidebarContextMenuProps) {
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

  const handlePluginAction = useCallback((action: string) => {
    fetch('/api/plugins/sidebar-action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, filename, title }),
    }).catch(() => {});
    onClose();
  }, [filename, title, onClose]);

  return (
    <div
      ref={menuRef}
      className="context-menu"
      style={{ left: x, top: y }}
    >
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
          {pluginItems.map((item) => (
            <button
              key={item.action}
              className="context-menu-item"
              onClick={() => handlePluginAction(item.action)}
            >
              <span>{item.label}</span>
            </button>
          ))}
        </>
      )}
    </div>
  );
}
