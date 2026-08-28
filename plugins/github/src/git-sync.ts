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

import { execFile, spawn } from 'child_process';
import { existsSync, mkdirSync, readFileSync, watch, writeFileSync, type FSWatcher } from 'fs';
import { randomUUID } from 'crypto';
import { basename, dirname, join } from 'path';
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
const COLLABORATION_DIR = '.openwriter';
const COLLABORATION_FILE = 'collaboration.json';
const DEFAULT_CHECKPOINT_DELAY_MS = 120_000;
const GITHUB_DEVICE_CLIENT_ID_ENV = 'OPENWRITER_GITHUB_OAUTH_CLIENT_ID';
const KEYCHAIN_SERVICE = 'OpenWriter GitHub';

export type CollaborationRole = 'primary' | 'contributor';
export type SyncState = 'unconfigured' | 'synced' | 'pending' | 'syncing' | 'attention' | 'error';

export interface PrimaryWriter {
  displayName: string;
  githubLogin?: string;
}

export interface CollaborationManifest {
  version: 1;
  primaryBranch: string;
  primaryWriter: PrimaryWriter;
  defaults: {
    automaticCheckpoints: boolean;
    checkpointDelayMs: number;
    contributorsUsePullRequests: boolean;
  };
}

export interface CollaborationSettings {
  role: CollaborationRole;
  branch: string;
  baseBranch: string;
  displayName: string;
  githubLogin?: string;
  changeSetTitle?: string;
  pullRequestUrl?: string;
  automaticCheckpoints: boolean;
  checkpointDelayMs: number;
}

export interface CollaborationSetup {
  role?: CollaborationRole;
  displayName?: string;
  githubLogin?: string;
  changeSetTitle?: string;
  automaticCheckpoints?: boolean;
  checkpointDelayMs?: number;
  /** Advanced safety override for a repository that already names another primary writer. */
  allowAdditionalPrimary?: boolean;
}

export interface SyncStatus {
  state: SyncState;
  lastSyncTime?: string;
  pendingFiles?: number;
  error?: string;
  collaboration?: CollaborationSettings;
  primaryWriter?: PrimaryWriter;
}

export interface SyncCapabilities {
  gitInstalled: boolean;
  ghInstalled: boolean;
  ghAuthenticated: boolean;
  deviceAuthAvailable: boolean;
  oauthAuthenticated: boolean;
  githubLogin?: string;
  existingRepo: boolean;
  remoteUrl?: string;
  primaryWriter?: PrimaryWriter;
}

/** A credential-free repository summary used only by the setup picker. */
export interface GitHubRepositoryOption {
  id: string;
  fullName: string;
  cloneUrl: string;
  private: boolean;
  updatedAt?: string;
}

let currentSyncState: SyncState = 'unconfigured';
let lastError: string | undefined;
let checkpointWatcher: FSWatcher | null = null;
let checkpointTimer: ReturnType<typeof setTimeout> | null = null;
let checkpointInFlight = false;
const pendingDeviceAuthorizations = new Map<string, {
  deviceCode: string;
  expiresAt: number;
  intervalMs: number;
  nextPollAt: number;
}>();

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

/**
 * Like exec(), but supplies a sensitive value through stdin. This lets the
 * macOS `security` utility prompt for `-w` without exposing an OAuth token in
 * argv or the process list.
 */
