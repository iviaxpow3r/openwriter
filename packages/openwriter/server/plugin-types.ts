/**
 * OpenWriter Plugin API types.
 * Plugins extend the editor with routes, MCP tools, and context menu items.
 */

import type { Router } from 'express';

export type PluginCategory = 'writing' | 'social-media' | 'image-generation' | 'publishing' | 'productivity' | 'analytics';

export interface PluginSidebarMenuItem {
  label: string;
  action: string;  // e.g. 'scheduler:schedule-post'
  pluginDisplayName?: string;
  /** Informational menu rows may be displayed but cannot dispatch an action. */
  disabled?: boolean;
  detail?: string;
  promptForFocus?: boolean;  // If true, show focus instructions modal before dispatching
  folderCapable?: boolean;  // If true, also offered on workspace/container right-click (applied to every doc in the folder)
  /** Which sidebar item owns this action. Folder/workspace actions receive the
   * target itself, so plugins can store configuration there instead of
   * fan-out dispatching one document action for every descendant. */
  target?: 'document' | 'folder' | 'workspace';
  /** Optional explicit submenu label. Ordinary multi-action plugins retain
   * the existing generic Transform submenu. */
  menuGroup?: string;
}

export interface PluginSidebarMenuTarget {
  type: 'document' | 'folder' | 'workspace';
  filename?: string;
  workspaceFile?: string;
  containerId?: string;
}

export interface OpenWriterManifest {
  displayName?: string;
  category?: PluginCategory;
  minVersion?: string;
}

export interface OpenWriterPlugin {
  name: string;
  version: string;
  description?: string;
  category?: PluginCategory;
  configSchema?: Record<string, PluginConfigField>;
  registerRoutes?(ctx: PluginRouteContext): void | Promise<void>;
  /**
   * Dynamic MCP surface. The host context carries namespaced document and
   * workspace storage, so a plugin never needs to reach into OpenWriter's
   * private filesystem layout.
   */
  mcpTools?(ctx: PluginHostContext): PluginMcpTool[];
  contextMenuItems?(): PluginContextMenuItem[];
  /** Contextual sidebar actions. The host is provided so menus can reflect
   * plugin-owned profiles without giving a plugin access to core internals. */
  sidebarMenuItems?(ctx: PluginHostContext): PluginSidebarMenuItem[];
  /** Resolve sidebar menu rows for the exact item being right-clicked. */
  sidebarMenuItemsForTarget?(ctx: PluginHostContext, target: PluginSidebarMenuTarget): PluginSidebarMenuItem[];
  /** Declarative UI supplied by the host; no arbitrary client script needed. */
  uiContributions?(): PluginUiContribution[];
  /** Lightweight sidebar decorations, resolved server-side with the document list. */
  documentBadges?(ctx: PluginHostContext, documents: PluginDocumentSummary[]): PluginDocumentBadge[] | Promise<PluginDocumentBadge[]>;
}

export interface PluginConfigField {
  type: 'string' | 'number' | 'boolean' | 'select';
  required?: boolean;
  env?: string;
  description?: string;
  options?: Array<{ value: string; label: string }>;
}

export interface PluginRouteContext {
  app: Router;
  config: Record<string, string>;
  dataDir: string;
  host: PluginHostContext;
}

/** A deliberately small, portable projection of an OpenWriter document. */
export interface PluginDocumentSummary {
  filename: string;
  title: string;
  docId?: string;
  wordCount: number;
  lastModified: string;
  contentType?: string;
}

/** A deliberately small, portable projection of a workspace. */
export interface PluginWorkspaceSummary {
  filename: string;
  title: string;
  docCount: number;
}

/** A workspace-tree document listing. It intentionally avoids loading each
 * manuscript body, making it safe for plugins that render workspace views. */
export interface PluginWorkspaceDocumentSummary {
  filename: string;
  title: string;
}

