import type { WorkspaceNode, WorkspaceWithData } from './sidebar-types';

export function nodeId(node: WorkspaceNode): string {
  return node.type === 'doc' ? node.file : node.id;
}

export function collectFiles(nodes: WorkspaceNode[], out: Set<string>): void {
  for (const node of nodes) {
    if (node.type === 'doc') out.add(node.file);
    else if (node.type === 'container') collectFiles(node.items, out);
  }
}

function walkForDocInheritance(nodes: WorkspaceNode[], filename: string, wsOn: boolean, containerOn: boolean): boolean | null {
  for (const n of nodes) {
    if (n.type === 'doc' && n.file === filename) return wsOn || containerOn;
    if (n.type === 'container') {
      const own = (n as any).autoAccept === true;
      const result = walkForDocInheritance(n.items, filename, wsOn, containerOn || own);
      if (result !== null) return result;
    }
  }
  return null;
}

/** Mirror of server's isAutoAcceptInheritedForDoc — walks every workspace and
 *  returns true if the doc lives under a workspace or ancestor container with
 *  autoAccept on. The doc's own frontmatter flag is NOT consulted here. */
export function isAutoAcceptInheritedForDoc(workspaces: WorkspaceWithData[], filename: string): boolean {
  for (const w of workspaces) {
    const ws = w.workspace;
    if (!ws) continue;
    const wsOn = (ws as any).autoAccept === true;
    const result = walkForDocInheritance(ws.root, filename, wsOn, false);
    if (result === true) return true;
    // result === false means the doc lives here without inheritance;
    // keep scanning since a doc can theoretically appear in multiple manifests.
  }
  return false;
}

function walkForDocSortInheritance(nodes: WorkspaceNode[], filename: string, wsOn: boolean, containerOn: boolean): boolean | null {
  for (const n of nodes) {
    if (n.type === 'doc' && n.file === filename) return wsOn || containerOn;
    if (n.type === 'container') {
      const own = (n as any).autoSort === true;
      const result = walkForDocSortInheritance(n.items, filename, wsOn, containerOn || own);
      if (result !== null) return result;
    }
  }
  return null;
}

/** Mirror of server's isAutoSortInheritedForDoc. Used by the sidebar to decide
 *  whether a doc's effective sort mode is "auto" (no proposal step) or
 *  "confirm" (write proposal, wait for human accept) when the per-doc
 *  preference is unset. */
export function isAutoSortInheritedForDoc(workspaces: WorkspaceWithData[], filename: string): boolean {
  for (const w of workspaces) {
    const ws = w.workspace;
    if (!ws) continue;
    const wsOn = (ws as any).autoSort === true;
    const result = walkForDocSortInheritance(ws.root, filename, wsOn, false);
    if (result === true) return true;
  }
  return false;
}

export function formatDate(iso: string): string {
  const d = new Date(iso);
  const diff = Date.now() - d.getTime();
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  if (diff < 604800000) return `${Math.floor(diff / 86400000)}d ago`;
  return d.toLocaleDateString();
}

export function isExternal(filename: string): boolean {
  return /^[A-Z]:[/\\]|^\//.test(filename);
}

export function parentDir(filename: string): string {
  const parts = filename.replace(/\\/g, '/').split('/');
  return parts.length >= 2 ? parts[parts.length - 2] : '';
}

/** Get the date group label for a given ISO date string. */
export function dateGroup(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today.getTime() - 86400000);
  const docDay = new Date(d.getFullYear(), d.getMonth(), d.getDate());

  if (docDay.getTime() === today.getTime()) return 'Today';
  if (docDay.getTime() === yesterday.getTime()) return 'Yesterday';
  if (now.getTime() - docDay.getTime() < 604800000) {
    return d.toLocaleDateString(undefined, { weekday: 'long' });
  }
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

