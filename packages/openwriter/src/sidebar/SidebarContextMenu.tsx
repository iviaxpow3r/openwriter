import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
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
  isApproved?: boolean;
  onToggleApprove?: () => void;
  isAutoAccept?: boolean;
  onToggleAutoAccept?: () => void;
  // Folder mode (workspace/container) — shows folder-specific actions instead of doc actions
  folderMode?: boolean;
  onNewDoc?: (e: React.MouseEvent) => void;
  onNewContainer?: () => void;
  onAcceptAll?: () => void;
  onRejectAll?: () => void;
  folderAutoAccept?: boolean;
  onToggleFolderAutoAccept?: () => void;
  folderAutoAcceptLabel?: string;
  // Folder delete — when docCount > 0, user is offered "delete folder only" or "delete folder + docs"
  folderDocCount?: number;
  onDeleteWithDocs?: () => void;
  // Bulk mode (multi-selection) — shows bulk actions only
  bulkCount?: number;
  onBulkDelete?: () => void;
}

/** Group plugin items: plugins with 3+ items get a submenu, others stay flat */
function PluginSubmenu({ items, onAction, menuRef }: {
  items: SidebarMenuItem[];
  onAction: (item: SidebarMenuItem) => void;
  menuRef: React.RefObject<HTMLDivElement | null>;
}) {
  const [openSubmenu, setOpenSubmenu] = useState<string | null>(null);
  const submenuRef = useRef<HTMLDivElement>(null);

  // Group items by plugin display name
  const groups = useMemo(() => {
    const map = new Map<string, SidebarMenuItem[]>();
    for (const item of items) {
      const key = item.pluginDisplayName || '_ungrouped';
      const arr = map.get(key) || [];
      arr.push(item);
      map.set(key, arr);
    }
    return map;
  }, [items]);

  // Position submenu to the right (or left if no room)
  const [submenuStyle, setSubmenuStyle] = useState<React.CSSProperties>({});
  useLayoutEffect(() => {
    if (!openSubmenu || !submenuRef.current || !menuRef.current) return;
    const parentRect = menuRef.current.getBoundingClientRect();
    const subRect = submenuRef.current.getBoundingClientRect();
    const pad = 8;
    let left = parentRect.right - 4;
    let top = submenuRef.current.offsetTop + parentRect.top - 4;
    if (left + subRect.width + pad > window.innerWidth) left = parentRect.left - subRect.width + 4;
    if (top + subRect.height + pad > window.innerHeight) top = window.innerHeight - subRect.height - pad;
    if (top < pad) top = pad;
    setSubmenuStyle({ position: 'fixed', left, top });
  }, [openSubmenu, menuRef]);

  const result: JSX.Element[] = [];
  for (const [pluginName, groupItems] of groups) {
    // 3+ items from same plugin → submenu
    if (pluginName !== '_ungrouped' && groupItems.length >= 3) {
      result.push(
        <span key={`sub-${pluginName}`}>
          <div className="context-menu-divider" />
          <button
            className="context-menu-item context-menu-submenu-trigger"
            onMouseEnter={() => setOpenSubmenu(pluginName)}
            onClick={() => setOpenSubmenu(openSubmenu === pluginName ? null : pluginName)}
          >
            <span>Transform</span>
            <span className="context-menu-submenu-arrow">&#9656;</span>
          </button>
          {openSubmenu === pluginName && (
            <div
              ref={submenuRef}
              className="context-menu context-menu-submenu"
              style={submenuStyle}
              onMouseLeave={() => setOpenSubmenu(null)}
            >
              {groupItems.map((item) => (
                <button key={item.action} className="context-menu-item" onClick={() => onAction(item)}>
                  <span>{item.label}</span>
                </button>
              ))}
            </div>
          )}
        </span>
      );
    } else {
      // Few items or ungrouped → render flat
      let isFirst = true;
      for (const item of groupItems) {
        const showHeader = isFirst && pluginName !== '_ungrouped';
        isFirst = false;
        result.push(
          <span key={item.action}>
            {showHeader && <div className="context-menu-divider" />}
            {showHeader && <div className="context-menu-section-header">{pluginName}</div>}
            <button className="context-menu-item" onClick={() => onAction(item)}>
              <span>{item.label}</span>
            </button>
          </span>
        );
      }
    }
  }
  return <>{result}</>;
}

