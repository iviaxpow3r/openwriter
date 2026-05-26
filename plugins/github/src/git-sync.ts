/**
 * Git sync module: all git/gh CLI interactions for GitHub docs backup.
 * Lifted from packages/openwriter/server/git-sync.ts into the github plugin.
 *
 * Uses child_process.execFile with shell:true (required on Windows).
 * Server-internal modules (state, helpers, ws) accessed via getServerModules().
 */

import { execFile } from 'child_process';
import { existsSync, writeFileSync } from 'fs';
import { join } from 'path';
import { getServerModules } from './helpers.js';

const GITIGNORE_CONTENT = `config.json\n.versions/\n`;
const NETWORK_TIMEOUT = 30000;

export type SyncState = 'unconfigured' | 'synced' | 'pending' | 'syncing' | 'error';

export interface SyncStatus {
  state: SyncState;
  lastSyncTime?: string;
  pendingFiles?: number;
  error?: string;
}

export interface SyncCapabilities {
  gitInstalled: boolean;
  ghInstalled: boolean;
  ghAuthenticated: boolean;
  existingRepo: boolean;
  remoteUrl?: string;
}

let currentSyncState: SyncState = 'unconfigured';
let lastError: string | undefined;

function exec(cmd: string, args: string[], cwd: string, timeout = 10000): Promise<string> {
  const safeArgs = args.map(a => a.includes(' ') ? `"${a}"` : a);
  return new Promise((resolve, reject) => {
    execFile(cmd, safeArgs, { cwd, shell: true, timeout }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr?.trim() || err.message));
      else resolve(stdout.trim());
    });
  });
}

async function dataDir(): Promise<string> {
  return (await getServerModules()).getDataDir();
}

export async function isGitInstalled(): Promise<boolean> {
  try { await exec('git', ['--version'], await dataDir()); return true; } catch { return false; }
}

export async function isGhInstalled(): Promise<boolean> {
  try { await exec('gh', ['--version'], await dataDir()); return true; } catch { return false; }
}

export async function isGhAuthenticated(): Promise<boolean> {
  try { await exec('gh', ['auth', 'status'], await dataDir()); return true; } catch { return false; }
}

export async function isGitRepo(): Promise<boolean> {
  return existsSync(join(await dataDir(), '.git'));
}

async function ensureGitignore(): Promise<void> {
  const gitignorePath = join(await dataDir(), '.gitignore');
  if (!existsSync(gitignorePath)) {
    writeFileSync(gitignorePath, GITIGNORE_CONTENT, 'utf-8');
  }
}

async function countPendingFiles(): Promise<number> {
  if (!(await isGitRepo())) return 0;
  try {
    const status = await exec('git', ['status', '--porcelain'], await dataDir());
    if (!status) return 0;
    return status.split('\n').filter(Boolean).length;
  } catch { return 0; }
}

export interface PendingFile {
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  file: string;
}

export async function getPendingFiles(): Promise<PendingFile[]> {
  if (!(await isGitRepo())) return [];
  try {
    const output = await exec('git', ['status', '--porcelain'], await dataDir());
    if (!output) return [];
    return output.split('\n').filter(Boolean).map(line => {
      const code = line.substring(0, 2);
      const file = line.substring(3);
      let status: PendingFile['status'] = 'modified';
      if (code.includes('?') || code.includes('A')) status = 'added';
      else if (code.includes('D')) status = 'deleted';
      else if (code.includes('R')) status = 'renamed';
      return { status, file };
    });
  } catch { return []; }
}

export async function getSyncStatus(): Promise<SyncStatus> {
  const srv = await getServerModules();
  const config = srv.readConfig();

  if (!config.gitConfigured || !(await isGitRepo())) {
    return { state: 'unconfigured' };
  }

  if (currentSyncState === 'syncing') {
    return { state: 'syncing' };
  }

  if (currentSyncState === 'error' && lastError) {
    return { state: 'error', error: lastError, lastSyncTime: config.lastSyncTime };
  }

  const pending = await countPendingFiles();
  return {
    state: pending > 0 ? 'pending' : 'synced',
    pendingFiles: pending,
    lastSyncTime: config.lastSyncTime,
  };
}

export async function getCapabilities(): Promise<SyncCapabilities> {
  const [git, gh] = await Promise.all([isGitInstalled(), isGhInstalled()]);
  let ghAuth = false;
  if (gh) ghAuth = await isGhAuthenticated();

  let remoteUrl: string | undefined;
  if (await isGitRepo()) {
    try {
      remoteUrl = await exec('git', ['remote', 'get-url', 'origin'], await dataDir());
    } catch { /* no remote */ }
  }

  return {
    gitInstalled: git,
    ghInstalled: gh,
    ghAuthenticated: ghAuth,
    existingRepo: await isGitRepo(),
    remoteUrl,
  };
}

