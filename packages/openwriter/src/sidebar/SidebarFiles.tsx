import { useState, useEffect, useRef, useCallback } from 'react';
import type { SidebarModeProps, DocumentInfo, WorkspaceNode, ContainerItem, ContentType } from './sidebar-types';
import { collectFiles } from './sidebar-utils';
import SidebarContextMenu from './SidebarContextMenu';
import type { SidebarMenuItem } from './SidebarContextMenu';
import FocusInstructionsModal from './FocusInstructionsModal';
import SchedulePostModal from './SchedulePostModal';
import CreateDocDropdown from './CreateDocDropdown';
import NewsletterAnalyticsModal from '../newsletter/NewsletterAnalyticsModal';
import SearchResults from './SearchResults';
import './SidebarFiles.css';

// ─── Icons (monochrome, inherit currentColor) ───

const FolderIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M20 20H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h4l2 2h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2z" />
    <line x1="9" y1="14" x2="15" y2="14" opacity="0.5" />
  </svg>
);

const DocIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <polyline points="14 2 14 8 20 8" />
    <line x1="8" y1="13" x2="16" y2="13" />
    <line x1="8" y1="17" x2="13" y2="17" />
  </svg>
);

const XIcon = () => (
  <svg viewBox="0 0 24 24" fill="currentColor" stroke="none">
    <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
  </svg>
);

const ReplyIcon = () => (
  <svg viewBox="0 0 24 24" fill="currentColor" stroke="none">
    <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" opacity="0.5" />
    <path d="M7 15l-4-3.5L7 8" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const QuoteIcon = () => (
  <svg viewBox="0 0 24 24" fill="currentColor" stroke="none">
    <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" opacity="0.5" />
    <path d="M3 8V6.5C3 5.67 3.67 5 4.5 5h2C7.33 5 8 5.67 8 6.5V8c0 2-1.5 3-3 3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
  </svg>
);

const ArticleIcon = () => (
  <svg viewBox="0 0 24 24" fill="currentColor" stroke="none">
    <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" opacity="0.5" />
    <rect x="2" y="16" width="8" height="7" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
    <line x1="4" y1="18.5" x2="8" y2="18.5" stroke="currentColor" strokeWidth="1" opacity="0.7" />
    <line x1="4" y1="20.5" x2="7" y2="20.5" stroke="currentColor" strokeWidth="1" opacity="0.7" />
  </svg>
);

const LinkedInIcon = () => (
  <svg viewBox="0 0 24 24" fill="currentColor" stroke="none">
    <path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 0 1-2.063-2.065 2.064 2.064 0 1 1 2.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z" />
  </svg>
);

const NewsletterIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <rect width="20" height="16" x="2" y="4" rx="2" />
    <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
  </svg>
);

const BlogIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="10" />
    <path d="M2 12h20" />
    <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
  </svg>
);

const CheckIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="20 6 9 17 4 12" />
  </svg>
);

function ContentIcon({ type }: { type?: ContentType }) {
  switch (type) {
    case 'tweet': return <XIcon />;
    case 'reply': return <ReplyIcon />;
    case 'quote': return <QuoteIcon />;
    case 'article': return <ArticleIcon />;
    case 'linkedin': return <LinkedInIcon />;
    case 'newsletter': return <NewsletterIcon />;
    case 'blog': return <BlogIcon />;
    default: return <DocIcon />;
  }
}

// ─── Helpers ───

function countDocs(nodes: WorkspaceNode[]): number {
  let n = 0;
  for (const node of nodes) {
    if (node.type === 'doc') n++;
    else if (node.type === 'container') n += countDocs(node.items);
  }
  return n;
}

function findDocPath(nodes: WorkspaceNode[], filename: string): string[] | null {
  for (const n of nodes) {
    if (n.type === 'doc' && n.file === filename) return [];
    if (n.type === 'container') {
      const sub = findDocPath(n.items, filename);
      if (sub) return [n.id, ...sub];
    }
  }
  return null;
}

function getFilenamesInNodes(nodes: WorkspaceNode[]): string[] {
  const files = new Set<string>();
  collectFiles(nodes, files);
  return [...files];
}

// ─── Folder Context Menu (workspace/container right-click) ───

interface FolderMenuProps {
  x: number;
  y: number;
  onClose: () => void;
  onRename: () => void;
  onNewDoc: (e: React.MouseEvent) => void;
  onNewContainer?: () => void;
  onDelete: () => void;
  onAcceptAll?: () => void;
  onRejectAll?: () => void;
}