function execWithInput(cmd: string, args: string[], cwd: string, input: string, timeout = 10000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${cmd} timed out`));
    }, timeout);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(stderr.trim() || `${cmd} exited with code ${code}`));
    });
    child.stdin.end(`${input}\n`);
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

function githubDeviceClientId(): string | undefined {
  const clientId = process.env[GITHUB_DEVICE_CLIENT_ID_ENV]?.trim();
  return clientId || undefined;
}

async function keychainAccount(): Promise<string> {
  return `profile:${basename(await dataDir())}`;
}

interface OAuthCredential {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
}

async function readOAuthCredential(): Promise<OAuthCredential | undefined> {
  if (process.platform !== 'darwin') return undefined;
  try {
    const raw = await exec('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', await keychainAccount(), '-w'], await dataDir());
    // The first implementation stored only the access token. Preserve that
    // pairing if it already exists while new pairings use the richer record.
    try {
      const parsed = JSON.parse(raw) as OAuthCredential;
      return parsed?.accessToken ? parsed : undefined;
    } catch {
      return raw ? { accessToken: raw } : undefined;
    }
  } catch {
    return undefined;
  }
}

async function storeOAuthCredential(credential: OAuthCredential): Promise<void> {
  if (process.platform !== 'darwin') {
    throw new Error('Secure GitHub pairing is currently available on macOS only.');
  }
  // The `security` command cannot consume -w credential data from a pipe: it
  // creates an empty record in a non-interactive app. The bundled native
  // helper uses Security.framework instead, accepting only service/account in
  // argv and receiving the opaque credential JSON on stdin.
  const keychainHelper = join(dirname(process.execPath), '..', 'OpenWriterKeychain');
  if (!existsSync(keychainHelper)) {
    throw new Error('This OpenWriter installation is missing its secure GitHub credential helper. Reinstall the app and sign in again.');
  }
  await execWithInput(
    keychainHelper,
    [KEYCHAIN_SERVICE, await keychainAccount()],
    await dataDir(),
    JSON.stringify(credential),
  );
}

async function getOAuthAccessToken(): Promise<string | undefined> {
  const credential = await readOAuthCredential();
  if (!credential) return undefined;
  if (!credential.expiresAt || credential.expiresAt > Date.now() + 60_000) return credential.accessToken;
  const clientId = githubDeviceClientId();
  if (!clientId || !credential.refreshToken) return undefined;

  const response = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, grant_type: 'refresh_token', refresh_token: credential.refreshToken }),
  });
  const payload = await response.json().catch(() => ({})) as { access_token?: string; refresh_token?: string; expires_in?: number };
  if (!response.ok || !payload.access_token) return undefined;
  const refreshed: OAuthCredential = {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token || credential.refreshToken,
    ...(payload.expires_in ? { expiresAt: Date.now() + payload.expires_in * 1000 } : {}),
  };
  await storeOAuthCredential(refreshed);
  return refreshed.accessToken;
}

async function repositoryToken(): Promise<string | undefined> {
  const config = (await getServerModules()).readConfig();
  return config.gitPat || getOAuthAccessToken();
}

/** The authenticated GitHub login is the durable collaboration identity. It is
 * safe to store with the repository metadata and avoids asking authors to
 * maintain a second, manual identity inside OpenWriter. */
async function githubLoginWithToken(token: string): Promise<string | undefined> {
  try {
    const response = await fetch('https://api.github.com/user', {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
    });
    if (!response.ok) return undefined;
    const user = await response.json() as { login?: unknown };
    return typeof user.login === 'string' && user.login.trim() ? user.login.trim() : undefined;
  } catch {
    return undefined;
  }
}

async function githubLoginWithGh(): Promise<string | undefined> {
  try {
    const login = await exec('gh', ['api', 'user', '--jq', '.login'], await dataDir());
    return login.trim() || undefined;
  } catch {
    return undefined;
  }
}

async function authenticatedGitHubLogin(token?: string): Promise<string | undefined> {
  const config = (await getServerModules()).readConfig();
  if (typeof config.gitOAuthLogin === 'string' && config.gitOAuthLogin.trim()) return config.gitOAuthLogin.trim();
  if (token) return githubLoginWithToken(token);
  if (await isGhAuthenticated()) return githubLoginWithGh();
  return undefined;
}

interface GitHubRepositoryResponse {
  id?: unknown;
  full_name?: unknown;
  clone_url?: unknown;
  private?: unknown;
  archived?: unknown;
  updated_at?: unknown;
  permissions?: { push?: unknown };
}

function repositoryOptions(payload: unknown): GitHubRepositoryOption[] {
  if (!Array.isArray(payload)) return [];
  return payload.flatMap((item): GitHubRepositoryOption[] => {
    const repo = item as GitHubRepositoryResponse;
    if (
      typeof repo.id !== 'number'
      || typeof repo.full_name !== 'string'
      || typeof repo.clone_url !== 'string'
      || repo.archived === true
      || repo.permissions?.push === false
    ) return [];
    return [{
      id: String(repo.id),
      fullName: repo.full_name,
      cloneUrl: sanitizeRemoteUrl(repo.clone_url),
      private: repo.private === true,
      ...(typeof repo.updated_at === 'string' ? { updatedAt: repo.updated_at } : {}),
    }];
  });
}

const ACCESSIBLE_REPOSITORIES_PATH = '/user/repos?affiliation=owner,collaborator,organization_member&per_page=100&sort=updated&direction=desc';

/**
 * List recent repositories the signed-in person can write to. This keeps the
 * setup choice useful for shared author spaces while never exposing an access
 * token to the browser or storing it in OpenWriter's config.
 */
export async function listAccessibleRepositories(authMethod: 'oauth' | 'gh'): Promise<GitHubRepositoryOption[]> {
  if (authMethod === 'oauth') {
    const token = await getOAuthAccessToken();
    if (!token) throw new Error('Your GitHub sign-in has expired. Sign in again to choose a repository.');
    const response = await fetch(`https://api.github.com${ACCESSIBLE_REPOSITORIES_PATH}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
    });
    if (!response.ok) throw new Error(`GitHub could not load your repositories (${response.status}).`);
    return repositoryOptions(await response.json().catch(() => []));
  }

  if (!(await isGhAuthenticated())) {
    throw new Error('Sign in with GitHub on this Mac before choosing a repository.');
  }
  const output = await exec('gh', ['api', ACCESSIBLE_REPOSITORIES_PATH], await dataDir(), NETWORK_TIMEOUT);
  return repositoryOptions(JSON.parse(output));
}

export interface DeviceAuthorizationStart {
  requestId: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
}

export interface DeviceAuthorizationStatus {
  state: 'pending' | 'authorized' | 'expired' | 'error';
  retryAfterMs?: number;
  login?: string;
  error?: string;
}

/** Begin a user-mediated GitHub device authorization. The short-lived device
 * code never leaves the server; the client receives only the verification URL
 * and the user code that GitHub asks the author to enter. */
export async function startDeviceAuthorization(): Promise<DeviceAuthorizationStart> {
  const clientId = githubDeviceClientId();
  if (!clientId) {
    throw new Error('This OpenWriter build has not been configured with its GitHub account-pairing client ID yet.');
  }

  const response = await fetch('https://github.com/login/device/code', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, scope: 'repo read:user' }),
  });
  const payload = await response.json().catch(() => ({})) as {
    device_code?: string;
    user_code?: string;
    verification_uri?: string;
    expires_in?: number;
    interval?: number;
    error_description?: string;
  };
  if (!response.ok || !payload.device_code || !payload.user_code || !payload.verification_uri) {
    throw new Error(payload.error_description || 'GitHub could not start account pairing.');
  }

  const requestId = randomUUID();
  const intervalMs = Math.max((payload.interval || 5) * 1000, 5000);
  pendingDeviceAuthorizations.set(requestId, {
    deviceCode: payload.device_code,
    expiresAt: Date.now() + (payload.expires_in || 900) * 1000,
    intervalMs,
    nextPollAt: Date.now() + intervalMs,
  });
  return {
    requestId,
    userCode: payload.user_code,
    verificationUri: payload.verification_uri,
    expiresIn: payload.expires_in || 900,
    interval: intervalMs / 1000,
  };
}

