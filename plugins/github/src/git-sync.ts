/**
 * Git sync module: all git/gh CLI interactions for GitHub docs backup.
 * Lifted from packages/openwriter/server/git-sync.ts into the github plugin.
 *
 * Uses child_process.execFile with an argv array and NO shell (MCP-1): values
 * are passed to git/gh as literal arguments, never interpreted by a shell.
 * The GitHub PAT is supplied to authenticated pushes out-of-band via an
 * inline credential helper reading from an env var (MCP-3) — it is never
 * embedded in the remote URL, written to .git/config, or placed in argv.
 * Server-internal modules (state, helpers, ws) accessed via getServerModules().
 */

import { execFile } from 'child_process';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { getServerModules } from './helpers.js';

// The repository is the portable, author-approved source. OpenWriter's
// recovery, attribution, activity, and pending-review sidecars are useful on
// one machine but are noisy and can conflict across machines. They remain
// available locally; Git is the durable cross-device history.
const GITIGNORE_ENTRIES = [
  'config.json',
  '.versions/',
  '_blame/',
  '_history/',
  '_commits/',
  '_marks/',
  '_pending/',
  'activity.log',
  '.DS_Store',
];
const GITIGNORE_CONTENT = `${GITIGNORE_ENTRIES.join('\n')}\n`;
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

// SECURITY (MCP-1): no shell. Arguments are passed to git/gh as an argv array,
// so each element is a single literal argument with no shell interpretation.
// The optional `env` is merged over the parent process env for that one call.
function exec(
  cmd: string,
  args: string[],
  cwd: string,
  timeout = 10000,
  env?: NodeJS.ProcessEnv,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { cwd, timeout, env: env ? { ...process.env, ...env } : process.env },
      (err, stdout, stderr) => {
        if (err) reject(new Error(stderr?.trim() || err.message));
        else resolve(stdout.trim());
      },
    );
  });
}

// ── Credential handling (MCP-3) ─────────────────────────────────────────────
// The PAT is supplied to authenticated git pushes WITHOUT ever touching the
// remote URL, .git/config, or argv. An inline credential helper (run by git
// through its own sh) reads the token from the OW_GIT_PAT env var at call time;
// only the variable *name* appears in arguments, never the secret itself.
const PAT_CRED_HELPER =
  '!f() { test "$1" = get && printf "username=x-access-token\\npassword=%s\\n" "$OW_GIT_PAT"; }; f';

/**
 * Run a git command that needs the PAT for network auth (push/fetch against a
 * private remote). The `-c credential.helper=` first resets any inherited
 * helper so only ours answers; the token is passed via env, not argv. The
 * remote URL stays credential-free.
 */
function execGitWithPat(args: string[], cwd: string, pat: string, timeout = NETWORK_TIMEOUT): Promise<string> {
  const authArgs = ['-c', 'credential.helper=', '-c', `credential.helper=${PAT_CRED_HELPER}`];
  return exec('git', [...authArgs, ...args], cwd, timeout, { OW_GIT_PAT: pat });
}

/**
 * Strip any embedded credentials (PAT / user:pass) from a git remote URL so a
 * credential-bearing URL is never returned to a client or logged. SSH scp-style
 * remotes (git@github.com:owner/repo.git) carry no secret and are left as-is.
 */