function FolderContextMenu({ x, y, onClose, onRename, onNewDoc, onNewContainer, onDelete, onAcceptAll, onRejectAll }: FolderMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);

  return (
    <div ref={ref} className="sidebar-density-dropdown" style={{ position: 'fixed', left: x, top: y, zIndex: 200, minWidth: 160 }}>
      <button className="sidebar-density-option" onClick={onRename}>Rename</button>
      <button className="sidebar-density-option" onClick={onNewDoc}>New Document</button>
      {onNewContainer && <button className="sidebar-density-option" onClick={onNewContainer}>New Container</button>}
      {onAcceptAll && <button className="sidebar-density-option" onClick={onAcceptAll}>Accept All Changes</button>}
      {onRejectAll && <button className="sidebar-density-option" onClick={onRejectAll}>Reject All Changes</button>}
      <div style={{ height: 1, background: 'var(--border)', margin: '4px 0' }} />
      {confirmDelete ? (
        <div style={{ display: 'flex', gap: 4, padding: '4px 10px', fontSize: 12 }}>
          <span style={{ color: '#dc2626' }}>Delete?</span>
          <button className="sidebar-density-option" style={{ padding: '2px 8px', color: '#dc2626' }} onClick={() => { onDelete(); onClose(); }}>Yes</button>
          <button className="sidebar-density-option" style={{ padding: '2px 8px' }} onClick={() => setConfirmDelete(false)}>No</button>
        </div>
      ) : (
        <button className="sidebar-density-option" style={{ color: '#dc2626' }} onClick={() => setConfirmDelete(true)}>Delete</button>
      )}
    </div>
  );
}

// ─── Component ───