export async function pollDeviceAuthorization(requestId: string): Promise<DeviceAuthorizationStatus> {
  const pending = pendingDeviceAuthorizations.get(requestId);
  if (!pending) return { state: 'expired', error: 'This GitHub sign-in request has expired. Start again.' };
  if (Date.now() >= pending.expiresAt) {
    pendingDeviceAuthorizations.delete(requestId);
    return { state: 'expired', error: 'This GitHub sign-in request expired. Start again.' };
  }
  if (Date.now() < pending.nextPollAt) {
    return { state: 'pending', retryAfterMs: pending.nextPollAt - Date.now() };
  }

  const clientId = githubDeviceClientId();
  if (!clientId) return { state: 'error', error: 'This OpenWriter build is missing its GitHub account-pairing client ID.' };
  const response = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      device_code: pending.deviceCode,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    }),
  });
  const payload = await response.json().catch(() => ({})) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };
  if (payload.error === 'authorization_pending') {
    pending.nextPollAt = Date.now() + pending.intervalMs;
    return { state: 'pending', retryAfterMs: pending.intervalMs };
  }
  if (payload.error === 'slow_down') {
    pending.intervalMs += 5000;
    pending.nextPollAt = Date.now() + pending.intervalMs;
    return { state: 'pending', retryAfterMs: pending.intervalMs };
  }
  if (payload.error) {
    pendingDeviceAuthorizations.delete(requestId);
    return { state: 'error', error: payload.error_description || 'GitHub sign-in could not be completed.' };
  }
  if (!response.ok || !payload.access_token) {
    return { state: 'error', error: 'GitHub did not return an account token.' };
  }

  try {
    await storeOAuthCredential({
      accessToken: payload.access_token,
      ...(payload.refresh_token ? { refreshToken: payload.refresh_token } : {}),
      ...(payload.expires_in ? { expiresAt: Date.now() + payload.expires_in * 1000 } : {}),
    });
    const identity = await fetch('https://api.github.com/user', {
      headers: { Authorization: `Bearer ${payload.access_token}`, Accept: 'application/vnd.github+json' },
    });
    const user = await identity.json().catch(() => ({})) as { login?: string };
    const srv = await getServerModules();
    // Replace any legacy token saved in config. The paired account now lives
    // in Keychain, so a plain-text PAT should no longer take precedence.
    srv.saveConfig({ gitPat: undefined, gitOAuthLogin: user.login || undefined });
    pendingDeviceAuthorizations.delete(requestId);
    return { state: 'authorized', login: user.login };
  } catch (err: any) {
    pendingDeviceAuthorizations.delete(requestId);
    return { state: 'error', error: err?.message || 'OpenWriter could not store this GitHub sign-in securely.' };
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

function collaborationPath(dir: string): string {
  return join(dir, COLLABORATION_DIR, COLLABORATION_FILE);
}

function clampCheckpointDelay(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_CHECKPOINT_DELAY_MS;
  // A short quiet period still gives the editor and local recovery system time
  // to persist first. A very long interval defeats the purpose of a backup.
  return Math.min(Math.max(Math.round(parsed), 30_000), 30 * 60_000);
}

function cleanDisplayName(value: unknown): string {
  const name = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
  return name || 'Primary writer';
}

function safeBranchPart(value: string): string {
  const clean = value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return clean || 'writer';
}

function defaultContributorBranch(displayName: string): string {
  const date = new Date().toISOString().slice(0, 10);
  return `contributors/${safeBranchPart(displayName)}/updates-${date}`;
}

function defaultChangeSetTitle(displayName: string): string {
  const date = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(new Date());
  return `Updates from ${cleanDisplayName(displayName)} · ${date}`;
}

function isCollaborationSettings(value: unknown): value is CollaborationSettings {
  if (!value || typeof value !== 'object') return false;
  const settings = value as Partial<CollaborationSettings>;
  return (settings.role === 'primary' || settings.role === 'contributor')
    && typeof settings.branch === 'string'
    && typeof settings.baseBranch === 'string'
    && typeof settings.displayName === 'string'
    && typeof settings.automaticCheckpoints === 'boolean'
    && typeof settings.checkpointDelayMs === 'number';
}

function normalizeSettings(value: CollaborationSettings): CollaborationSettings {
  return {
    ...value,
    displayName: cleanDisplayName(value.displayName),
    branch: value.branch.trim(),
    baseBranch: value.baseBranch.trim() || 'main',
    automaticCheckpoints: value.automaticCheckpoints !== false,
    checkpointDelayMs: clampCheckpointDelay(value.checkpointDelayMs),
  };
}

function readCollaborationManifest(dir: string): CollaborationManifest | null {
  const path = collaborationPath(dir);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<CollaborationManifest>;
    if (parsed.version !== 1 || !parsed.primaryBranch || !parsed.primaryWriter?.displayName) return null;
    return {
      version: 1,
      primaryBranch: parsed.primaryBranch,
      primaryWriter: {
        displayName: cleanDisplayName(parsed.primaryWriter.displayName),
        ...(parsed.primaryWriter.githubLogin ? { githubLogin: parsed.primaryWriter.githubLogin } : {}),
      },
      defaults: {
        automaticCheckpoints: parsed.defaults?.automaticCheckpoints !== false,
        checkpointDelayMs: clampCheckpointDelay(parsed.defaults?.checkpointDelayMs),
        contributorsUsePullRequests: parsed.defaults?.contributorsUsePullRequests !== false,
      },
    };
  } catch {
    return null;
  }
}

