/**
 * Plugin discovery: scans bundled plugins/ directory and user ~/.openwriter/plugins/
 * for available plugins. Reads package.json metadata without importing plugin code.
 */

import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { dirname } from 'path';
import { homedir } from 'os';
import { createRequire } from 'module';
import type { PluginCategory, PluginConfigField } from './plugin-types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const USER_PLUGINS_DIR = join(homedir(), '.openwriter', 'plugins');

export interface DiscoveredPlugin {
  /** npm package name (e.g. "@openwriter/plugin-authors-voice") */
  name: string;
  /** Directory name in plugins/ (e.g. "authors-voice") */
  dirName: string;
  version: string;
  description: string;
  /** Where this plugin was found */
  source: 'bundled' | 'user';
  /** Display name from openwriter manifest */
  displayName?: string;
  /** Category from openwriter manifest */
  category?: PluginCategory;
  /** Absolute path to the plugin directory (for path-based imports) */
  pluginDir: string;
}

/**
 * Scan for bundled plugins. Checks two locations:
 * 1. dist/plugins/ — plugins copied into the npm package at publish time
 * 2. monorepo root plugins/ — local dev with workspace symlinks
 */
function discoverBundledPlugins(): DiscoveredPlugin[] {
  // 1. Monorepo root: dist/server/ → ../../../../plugins/ (live dev code)
  const monoPluginsDir = join(__dirname, '..', '..', '..', '..', 'plugins');
  // 2. Bundled in dist: dist/server/ → ../plugins/ (npm install)
  const distPluginsDir = join(__dirname, '..', 'plugins');

  // Prefer monorepo path in dev (live code), fall back to bundled copy in npm install
  const pluginsDir = existsSync(monoPluginsDir) ? monoPluginsDir : distPluginsDir;
  if (!existsSync(pluginsDir)) return [];

  const results: DiscoveredPlugin[] = [];

  for (const entry of readdirSync(pluginsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;

    const pluginDir = join(pluginsDir, entry.name);
    const pkgPath = join(pluginDir, 'package.json');
    if (!existsSync(pkgPath)) continue;

    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      if (!pkg.name) continue;

      const manifest = pkg.openwriter as { displayName?: string; category?: PluginCategory } | undefined;

      results.push({
        name: pkg.name,
        dirName: entry.name,
        version: pkg.version || '0.0.0',
        description: pkg.description || '',
        source: 'bundled',
        displayName: manifest?.displayName,
        category: manifest?.category,
        pluginDir,
      });
    } catch {
      // Skip malformed package.json
    }
  }

  return results;
}

/**
 * Scan ~/.openwriter/plugins/node_modules/ for user-installed plugins.
 * Matches packages with `openwriter` field in package.json or matching naming conventions.
 */
function discoverUserPlugins(): DiscoveredPlugin[] {
  const nodeModules = join(USER_PLUGINS_DIR, 'node_modules');
  if (!existsSync(nodeModules)) return [];

  const results: DiscoveredPlugin[] = [];

  const scanDir = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;

      // Handle scoped packages (@scope/package-name)
      if (entry.name.startsWith('@')) {
        const scopeDir = join(dir, entry.name);
        for (const scoped of readdirSync(scopeDir, { withFileTypes: true })) {
          if (!scoped.isDirectory()) continue;
          tryAddPlugin(join(scopeDir, scoped.name), `${entry.name}/${scoped.name}`, results);
        }
      } else {
        tryAddPlugin(join(dir, entry.name), entry.name, results);
      }
    }
  };

  scanDir(nodeModules);
  return results;
}

function tryAddPlugin(pkgDir: string, fullName: string, results: DiscoveredPlugin[]): void {
  const pkgPath = join(pkgDir, 'package.json');
  if (!existsSync(pkgPath)) return;

  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    if (!pkg.name) return;

    const manifest = pkg.openwriter as { displayName?: string; category?: PluginCategory } | undefined;
    const isOpenWriterPlugin = manifest ||
      /^openwriter-plugin-/.test(pkg.name) ||
      /^@openwriter\/plugin-/.test(pkg.name) ||
      /^@[\w-]+\/openwriter-plugin-/.test(pkg.name);

    if (!isOpenWriterPlugin) return;

    results.push({
      name: pkg.name,
      dirName: fullName,
      version: pkg.version || '0.0.0',
      description: pkg.description || '',
      source: 'user',
      displayName: manifest?.displayName,
      category: manifest?.category,
      pluginDir: pkgDir,
    });
  } catch {
    // Skip malformed package.json
  }
}

/**
 * Discover all plugins from both bundled and user sources.
 * Deduplicates by name (bundled takes priority).
 */
export function discoverPlugins(): DiscoveredPlugin[] {
  const bundled = discoverBundledPlugins();
  const user = discoverUserPlugins();

  // Deduplicate: bundled wins if same name exists in both
  const seen = new Set(bundled.map(p => p.name));
  const deduped = [...bundled];
  for (const p of user) {
    if (!seen.has(p.name)) {
      deduped.push(p);
      seen.add(p.name);
    }
  }

  return deduped;
}

/**
 * Import a plugin module and extract its metadata.
 * Uses pluginDir for path-based imports (works in both npm install and monorepo dev).
 */
export async function loadPluginModule(name: string, source: 'bundled' | 'user' = 'bundled', pluginDir?: string): Promise<{
  plugin: any;
  configSchema: Record<string, PluginConfigField>;
} | null> {
  try {
    let mod: any;

    if (source === 'user') {
      // ESM import from non-standard node_modules requires path resolution
      const userRequire = createRequire(join(USER_PLUGINS_DIR, 'package.json'));
      const resolved = userRequire.resolve(name);
      mod = await import(pathToFileURL(resolved).href);
    } else if (pluginDir) {
      // Path-based import — works for both bundled-in-dist and monorepo plugins
      const mainPath = join(pluginDir, 'dist', 'index.js');
      mod = await import(pathToFileURL(mainPath).href);
    } else {
      // Fallback: bare import (workspace symlinks in monorepo dev)
      mod = await import(name);
    }

    const plugin = mod.default || mod.plugin || mod;

    if (!plugin.name || !plugin.version) return null;

    return {
      plugin,
      configSchema: plugin.configSchema || {},
    };
  } catch (err: any) {
    console.error(`[PluginDiscovery] Failed to import "${name}" (${source}):`, err.message);
    return null;
  }
}
