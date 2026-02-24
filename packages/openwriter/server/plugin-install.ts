/**
 * CLI plugin management: install, remove, list user plugins.
 * User plugins live in ~/.openwriter/plugins/ with their own package.json and node_modules.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { execSync } from 'child_process';

const PLUGINS_DIR = join(homedir(), '.openwriter', 'plugins');
const PLUGINS_PKG = join(PLUGINS_DIR, 'package.json');

const VALID_NAME = /^(@openwriter\/plugin-[\w-]+|openwriter-plugin-[\w-]+|@[\w-]+\/openwriter-plugin-[\w-]+)$/;

/** Ensure ~/.openwriter/plugins/ exists with a package.json */
export function ensureUserPluginsDir(): void {
  if (!existsSync(PLUGINS_DIR)) {
    mkdirSync(PLUGINS_DIR, { recursive: true });
  }
  if (!existsSync(PLUGINS_PKG)) {
    writeFileSync(PLUGINS_PKG, JSON.stringify({
      private: true,
      type: 'module',
      dependencies: {}
    }, null, 2), 'utf-8');
  }
}

/** Install a plugin package into the user plugins directory */
export function installPlugin(packageName: string): void {
  if (!VALID_NAME.test(packageName)) {
    console.error(`Invalid plugin name: ${packageName}`);
    console.error('Plugin names must match: openwriter-plugin-*, @openwriter/plugin-*, or @scope/openwriter-plugin-*');
    process.exit(1);
  }

  ensureUserPluginsDir();
  console.error(`Installing ${packageName}...`);

  try {
    execSync(`npm install --save ${packageName}`, {
      cwd: PLUGINS_DIR,
      stdio: 'inherit',
    });
    console.error(`Installed ${packageName} successfully.`);
  } catch {
    console.error(`Failed to install ${packageName}.`);
    process.exit(1);
  }
}

/** Remove a plugin package from the user plugins directory */
export function removePlugin(packageName: string): void {
  ensureUserPluginsDir();

  const pkg = readPkg();
  if (!pkg.dependencies?.[packageName]) {
    console.error(`Plugin ${packageName} is not installed.`);
    process.exit(1);
  }

  console.error(`Removing ${packageName}...`);

  try {
    execSync(`npm uninstall ${packageName}`, {
      cwd: PLUGINS_DIR,
      stdio: 'inherit',
    });
    console.error(`Removed ${packageName} successfully.`);
  } catch {
    console.error(`Failed to remove ${packageName}.`);
    process.exit(1);
  }
}

/** List installed user plugins */
export function listInstalledPlugins(): void {
  ensureUserPluginsDir();

  const pkg = readPkg();
  const deps = pkg.dependencies || {};
  const names = Object.keys(deps);

  if (names.length === 0) {
    console.error('No user plugins installed.');
    console.error('Install one with: openwriter plugin install <package-name>');
    return;
  }

  console.error('Installed plugins:');
  for (const name of names) {
    console.error(`  ${name}@${deps[name]}`);
  }
}

/** CLI router for plugin subcommands */
export function handlePluginCommand(args: string[]): void {
  const sub = args[0];
  const name = args[1];

  switch (sub) {
    case 'install':
      if (!name) {
        console.error('Usage: openwriter plugin install <package-name>');
        process.exit(1);
      }
      installPlugin(name);
      break;
    case 'remove':
    case 'uninstall':
      if (!name) {
        console.error('Usage: openwriter plugin remove <package-name>');
        process.exit(1);
      }
      removePlugin(name);
      break;
    case 'list':
    case 'ls':
      listInstalledPlugins();
      break;
    default:
      console.error('Usage: openwriter plugin <install|remove|list> [package-name]');
      process.exit(1);
  }
}

function readPkg(): { dependencies?: Record<string, string> } {
  try {
    return JSON.parse(readFileSync(PLUGINS_PKG, 'utf-8'));
  } catch {
    return {};
  }
}