function writeCollaborationManifest(dir: string, manifest: CollaborationManifest): void {
  const path = collaborationPath(dir);
  mkdirSync(join(dir, COLLABORATION_DIR), { recursive: true });
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');
}

async function gitConfigValue(dir: string, key: string): Promise<string | undefined> {
  try {
    const value = await exec('git', ['config', '--get', key], dir);
    return value || undefined;
  } catch {
    return undefined;
  }
}

async function inferredPrimaryWriter(dir: string): Promise<PrimaryWriter> {
  const gitName = await gitConfigValue(dir, 'user.name');
  return { displayName: gitName && gitName !== 'OpenWriter' ? cleanDisplayName(gitName) : 'Primary writer' };
}

async function collaborationContext(): Promise<{ settings?: CollaborationSettings; primaryWriter?: PrimaryWriter }> {
  const srv = await getServerModules();
  const config = srv.readConfig();
  const dir = await dataDir();
  const manifest = readCollaborationManifest(dir);
  const stored = config.gitCollaboration;
  if (isCollaborationSettings(stored)) {
    return { settings: normalizeSettings(stored), primaryWriter: manifest?.primaryWriter };
  }

  // Existing OpenWriter Git backups predate collaboration metadata. Treat them
  // as a primary writer setup rather than changing their behavior invisibly.
  if (config.gitConfigured && existsSync(join(dir, '.git'))) {
    let branch = 'main';
    try { branch = await currentBranch(dir); } catch { /* retain safe default */ }
    const primaryWriter = manifest?.primaryWriter || await inferredPrimaryWriter(dir);
    return {
      settings: {
        role: 'primary',
        branch,
        baseBranch: manifest?.primaryBranch || branch,
        displayName: primaryWriter.displayName,
        automaticCheckpoints: true,
        checkpointDelayMs: DEFAULT_CHECKPOINT_DELAY_MS,
      },
      primaryWriter,
    };
  }

  return { primaryWriter: manifest?.primaryWriter };
}

async function configureGitIdentity(dir: string, displayName: string): Promise<void> {
  await exec('git', ['config', 'user.name', cleanDisplayName(displayName)], dir);
}

async function hasHead(dir: string): Promise<boolean> {
  try { await exec('git', ['rev-parse', '--verify', 'HEAD'], dir); return true; }
  catch { return false; }
}

async function localBranchExists(dir: string, branch: string): Promise<boolean> {
  try { await exec('git', ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], dir); return true; }
  catch { return false; }
}

async function remoteBranchExists(dir: string, branch: string): Promise<boolean> {
  try { await exec('git', ['show-ref', '--verify', '--quiet', `refs/remotes/origin/${branch}`], dir); return true; }
  catch { return false; }
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

  const context = await collaborationContext();
  const details = {
    ...(context.settings ? { collaboration: context.settings } : {}),
    ...(context.primaryWriter ? { primaryWriter: context.primaryWriter } : {}),
  };

  if (currentSyncState === 'syncing') {
    return { state: 'syncing', ...details };
  }

  if ((currentSyncState === 'error' || currentSyncState === 'attention') && lastError) {
    return { state: currentSyncState, error: lastError, lastSyncTime: config.lastSyncTime, ...details };
  }

  const pending = await countPendingFiles();
  return {
    state: pending > 0 ? 'pending' : 'synced',
    pendingFiles: pending,
    lastSyncTime: config.lastSyncTime,
    ...details,
  };
}

export async function getCapabilities(): Promise<SyncCapabilities> {
  const [git, gh, oauthToken] = await Promise.all([isGitInstalled(), isGhInstalled(), getOAuthAccessToken()]);
  let ghAuth = false;
  if (gh) ghAuth = await isGhAuthenticated();
  const githubLogin = await authenticatedGitHubLogin(oauthToken);

  let remoteUrl: string | undefined;
  let primaryWriter: PrimaryWriter | undefined;
  if (await isGitRepo()) {
    try {
      // MCP-3: never expose embedded credentials. Even though the remote is
      // now stored credential-free, strip defensively so a legacy URL written
      // by an older build (PAT-in-URL) can't leak through this route.
      remoteUrl = sanitizeRemoteUrl(await exec('git', ['remote', 'get-url', 'origin'], await dataDir()));
    } catch { /* no remote */ }
    primaryWriter = readCollaborationManifest(await dataDir())?.primaryWriter;
  }

  return {
    gitInstalled: git,
    ghInstalled: gh,
    ghAuthenticated: ghAuth,
    deviceAuthAvailable: Boolean(githubDeviceClientId()) && process.platform === 'darwin',
    oauthAuthenticated: Boolean(oauthToken),
    ...(githubLogin ? { githubLogin } : {}),
    existingRepo: await isGitRepo(),
    remoteUrl,
    primaryWriter,
  };
}

async function initRepo(options: { ensureIgnore?: boolean } = {}): Promise<void> {
  const dir = await dataDir();
  if (!(await isGitRepo())) {
    await exec('git', ['init'], dir);
  }
  if (options.ensureIgnore !== false) await ensureGitignore();
  try { await exec('git', ['config', 'user.name'], dir); } catch {
    await exec('git', ['config', 'user.name', 'OpenWriter'], dir);
  }
  try { await exec('git', ['config', 'user.email'], dir); } catch {
    await exec('git', ['config', 'user.email', 'openwriter@local'], dir);
  }
}