export function sanitizeRemoteUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.username || u.password) {
      u.username = '';
      u.password = '';
    }
    return u.toString();
  } catch {
    // Not a parseable URL (e.g. ssh scp-like form) — defensively drop any
    // userinfo that precedes an @ in a scheme://… authority.
    return url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@]*@/i, '$1');
  }
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
    return;
  }

  // Existing repositories may have been created by older OpenWriter builds.
  // Only append missing, exact entries; never replace author-maintained rules.
  const existing = readFileSync(gitignorePath, 'utf-8');
  const entries = new Set(existing.split(/\r?\n/));
  const missing = GITIGNORE_ENTRIES.filter((entry) => !entries.has(entry));
  if (missing.length) {
    const separator = existing && !existing.endsWith('\n') ? '\n' : '';
    writeFileSync(gitignorePath, `${existing}${separator}${missing.join('\n')}\n`, 'utf-8');
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
      // MCP-3: never expose embedded credentials. Even though the remote is
      // now stored credential-free, strip defensively so a legacy URL written
      // by an older build (PAT-in-URL) can't leak through this route.
      remoteUrl = sanitizeRemoteUrl(await exec('git', ['remote', 'get-url', 'origin'], await dataDir()));
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

async function remoteCommand(args: string[], dir: string): Promise<string> {
  const pat: string | undefined = (await getServerModules()).readConfig()?.gitPat;
  return pat
    ? execGitWithPat(args, dir, pat, NETWORK_TIMEOUT)
    : exec('git', args, dir, NETWORK_TIMEOUT);
}

async function currentBranch(dir: string): Promise<string> {
  const branch = await exec('git', ['branch', '--show-current'], dir);
  if (!branch) throw new Error('OpenWriter can only sync a named Git branch');
  return branch;
}

async function hasUncommittedChanges(dir: string): Promise<boolean> {
  return Boolean((await exec('git', ['status', '--porcelain'], dir)).trim());
}

/**
 * Bring a clean local checkout forward before publishing a writing-session
 * checkpoint. A divergent history is deliberately not auto-merged: prose
 * conflicts need an author-aware resolution, never a background guess.
 */
async function fastForwardRemoteChanges(dir: string): Promise<void> {
  try {
    await exec('git', ['remote', 'get-url', 'origin'], dir);
  } catch {
    return; // A local-only repository has nothing to reconcile yet.
  }

  const branch = await currentBranch(dir);
  await remoteCommand(['fetch', '--prune', 'origin'], dir);

  const remoteRef = `origin/${branch}`;
  try {
    await exec('git', ['rev-parse', '--verify', '--quiet', remoteRef], dir);
  } catch {
    return; // The remote does not have this branch yet; the push creates it.
  }

  const counts = await exec('git', ['rev-list', '--left-right', '--count', `HEAD...${remoteRef}`], dir);
  const [ahead = 0, behind = 0] = counts.trim().split(/\s+/).map(Number);
  if (!behind) return;

  if (!ahead) {
    if (await hasUncommittedChanges(dir)) {
      throw new Error(
        'This device has saved local edits while the remote contains newer writing. Sync stopped before either copy changed; reconcile the two copies, then try again.',
      );
    }
    await exec('git', ['merge', '--ff-only', remoteRef], dir, NETWORK_TIMEOUT);
    return;
  }

  throw new Error(
    'Remote changes and this device both contain new writing. Your local work is saved, but Sync stopped before pushing. Reconcile the two copies before trying again.',
  );
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
  // MCP-3: store a credential-free remote. The PAT is supplied per-push via
  // the credential helper (execGitWithPat), never embedded in the URL.
  const remoteUrl = `https://github.com/${repo.full_name}.git`;

  await initRepo();
  await initialCommit();

  try { await exec('git', ['remote', 'remove', 'origin'], dir); } catch { /* no remote */ }
  await exec('git', ['remote', 'add', 'origin', remoteUrl], dir);
  await execGitWithPat(['push', '-u', 'origin', 'main'], dir, pat, NETWORK_TIMEOUT);

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

  // MCP-3: keep the remote credential-free; never splice the PAT into the URL.
  // Strip any credentials the caller may have included before storing/using it.
  const finalUrl = sanitizeRemoteUrl(remoteUrl);

  try { await exec('git', ['remote', 'remove', 'origin'], dir); } catch { /* no remote */ }
  await exec('git', ['remote', 'add', 'origin', finalUrl], dir);
  if (pat) {
    await execGitWithPat(['push', '-u', 'origin', 'main'], dir, pat, NETWORK_TIMEOUT);
  } else {
    await exec('git', ['push', '-u', 'origin', 'main'], dir, NETWORK_TIMEOUT);
  }

  srv.saveConfig({
    gitConfigured: true,
    gitPat: pat,
    gitRemote: finalUrl,
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
    // Fetch before this session becomes a local checkpoint. If both a remote
    // change and saved local edits exist, stop instead of attempting a hidden
    // merge of the author's prose.
    await fastForwardRemoteChanges(dir);
    await exec('git', ['add', '-A'], dir);

    const status = await exec('git', ['status', '--porcelain'], dir);
    if (status) {
      const timestamp = new Date().toLocaleString('en-US', {
        month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
      });
      await exec('git', ['commit', '-m', `Sync: ${timestamp}`], dir);
    }

    // Remote reconciliation ran before the checkpoint above. A divergent
    // manuscript history is intentionally left for an author-aware resolution
    // instead of a silent background merge.
    await remoteCommand(['push'], dir);

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
