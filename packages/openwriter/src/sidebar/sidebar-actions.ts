import { useCallback, useRef, useEffect, useState } from 'react';
import type { DocumentInfo, SidebarActions, WorkspaceWithData, WorkspaceNode } from './sidebar-types';

// ---------------------------------------------------------------------------
// Tree helpers for optimistic workspace mutations
// ---------------------------------------------------------------------------

function removeNode(nodes: WorkspaceNode[], predicate: (n: WorkspaceNode) => boolean): WorkspaceNode[] {
  return nodes
    .filter(n => !predicate(n))
    .map(n => n.type === 'container' ? { ...n, items: removeNode(n.items, predicate) } : n);
}

function renameContainerInTree(nodes: WorkspaceNode[], containerId: string, name: string): WorkspaceNode[] {
  return nodes.map(n => {
    if (n.type === 'container' && n.id === containerId) return { ...n, name };
    if (n.type === 'container') return { ...n, items: renameContainerInTree(n.items, containerId, name) };
    return n;
  });
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useSidebarActions(
  fetchDocs: () => void,
  fetchWorkspaces: () => void,
  setDocs: React.Dispatch<React.SetStateAction<DocumentInfo[]>>,
  setWorkspaces: React.Dispatch<React.SetStateAction<WorkspaceWithData[]>>,
  docTagsRefreshKey?: number,
): SidebarActions {

  // ---- Doc-level actions (optimistic via setDocs) ----

  const handleDelete = useCallback((filename: string) => {
    setDocs(prev => prev.filter(d => d.filename !== filename));
    fetch(`/api/documents/${encodeURIComponent(filename)}`, { method: 'DELETE' })
      .catch(() => fetchDocs());
  }, [setDocs, fetchDocs]);

  const handleArchive = useCallback((filename: string) => {
    setDocs(prev => prev.filter(d => d.filename !== filename));
    fetch(`/api/documents/${encodeURIComponent(filename)}/archive`, { method: 'POST' })
      .catch(() => fetchDocs());
  }, [setDocs, fetchDocs]);

  const handleUnarchive = useCallback((filename: string) => {
    setDocs(prev => prev.filter(d => d.filename !== filename));
    fetch(`/api/documents/${encodeURIComponent(filename)}/unarchive`, { method: 'POST' })
      .catch(() => fetchDocs());
  }, [setDocs, fetchDocs]);

  const handleRename = useCallback((filename: string, originalTitle: string, newTitle: string) => {
    if (!newTitle.trim() || newTitle.trim() === originalTitle) return;
    setDocs(prev => prev.map(d => d.filename === filename ? { ...d, title: newTitle.trim() } : d));
    fetch(`/api/documents/${encodeURIComponent(filename)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: newTitle.trim() }),
    }).catch(() => fetchDocs());
  }, [setDocs, fetchDocs]);

  // ---- Workspace-level actions (optimistic via setWorkspaces) ----

  const handleDeleteWorkspace = useCallback((wsFilename: string) => {
    setWorkspaces(prev => prev.filter(w => w.filename !== wsFilename));
    fetch(`/api/workspaces/${encodeURIComponent(wsFilename)}`, { method: 'DELETE' })
      .catch(() => fetchWorkspaces());
  }, [setWorkspaces, fetchWorkspaces]);

  const handleRenameWorkspace = useCallback((wsFilename: string, newTitle: string) => {
    if (!newTitle.trim()) return;
    setWorkspaces(prev => prev.map(w =>
      w.filename === wsFilename ? { ...w, title: newTitle.trim() } : w,
    ));
    fetch(`/api/workspaces/${encodeURIComponent(wsFilename)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: newTitle.trim() }),
    }).catch(() => fetchWorkspaces());
  }, [setWorkspaces, fetchWorkspaces]);

  const handleRemoveFromWorkspace = useCallback((wsFilename: string, docFilename: string) => {
    setWorkspaces(prev => prev.map(w => {
      if (w.filename !== wsFilename || !w.workspace) return w;
      return {
        ...w,
        docCount: Math.max(0, w.docCount - 1),
        workspace: { ...w.workspace, root: removeNode(w.workspace.root, n => n.type === 'doc' && n.file === docFilename) },
      };
    }));
    fetch(`/api/workspaces/${encodeURIComponent(wsFilename)}/docs/${encodeURIComponent(docFilename)}`, {
      method: 'DELETE',
    }).catch(() => fetchWorkspaces());
  }, [setWorkspaces, fetchWorkspaces]);

  const handleDeleteContainer = useCallback((wsFilename: string, containerId: string) => {
    setWorkspaces(prev => prev.map(w => {
      if (w.filename !== wsFilename || !w.workspace) return w;
      return {
        ...w,
        workspace: { ...w.workspace, root: removeNode(w.workspace.root, n => n.type === 'container' && n.id === containerId) },
      };
    }));
    fetch(`/api/workspaces/${encodeURIComponent(wsFilename)}/containers/${encodeURIComponent(containerId)}`, {
      method: 'DELETE',
    }).catch(() => fetchWorkspaces());
  }, [setWorkspaces, fetchWorkspaces]);

  const handleRenameContainer = useCallback((wsFilename: string, containerId: string, newName: string) => {
    if (!newName.trim()) return;
    setWorkspaces(prev => prev.map(w => {
      if (w.filename !== wsFilename || !w.workspace) return w;
      return {
        ...w,
        workspace: { ...w.workspace, root: renameContainerInTree(w.workspace.root, containerId, newName.trim()) },
      };
    }));
    fetch(`/api/workspaces/${encodeURIComponent(wsFilename)}/containers/${encodeURIComponent(containerId)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newName.trim() }),
    }).catch(() => fetchWorkspaces());
  }, [setWorkspaces, fetchWorkspaces]);

  // ---- Create actions (need server-generated IDs — not optimistic) ----

  const handleCreateWorkspace = useCallback(() => {
    fetch('/api/workspaces', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Untitled Workspace' }),
    }).catch(() => {});
  }, []);

  const handleCreateInWorkspace = useCallback((wsFilename: string, containerId: string | null, metadata?: Record<string, any>) => {
    fetch('/api/documents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(metadata ? { metadata } : {}),
    })
      .then((res) => res.json())
      .then((result) => {
        if (result.filename) {
          return fetch(`/api/workspaces/${encodeURIComponent(wsFilename)}/docs`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ file: result.filename, title: result.title || 'Untitled', containerId }),
          });
        }
      })
      .catch(() => {});
  }, []);

  const handleCreateContainer = useCallback((wsFilename: string, parentContainerId: string | null) => {
    fetch(`/api/workspaces/${encodeURIComponent(wsFilename)}/containers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Untitled', parentContainerId }),
    }).catch(() => {});
  }, []);

  // ---- Tags (already optimistic) ----

  const [docTagsCache, setDocTagsCache] = useState<Record<string, string[]>>({});
  const fetchedTagsKey = useRef(-1);

  useEffect(() => {
    if (docTagsRefreshKey === fetchedTagsKey.current) return;
    fetchedTagsKey.current = docTagsRefreshKey ?? 0;
    fetch('/api/documents')
      .then(r => r.json())
      .then((docs: { filename: string }[]) => {
        const cache: Record<string, string[]> = {};
        return Promise.all(
          docs.map(d =>
            fetch(`/api/doc-tags/${encodeURIComponent(d.filename)}`)
              .then(r => r.json())
              .then(data => { if (data.tags?.length) cache[d.filename] = data.tags; })
              .catch(() => {})
          )
        ).then(() => setDocTagsCache(cache));
      })
      .catch(() => {});
  }, [docTagsRefreshKey]);

  const getDocTags = useCallback((docFile: string): string[] => {
    return docTagsCache[docFile] || [];
  }, [docTagsCache]);

  const handleAddTag = useCallback((docFile: string, tag: string) => {
    if (!tag.trim()) return;
    setDocTagsCache(prev => {
      const existing = prev[docFile] || [];
      if (existing.includes(tag.trim())) return prev;
      return { ...prev, [docFile]: [...existing, tag.trim()] };
    });
    fetch(`/api/doc-tags/${encodeURIComponent(docFile)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tag: tag.trim() }),
    }).catch(() => {});
  }, []);

  const handleRemoveTag = useCallback((docFile: string, tag: string) => {
    setDocTagsCache(prev => {
      const existing = prev[docFile] || [];
      const filtered = existing.filter(t => t !== tag);
      if (filtered.length === 0) { const next = { ...prev }; delete next[docFile]; return next; }
      return { ...prev, [docFile]: filtered };
    });
    fetch(`/api/doc-tags/${encodeURIComponent(docFile)}/${encodeURIComponent(tag)}`, {
      method: 'DELETE',
    }).catch(() => {});
  }, []);

  return {
    fetchDocs,
    handleDelete,
    handleArchive,
    handleUnarchive,
    handleRename,
    handleCreateWorkspace,
    handleDeleteWorkspace,
    handleCreateInWorkspace,
    handleRemoveFromWorkspace,
    handleCreateContainer,
    handleDeleteContainer,
    handleRenameContainer,
    handleRenameWorkspace,
    getDocTags,
    handleAddTag,
    handleRemoveTag,
  };
}
