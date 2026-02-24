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
}

/**
 * Scan the bundled plugins/ directory at the monorepo root.
 * Returns [] if plugins/ doesn't exist (e.g. npx install scenario).
 */
function discoverBundledPlugins(): DiscoveredPlugin[] {
  // At runtime: dist/server/ → ../../../.. → monorepo root → /plugins/
  const pluginsDir = join(__dirname, '..', '..', '..', '..', 'plugins');

  if (!existsSync(pluginsDir)) return [];

  const results: DiscoveredPlugin[] = [];

  for (const entry of readdirSync(pluginsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;

    const pkgPath = join(pluginsDir, entry.name, 'package.json');
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
 * Import a plugin by npm package name and extract its metadata.
 * Returns the plugin's configSchema and full module export.
 */
export async function loadPluginModule(name: string, source: 'bundled' | 'user' = 'bundled'): Promise<{
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
    } else {
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