async function initRepo(): Promise<void> {
  const dir = await dataDir();
  if (!(await isGitRepo())) {
    await exec('git', ['init'], dir);
  }
  await ensureGitignore();
  try { await exec('git', ['config', 'user.name'], dir); } catch {
    await exec('git', ['config', 'user.name', 'OpenWriter'], dir);
  }
  try { await exec('git', ['config', 'user.email'], dir); } catch {
    await exec('git', ['config', 'user.email', 'openwriter@local'], dir);
  }
}

async function initialCommit(): Promise<void> {
  const dir = await dataDir();
  await exec('git', ['add', '-A'], dir);
  const status = await exec('git', ['status', '--porcelain'], dir);
  if (!status) return;
  await exec('git', ['commit', '-m', 'Initial sync from OpenWriter'], dir);
  await exec('git', ['branch', '-M', 'main'], dir);
}

export async function setupWithGh(repoName: string, isPrivate: boolean): Promise<void> {
  const srv = await getServerModules();
  const dir = await dataDir();
  await initRepo();
  await initialCommit();

  const visibility = isPrivate ? '--private' : '--public';
  await exec('gh', ['repo', 'create', repoName, visibility, '--source=.', '--remote=origin'], dir, NETWORK_TIMEOUT);
  await exec('git', ['push', '-u', 'origin', 'main'], dir, NETWORK_TIMEOUT);

  srv.saveConfig({
    gitConfigured: true,
    repoName,
    lastSyncTime: new Date().toISOString(),
  });
  currentSyncState = 'synced';
}

export async function setupWithPat(pat: string, repoName: string, isPrivate: boolean): Promise<void> {
  const srv = await getServerModules();
  const dir = await dataDir();

  const res = await fetch('https://api.github.com/user/repos', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${pat}`,
      'Content-Type': 'application/json',
      Accept: 'application/vnd.github+json',
    },
    body: JSON.stringify({ name: repoName, private: isPrivate, auto_init: false }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as any).message || `GitHub API error: ${res.status}`);
  }

  const repo: any = await res.json();
  const remoteUrl = `https://${pat}@github.com/${repo.full_name}.git`;

  await initRepo();
  await initialCommit();

  try { await exec('git', ['remote', 'remove', 'origin'], dir); } catch { /* no remote */ }
  await exec('git', ['remote', 'add', 'origin', remoteUrl], dir);
  await exec('git', ['push', '-u', 'origin', 'main'], dir, NETWORK_TIMEOUT);

  srv.saveConfig({
    gitConfigured: true,
    gitPat: pat,
    repoName,
    gitRemote: repo.html_url,
    lastSyncTime: new Date().toISOString(),
  });
  currentSyncState = 'synced';
}

export async function connectExisting(remoteUrl: string, pat?: string): Promise<void> {
  const srv = await getServerModules();
  const dir = await dataDir();
  await initRepo();
  await initialCommit();

  let finalUrl = remoteUrl;
  if (pat && remoteUrl.startsWith('https://')) {
    finalUrl = remoteUrl.replace('https://', `https://${pat}@`);
  }

  try { await exec('git', ['remote', 'remove', 'origin'], dir); } catch { /* no remote */ }
  await exec('git', ['remote', 'add', 'origin', finalUrl], dir);
  await exec('git', ['push', '-u', 'origin', 'main'], dir, NETWORK_TIMEOUT);

  srv.saveConfig({
    gitConfigured: true,
    gitPat: pat,
    gitRemote: remoteUrl,
    lastSyncTime: new Date().toISOString(),
  });
  currentSyncState = 'synced';
}

export async function pushSync(onStatus: (status: SyncStatus) => void): Promise<SyncStatus> {
  const srv = await getServerModules();
  const dir = await dataDir();

  currentSyncState = 'syncing';
  lastError = undefined;
  onStatus({ state: 'syncing' });

  try {
    srv.cancelDebouncedSave();
    srv.save();

    await ensureGitignore();
    await exec('git', ['add', '-A'], dir);

    const status = await exec('git', ['status', '--porcelain'], dir);
    if (status) {
      const timestamp = new Date().toLocaleString('en-US', {
        month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
      });
      await exec('git', ['commit', '-m', `Sync: ${timestamp}`], dir);
    }

    await exec('git', ['push'], dir, NETWORK_TIMEOUT);

    const now = new Date().toISOString();
    srv.saveConfig({ lastSyncTime: now });
    currentSyncState = 'synced';

    const result: SyncStatus = { state: 'synced', lastSyncTime: now, pendingFiles: 0 };
    onStatus(result);
    return result;
  } catch (err: any) {
    currentSyncState = 'error';
    lastError = err.message;
    const result: SyncStatus = { state: 'error', error: err.message };
    onStatus(result);
    return result;
  }
}
