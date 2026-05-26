/**
 * Local helpers for the github plugin — server-module bridge.
 * Mirrors the lazy-import pattern from plugins/publish/src/helpers.ts.
 *
 * Plugins live outside the server bundle, so they cannot import server
 * internals statically. We resolve them at runtime from the running
 * package's dist/ tree (works for both monorepo dev and npm install layout).
 */

export interface ServerModules {
  // helpers.js
  getDataDir: () => string;
  readConfig: () => any;
  saveConfig: (patch: Record<string, any>) => void;
  // state.js
  save: () => void;
  cancelDebouncedSave: () => void;
  // ws.js
  broadcastSyncStatus: (status: any) => void;
}

// npm package:  dist/plugins/github/dist/helpers.js → ../../../server/
// Monorepo dev: plugins/github/dist/helpers.js     → ../../../packages/openwriter/dist/server/
const npmBase = new URL('../../../server/', import.meta.url).href;
const monoBase = new URL('../../../packages/openwriter/dist/server/', import.meta.url).href;

let _cached: ServerModules | null = null;

async function tryImport(base: string) {
  const [helpers, state, ws] = await Promise.all([
    import(base + 'helpers.js'),
    import(base + 'state.js'),
    import(base + 'ws.js'),
  ]);
  return { helpers, state, ws };
}

export async function getServerModules(): Promise<ServerModules> {
  if (_cached) return _cached;
  let helpers, state, ws;
  try {
    ({ helpers, state, ws } = await tryImport(npmBase));
  } catch {
    ({ helpers, state, ws } = await tryImport(monoBase));
  }
  _cached = {
    getDataDir: helpers.getDataDir,
    readConfig: helpers.readConfig,
    saveConfig: helpers.saveConfig,
    save: state.save,
    cancelDebouncedSave: state.cancelDebouncedSave,
    broadcastSyncStatus: ws.broadcastSyncStatus,
  };
  return _cached;
}

// Plugin API types (re-declared locally — plugins are independent packages)
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

export interface OpenWriterPlugin {
  name: string;
  version: string;
  description?: string;
  category?: 'writing' | 'social-media' | 'image-generation' | 'publishing' | 'productivity' | 'analytics';
  configSchema?: Record<string, PluginConfigField>;
  registerRoutes?(ctx: PluginRouteContext): void | Promise<void>;
}
