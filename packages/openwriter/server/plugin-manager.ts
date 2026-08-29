/**
 * Plugin Manager: dynamic enable/disable, config persistence, route management.
 * Replaces the one-shot loadPlugins() with a full lifecycle manager.
 */

import type { Express, Router, Request, Response, NextFunction } from 'express';
import { Router as createRouter } from 'express';
import { discoverPlugins, loadPluginModule, type DiscoveredPlugin } from './plugin-discovery.js';
import { registerPluginTools, removePluginTools } from './mcp.js';
import { readConfig, saveConfig, getDataDir, readProfilePluginData, writeProfilePluginData } from './helpers.js';
import { listDocuments, getDocumentPluginData, setDocumentPluginData } from './documents.js';
import { listWorkspaces, listWorkspaceDocuments, listWorkspaceContainers, getWorkspacePluginData, setWorkspacePluginData, getContainerPluginData, setContainerPluginData, getContainerPathForDocument, findWorkspacesContainingDoc } from './workspaces.js';
import type { OpenWriterPlugin, PluginConfigField, PluginContextMenuItem, PluginSidebarMenuItem, PluginSidebarMenuTarget, PluginDocumentBadge, PluginDocumentSummary, PluginHostContext, PluginUiContribution } from './plugin-types.js';
import { broadcastDocumentsChanged, broadcastPluginsChanged, broadcastWorkspacesChanged } from './ws.js';
import { isAllowedPublishApiUrl } from './connections.js';

// MCP-2: plugin config holds raw secrets (publish ow_live_ key, X OAuth1
// tokens, GitHub PAT, Gemini key). These must never cross the HTTP API. We
// redact any config value whose KEY names a secret before it leaves the
// server. Returned in place of the value is a sentinel that the settings UI
// renders as "set"; updateConfig() treats an echoed sentinel as "unchanged"
// so a naive save round-trip can never clobber the real secret with the mask.
const SECRET_KEY_RE = /(key|secret|token|pat|password|auth|credential|bearer)/i;
const REDACTED_SECRET = '__OW_SECRET_REDACTED__';

/** Mask secret-valued config fields for safe transport over the API. */
function redactConfig(config: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(config)) {
    out[k] = SECRET_KEY_RE.test(k) && v ? REDACTED_SECRET : v;
  }
  return out;
}

interface ManagedPlugin {
  discovered: DiscoveredPlugin;
  plugin?: OpenWriterPlugin;
  configSchema: Record<string, PluginConfigField>;
  enabled: boolean;
  config: Record<string, string>;
  /** Middleware wrapper — skips routing when disabled */
  middleware?: (req: Request, res: Response, next: NextFunction) => void;
  /** Router holding plugin routes */
  router?: Router;
  /** Names of MCP tools registered by this plugin */
  toolNames: string[];
}

export class PluginManager {
  private app: Express;
  private plugins = new Map<string, ManagedPlugin>();

  constructor(app: Express) {
    this.app = app;
  }

  /** Scan plugins/ directory and build the available plugins map. */
  async discover(): Promise<void> {
    const discovered = discoverPlugins();
    const savedConfig = readConfig();
    const savedPlugins = savedConfig.plugins || {};

    for (const d of discovered) {
      // Load module to get configSchema
      const loaded = await loadPluginModule(d.name, d.source, d.pluginDir);

      const saved = savedPlugins[d.name];

      this.plugins.set(d.name, {
        discovered: d,
        plugin: loaded?.plugin,
        configSchema: loaded?.configSchema || {},
        enabled: false,
        config: saved?.config || {},
        toolNames: [],
      });
    }
  }

