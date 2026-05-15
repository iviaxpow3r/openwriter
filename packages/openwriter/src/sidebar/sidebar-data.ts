import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DocumentInfo, WorkspaceWithData, WorkspaceInfo, WorkspaceFull } from './sidebar-types';
import { collectFiles } from './sidebar-utils';

export function useSidebarData(refreshKey: number, workspacesRefreshKey: number) {
  const [docs, setDocs] = useState<DocumentInfo[]>([]);
  const [workspaces, setWorkspaces] = useState<WorkspaceWithData[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Filenames the user has optimistically deleted but the server may not yet
  // have processed. fetchDocs filters its result through this set so bulk-delete
  // broadcasts don't cause docs to flicker back in. Self-heals: when the server
  // confirms a doc is gone, its entry here clears.
  const pendingDeletesRef = useRef<Set<string>>(new Set());
  const markPendingDelete = useCallback((filename: string) => {
    pendingDeletesRef.current.add(filename);
  }, []);

  // Derived from workspaces — stays in sync with optimistic updates automatically
  const assignedFiles = useMemo(() => {
    const assigned = new Set<string>();
    for (const w of workspaces) {
      if (w.workspace) collectFiles(w.workspace.root, assigned);
    }
    return assigned;
  }, [workspaces]);

  const fetchDocs = useCallback(() => {
    fetch('/api/documents')
      .then((res) => res.json())
      .then((data) => {
        if (!Array.isArray(data)) return;
        const pending = pendingDeletesRef.current;
        // Self-heal: any pending entry NOT in the fresh response is confirmed gone
        if (pending.size > 0) {
          const fresh = new Set(data.map((d: DocumentInfo) => d.filename));
          for (const fn of [...pending]) if (!fresh.has(fn)) pending.delete(fn);
        }
        // Filter: hide docs the user has optimistically deleted but server still has on disk
        const filtered = pending.size > 0
          ? data.filter((d: DocumentInfo) => !pending.has(d.filename))
          : data;
        setDocs(filtered);
      })
      .catch(() => {});
  }, []);

  const fetchWorkspaces = useCallback(() => {
    fetch('/api/workspaces')
      .then((res) => res.json())
      .then(async (wsList: WorkspaceInfo[]) => {
        if (!Array.isArray(wsList)) return;
        const detailed = await Promise.all(wsList.map(async (w) => {
          try {
            const res = await fetch(`/api/workspaces/${encodeURIComponent(w.filename)}`);
            const workspace: WorkspaceFull = await res.json();
            return { ...w, workspace } as WorkspaceWithData;
          } catch { return w as WorkspaceWithData; }
        }));
        setWorkspaces(detailed);
      })
      .catch(() => {});
  }, []);

  useEffect(() => { fetchDocs(); }, [fetchDocs, refreshKey]);
  useEffect(() => { fetchWorkspaces(); }, [fetchWorkspaces, workspacesRefreshKey]);

  // Scroll active doc into view after docs list re-renders
  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      const activeItem = scrollRef.current?.querySelector('.sidebar-item.active');
      activeItem?.scrollIntoView({ block: 'nearest', behavior: 'instant' });
    });
    return () => cancelAnimationFrame(raf);
  }, [docs]);

  return { docs, setDocs, workspaces, setWorkspaces, assignedFiles, fetchDocs, fetchWorkspaces, scrollRef, markPendingDelete };
}
