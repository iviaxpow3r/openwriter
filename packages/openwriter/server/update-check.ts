/**
 * Built-in update check — zero dependencies.
 * Uses Node's built-in fetch + existing config system.
 * Fire-and-forget: never blocks startup, never throws to caller.
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { readConfig, saveConfig } from './helpers.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const FETCH_TIMEOUT_MS = 5000;

let cachedLatestVersion: string | null = null;

/** Compare two semver strings numerically. Returns -1, 0, or 1. */
export function compareVersions(a: string, b: string): number {
  const partsA = a.split('.').map((s) => parseInt(s, 10));
  const partsB = b.split('.').map((s) => parseInt(s, 10));
  const len = Math.max(partsA.length, partsB.length);
  for (let i = 0; i < len; i++) {
    const numA = partsA[i] || 0;
    const numB = partsB[i] || 0;
    if (numA < numB) return -1;
    if (numA > numB) return 1;
  }
  return 0;
}

/** Read current package version from package.json on disk. */
export function getCurrentVersion(): string {
  try {
    const pkgPath = join(__dirname, '../../package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    return pkg.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export type InstallType = 'git' | 'npm';

/**
 * Detect how this instance was installed.
 *  - 'git'  — running from a git checkout (dev / dogfood): a `.git` dir exists
 *             above the package. Update path is `git pull && npm run build`.
 *  - 'npm'  — packaged global install (npm tarball extract, no `.git`).
 *             Update path is `npm update -g openwriter`.
 * Walks up from the package dir; npm tarballs never ship `.git`, so its
 * absence is a reliable signal.
 */
export function getInstallType(): InstallType {
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, '.git'))) return 'git';
    const parent = dirname(dir);
    if (parent === dir) break; // hit filesystem root
    dir = parent;
  }
  return 'npm';
}

/** The shell command this user should run to update, given their install type. */
export function getUpdateCommand(): string {
  return getInstallType() === 'git'
    ? 'git pull && npm run build'
    : 'npm update -g openwriter';
}

/**
 * Check npm registry for a newer version. Fire-and-forget.
 * - Respects NO_UPDATE_NOTIFIER env var
 * - Caches result for 24h in config
 * - Logs to stderr if update available
 */
export async function checkForUpdate(): Promise<void> {
  if (process.env.NO_UPDATE_NOTIFIER) return;

  const config = readConfig();
  const now = Date.now();
  const currentVersion = getCurrentVersion();

  // Use cached result if checked within 24h
  if (config.lastUpdateCheck && config.latestVersion) {
    const lastCheck = new Date(config.lastUpdateCheck).getTime();
    if (now - lastCheck < CHECK_INTERVAL_MS) {
      if (compareVersions(currentVersion, config.latestVersion) < 0) {
        cachedLatestVersion = config.latestVersion;
        console.error(`[OpenWriter] Update available: ${currentVersion} → ${config.latestVersion} — run: ${getUpdateCommand()}`);
      }
      return;
    }
  }

  // Fetch latest version from npm registry
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch('https://registry.npmjs.org/openwriter/latest', {
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) return;

    const data = (await res.json()) as { version?: string };
    const latestVersion = data.version;
    if (!latestVersion) return;

    // Save to config for 24h cache
    saveConfig({
      lastUpdateCheck: new Date().toISOString(),
      latestVersion,
    });

    if (compareVersions(currentVersion, latestVersion) < 0) {
      cachedLatestVersion = latestVersion;
      console.error(`[OpenWriter] Update available: ${currentVersion} → ${latestVersion} — run: ${getUpdateCommand()}`);
    }
  } catch {
    // Network error, timeout, abort — silently ignore
    clearTimeout(timeout);
  }
}

/** Sync getter: returns latest version string if update available, null otherwise. */
export function getUpdateInfo(): string | null {
  return cachedLatestVersion;
}
