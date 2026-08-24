/**
 * OpenWriter Plugin API types.
 * Plugins extend the editor with routes, MCP tools, and context menu items.
 */

import type { Router } from 'express';

export type PluginCategory = 'writing' | 'social-media' | 'image-generation' | 'publishing' | 'productivity' | 'analytics';

export interface PluginSidebarMenuItem {
  label: string;
  action: string;  // e.g. 'scheduler:schedule-post'
  promptForFocus?: boolean;  // If true, show focus instructions modal before dispatching
  folderCapable?: boolean;  // If true, also offered on workspace/container right-click (applied to every doc in the folder)
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
  sidebarMenuItems?(): PluginSidebarMenuItem[];
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
    readPluginData<T = Record<string, unknown>>(workspaceFile: string): T | undefined;
    writePluginData<T = Record<string, unknown>>(workspaceFile: string, value: T | null): void;
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
}

export type PluginUiIcon = 'workflow' | 'settings' | 'board' | 'check' | 'sparkle';

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

export type PluginUiBlock =
  | { type: 'heading'; text: string; detail?: string }
  | { type: 'notice'; text: string; tone?: 'neutral' | 'success' | 'warning' }
  | { type: 'text'; id: string; label: string; value: string; placeholder?: string; help?: string }
  | { type: 'select'; id: string; label: string; value: string; options: PluginUiOption[]; help?: string }
  | { type: 'button'; id: string; label: string; tone?: 'default' | 'primary' | 'danger'; disabled?: boolean }
  | { type: 'kanban'; id: string; columns: Array<{ id: string; label: string; color?: string; items: Array<{ id: string; title: string; detail?: string }> }> };

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