export default function SidebarFiles({
  docs, workspaces, assignedFiles, pendingDocs,
  onSwitchDocument, onCreateDocument, actions, scrollRef,
  searchQuery, searchResults, onSearchChange,
}: SidebarModeProps) {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    try {
      const saved = localStorage.getItem('ow-files-collapsed');
      return saved ? new Set(JSON.parse(saved)) : new Set();
    } catch { return new Set(); }
  });

  // Rename state
  const [renaming, setRenaming] = useState<{ type: 'doc' | 'workspace' | 'container'; key: string; value: string; wsFilename?: string } | null>(null);

  // Doc context menu state
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; filename: string; title: string; docId?: string; lastSent?: string; postedUrl?: string; isNewsletter?: boolean } | null>(null);
  const [sidebarPluginItems, setSidebarPluginItems] = useState<SidebarMenuItem[]>([]);
  const [focusModal, setFocusModal] = useState<{ action: string; label: string; filename: string; title: string } | null>(null);
  const [scheduleModal, setScheduleModal] = useState<{ filename: string; title: string } | null>(null);
  const [analyticsModal, setAnalyticsModal] = useState<{ docId: string; title: string } | null>(null);
  const [createDropdown, setCreateDropdown] = useState<{ anchor: DOMRect; wsFilename?: string; containerId?: string | null } | null>(null);

  // Folder context menu state
  const [folderMenu, setFolderMenu] = useState<{ x: number; y: number; type: 'workspace' | 'container'; wsFilename: string; containerId?: string; title: string; nodes: WorkspaceNode[] } | null>(null);

  // Fetch plugin sidebar items
  const fetchSidebarItems = useCallback(() => {
    fetch('/api/plugins')
      .then(r => r.json())
      .then(data => {
        const items: SidebarMenuItem[] = [];
        for (const plugin of data.plugins || []) {
          const displayName = plugin.displayName || undefined;
          for (const item of plugin.sidebarMenuItems || []) {
            items.push({ ...item, pluginDisplayName: displayName });
          }
        }
        setSidebarPluginItems(items);
      })
      .catch(() => {});
  }, []);

  useEffect(() => { fetchSidebarItems(); }, [fetchSidebarItems]);
  useEffect(() => {
    const handler = () => fetchSidebarItems();
    window.addEventListener('ow-plugins-changed', handler);
    return () => window.removeEventListener('ow-plugins-changed', handler);
  }, [fetchSidebarItems]);

  const handleDocContextMenu = useCallback((e: React.MouseEvent, doc: DocumentInfo) => {
    e.preventDefault();
    e.stopPropagation();
    setCtxMenu({ x: e.clientX, y: e.clientY, filename: doc.filename, title: doc.title, docId: doc.docId, lastSent: doc.lastSent, postedUrl: doc.postedUrl, isNewsletter: doc.isNewsletter });
  }, []);

  const handleDuplicate = useCallback((filename: string) => {
    fetch('/api/documents/duplicate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ filename }) }).catch(() => {});
  }, []);

  const handlePluginAction = useCallback((action: string, item: SidebarMenuItem, filename: string, title: string, instructions?: string) => {
    if (item.promptForFocus && instructions === undefined) {
      setFocusModal({ action, label: item.label, filename, title });
      return;
    }
    fetch('/api/plugins/sidebar-action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, filename, title, instructions: instructions || '', label: item.label }) }).catch(() => {});
  }, []);

  const handleBatchResolve = useCallback((filenames: string[], action: 'accept' | 'reject') => {
    fetch('/api/documents/batch-resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filenames, action }),
    }).catch(() => {});
  }, []);

  const toggle = (key: string) => {
    setCollapsed(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      localStorage.setItem('ow-files-collapsed', JSON.stringify([...next]));
      return next;
    });
  };

  const startRename = (type: 'doc' | 'workspace' | 'container', key: string, value: string, wsFilename?: string) => {
    setRenaming({ type, key, value, wsFilename });
  };

  const commitRename = () => {
    if (!renaming) return;
    const { type, key, value, wsFilename } = renaming;
    if (type === 'doc') actions.handleRename(key, '', value);
    else if (type === 'workspace') actions.handleRenameWorkspace(key, value);
    else if (type === 'container' && wsFilename) actions.handleRenameContainer(wsFilename, key, value);
    setRenaming(null);
  };

  // Auto-expand to active doc
  const activeDoc = docs.find(d => d.isActive);
  const workspacesRef = useRef(workspaces);
  workspacesRef.current = workspaces;
  useEffect(() => {
    if (!activeDoc) return;
    for (const ws of workspacesRef.current) {
      const path = findDocPath(ws.workspace?.root || [], activeDoc.filename);
      if (path) {
        setCollapsed(prev => {
          const keysToExpand = [ws.filename, ...path.map(id => `container-${id}`)];
          if (keysToExpand.every(k => !prev.has(k))) return prev;
          const next = new Set(prev);
          for (const k of keysToExpand) next.delete(k);
          localStorage.setItem('ow-files-collapsed', JSON.stringify([...next]));
          return next;
        });
        break;
      }
    }
  }, [activeDoc?.filename]);

  if (searchResults !== null) {
    return <SearchResults results={searchResults} query={searchQuery} onSwitchDocument={onSwitchDocument} actions={actions} />;
  }

  const unassignedDocs = docs.filter(d => !assignedFiles.has(d.filename));

  const renderRenameInput = (onCommit: () => void) => (
    <input
      className="sidebar-rename-input"
      value={renaming!.value}
      onChange={e => setRenaming(prev => prev ? { ...prev, value: e.target.value } : null)}
      onBlur={onCommit}
      onKeyDown={e => { if (e.key === 'Enter') onCommit(); if (e.key === 'Escape') setRenaming(null); }}
      autoFocus
      onClick={e => e.stopPropagation()}
    />
  );

  const renderDoc = (doc: DocumentInfo, indent: number) => (
    <div
      key={doc.filename}
      className={`files-row${doc.isActive ? ' active' : ''}`}
      style={{ paddingLeft: indent }}
      onClick={() => !doc.isActive && onSwitchDocument(doc.filename)}
      onDoubleClick={() => startRename('doc', doc.filename, doc.title)}
      onContextMenu={e => handleDocContextMenu(e, doc)}
    >
      <span className="files-row-icon"><ContentIcon type={doc.contentType} /></span>
      {renaming?.type === 'doc' && renaming.key === doc.filename ? (
        renderRenameInput(commitRename)
      ) : (
        <>
          <span className="files-row-label">{doc.title}</span>
          {pendingDocs.filenames.includes(doc.filename) && <span className="files-badge-pending" />}
          {actions.getDocTags(doc.filename).includes('✓') && <span className="files-badge-approved"><CheckIcon /></span>}
          {doc.lastSent && <span className="files-badge-sent"><CheckIcon /></span>}
        </>
      )}
    </div>
  );

  const renderNode = (node: WorkspaceNode, depth: number, wsFilename: string): JSX.Element | null => {
    const indent = 12 + depth * 16;

    if (node.type === 'doc') {
      const doc = docs.find(d => d.filename === node.file);
      if (!doc) return null;
      return renderDoc(doc, indent);
    }

    const container = node as ContainerItem;
    const key = `container-${container.id}`;
    const isCollapsed = collapsed.has(key);
    const count = countDocs(container.items);

    return (
      <div key={container.id}>
        <div
          className="files-row is-container"
          style={{ paddingLeft: indent }}
          onClick={() => toggle(key)}
          onDoubleClick={e => { e.stopPropagation(); startRename('container', container.id, container.name, wsFilename); }}
          onContextMenu={e => {
            e.preventDefault();
            e.stopPropagation();
            setFolderMenu({ x: e.clientX, y: e.clientY, type: 'container', wsFilename, containerId: container.id, title: container.name, nodes: container.items });
          }}
        >
          <span className="files-row-icon"><FolderIcon /></span>
          {renaming?.type === 'container' && renaming.key === container.id ? (
            renderRenameInput(commitRename)
          ) : (
            <>
              <span className="files-row-label">{container.name}</span>
              <span className="files-row-count">{count}</span>
              <span className={`files-row-chevron${isCollapsed ? ' collapsed' : ''}`}>&#9662;</span>
            </>
          )}
        </div>
        <div className={`files-children${isCollapsed ? ' collapsed' : ''}`}>
          {container.items.map(child => renderNode(child, depth + 1, wsFilename))}
        </div>
      </div>
    );
  };

  return (
    <div className="files-scroll" ref={scrollRef}>
      {/* Unassigned documents section */}
      <div className="files-section">
        <div className="files-row is-section" onClick={() => toggle('docs')}>
          <span className="files-row-label">Documents</span>
          <span className={`files-row-chevron${collapsed.has('docs') ? ' collapsed' : ''}`}>&#9662;</span>
        </div>
        <div className={`files-section-list files-children${collapsed.has('docs') ? ' collapsed' : ''}`}>
          {unassignedDocs.map(doc => renderDoc(doc, 12))}
        </div>
      </div>

      {/* Workspace sections */}
      {workspaces.map(ws => {
        const wsRoot = ws.workspace?.root || [];
        const isCollapsedWs = collapsed.has(ws.filename);
        const count = countDocs(wsRoot);

        return (
          <div key={ws.filename} className="files-section">
            <div
              className="files-row is-section"
              onClick={() => toggle(ws.filename)}
              onDoubleClick={e => { e.stopPropagation(); startRename('workspace', ws.filename, ws.title); }}
              onContextMenu={e => {
                e.preventDefault();
                e.stopPropagation();
                setFolderMenu({ x: e.clientX, y: e.clientY, type: 'workspace', wsFilename: ws.filename, title: ws.title, nodes: wsRoot });
              }}
            >
              {renaming?.type === 'workspace' && renaming.key === ws.filename ? (
                renderRenameInput(commitRename)
              ) : (
                <>
                  <span className="files-row-label">{ws.title}</span>
                  <span className="files-row-count">{count}</span>
                  <span className={`files-row-chevron${isCollapsedWs ? ' collapsed' : ''}`}>&#9662;</span>
                </>
              )}
            </div>
            <div className={`files-section-list files-children${isCollapsedWs ? ' collapsed' : ''}`}>
              {wsRoot.map(node => renderNode(node, 0, ws.filename))}
            </div>
          </div>
        );
      })}

      <div className="files-new-ws">
        <button onClick={actions.handleCreateWorkspace}>+ New Workspace</button>
      </div>

      {/* Folder context menu (workspace/container) */}
      {folderMenu && (
        <FolderContextMenu
          x={folderMenu.x}
          y={folderMenu.y}
          onClose={() => setFolderMenu(null)}
          onRename={() => {
            if (folderMenu.type === 'workspace') startRename('workspace', folderMenu.wsFilename, folderMenu.title);
            else if (folderMenu.containerId) startRename('container', folderMenu.containerId, folderMenu.title, folderMenu.wsFilename);
            setFolderMenu(null);
          }}
          onNewDoc={(e) => {
            setCreateDropdown({
              anchor: (e.target as HTMLElement).getBoundingClientRect(),
              wsFilename: folderMenu.wsFilename,
              containerId: folderMenu.type === 'container' ? folderMenu.containerId : null,
            });
            setFolderMenu(null);
          }}
          onNewContainer={folderMenu.type === 'workspace' ? () => {
            actions.handleCreateContainer(folderMenu.wsFilename, null);
            setFolderMenu(null);
          } : folderMenu.type === 'container' ? () => {
            actions.handleCreateContainer(folderMenu.wsFilename, folderMenu.containerId!);
            setFolderMenu(null);
          } : undefined}
          onDelete={() => {
            if (folderMenu.type === 'workspace') actions.handleDeleteWorkspace(folderMenu.wsFilename);
            else if (folderMenu.containerId) actions.handleDeleteContainer(folderMenu.wsFilename, folderMenu.containerId);
          }}
          onAcceptAll={() => {
            const filenames = getFilenamesInNodes(folderMenu.nodes);
            if (filenames.length) handleBatchResolve(filenames, 'accept');
            setFolderMenu(null);
          }}
          onRejectAll={() => {
            const filenames = getFilenamesInNodes(folderMenu.nodes);
            if (filenames.length) handleBatchResolve(filenames, 'reject');
            setFolderMenu(null);
          }}
        />
      )}

      {/* Doc context menu */}
      {ctxMenu && (
        <SidebarContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          filename={ctxMenu.filename}
          title={ctxMenu.title}
          onClose={() => setCtxMenu(null)}
          onDuplicate={() => handleDuplicate(ctxMenu.filename)}
          onRename={() => {
            startRename('doc', ctxMenu.filename, ctxMenu.title);
            setCtxMenu(null);
          }}
          onArchive={() => actions.handleArchive(ctxMenu.filename)}
          onDelete={() => actions.handleDelete(ctxMenu.filename)}
          onPluginAction={(action, item) => handlePluginAction(action, item, ctxMenu.filename, ctxMenu.title)}
          pluginItems={sidebarPluginItems}
          onSchedulePost={() => {
            setScheduleModal({ filename: ctxMenu.filename, title: ctxMenu.title });
            setCtxMenu(null);
          }}
          onViewAnalytics={ctxMenu.docId && ctxMenu.lastSent && (ctxMenu.postedUrl || ctxMenu.isNewsletter) ? () => {
            if (ctxMenu.isNewsletter) setAnalyticsModal({ docId: ctxMenu.docId!, title: ctxMenu.title });
            else if (ctxMenu.postedUrl) window.open(ctxMenu.postedUrl, '_blank');
            setCtxMenu(null);
          } : undefined}
          viewAnalyticsLabel={ctxMenu.isNewsletter ? 'View Analytics' : ctxMenu.postedUrl ? 'View on X' : 'View Analytics'}
          isApproved={actions.getDocTags(ctxMenu.filename).includes('✓')}
          onToggleApprove={() => {
            const tags = actions.getDocTags(ctxMenu.filename);
            if (tags.includes('✓')) actions.handleRemoveTag(ctxMenu.filename, '✓');
            else {
              actions.handleAddTag(ctxMenu.filename, '✓');
              setTimeout(() => window.dispatchEvent(new CustomEvent('ow-accept-all')), 50);
            }
          }}
          isAlreadySent={!!ctxMenu.lastSent}
          onMarkSent={() => {
            const fn = ctxMenu.filename;
            if (actions.getDocTags(fn).includes('✓')) actions.handleRemoveTag(fn, '✓');
            onSwitchDocument(fn);
            setTimeout(() => {
              fetch('/api/metadata', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ manualPost: { postedAt: new Date().toISOString() } }) })
                .then(() => actions.fetchDocs()).catch(() => {});
            }, 100);
            setCtxMenu(null);
          }}
        />
      )}
      {focusModal && (
        <FocusInstructionsModal
          actionLabel={focusModal.label}
          docTitle={focusModal.title}
          onClose={() => setFocusModal(null)}
          onConfirm={instructions => {
            const item = sidebarPluginItems.find(i => i.action === focusModal.action);
            if (item) handlePluginAction(focusModal.action, item, focusModal.filename, focusModal.title, instructions);
            setFocusModal(null);
          }}
        />
      )}
      {analyticsModal && (
        <NewsletterAnalyticsModal docId={analyticsModal.docId} title={analyticsModal.title} onClose={() => setAnalyticsModal(null)} />
      )}
      {scheduleModal && (
        <SchedulePostModal filename={scheduleModal.filename} title={scheduleModal.title} onClose={() => setScheduleModal(null)} />
      )}
      {createDropdown && (
        <CreateDocDropdown
          anchorRect={createDropdown.anchor}
          onClose={() => setCreateDropdown(null)}
          onSelect={metadata => {
            setCreateDropdown(null);
            if (createDropdown.wsFilename) {
              actions.handleCreateInWorkspace(createDropdown.wsFilename, createDropdown.containerId ?? null, metadata);
            } else if (metadata) {
              fetch('/api/documents', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ metadata }) }).catch(() => {});
            } else {
              onCreateDocument();
            }
          }}
        />
      )}
    </div>
  );
}