/** A container available to a plugin. `path` is display-only and contains the
 * containing workspace hierarchy; plugins never receive raw manifests. */
export interface PluginWorkspaceContainerSummary {
  id: string;
  name: string;
  path: string;
}

/**
 * Stable host services for plugins. `pluginData` is namespaced by the plugin
 * package name and stays with the underlying markdown/workspace JSON, making
 * it portable through filesystem and Git sync without exposing core internals.
 */
export interface PluginHostContext {
  pluginName: string;
  config: Record<string, string>;
  dataDir: string;
  documents: {
    list(): PluginDocumentSummary[];
    readPluginData<T = Record<string, unknown>>(filename: string): T | undefined;
    writePluginData<T = Record<string, unknown>>(filename: string, value: T | null): void;
  };
  workspaces: {
    list(): PluginWorkspaceSummary[];
    listDocuments(workspaceFile: string): PluginWorkspaceDocumentSummary[];
    listContainers(workspaceFile: string): PluginWorkspaceContainerSummary[];
    readPluginData<T = Record<string, unknown>>(workspaceFile: string): T | undefined;
    writePluginData<T = Record<string, unknown>>(workspaceFile: string, value: T | null): void;
    readContainerPluginData<T = Record<string, unknown>>(workspaceFile: string, containerId: string): T | undefined;
    writeContainerPluginData<T = Record<string, unknown>>(workspaceFile: string, containerId: string, value: T | null): void;
    findContainerPathForDocument(workspaceFile: string, filename: string): PluginWorkspaceContainerSummary[];
    findForDocument(filename: string): PluginWorkspaceSummary[];
  };
  /** Structured, plugin-owned global settings (profiles, templates, etc.). */
  settings: {
    readData<T = Record<string, unknown>>(): T | undefined;
    writeData<T = Record<string, unknown>>(value: T | null): void;
  };
  notify: {
    documentsChanged(): void;
    workspacesChanged(): void;
  };
}

export type PluginUiScope = 'document' | 'workspace' | 'settings';

/**
 * A host-rendered view. The endpoint returns a `PluginUiModel`; interaction
 * posts the selected action back to that same endpoint. This preserves a
 * consistent native UI while giving plugins rich, version-stable controls.
 */
export interface PluginUiContribution {
  id: string;
  label: string;
  scope: PluginUiScope;
  endpoint: string;
  icon?: PluginUiIcon;
  order?: number;
  /** For compact editor-status readouts, the owning rail contribution to open
   * when the author activates the readout. The host resolves this within the
   * same plugin namespace, so plugins never need to invent global tab ids. */
  openTabContributionId?: string;
  /** Where this host-rendered view belongs. `rail` adds one explicit right-rail
   * tab; `plugins` nests configuration with the plugin that owns it;
   * `sidebar-layout` adds a selectable document-navigation layout; and
   * `editor-status` places a compact document-derived readout at the lower
   * edge of the writing surface. */
  surface?: 'rail' | 'plugins' | 'sidebar-layout' | 'editor-status';
}

/**
 * `pipeline` is intentionally distinct from `check`: a workflow describes
 * the path a document is on, while Review's checkmark describes an approval
 * action. Keeping both tokens avoids two rail tabs with the same silhouette.
 */
export type PluginUiIcon = 'pipeline' | 'workflow' | 'settings' | 'board' | 'check' | 'sparkle' | 'counter';

export interface PluginDocumentBadge {
  filename: string;
  label: string;
  color?: string;
  tooltip?: string;
  contributionId?: string;
}

export interface PluginUiOption {
  value: string;
  label: string;
  color?: string;
}

export interface PluginUiConfirmation {
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel?: string;
}

export interface PluginUiButton {
  id: string;
  label: string;
  tone?: 'default' | 'primary' | 'danger';
  disabled?: boolean;
  /** Opens a host-rendered inline form. No plugin action is posted until the
   * form's explicit submit control is used. */
  opensForm?: string;
  /** A local, second-step confirmation rendered by the host before this
   * action is posted. Use for destructive or disruptive plugin operations. */
  confirm?: PluginUiConfirmation;
}