async function initialCommit(branch = 'main'): Promise<void> {
  const dir = await dataDir();
  await exec('git', ['add', '-A'], dir);
  const status = await exec('git', ['status', '--porcelain'], dir);
  if (!status) return;
  await exec('git', ['commit', '-m', 'Initial sync from OpenWriter'], dir);
  await exec('git', ['branch', '-M', branch], dir);
}

async function remoteCommand(args: string[], dir: string): Promise<string> {
  const token = await repositoryToken();
  return token
    ? execGitWithPat(args, dir, token, NETWORK_TIMEOUT)
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

async function readRemoteManifest(dir: string, branch: string, pat?: string): Promise<CollaborationManifest | null> {
  try {
    const ref = `origin/${branch}:${COLLABORATION_DIR}/${COLLABORATION_FILE}`;
    const output = pat
      ? await execGitWithPat(['show', ref], dir, pat, NETWORK_TIMEOUT)
      : await exec('git', ['show', ref], dir, NETWORK_TIMEOUT);
    const parsed = JSON.parse(output) as Partial<CollaborationManifest>;
    if (parsed.version !== 1 || !parsed.primaryBranch || !parsed.primaryWriter?.displayName) return null;
    return {
      version: 1,
      primaryBranch: parsed.primaryBranch,
      primaryWriter: {
        displayName: cleanDisplayName(parsed.primaryWriter.displayName),
        ...(parsed.primaryWriter.githubLogin ? { githubLogin: parsed.primaryWriter.githubLogin } : {}),
      },
      defaults: {
        automaticCheckpoints: parsed.defaults?.automaticCheckpoints !== false,
        checkpointDelayMs: clampCheckpointDelay(parsed.defaults?.checkpointDelayMs),
        contributorsUsePullRequests: parsed.defaults?.contributorsUsePullRequests !== false,
      },
    };
  } catch {
    return null;
  }
}

async function remoteDefaultBranch(dir: string, pat?: string): Promise<string> {
  try {
    const output = pat
      ? await execGitWithPat(['ls-remote', '--symref', 'origin', 'HEAD'], dir, pat, NETWORK_TIMEOUT)
      : await exec('git', ['ls-remote', '--symref', 'origin', 'HEAD'], dir, NETWORK_TIMEOUT);
    const match = output.match(/^ref:\s+refs\/heads\/([^\s]+)\s+HEAD$/m);
    return match?.[1] || 'main';
  } catch {
    // An empty repository has no HEAD yet. main remains OpenWriter's safe
    // first branch in that case.
    return 'main';
  }
}

async function commitSetupMetadata(dir: string): Promise<void> {
  const paths = ['.gitignore', join(COLLABORATION_DIR, COLLABORATION_FILE)]
    .filter((path) => existsSync(join(dir, path)));
  if (!paths.length) return;
  await exec('git', ['add', '--', ...paths], dir);
  try {
    await exec('git', ['diff', '--cached', '--quiet'], dir);
    return;
  } catch {
    await exec('git', ['commit', '-m', 'Configure OpenWriter collaboration'], dir);
  }
}

async function configurePrimaryWriter(
  dir: string,
  setup: CollaborationSetup,
  existing?: CollaborationManifest | null,
  fallbackPrimaryBranch = 'main',
): Promise<CollaborationSettings> {
  const displayName = cleanDisplayName(setup.githubLogin || setup.displayName || (await inferredPrimaryWriter(dir)).displayName);
  if (existing && existing.primaryWriter.displayName !== displayName && !setup.allowAdditionalPrimary) {
    throw new Error(
      `${existing.primaryWriter.displayName} is already set as the primary writer for this repository. Connect as a contributor, or explicitly confirm an additional primary writer before changing this setup.`,
    );
  }

  const primaryBranch = existing?.primaryBranch || fallbackPrimaryBranch;
  const manifest: CollaborationManifest = {
    version: 1,
    primaryBranch,
    primaryWriter: existing?.primaryWriter || {
      displayName,
      ...(setup.githubLogin ? { githubLogin: setup.githubLogin } : {}),
    },
    defaults: {
      automaticCheckpoints: setup.automaticCheckpoints !== false,
      checkpointDelayMs: clampCheckpointDelay(setup.checkpointDelayMs),
      contributorsUsePullRequests: true,
    },
  };
  writeCollaborationManifest(dir, manifest);
  await configureGitIdentity(dir, displayName);

  const settings: CollaborationSettings = {
    role: 'primary',
    branch: primaryBranch,
    baseBranch: primaryBranch,
    displayName,
    ...(setup.githubLogin ? { githubLogin: setup.githubLogin } : {}),
    automaticCheckpoints: manifest.defaults.automaticCheckpoints,
    checkpointDelayMs: manifest.defaults.checkpointDelayMs,
  };
  const srv = await getServerModules();
  srv.saveConfig({ gitCollaboration: settings });
  return settings;
}

async function checkoutContributorBranch(dir: string, branch: string, baseBranch: string): Promise<void> {
  if (await localBranchExists(dir, branch)) {
    await exec('git', ['checkout', branch], dir);
    return;
  }

  // Creating a branch from the current checkout never rewrites working files.
  // This is intentionally preferred when an author already has local edits.
  if (await hasHead(dir)) {
    const current = await currentBranch(dir);
    // A clean primary checkout can safely adopt remote-only updates before a
    // contributor branch is cut. This avoids opening a PR from an unnecessarily
    // stale base without ever auto-merging two sets of writing.
    if (current === baseBranch && !(await hasUncommittedChanges(dir)) && await remoteBranchExists(dir, baseBranch)) {
      const counts = await exec('git', ['rev-list', '--left-right', '--count', `HEAD...origin/${baseBranch}`], dir);
      const [ahead = 0, behind = 0] = counts.trim().split(/\s+/).map(Number);
      if (!ahead && behind) await exec('git', ['merge', '--ff-only', `origin/${baseBranch}`], dir, NETWORK_TIMEOUT);
      if (ahead && behind) {
        throw new Error('This device and the shared writing branch both contain new work. Resolve that history before creating a contributor branch.');
      }
    }
    await exec('git', ['checkout', '-b', branch], dir);
    return;
  }

  if (await hasUncommittedChanges(dir)) {
    throw new Error(
      'This device has writing that is not yet connected to the shared repository. Open the shared workspace first, or save a separate copy before joining as a contributor.',
    );
  }
  if (!(await remoteBranchExists(dir, baseBranch))) {
    throw new Error(`The shared repository does not have its ${baseBranch} branch yet.`);
  }
  await exec('git', ['checkout', '-b', branch, `origin/${baseBranch}`], dir);
}

async function configureContributor(dir: string, setup: CollaborationSetup, manifest: CollaborationManifest): Promise<CollaborationSettings> {
  const displayName = cleanDisplayName(setup.githubLogin || setup.displayName || (await inferredPrimaryWriter(dir)).displayName);
  const branch = defaultContributorBranch(displayName);
  await checkoutContributorBranch(dir, branch, manifest.primaryBranch);
  await configureGitIdentity(dir, displayName);

  const settings: CollaborationSettings = {
    role: 'contributor',
    branch,
    baseBranch: manifest.primaryBranch,
    displayName,
    ...(setup.githubLogin ? { githubLogin: setup.githubLogin } : {}),
    changeSetTitle: setup.changeSetTitle?.trim() || defaultChangeSetTitle(displayName),
    automaticCheckpoints: setup.automaticCheckpoints !== false,
    checkpointDelayMs: clampCheckpointDelay(setup.checkpointDelayMs),
  };
  const srv = await getServerModules();
  srv.saveConfig({ gitCollaboration: settings });
  return settings;
}

function parseGitHubRepository(remoteUrl: string): { owner: string; repo: string } | null {
  const https = remoteUrl.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
  const ssh = remoteUrl.match(/^(?:git@)?github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/i);
  const match = https || ssh;
  return match ? { owner: match[1], repo: match[2] } : null;
}

async function existingPullRequestWithPat(
  repo: { owner: string; repo: string },
  branch: string,
  baseBranch: string,
  pat: string,
): Promise<string | null> {
  const params = new URLSearchParams({ state: 'open', head: `${repo.owner}:${branch}`, base: baseBranch });
  const response = await fetch(`https://api.github.com/repos/${repo.owner}/${repo.repo}/pulls?${params}`, {
    headers: { Authorization: `Bearer ${pat}`, Accept: 'application/vnd.github+json' },
  });
  if (!response.ok) throw new Error(`GitHub could not check the contributor pull request (${response.status}).`);
  const pulls = await response.json() as Array<{ html_url?: string }>;
  return pulls[0]?.html_url || null;
}

async function createOrUpdatePullRequest(dir: string, settings: CollaborationSettings): Promise<string> {
  if (settings.role !== 'contributor' || settings.branch === settings.baseBranch) {
    throw new Error('A contributor branch is required before OpenWriter can prepare changes for review.');
  }

  const remoteUrl = await exec('git', ['remote', 'get-url', 'origin'], dir);
  const repo = parseGitHubRepository(remoteUrl);
  if (!repo) throw new Error('OpenWriter can create review requests only for GitHub repositories. Your branch is still backed up.');

  const title = settings.changeSetTitle || defaultChangeSetTitle(settings.displayName);
  const body = `Prepared in OpenWriter by ${settings.displayName}.`;
  const token = await repositoryToken();
  if (token) {
    const existing = await existingPullRequestWithPat(repo, settings.branch, settings.baseBranch, token);
    if (existing) return existing;
    const response = await fetch(`https://api.github.com/repos/${repo.owner}/${repo.repo}/pulls`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/vnd.github+json',
      },
      body: JSON.stringify({ title, head: settings.branch, base: settings.baseBranch, body }),
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({})) as { message?: string };
      throw new Error(payload.message || `GitHub could not create the review request (${response.status}).`);
    }
    return (await response.json() as { html_url: string }).html_url;
  }

  if (await isGhAuthenticated()) {
    try {
      const existing = await exec('gh', ['pr', 'view', '--head', settings.branch, '--json', 'url', '--jq', '.url'], dir, NETWORK_TIMEOUT);
      if (existing) return existing;
    } catch { /* no existing PR — create one below */ }
    return exec('gh', [
      'pr', 'create', '--base', settings.baseBranch, '--head', settings.branch,
      '--title', title, '--body', body,
    ], dir, NETWORK_TIMEOUT);
  }

  throw new Error('Your contributor branch is backed up, but GitHub sign-in is needed to create its review request.');
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