  /** Enable a plugin: import, register routes + tools, save state. */
  async enable(name: string): Promise<{ success: boolean; error?: string }> {
    const managed = this.plugins.get(name);
    if (!managed) return { success: false, error: `Plugin "${name}" not found` };
    if (managed.enabled) return { success: true };

    // Ensure plugin module is loaded
    if (!managed.plugin) {
      const loaded = await loadPluginModule(name, managed.discovered.source, managed.discovered.pluginDir);
      if (!loaded) return { success: false, error: `Failed to import "${name}"` };
      managed.plugin = loaded.plugin;
      managed.configSchema = loaded.configSchema;
    }

    if (!managed.plugin) return { success: false, error: `Plugin "${name}" failed to load` };
    const plugin = managed.plugin;

    // Resolve config: saved config → env vars → empty
    const resolvedConfig = this.resolveConfig(managed);

    const host = this.createHostContext(plugin.name, resolvedConfig);

    // Register routes via togglable middleware
    if (plugin.registerRoutes) {
      const router = createRouter();
      await plugin.registerRoutes({ app: router, config: resolvedConfig, dataDir: getDataDir(), host });
      managed.router = router;

      // Wrap in middleware that skips when disabled
      managed.middleware = (req: Request, res: Response, next: NextFunction) => {
        if (!managed.enabled) return next();
        managed.router!(req, res, next);
      };

      this.app.use(managed.middleware);
    }

    // Register MCP tools
    if (plugin.mcpTools) {
      const tools = plugin.mcpTools(host);
      managed.toolNames = tools.map((t) => t.name);
      registerPluginTools(tools);
    }

    managed.enabled = true;
    managed.config = resolvedConfig;
    this.savePluginState();
    broadcastPluginsChanged();

    console.log(`[PluginManager] Enabled: ${plugin.name} v${plugin.version}`);
    return { success: true };
  }

  /** Disable a plugin: skip routes, remove tools, save state. */
  async disable(name: string): Promise<{ success: boolean; error?: string }> {
    const managed = this.plugins.get(name);
    if (!managed) return { success: false, error: `Plugin "${name}" not found` };
    if (!managed.enabled) return { success: true };

    // Remove MCP tools
    if (managed.toolNames.length > 0) {
      removePluginTools(managed.toolNames);
      managed.toolNames = [];
    }

    managed.enabled = false;
    this.savePluginState();
    broadcastPluginsChanged();

    console.log(`[PluginManager] Disabled: ${name}`);
    return { success: true };
  }

  /** Update plugin config values and save. */
  updateConfig(name: string, values: Record<string, string>): { success: boolean; error?: string } {
    const managed = this.plugins.get(name);
    if (!managed) return { success: false, error: `Plugin "${name}" not found` };

    // Drop echoed redaction sentinels — the API never hands out real secrets
    // (see redactConfig), so a value equal to the sentinel means "unchanged".
    // Keeping the spread merge then preserves the stored secret. MCP-2.
    const incoming: Record<string, string> = {};
    for (const [k, v] of Object.entries(values)) {
      if (v === REDACTED_SECRET) continue;
      incoming[k] = v;
    }

    // MCP-6: a hijacked publish `api-url` redirects the Bearer key off-host.
    // Reject writes that point it anywhere but an allowed destination. The
    // load-bearing pin lives in connections.ts; this rejects bad writes early.
    if (typeof incoming['api-url'] === 'string' && incoming['api-url'] && !isAllowedPublishApiUrl(incoming['api-url'])) {
      return { success: false, error: 'Invalid api-url: must point to an OpenWriter publish host' };
    }

    managed.config = { ...managed.config, ...incoming };
    this.savePluginState();
    return { success: true };
  }

  /** Get all discovered plugins with status and config info. */
  getAvailablePlugins(): Array<{
    name: string;
    version: string;
    description: string;
    enabled: boolean;
    configSchema: Record<string, PluginConfigField>;
    config: Record<string, string>;
    source: 'bundled' | 'user';
    displayName?: string;
    category?: string;
  }> {
    return Array.from(this.plugins.values()).map((m) => ({
      name: m.discovered.name,
      version: m.discovered.version,
      description: m.discovered.description,
      enabled: m.enabled,
      configSchema: m.configSchema,
      config: redactConfig(m.config),  // MCP-2: never leak raw secrets over the API
      source: m.discovered.source,
      displayName: m.discovered.displayName,
      category: m.discovered.category,
    }));
  }

  /** Get enabled plugins' context menu items and sidebar menu items. */
  getEnabledPluginDescriptors(): Array<{
    name: string;
    displayName?: string;
    contextMenuItems: PluginContextMenuItem[];
    sidebarMenuItems: PluginSidebarMenuItem[];
    uiContributions: PluginUiContribution[];
  }> {
    const results: Array<{
      name: string;
      displayName?: string;
      contextMenuItems: PluginContextMenuItem[];
      sidebarMenuItems: PluginSidebarMenuItem[];
      uiContributions: PluginUiContribution[];
    }> = [];
    for (const managed of this.plugins.values()) {
      if (!managed.enabled || !managed.plugin) continue;
      results.push({
        name: managed.plugin.name,
        displayName: managed.discovered.displayName,
        contextMenuItems: managed.plugin.contextMenuItems?.() || [],
        sidebarMenuItems: managed.plugin.sidebarMenuItems?.(this.createHostContext(managed.plugin.name, managed.config)) || [],
        uiContributions: managed.plugin.uiContributions?.() || [],
      });
    }
    return results;
  }

