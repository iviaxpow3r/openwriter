/**
 * Local helpers for the github plugin — server-module bridge.
 * Mirrors the lazy-import pattern from plugins/publish/src/helpers.ts.
 */

export interface ServerModules {
  // helpers.js
  getDataDir: () => string;
  readConfig: () => any;
  saveConfig: (patch: Record<string, any>) => void;
  // state.js
  save: () => void;
  cancelDebouncedSave: () => void;
  getDocument: () => any;
  getTitle: () => string;
  getMetadata: () => Record<string, any>;
  getDocId: () => string;
  // ws.js
  broadcastSyncStatus: (status: any) => void;
  // markdown.js
  tiptapToMarkdown: (doc: any, title: string, metadata?: Record<string, any>) => string;
}

// npm package:  dist/plugins/github/dist/helpers.js → ../../../server/
// Monorepo dev: plugins/github/dist/helpers.js     → ../../../packages/openwriter/dist/server/
const npmBase = new URL('../../../server/', import.meta.url).href;
const monoBase = new URL('../../../packages/openwriter/dist/server/', import.meta.url).href;

let _cached: ServerModules | null = null;

async function tryImport(base: string) {
  const [helpers, state, ws, markdown] = await Promise.all([
    import(base + 'helpers.js'),
    import(base + 'state.js'),
    import(base + 'ws.js'),
    import(base + 'markdown.js'),
  ]);
  return { helpers, state, ws, markdown };
}

export async function getServerModules(): Promise<ServerModules> {
  if (_cached) return _cached;
  let helpers, state, ws, markdown;
  try {
    ({ helpers, state, ws, markdown } = await tryImport(npmBase));
  } catch {
    ({ helpers, state, ws, markdown } = await tryImport(monoBase));
  }
  _cached = {
    getDataDir: helpers.getDataDir,
    readConfig: helpers.readConfig,
    saveConfig: helpers.saveConfig,
    save: state.save,
    cancelDebouncedSave: state.cancelDebouncedSave,
    getDocument: state.getDocument,
    getTitle: state.getTitle,
    getMetadata: state.getMetadata,
    getDocId: state.getDocId,
    broadcastSyncStatus: ws.broadcastSyncStatus,
    tiptapToMarkdown: markdown.tiptapToMarkdown,
  };
  return _cached;
}

// Plugin API types
export interface PluginConfigField {
  type: 'string' | 'number' | 'boolean';
  required?: boolean;
  env?: string;
  description?: string;
}

export interface PluginRouteContext {
  app: import('express').Router;
  config: Record<string, string>;
  dataDir: string;
}

export interface PluginMcpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (params: Record<string, unknown>) => Promise<unknown>;
}

export interface OpenWriterPlugin {
  name: string;
  version: string;
  description?: string;
  category?: 'writing' | 'social-media' | 'image-generation' | 'publishing' | 'productivity' | 'analytics';
  configSchema?: Record<string, PluginConfigField>;
  registerRoutes?(ctx: PluginRouteContext): void | Promise<void>;
  mcpTools?(config: Record<string, string>): PluginMcpTool[];
}

// ---- Blog site persistence ----

export interface BlogSite {
  id: string;
  label: string;
  owner: string;
  repo: string;
  branch: string;
  content_dir: string;
  image_dir: string;
  image_public_prefix: string;
  framework: 'astro' | 'next' | 'jekyll' | 'hugo' | 'unknown';
}

const PLUGIN_NAME = '@openwriter/plugin-github';

export async function listBlogSites(): Promise<BlogSite[]> {
  const srv = await getServerModules();
  const cfg = srv.readConfig() || {};
  const slot = cfg.plugins?.[PLUGIN_NAME];
  return (slot?.blogSites as BlogSite[]) || [];
}

export async function writeBlogSites(sites: BlogSite[]): Promise<void> {
  const srv = await getServerModules();
  const cfg = srv.readConfig() || {};
  const plugins = { ...(cfg.plugins || {}) };
  const slot = { ...(plugins[PLUGIN_NAME] || { enabled: true, config: {} }) };
  slot.blogSites = sites;
  plugins[PLUGIN_NAME] = slot;
  srv.saveConfig({ plugins });
}