export async function setupWithGh(repoName: string, isPrivate: boolean, collaboration: CollaborationSetup = {}): Promise<void> {
  const srv = await getServerModules();
  const dir = await dataDir();
  await initRepo();
  const githubLogin = collaboration.githubLogin || await githubLoginWithGh();
  await configurePrimaryWriter(dir, { ...collaboration, role: 'primary', ...(githubLogin ? { githubLogin } : {}) });
  await initialCommit();

  const visibility = isPrivate ? '--private' : '--public';
  await exec('gh', ['repo', 'create', repoName, visibility, '--source=.', '--remote=origin'], dir, NETWORK_TIMEOUT);
  await exec('gh', ['auth', 'setup-git'], dir, NETWORK_TIMEOUT);
  await exec('git', ['push', '-u', 'origin', 'main'], dir, NETWORK_TIMEOUT);

  srv.saveConfig({
    gitConfigured: true,
    repoName,
    lastSyncTime: new Date().toISOString(),
  });
  currentSyncState = 'synced';
}

export async function setupWithPat(pat: string, repoName: string, isPrivate: boolean, collaboration: CollaborationSetup = {}): Promise<void> {
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
  const githubLogin = collaboration.githubLogin || repo.owner?.login || await githubLoginWithToken(pat);
  await configurePrimaryWriter(dir, { ...collaboration, role: 'primary', ...(githubLogin ? { githubLogin } : {}) });
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

/** Create the first private writing repository using a token already stored in
 * macOS Keychain by the GitHub device flow. The token is deliberately not
 * copied into OpenWriter's JSON config. */
export async function setupWithOAuth(repoName: string, isPrivate: boolean, collaboration: CollaborationSetup = {}): Promise<void> {
  const srv = await getServerModules();
  const dir = await dataDir();
  const token = await getOAuthAccessToken();
  if (!token) throw new Error('Pair a GitHub account before creating private backup.');

  const res = await fetch('https://api.github.com/user/repos', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
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
  const remoteUrl = `https://github.com/${repo.full_name}.git`;

  await initRepo();
  const githubLogin = collaboration.githubLogin || await githubLoginWithToken(token);
  await configurePrimaryWriter(dir, { ...collaboration, role: 'primary', ...(githubLogin ? { githubLogin } : {}) });
  await initialCommit();
  try { await exec('git', ['remote', 'remove', 'origin'], dir); } catch { /* no remote */ }
  await exec('git', ['remote', 'add', 'origin', remoteUrl], dir);
  await execGitWithPat(['push', '-u', 'origin', 'main'], dir, token, NETWORK_TIMEOUT);

  srv.saveConfig({
    gitConfigured: true,
    gitPat: undefined,
    repoName,
    gitRemote: repo.html_url,
    lastSyncTime: new Date().toISOString(),
  });
  currentSyncState = 'synced';
}

export async function connectExisting(
  remoteUrl: string,
  pat?: string,
  collaboration: CollaborationSetup = {},
  authMethod: 'oauth' | 'gh' | 'pat' = pat ? 'pat' : 'oauth',
): Promise<void> {
  const srv = await getServerModules();
  const dir = await dataDir();
  // Do not create a local .gitignore before checking out a remote: it could
  // collide with the repository's own file and make a clean workspace look
  // like it has unsaved author work.
  await initRepo({ ensureIgnore: false });

  // MCP-3: keep the remote credential-free; never splice the PAT into the URL.
  // Strip any credentials the caller may have included before storing/using it.
  const finalUrl = sanitizeRemoteUrl(remoteUrl);

  try { await exec('git', ['remote', 'remove', 'origin'], dir); } catch { /* no remote */ }
  await exec('git', ['remote', 'add', 'origin', finalUrl], dir);
  const token = authMethod === 'pat'
    ? pat
    : authMethod === 'oauth'
      ? await getOAuthAccessToken()
      : undefined;
  const githubLogin = collaboration.githubLogin || (authMethod === 'gh'
    ? await githubLoginWithGh()
    : token
      ? await githubLoginWithToken(token)
      : undefined);
  const authenticatedSetup = { ...collaboration, ...(githubLogin ? { githubLogin } : {}) };
  if (!token && await isGhAuthenticated()) {
    // Configure Git to use the existing GitHub CLI session. This is the
    // backwards-compatible sign-in route for people who prefer their existing
    // GitHub CLI session over OpenWriter's device-pairing flow.
    await exec('gh', ['auth', 'setup-git'], dir, NETWORK_TIMEOUT);
  }

  // Read the shared manifest before selecting a role. This tells a second
  // device who owns the primary branch without relying on a locally entered
  // name or an opaque Git setting.
  if (token) await execGitWithPat(['fetch', '--prune', 'origin'], dir, token, NETWORK_TIMEOUT);
  else await exec('git', ['fetch', '--prune', 'origin'], dir, NETWORK_TIMEOUT);
  const defaultBranch = await remoteDefaultBranch(dir, token);
  const remoteManifest = await readRemoteManifest(dir, defaultBranch, token);
  const role = collaboration.role || (remoteManifest ? 'contributor' : 'primary');

  if (role === 'contributor') {
    if (!remoteManifest) {
      throw new Error('This repository does not identify a primary writer yet. Ask the primary writer to finish backup setup before joining as a contributor.');
    }
    await configureContributor(dir, { ...authenticatedSetup, role }, remoteManifest);
  } else {
    // A blank profile can safely adopt the established primary branch. Never
    // check it out over local writing: that case stops with a clear message
    // rather than turning setup into an implicit overwrite.
    const primaryBranch = remoteManifest?.primaryBranch || defaultBranch;
    if (!(await hasHead(dir))) {
      if (await hasUncommittedChanges(dir)) {
        throw new Error('This device already contains local writing. Open the shared workspace first, or preserve this writing separately before connecting it as the primary writer.');
      }
      if (await remoteBranchExists(dir, primaryBranch)) {
        await exec('git', ['checkout', '-b', primaryBranch, `origin/${primaryBranch}`], dir);
      }
    }
    await ensureGitignore();
    await configurePrimaryWriter(dir, { ...authenticatedSetup, role }, remoteManifest, primaryBranch);
    if (!(await hasHead(dir))) await initialCommit(primaryBranch);
    else await commitSetupMetadata(dir);
    const branch = await currentBranch(dir);
    if (token) await execGitWithPat(['push', '-u', 'origin', branch], dir, token, NETWORK_TIMEOUT);
    else await exec('git', ['push', '-u', 'origin', branch], dir, NETWORK_TIMEOUT);
  }

  srv.saveConfig({
    gitConfigured: true,
    gitPat: pat,
    gitRemote: finalUrl,
    lastSyncTime: new Date().toISOString(),
  });
  currentSyncState = 'synced';
  // The repository has just populated this profile on disk. Re-open it before
  // responding so the author immediately sees the connected writing space.
  srv.reloadWorkspaceFromDisk();
}

function isReconciliationProblem(message: string): boolean {
  return /reconcile|both contain new writing|saved local edits while the remote/i.test(message);
}

async function statusWithContext(
  state: SyncState,
  extras: Omit<SyncStatus, 'state' | 'collaboration' | 'primaryWriter'> = {},
): Promise<SyncStatus> {
  const context = await collaborationContext();
  return {
    state,
    ...extras,
    ...(context.settings ? { collaboration: context.settings } : {}),
    ...(context.primaryWriter ? { primaryWriter: context.primaryWriter } : {}),
  };
}

export async function pushSync(onStatus: (status: SyncStatus) => void): Promise<SyncStatus> {
  const srv = await getServerModules();
  const dir = await dataDir();
  const context = await collaborationContext();

  currentSyncState = 'syncing';
  lastError = undefined;
  onStatus(await statusWithContext('syncing'));

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
    const branch = await currentBranch(dir);
    await remoteCommand(['push', '-u', 'origin', branch], dir);

    const now = new Date().toISOString();
    srv.saveConfig({ lastSyncTime: now });
    if (context.settings?.role === 'contributor') {
      try {
        const url = await createOrUpdatePullRequest(dir, context.settings);
        srv.saveConfig({ gitCollaboration: { ...context.settings, pullRequestUrl: url } });
      } catch (err: any) {
        // The branch is safely backed up even if the review request needs a
        // separate GitHub sign-in. Surface that distinction instead of making
        // the author think their work failed to save.
        currentSyncState = 'attention';
        lastError = err?.message || 'The contributor branch is backed up, but needs attention.';
        const attention = await statusWithContext('attention', { lastSyncTime: now, error: lastError });
        onStatus(attention);
        return attention;
      }
    }

    currentSyncState = 'synced';
    const result = await statusWithContext('synced', { lastSyncTime: now, pendingFiles: 0 });
    onStatus(result);
    return result;
  } catch (err: any) {
    currentSyncState = isReconciliationProblem(err?.message || '') ? 'attention' : 'error';
    lastError = err.message;
    const result = await statusWithContext(currentSyncState, { error: err.message });
    onStatus(result);
    return result;
  }
}

function watchedPathIsWorkspaceSource(filename: string | Buffer | null): boolean {
  if (!filename) return false;
  const normalized = String(filename).replace(/\\/g, '/').replace(/^\.\//, '');
  if (!normalized || normalized.startsWith('.git/') || normalized === '.git') return false;
  return !GITIGNORE_ENTRIES.some((entry) => normalized === entry || normalized.startsWith(`${entry}/`));
}

/**
 * Starts the quiet-period backup loop for the active writing profile. The
 * watcher only observes source files that Git tracks; local recovery and
 * review sidecars are explicitly excluded by the same rules as .gitignore.
 */
export async function startAutomaticCheckpoints(onStatus: (status: SyncStatus) => void): Promise<void> {
  if (checkpointWatcher) return;
  const srv = await getServerModules();
  const config = srv.readConfig();
  if (!config.gitConfigured || !(await isGitRepo())) return;

  const dir = await dataDir();
  const schedule = async () => {
    const context = await collaborationContext();
    const settings = context.settings;
    if (!settings?.automaticCheckpoints || checkpointInFlight) return;
    if (checkpointTimer) clearTimeout(checkpointTimer);
    checkpointTimer = setTimeout(async () => {
      checkpointTimer = null;
      if (checkpointInFlight) return;
      checkpointInFlight = true;
      try {
        if ((await countPendingFiles()) > 0) await pushSync(onStatus);
      } finally {
        checkpointInFlight = false;
      }
    }, settings.checkpointDelayMs);
  };

  try {
    checkpointWatcher = watch(dir, { recursive: true }, (_event, filename) => {
      if (!watchedPathIsWorkspaceSource(filename)) return;
      void getSyncStatus().then(onStatus).catch(() => {});
      void schedule();
    });
    checkpointWatcher.on('error', (err) => {
      console.error('[GitHub Plugin] automatic checkpoint watcher failed:', err.message);
      checkpointWatcher?.close();
      checkpointWatcher = null;
    });
  } catch (err: any) {
    console.error('[GitHub Plugin] automatic checkpoint watcher could not start:', err?.message || err);
  }
}

export function stopAutomaticCheckpoints(): void {
  if (checkpointTimer) clearTimeout(checkpointTimer);
  checkpointTimer = null;
  checkpointWatcher?.close();
  checkpointWatcher = null;
}