  /** Resolve context-menu rows for the actual sidebar item. This lets a plugin
   * show inherited state without forcing the UI to understand plugin storage. */
  getSidebarMenuItemsForTarget(target: PluginSidebarMenuTarget): PluginSidebarMenuItem[] {
    const items: PluginSidebarMenuItem[] = [];
    for (const managed of this.plugins.values()) {
      if (!managed.enabled || !managed.plugin) continue;
      const host = this.createHostContext(managed.plugin.name, managed.config);
      const resolved = managed.plugin.sidebarMenuItemsForTarget?.(host, target)
        || managed.plugin.sidebarMenuItems?.(host)
        || [];
      for (const item of resolved) {
        if (item.target && item.target !== target.type) continue;
        items.push({ ...item, pluginDisplayName: managed.discovered.displayName });
      }
    }
    return items;
  }

  /** Declarative UI views from enabled plugins, ordered within their scope. */
  getUiContributions(): Array<PluginUiContribution & { pluginName: string; displayName?: string }> {
    const contributions: Array<PluginUiContribution & { pluginName: string; displayName?: string }> = [];
    for (const managed of this.plugins.values()) {
      if (!managed.enabled || !managed.plugin) continue;
      for (const contribution of managed.plugin.uiContributions?.() || []) {
        contributions.push({ ...contribution, surface: contribution.surface || 'rail', pluginName: managed.plugin.name, displayName: managed.discovered.displayName });
      }
    }
    return contributions.sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.label.localeCompare(b.label));
  }

  /** Resolve safe, lightweight sidebar badges without leaking plugin storage. */
  async getDocumentBadges(documents: PluginDocumentSummary[]): Promise<Record<string, PluginDocumentBadge[]>> {
    const result: Record<string, PluginDocumentBadge[]> = {};
    for (const managed of this.plugins.values()) {
      if (!managed.enabled || !managed.plugin?.documentBadges) continue;
      try {
        const badges = await managed.plugin.documentBadges(this.createHostContext(managed.plugin.name, managed.config), documents);
        for (const badge of badges) {
          if (!documents.some((doc) => doc.filename === badge.filename)) continue;
          (result[badge.filename] ||= []).push(badge);
        }
      } catch (err: any) {
        console.error(`[PluginManager] ${managed.plugin.name} document badges failed:`, err?.message ?? err);
      }
    }
    return result;
  }

  /** Resolve config values: saved config → env vars → empty. */
  private resolveConfig(managed: ManagedPlugin): Record<string, string> {
    const resolved: Record<string, string> = { ...managed.config };

    for (const [key, field] of Object.entries(managed.configSchema)) {
      if (resolved[key]) continue;
      const envVal = field.env ? process.env[field.env] : undefined;
      if (envVal) resolved[key] = envVal;
    }

    return resolved;
  }

  /**
   * The boundary between plugins and OpenWriter internals. It deliberately
  * exposes only portable data primitives, not raw paths or mutable manifests.
  */
  private createHostContext(pluginName: string, config: Record<string, string>): PluginHostContext {
    let knownDocumentFilenames: Set<string> | null = null;
    const refreshKnownDocuments = () => {
      knownDocumentFilenames = new Set(listDocuments().map((doc) => doc.filename));
      return knownDocumentFilenames;
    };
    const ensureKnownDocument = (filename: string) => {
      const known = knownDocumentFilenames || refreshKnownDocuments();
      if (known.has(filename)) return;
      // A document may have been created after this host was initialized.
      // Refresh only on a cache miss, rather than reparsing every document for
      // each read of plugin metadata in a workspace-sized board.
      if (refreshKnownDocuments().has(filename)) return;
      throw new Error(`Document is not available to this profile: ${filename}`);
    };

    return {
      pluginName,
      config,
      dataDir: getDataDir(),
      documents: {
        list: () => {
          const documents = listDocuments();
          knownDocumentFilenames = new Set(documents.map((doc) => doc.filename));
          return documents.map((doc) => ({
            filename: doc.filename,
            title: doc.title,
            docId: doc.docId,
            wordCount: doc.wordCount,
            lastModified: doc.lastModified,
            contentType: doc.contentType,
          }));
        },
        readPluginData: <T = Record<string, unknown>>(filename: string) => {
          ensureKnownDocument(filename);
          return getDocumentPluginData<T>(filename, pluginName);
        },
        writePluginData: <T = Record<string, unknown>>(filename: string, value: T | null) => {
          ensureKnownDocument(filename);
          setDocumentPluginData(filename, pluginName, value);
        },
      },
      workspaces: {
        list: () => listWorkspaces().map((workspace) => ({ ...workspace })),
        listDocuments: (workspaceFile: string) => listWorkspaceDocuments(workspaceFile).map((document) => ({ ...document })),
        listContainers: (workspaceFile: string) => listWorkspaceContainers(workspaceFile).map((container) => ({ ...container })),
        readPluginData: <T = Record<string, unknown>>(workspaceFile: string) => getWorkspacePluginData<T>(workspaceFile, pluginName),
        writePluginData: <T = Record<string, unknown>>(workspaceFile: string, value: T | null) => {
          setWorkspacePluginData(workspaceFile, pluginName, value);
        },
        readContainerPluginData: <T = Record<string, unknown>>(workspaceFile: string, containerId: string) => getContainerPluginData<T>(workspaceFile, containerId, pluginName),
        writeContainerPluginData: <T = Record<string, unknown>>(workspaceFile: string, containerId: string, value: T | null) => {
          setContainerPluginData(workspaceFile, containerId, pluginName, value);
        },
        findContainerPathForDocument: (workspaceFile: string, filename: string) => getContainerPathForDocument(workspaceFile, filename).map((container) => ({ ...container })),
        findForDocument: (filename: string) => findWorkspacesContainingDoc(filename).map((workspace) => ({ ...workspace })),
      },
      settings: {
        readData: <T = Record<string, unknown>>() => readProfilePluginData<T>(pluginName),
        writeData: <T = Record<string, unknown>>(value: T | null) => {
          writeProfilePluginData(pluginName, value);
          broadcastPluginsChanged();
        },
      },
      notify: {
        documentsChanged: () => broadcastDocumentsChanged(),
        workspacesChanged: () => broadcastWorkspacesChanged(),
      },
    };
  }

  /**
   * Persist enabled/config state to ~/.openwriter/config.json.
   *
   * IMPORTANT: plugins can store arbitrary nested data on their own slot
   * (e.g. the github plugin stores `blogSites: [...]`). This writer
   * preserves any such keys by merging into the existing on-disk slot
   * rather than rebuilding the slot from scratch. Without this preserve
   * step, every plugin enable/disable/config edit would silently drop
   * blogSites and any other plugin-owned data.
   *
   * adr: adr/plugin-slot-nested-data.md
   */
  private savePluginState(): void {
    const current = readConfig();
    const existing = (current.plugins || {}) as unknown as Record<string, Record<string, unknown>>;
    const pluginsState: Record<string, Record<string, unknown>> = { ...existing };

    for (const [name, managed] of this.plugins) {
      const prior = (existing[name] || {}) as Record<string, unknown>;
      // A plugin that never loaded (plugin===undefined: bundled dist missing in
      // an unbuilt worktree, transient import failure, etc.) sits in the map with
      // the default enabled===false. Persisting that false would clobber the
      // user's real on-disk intent and STICK — the plugin would stay off on every
      // future boot even after the load problem is fixed, because startup only
      // re-enables plugins marked true. PluginManager owns `enabled` only for
      // plugins it actually loaded; for unloaded ones, preserve the on-disk value.
      // (A user-disabled plugin keeps plugin set — disable() never clears it — so
      // a deliberate false still persists correctly.)
      const enabled = managed.plugin ? managed.enabled : (prior.enabled ?? managed.enabled);
      pluginsState[name] = {
        ...prior,                 // preserve blogSites + any other plugin-owned data
        enabled,                  // overwrite managed fields (only when actually loaded)
        config: managed.config,
      };
    }

    saveConfig({ plugins: pluginsState } as any);
  }
}