export interface PluginUiFormField {
  id: string;
  label: string;
  placeholder?: string;
  help?: string;
  required?: boolean;
}

export interface PluginUiForm {
  id: string;
  title: string;
  detail?: string;
  fields: PluginUiFormField[];
  submit: PluginUiButton;
  cancelLabel?: string;
}

export interface PluginUiKanbanColumn {
  id: string;
  label: string;
  color?: string;
  items: Array<{ id: string; title: string; detail?: string }>;
}

/** A host-computed document counter. The plugin owns where it appears and
 * which labels it gives the feature; the editor owns live document and
 * selection measurements so nothing is persisted or exposed to a plugin. */
export interface PluginUiDocumentMetrics {
  type: 'document-metrics';
  id: string;
  label?: string;
  detail?: string;
  showLines?: boolean;
  showPages?: boolean;
}

/** A compact editor-edge value, derived from the live document by the host. */
export interface PluginUiDocumentStatus {
  type: 'document-status';
  id: string;
  metric: 'words';
  label?: string;
}

/** A collapsible navigation group for a host-rendered board. Groups may nest
 * so a plugin can mirror real workspace structure without owning sidebar UI. */
export interface PluginUiKanbanGroup {
  id: string;
  label: string;
  detail?: string;
  empty?: string;
  columns?: PluginUiKanbanColumn[];
  groups?: PluginUiKanbanGroup[];
}

export type PluginUiBlock =
  | { type: 'heading'; text: string; detail?: string }
  | { type: 'notice'; text: string; tone?: 'neutral' | 'success' | 'warning' }
  | { type: 'text'; id: string; label: string; value: string; placeholder?: string; help?: string }
  | { type: 'select'; id: string; label: string; value: string; options: PluginUiOption[]; help?: string }
  | ({ type: 'button' } & PluginUiButton)
  /** An ordered, editable list. The host owns its familiar stage controls;
   * the plugin receives small semantic actions for rename, movement, add, and removal. */
  | {
    type: 'sequence';
    id: string;
    label: string;
    items: Array<{ id: string; label: string; color?: string; detail?: string; removable?: boolean }>;
    actions: { rename: string; move: string; remove: string; add: string; addLabel?: string; setColor?: string };
    help?: string;
  }
  /** Adjacent related actions, such as creating or deleting the selected profile. */
  | { type: 'buttons'; id: string; buttons: PluginUiButton[] }
  /** A small, local creation/editing form revealed by a button's `opensForm` value. */
  | ({ type: 'form' } & PluginUiForm)
  /** A compact, host-rendered workflow/board. Plugins can opt into semantic
   * movement; the host supplies drag, keyboard, and touch affordances. */
  | {
    type: 'kanban';
    id: string;
    actions?: { move?: string };
    columns: PluginUiKanbanColumn[];
    groups?: PluginUiKanbanGroup[];
  }
  | PluginUiDocumentMetrics
  | PluginUiDocumentStatus;

export interface PluginUiModel {
  title?: string;
  blocks: PluginUiBlock[];
}

export interface PluginMcpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (params: Record<string, unknown>) => Promise<unknown>;
}

export interface PluginContextMenuItem {
  label: string;
  shortcut?: string;
  action: string;
  condition?: 'has-selection' | 'empty-node' | 'always';
  promptForInput?: boolean;
}

export interface PluginActionPayload {
  action: string;
  selectedNodes: any[];
  selectedNodeIds: string[];
  selectedText: string;
  contextBefore: string;
  contextAfter: string;
  instruction?: string;
}

export interface LoadedPlugin {
  plugin: OpenWriterPlugin;
  config: Record<string, string>;
}

export interface PluginLoadResult {
  plugins: LoadedPlugin[];
  errors: string[];
}

