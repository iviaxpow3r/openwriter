import type { PendingDocsPayload } from '../ws/client';

export type ContentType = 'document' | 'tweet' | 'reply' | 'quote' | 'article' | 'linkedin' | 'newsletter' | 'blog';

export interface DocumentInfo {
  filename: string;
  title: string;
  lastModified: string;
  wordCount: number;
  isActive: boolean;
  archivedAt?: string;
  lastSent?: string;
  postedUrl?: string;
  docId?: string;
  isNewsletter?: boolean;
  contentType?: ContentType;
  masterDocId?: string;
  variantType?: string;
  autoAccept?: boolean;
}

// V2 types matching server workspace-types.ts
export interface DocItem { type: 'doc'; file: string; title: string; children?: ContainerItem[] }
export interface ContainerItem { type: 'container'; id: string; name: string; items: WorkspaceNode[] }
export type WorkspaceNode = DocItem | ContainerItem;

export interface WorkspaceInfo { filename: string; title: string; docCount: number }
export interface WorkspaceFull {
  version: 2;
  title: string;
  root: WorkspaceNode[];
  context?: any;
}

export type WorkspaceWithData = WorkspaceInfo & { workspace?: WorkspaceFull };

export type DraggedItem =
  | { type: 'doc'; file: string; sourceWs: string | null }
  | { type: 'container'; id: string; sourceWs: string }
  | { type: 'workspace'; filename: string }
  | null;

export interface DropIndicator {
  itemId: string;
  position: 'before' | 'after' | 'inside';
  wsFilename: string | null;
  containerId: string | null;
  afterId: string | null;
}

export interface SearchResult {
  filename: string;
  title: string;
  lastModified: string;
  wordCount: number;
  isActive: boolean;
  matchType: 'title' | 'tag' | 'content';
  snippet: string | null;
  matchedTag: string | null;
  isArchived?: boolean;
}

export interface SidebarModeProps {
  docs: DocumentInfo[];
  archivedDocs: DocumentInfo[];
  workspaces: WorkspaceWithData[];
  assignedFiles: Set<string>;
  pendingDocs: PendingDocsPayload;
  onSwitchDocument: (filename: string) => void;
  onCreateDocument: () => void;
  actions: SidebarActions;
  scrollRef: React.RefObject<HTMLDivElement>;
  writingTitle?: string | null;
  writingTarget?: { wsFilename: string; containerId: string | null; parentDocId?: string } | null;
  /** Filenames of all pending writes on the server — sidebar hides matching real entries */
  pendingWriteFilenames?: Set<string>;
  searchQuery: string;
  searchResults: SearchResult[] | null;
  onSearchChange: (query: string) => void;
}

export interface SidebarActions {
  fetchDocs: () => void;
  handleDelete: (filename: string) => void;
  handleArchive: (filename: string) => void;
  handleUnarchive: (filename: string) => void;
  handleRename: (filename: string, originalTitle: string, newTitle: string) => void;
  handleCreateWorkspace: () => void;
  handleDeleteWorkspace: (wsFilename: string) => void;
  handleCreateInWorkspace: (wsFilename: string, containerId: string | null, metadata?: Record<string, any>) => void;
  handleRemoveFromWorkspace: (wsFilename: string, docFilename: string) => void;
  handleCreateContainer: (wsFilename: string, parentContainerId: string | null) => void;
  handleDeleteContainer: (wsFilename: string, containerId: string, cascade?: boolean) => void;
  handleRenameContainer: (wsFilename: string, containerId: string, newName: string) => void;
  handleRenameWorkspace: (wsFilename: string, newTitle: string) => void;
  getDocTags: (docFile: string) => string[];
  handleAddTag: (docFile: string, tag: string) => void;
  handleRemoveTag: (docFile: string, tag: string) => void;
}