export default function SidebarContextMenu({ x, y, filename, title, onClose, onDuplicate, onRename, onArchive, onDelete, onPluginAction, pluginItems, onSchedulePost, onViewAnalytics, viewAnalyticsLabel, onMarkSent, isAlreadySent, isApproved, onToggleApprove, isAutoAccept, onToggleAutoAccept, folderMode, onNewDoc, onNewContainer, onAcceptAll, onRejectAll, folderAutoAccept, onToggleFolderAutoAccept, folderAutoAcceptLabel, folderDocCount, onDeleteWithDocs, bulkCount, onBulkDelete }: SidebarContextMenuProps) {
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

  if (bulkCount && bulkCount > 1 && onBulkDelete) {
    return (
      <div ref={menuRef} className="context-menu" style={{ left: adjustedPos.left, top: adjustedPos.top }}>
        <div className="context-menu-section-header">{bulkCount} selected</div>
        {confirmDelete ? (
          <div className="context-menu-item sidebar-ctx-confirm" onClick={(e) => e.stopPropagation()}>
            <span>Delete {bulkCount}?</span>
            <button onClick={() => { onBulkDelete(); onClose(); }}>Yes</button>
            <button onClick={() => setConfirmDelete(false)}>No</button>
          </div>
        ) : (
          <button className="context-menu-item sidebar-ctx-delete" onClick={() => setConfirmDelete(true)}>
            <span>Delete ({bulkCount})</span>
          </button>
        )}
      </div>
    );
  }

  if (folderMode) {
    return (
      <div ref={menuRef} className="context-menu" style={{ left: adjustedPos.left, top: adjustedPos.top }}>
        <button className="context-menu-item" onClick={() => { onRename(); onClose(); }}>
          <span>Rename</span>
        </button>
        {onNewDoc && (
          <button className="context-menu-item" onClick={(e) => { onNewDoc(e); onClose(); }}>
            <span>New Document</span>
          </button>
        )}
        {onNewContainer && (
          <button className="context-menu-item" onClick={() => { onNewContainer(); onClose(); }}>
            <span>New Container</span>
          </button>
        )}
        {(onAcceptAll || onRejectAll) && <div className="context-menu-divider" />}
        {onAcceptAll && (
          <button className="context-menu-item" onClick={() => { onAcceptAll(); onClose(); }}>
            <span>Accept All Changes</span>
          </button>
        )}
        {onRejectAll && (
          <button className="context-menu-item" onClick={() => { onRejectAll(); onClose(); }}>
            <span>Reject All Changes</span>
          </button>
        )}
        {onToggleFolderAutoAccept && (
          <>
            <div className="context-menu-divider" />
            <button className="context-menu-item" onClick={() => { onToggleFolderAutoAccept(); onClose(); }}>
              <span>{folderAutoAccept ? `Turn off auto-accept${folderAutoAcceptLabel ? ' ' + folderAutoAcceptLabel : ''}` : `Turn on auto-accept${folderAutoAcceptLabel ? ' ' + folderAutoAcceptLabel : ''}`}</span>
            </button>
          </>
        )}
        <div className="context-menu-divider" />
        {confirmDelete ? (
          folderDocCount && folderDocCount > 0 && onDeleteWithDocs ? (
            <div className="sidebar-ctx-folder-delete" onClick={(e) => e.stopPropagation()}>
              <div className="sidebar-ctx-folder-delete-prompt">Delete this folder?</div>
              <button className="context-menu-item sidebar-ctx-delete-option" onClick={() => { onDelete(); onClose(); }}>
                <span>Folder only</span>
                <span className="sidebar-ctx-delete-hint">{folderDocCount} doc{folderDocCount === 1 ? '' : 's'} → Documents</span>
              </button>
              <button className="context-menu-item sidebar-ctx-delete-option sidebar-ctx-delete" onClick={() => { onDeleteWithDocs(); onClose(); }}>
                <span>Folder + {folderDocCount} doc{folderDocCount === 1 ? '' : 's'}</span>
                <span className="sidebar-ctx-delete-hint">permanently deletes files</span>
              </button>
              <button className="context-menu-item sidebar-ctx-delete-cancel" onClick={() => setConfirmDelete(false)}>
                <span>Cancel</span>
              </button>
            </div>
          ) : (
            <div className="context-menu-item sidebar-ctx-confirm" onClick={(e) => e.stopPropagation()}>
              <span>Delete?</span>
              <button onClick={() => { onDelete(); onClose(); }}>Yes</button>
              <button onClick={() => setConfirmDelete(false)}>No</button>
            </div>
          )
        ) : (
          <button className="context-menu-item sidebar-ctx-delete" onClick={() => setConfirmDelete(true)}>
            <span>Delete</span>
          </button>
        )}
      </div>
    );
  }

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
      {onToggleApprove && (
        <>
          <div className="context-menu-divider" />
          <button className="context-menu-item" onClick={() => { onToggleApprove(); onClose(); }}>
            <span>{isApproved ? 'Remove Approval' : 'Approve'}</span>
          </button>
        </>
      )}
      {onToggleAutoAccept && (
        <>
          <div className="context-menu-divider" />
          <button className="context-menu-item" onClick={() => { onToggleAutoAccept(); onClose(); }}>
            <span>{isAutoAccept ? 'Turn off auto-accept' : 'Turn on auto-accept'}</span>
          </button>
        </>
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
      {pluginItems.length > 0 && <PluginSubmenu items={pluginItems} onAction={handlePluginAction} menuRef={menuRef} />}
    </div>
  );
}
