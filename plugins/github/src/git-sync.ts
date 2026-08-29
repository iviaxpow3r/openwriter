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
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, watch, writeFileSync, type Dirent, type FSWatcher } from 'fs';
import { randomUUID } from 'crypto';
import { tmpdir } from 'os';
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
const WORKFLOW_MANIFEST_FILE = 'workflows.json';
const WORKFLOWS_PLUGIN_NAME = '@openwriter/plugin-workflows';
const DEFAULT_CHECKPOINT_DELAY_MS = 120_000;
const GITHUB_DEVICE_CLIENT_ID_ENV = 'OPENWRITER_GITHUB_OAUTH_CLIENT_ID';
const KEYCHAIN_SERVICE = 'OpenWriter GitHub';

export type CollaborationRole = 'primary' | 'contributor';
export type SyncState = 'unconfigured' | 'synced' | 'pending' | 'syncing' | 'attention' | 'error';
/**
 * Whether this OpenWriter process can authenticate a Git operation without
 * prompting the author unexpectedly. A saved macOS Keychain pairing remains
 * deliberately inactive until the author explicitly restores it.
 */
export type BackupAuthenticationState = 'ready' | 'restore-required' | 'reconnect-required';

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

interface WorkflowManifest {
  version: 1;
  settings: Record<string, unknown>;
}

export interface CollaborationSetup {
  role?: CollaborationRole;
  displayName?: string;
  githubLogin?: string;
  changeSetTitle?: string;
  automaticCheckpoints?: boolean;
  checkpointDelayMs?: number;
}

export interface CollaborationMember {
  githubLogin: string;
  displayName: string;
  role: 'primary' | 'contributor';
}

export interface PrimaryTransferRequest {
  id: number;
  githubLogin: string;
  displayName: string;
  createdAt?: string;
}

export interface ContributorReviewRequest {
  number: number;
  title: string;
  githubLogin: string;
  displayName: string;
  branch: string;
  url: string;
  changedFiles: number;
  additions: number;
  deletions: number;
  updatedAt?: string;
}

/**
 * A contributor request staged into OpenWriter's normal pending-change
 * surface. This is deliberately local profile state: GitHub remains the
 * durable source for the request, while the active review is the primary
 * writer's in-progress decision on this Mac.
 */
export interface ContributorReviewSession {
  requestNumber: number;
  title: string;
  githubLogin: string;
  branch: string;
  url: string;
  files: string[];
  stagedChanges: number;
  startedAt: string;
}

export interface CollaborationOverview {
  primaryWriter?: PrimaryWriter;
  currentRole?: CollaborationRole;
  currentGitHubLogin?: string;
  contributors: CollaborationMember[];
  reviewRequests: ContributorReviewRequest[];
  activeReviewSession?: ContributorReviewSession;
  transferRequests: PrimaryTransferRequest[];
  canRequestPrimary: boolean;
  canApproveTransfers: boolean;
  canClaimPrimary: boolean;
  requestAlreadyOpen: boolean;
  /** Role details remain locally visible, but GitHub access is needed before
   * OpenWriter can refresh people, requests, or transfer controls. */
  needsGitHubSignIn: boolean;
  /** A profile-scoped OpenWriter sign-in can be explicitly restored. */
  savedGitHubSignIn: boolean;
}

export type ReconciliationState = 'up-to-date' | 'remote-updates' | 'local-changes' | 'diverged' | 'resolving' | 'ready-to-apply';

export interface ReconciliationConflict {
  path: string;
  localContent?: string;
  githubContent?: string;
}

export interface ReconciliationOverview {
  state: ReconciliationState;
  branch: string;
  remoteBranch: string;
  localCommits: number;
  githubCommits: number;
  localEdits: number;
  localFiles: string[];
  githubFiles: string[];
  conflicts: ReconciliationConflict[];
  recoveryBranch?: string;
  message?: string;
}

export interface SyncStatus {
  state: SyncState;
  lastSyncTime?: string;
  pendingFiles?: number;
  /** The locally scheduled automatic GitHub checkpoint, when one is pending. */
  nextAutomaticCheckpointAt?: string;
  error?: string;
  /** Present for a configured writing space. */
  backupAuthentication?: BackupAuthenticationState;
  collaboration?: CollaborationSettings;
  primaryWriter?: PrimaryWriter;
}

export interface SyncCapabilities {
  gitInstalled: boolean;
  ghInstalled: boolean;
  ghAuthenticated: boolean;
  deviceAuthAvailable: boolean;
  oauthAuthenticated: boolean;
  /** A prior GitHub pairing exists, but Keychain access has not been requested in this app session. */
  oauthSaved: boolean;
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
  /** Read-only GitHub inspection used to guide the writing-space picker. */
  kind: GitHubRepositoryKind;
  markdownFiles?: number;
  workspaceFiles?: number;
  primaryWriter?: PrimaryWriter;
}

/**
 * OpenWriter never needs a subjective "is this good writing?" judgment. It
 * only classifies the repository structure so setup can explain the concrete
 * consequence of connecting it before it writes any OpenWriter metadata.
 */
export type GitHubRepositoryKind = 'openwriter' | 'markdown' | 'empty' | 'other' | 'unknown';

export interface GitHubRepositoryInspection {
  kind: GitHubRepositoryKind;
  markdownFiles: number;
  workspaceFiles: number;
  defaultBranch?: string;
  primaryWriter?: PrimaryWriter;
}

let currentSyncState: SyncState = 'unconfigured';
let lastError: string | undefined;
let checkpointWatcher: FSWatcher | null = null;
let checkpointTimer: ReturnType<typeof setTimeout> | null = null;
let checkpointInFlight = false;
// This is intentionally process-local: a restart clears a pending timer, so
// the UI must not promise a specific time that no longer exists.
let nextAutomaticCheckpointAt: string | undefined;
const pendingDeviceAuthorizations = new Map<string, {
  deviceCode: string;
  expiresAt: number;
  intervalMs: number;
  nextPollAt: number;
}>();
// A GitHub pairing is immediately useful to the setup screen. Keep it in
// memory for this OpenWriter process so repository selection does not reopen
// the macOS Keychain immediately after the author has approved GitHub access.
// It is keyed by writing profile: switching profiles must never silently reuse
// another profile's GitHub account.
const cachedOAuthCredentials = new Map<string, OAuthCredential>();

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
 * Like exec(), but supplies a sensitive value through stdin so the native
 * Keychain helper never receives an OAuth token in argv or the process list.
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
  // Some older macOS Git builds do not consistently invoke an inline
  // credential helper when launched from an app process. Keep the helper as
  // the first choice, then provide Git's standard askpass fallback. The
  // temporary script contains no credential, reads only OW_GIT_PAT from this
  // one child process, and is removed immediately after the Git command.
  const askpassPath = join(tmpdir(), `openwriter-git-askpass-${randomUUID()}.sh`);
  writeFileSync(
    askpassPath,
    `#!/bin/sh\ncase "$1" in\n  *Username*) printf '%s' x-access-token ;;\n  *) printf '%s' "$OW_GIT_PAT" ;;\nesac\n`,
    { mode: 0o700 },
  );
  chmodSync(askpassPath, 0o700);
  return exec('git', [...authArgs, ...args], cwd, timeout, {
    OW_GIT_PAT: pat,
    GIT_ASKPASS: askpassPath,
    GIT_ASKPASS_REQUIRE: 'force',
    GIT_TERMINAL_PROMPT: '0',
  }).finally(() => {
    try { unlinkSync(askpassPath); } catch { /* best-effort cleanup */ }
  });
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
  const account = await keychainAccount();
  const cached = cachedOAuthCredentials.get(account);
  if (cached) return cached;
  if (process.platform !== 'darwin') return undefined;
  try {
    const raw = await exec(keychainHelperPath(), ['read', KEYCHAIN_SERVICE, account], await dataDir());
    // The first implementation stored only the access token. Preserve that
    // pairing if it already exists while new pairings use the richer record.
    try {
      const parsed = JSON.parse(raw) as OAuthCredential;
      if (parsed?.accessToken) cachedOAuthCredentials.set(account, parsed);
    } catch {
      if (raw) cachedOAuthCredentials.set(account, { accessToken: raw });
    }
    return cachedOAuthCredentials.get(account);
  } catch {
    return undefined;
  }
}

function keychainHelperPath(): string {
  return join(dirname(process.execPath), '..', 'OpenWriterKeychain');
}

async function storeOAuthCredential(credential: OAuthCredential): Promise<void> {
  if (process.platform !== 'darwin') {
    throw new Error('Secure GitHub pairing is currently available on macOS only.');
  }
  // The `security` command cannot consume -w credential data from a pipe: it
  // creates an empty record in a non-interactive app. The bundled native
  // helper uses Security.framework instead, accepting only service/account in
  // argv and receiving the opaque credential JSON on stdin.
  const keychainHelper = keychainHelperPath();
  if (!existsSync(keychainHelper)) {
    throw new Error('This OpenWriter installation is missing its secure GitHub credential helper. Reinstall the app and sign in again.');
  }
  const account = await keychainAccount();
  await execWithInput(
    keychainHelper,
    ['write', KEYCHAIN_SERVICE, account],
    await dataDir(),
    JSON.stringify(credential),
  );
  cachedOAuthCredentials.set(account, credential);
}

/**
 * Forget the device-pairing credential for the active writing profile. This
 * deliberately does not touch the browser's GitHub session, the GitHub CLI,
 * or any repository. Those are owned outside OpenWriter and may be shared by
 * other profiles or applications.
 */
async function deleteOAuthCredential(): Promise<void> {
  const account = await keychainAccount();
  cachedOAuthCredentials.delete(account);
  if (process.platform !== 'darwin') return;

  const keychainHelper = keychainHelperPath();
  if (!existsSync(keychainHelper)) {
    throw new Error('This OpenWriter installation is missing its secure GitHub credential helper. Reinstall the app before changing accounts.');
  }
  await exec(keychainHelper, ['delete', KEYCHAIN_SERVICE, account], await dataDir());
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
  return (await readProfileSyncConfig()).gitPat || getOAuthAccessToken();
}

/**
 * Return only a credential that is already active in this OpenWriter process.
 * This is deliberately different from repositoryToken(): opening a read-only
 * role panel must not unexpectedly ask macOS for Keychain access. The author
 * can explicitly restore a saved session from that panel when it is needed.
 */
async function activeRepositoryToken(): Promise<string | undefined> {
  const config = await readProfileSyncConfig();
  if (config.gitPat) return config.gitPat;
  return cachedOAuthCredentials.get(await keychainAccount())?.accessToken;
}

/**
 * Check whether a configured writing space can make an authenticated GitHub
 * request now. This intentionally never reads Keychain: opening OpenWriter or
 * viewing backup status must not surface a macOS password prompt. The author
 * chooses "Use saved GitHub sign-in" before we unlock the durable pairing.
 */
async function backupAuthenticationState(config: ProfileSyncConfig): Promise<BackupAuthenticationState> {
  if (config.gitPat) return 'ready';
  if (cachedOAuthCredentials.get(await keychainAccount())?.accessToken) return 'ready';
  if (config.gitOAuthLogin) return 'restore-required';
  // A GitHub CLI pairing can provide Git credentials even though OpenWriter
  // does not own its token. Only ask the CLI when there is no saved
  // OpenWriter pairing to restore.
  if (await isGhInstalled() && await isGhAuthenticated()) return 'ready';
  return 'reconnect-required';
}

function backupAuthenticationMessage(state: BackupAuthenticationState): string {
  return state === 'restore-required'
    ? 'Reconnect your saved GitHub sign-in before this Mac can back up your writing.'
    : 'Connect GitHub before this Mac can back up your writing.';
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
  const config = await readProfileSyncConfig();
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
  default_branch?: unknown;
  permissions?: { push?: unknown };
}

interface GitHubRepositoryDetailResponse {
  default_branch?: unknown;
}

interface GitHubTreeResponse {
  truncated?: unknown;
  tree?: Array<{ path?: unknown; type?: unknown }>;
}

interface GitHubContentResponse {
  encoding?: unknown;
  content?: unknown;
}

interface GitHubRequestAuthentication {
  kind: 'token' | 'gh';
  token?: string;
}

function normalizeGitHubLogin(value?: string): string | undefined {
  const normalized = value?.trim().toLocaleLowerCase();
  return normalized || undefined;
}

/** GitHub login is authoritative when it exists. Older workspaces may have
 * only a display name, so retain that comparison as a backwards-compatible
 * fallback until their primary writer next connects with GitHub. */
function writerMatches(primary: PrimaryWriter, githubLogin?: string, displayName?: string): boolean {
  const primaryLogin = normalizeGitHubLogin(primary.githubLogin);
  const currentLogin = normalizeGitHubLogin(githubLogin);
  if (primaryLogin || currentLogin) return Boolean(primaryLogin && currentLogin && primaryLogin === currentLogin);
  return Boolean(displayName && primary.displayName.trim().toLocaleLowerCase() === displayName.trim().toLocaleLowerCase());
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
      kind: 'unknown',
      ...(typeof repo.updated_at === 'string' ? { updatedAt: repo.updated_at } : {}),
    }];
  });
}

const ACCESSIBLE_REPOSITORIES_PATH = '/user/repos?affiliation=owner,collaborator,organization_member&per_page=100&sort=updated&direction=desc';

async function resolveGitHubRequestAuthentication(
  authMethod: 'oauth' | 'gh' | 'pat',
  pat?: string,
): Promise<GitHubRequestAuthentication> {
  if (authMethod === 'oauth') {
    const token = await getOAuthAccessToken();
    if (!token) throw new Error('Your GitHub sign-in has expired. Sign in again to choose a repository.');
    return { kind: 'token', token };
  }
  if (authMethod === 'pat') {
    if (!pat?.trim()) throw new Error('Enter a personal access token before checking this repository.');
    return { kind: 'token', token: pat.trim() };
  }
  if (!(await isGhAuthenticated())) {
    throw new Error('Sign in with GitHub on this Mac before choosing a repository.');
  }
  return { kind: 'gh' };
}

/** A small GitHub API wrapper for setup-time inspection. It deliberately
 * accepts an already-resolved authentication method so listing a repository
 * never exposes or stores a credential in the browser. */
async function githubApiWithAuthentication<T>(
  authentication: GitHubRequestAuthentication,
  path: string,
): Promise<T> {
  if (authentication.kind === 'token') {
    const response = await fetch(`https://api.github.com${path}`, {
      headers: { Authorization: `Bearer ${authentication.token}`, Accept: 'application/vnd.github+json' },
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({})) as { message?: string };
      throw new Error(payload.message || `GitHub could not inspect this repository (${response.status}).`);
    }
    return response.json() as Promise<T>;
  }

  const output = await exec('gh', ['api', path], await dataDir(), NETWORK_TIMEOUT);
  return JSON.parse(output) as T;
}

function collaborationManifestFromValue(value: unknown): CollaborationManifest | null {
  if (!value || typeof value !== 'object') return null;
  const parsed = value as Partial<CollaborationManifest>;
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
}

function isAuthorMarkdownPath(path: string): boolean {
  const normalized = path.toLocaleLowerCase();
  if (!normalized.endsWith('.md')) return false;
  if (/^(?:node_modules|vendor|dist|build|coverage|\.git)\//.test(normalized)) return false;
  // A lone README is normally project documentation, not an author's draft.
  // Excluding the common project files lets the picker surface actual Markdown
  // writing without presenting every code repository as a writing space.
  return !/(?:^|\/)(?:readme|changelog|contributing|code_of_conduct|security|license)\.md$/i.test(normalized);
}

async function remoteCollaborationManifest(
  repository: { owner: string; repo: string },
  branch: string,
  authentication: GitHubRequestAuthentication,
): Promise<CollaborationManifest | null> {
  try {
    const path = `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}/contents/${COLLABORATION_DIR}/${COLLABORATION_FILE}?ref=${encodeURIComponent(branch)}`;
    const file = await githubApiWithAuthentication<GitHubContentResponse>(authentication, path);
    if (file.encoding !== 'base64' || typeof file.content !== 'string') return null;
    const decoded = Buffer.from(file.content.replace(/\s/g, ''), 'base64').toString('utf-8');
    return collaborationManifestFromValue(JSON.parse(decoded));
  } catch {
    // A missing/invalid manifest is a meaningful result for the picker, not a
    // setup error. The classifier below still reports ordinary Markdown files.
    return null;
  }
}

async function inspectGitHubRepository(
  remoteUrl: string,
  authentication: GitHubRequestAuthentication,
): Promise<GitHubRepositoryInspection> {
  const repository = parseGitHubRepository(remoteUrl);
  if (!repository) {
    throw new Error('OpenWriter can inspect GitHub repository links only. Paste a github.com repository link or choose one from the list.');
  }

  const repoPath = `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}`;
  const details = await githubApiWithAuthentication<GitHubRepositoryDetailResponse>(authentication, repoPath);
  const defaultBranch = typeof details.default_branch === 'string' && details.default_branch.trim()
    ? details.default_branch.trim()
    : undefined;
  if (!defaultBranch) {
    return { kind: 'empty', markdownFiles: 0, workspaceFiles: 0 };
  }

  let tree: GitHubTreeResponse;
  try {
    tree = await githubApiWithAuthentication<GitHubTreeResponse>(
      authentication,
      `${repoPath}/git/trees/${encodeURIComponent(defaultBranch)}?recursive=1`,
    );
  } catch (error: any) {
    // GitHub returns this for a freshly-created repository without a commit.
    if (/empty/i.test(error?.message || '')) {
      return { kind: 'empty', markdownFiles: 0, workspaceFiles: 0, defaultBranch };
    }
    throw error;
  }

  const paths = (tree.tree || [])
    .filter((entry) => entry.type === 'blob' && typeof entry.path === 'string')
    .map((entry) => entry.path as string);
  const markdownFiles = paths.filter(isAuthorMarkdownPath).length;
  const workspaceFiles = paths.filter((path) => /^_workspaces\/[^/]+\.json$/i.test(path) && !/_order\.json$/i.test(path)).length;
  const hasCollaborationManifest = paths.includes(`${COLLABORATION_DIR}/${COLLABORATION_FILE}`);
  const manifest = hasCollaborationManifest
    ? await remoteCollaborationManifest(repository, defaultBranch, authentication)
    : null;

  if (hasCollaborationManifest) {
    return {
      kind: 'openwriter',
      markdownFiles,
      workspaceFiles,
      defaultBranch,
      ...(manifest ? { primaryWriter: manifest.primaryWriter } : {}),
    };
  }
  if (!paths.length) return { kind: 'empty', markdownFiles: 0, workspaceFiles: 0, defaultBranch };
  // A single chapter or essay is enough to adopt a Markdown writing space.
  // The author explicitly selects it, and setup adds only OpenWriter's small
  // collaboration manifest; it never rewrites the document itself.
  if (workspaceFiles > 0 || markdownFiles > 0) {
    return { kind: 'markdown', markdownFiles, workspaceFiles, defaultBranch };
  }
  // A truncated tree cannot safely rule a repository out. Keep it available
  // through the ordinary repository list, but do not present it as a writing
  // space recommendation.
  if (tree.truncated === true) return { kind: 'unknown', markdownFiles, workspaceFiles, defaultBranch };
  return { kind: 'other', markdownFiles, workspaceFiles, defaultBranch };
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await mapper(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

/**
 * List recent repositories the signed-in person can write to. This keeps the
 * setup choice useful for shared author spaces while never exposing an access
 * token to the browser or storing it in OpenWriter's config.
 */
export async function listAccessibleRepositories(authMethod: 'oauth' | 'gh'): Promise<GitHubRepositoryOption[]> {
  const authentication = await resolveGitHubRequestAuthentication(authMethod);
  const repositories = repositoryOptions(await githubApiWithAuthentication<unknown>(authentication, ACCESSIBLE_REPOSITORIES_PATH));
  return mapWithConcurrency(repositories, 5, async (repository) => {
    try {
      return { ...repository, ...await inspectGitHubRepository(repository.cloneUrl, authentication) };
    } catch {
      // An individual inspection must not hide the rest of the author's
      // repository list. Unknown repositories remain available under the
      // explicit "other repositories" disclosure in setup.
      return repository;
    }
  });
}

export async function inspectAccessibleRepository(
  remoteUrl: string,
  authMethod: 'oauth' | 'gh' | 'pat',
  pat?: string,
): Promise<GitHubRepositoryInspection> {
  return inspectGitHubRepository(remoteUrl, await resolveGitHubRequestAuthentication(authMethod, pat));
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
    // The paired account belongs to the current writing profile. Its actual
    // token remains in Keychain; this is only the safe account label used by
    // setup and collaboration checks.
    await saveProfileSyncConfig({ gitPat: undefined, gitOAuthLogin: user.login || undefined });
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

/**
 * A profile is a separate writing context. GitHub setup therefore has to be
 * stored by profile as well: its repository, sign-in identity, collaboration
 * role, and backup cadence must not leak into another author's profile.
 *
 * The original GitHub plugin used top-level config fields. The small migration
 * below adopts those fields into whichever profile is active the first time a
 * newer build opens that existing installation, then clears the legacy copy.
 */
interface ProfileSyncConfig {
  gitConfigured?: boolean;
  gitRemote?: string;
  lastSyncTime?: string;
  gitPat?: string;
  gitOAuthLogin?: string;
  repoName?: string;
  gitCollaboration?: CollaborationSettings;
  contributorReview?: ContributorReviewSession;
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function withoutUndefined<T extends Record<string, any>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

function legacyProfileSyncConfig(config: Record<string, any>): ProfileSyncConfig {
  return withoutUndefined({
    gitConfigured: typeof config.gitConfigured === 'boolean' ? config.gitConfigured : undefined,
    gitRemote: typeof config.gitRemote === 'string' ? config.gitRemote : undefined,
    lastSyncTime: typeof config.lastSyncTime === 'string' ? config.lastSyncTime : undefined,
    gitPat: typeof config.gitPat === 'string' ? config.gitPat : undefined,
    gitOAuthLogin: typeof config.gitOAuthLogin === 'string' ? config.gitOAuthLogin : undefined,
    repoName: typeof config.repoName === 'string' ? config.repoName : undefined,
    gitCollaboration: isCollaborationSettings(config.gitCollaboration) ? config.gitCollaboration : undefined,
  });
}

function clearLegacyProfileSyncConfig(): Record<string, undefined> {
  return {
    gitConfigured: undefined,
    gitRemote: undefined,
    lastSyncTime: undefined,
    gitPat: undefined,
    gitOAuthLogin: undefined,
    repoName: undefined,
    gitCollaboration: undefined,
  };
}

async function currentProfileKey(): Promise<string> {
  return basename(await dataDir());
}

async function readProfileSyncConfig(): Promise<ProfileSyncConfig> {
  const srv = await getServerModules();
  const config = srv.readConfig() as Record<string, any>;
  const profile = await currentProfileKey();
  if (isRecord(config.gitProfiles)) {
    const saved = config.gitProfiles[profile];
    return isRecord(saved) ? saved as ProfileSyncConfig : {};
  }

  // One-time compatibility migration. At this point the active profile is the
  // only profile that could have owned the former app-wide Git configuration.
  const legacy = legacyProfileSyncConfig(config);
  if (Object.keys(legacy).length) {
    srv.saveConfig({
      gitProfiles: { [profile]: legacy },
      ...clearLegacyProfileSyncConfig(),
    });
  }
  return legacy;
}

async function saveProfileSyncConfig(updates: Partial<ProfileSyncConfig>): Promise<ProfileSyncConfig> {
  const srv = await getServerModules();
  const config = srv.readConfig() as Record<string, any>;
  const profile = await currentProfileKey();
  const profiles = isRecord(config.gitProfiles) ? { ...config.gitProfiles } : {};
  const existing = isRecord(profiles[profile])
    ? profiles[profile] as ProfileSyncConfig
    : (isRecord(config.gitProfiles) ? {} : legacyProfileSyncConfig(config));
  const next = withoutUndefined({ ...existing, ...updates }) as ProfileSyncConfig;
  profiles[profile] = next;
  srv.saveConfig({
    gitProfiles: profiles,
    ...clearLegacyProfileSyncConfig(),
  });
  return next;
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

function workflowManifestPath(dir: string): string {
  return join(dir, COLLABORATION_DIR, WORKFLOW_MANIFEST_FILE);
}

function workflowManifestFromValue(value: unknown): WorkflowManifest | null {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.settings)) return null;
  return { version: 1, settings: value.settings };
}

function readWorkflowManifest(dir: string): WorkflowManifest | null {
  const path = workflowManifestPath(dir);
  if (!existsSync(path)) return null;
  try {
    return workflowManifestFromValue(JSON.parse(readFileSync(path, 'utf-8')));
  } catch {
    return null;
  }
}

/** Apply a repository-owned workflow definition to this local writing profile. */
async function restoreWorkflowSettingsFromRepository(dir: string): Promise<boolean> {
  const manifest = readWorkflowManifest(dir);
  if (!manifest) return false;
  const srv = await getServerModules();
  srv.writeProfilePluginData(WORKFLOWS_PLUGIN_NAME, manifest.settings);
  return true;
}

/**
 * Materialize existing local workflow settings into the portable writing-space
 * manifest only when it does not already exist. This migrates older profiles
 * that kept workflow definitions only in app config, without overwriting a
 * repository-owned workflow definition with stale local settings.
 */
async function writeWorkflowSettingsToRepository(dir: string): Promise<boolean> {
  const path = workflowManifestPath(dir);
  if (existsSync(path)) return false;

  const srv = await getServerModules();
  const settings = srv.readProfilePluginData<Record<string, unknown>>(WORKFLOWS_PLUGIN_NAME);
  if (!isRecord(settings)) return false;

  const next = `${JSON.stringify({ version: 1, settings }, null, 2)}\n`;
  mkdirSync(join(dir, COLLABORATION_DIR), { recursive: true });
  writeFileSync(path, next, 'utf-8');
  return true;
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
    return collaborationManifestFromValue(JSON.parse(readFileSync(path, 'utf-8')));
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
  const config = await readProfileSyncConfig();
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
  const config = await readProfileSyncConfig();

  if (!config.gitConfigured || !(await isGitRepo())) {
    return { state: 'unconfigured' };
  }

  const context = await collaborationContext();
  const details = {
    ...(context.settings ? { collaboration: context.settings } : {}),
    ...(context.primaryWriter ? { primaryWriter: context.primaryWriter } : {}),
  };
  const backupAuthentication = await backupAuthenticationState(config);

  // A selected repository alone is not evidence that this app session can
  // back up. Surface the safe, actionable state before a push can reach Git
  // and produce a confusing credential error.
  if (backupAuthentication !== 'ready') {
    return {
      state: 'attention',
      error: backupAuthenticationMessage(backupAuthentication),
      backupAuthentication,
      lastSyncTime: config.lastSyncTime,
      ...details,
    };
  }

  if (currentSyncState === 'syncing') {
    return { state: 'syncing', backupAuthentication, ...details };
  }

  if ((currentSyncState === 'error' || currentSyncState === 'attention') && lastError) {
    return { state: currentSyncState, error: lastError, backupAuthentication, lastSyncTime: config.lastSyncTime, ...details };
  }

  const pending = await countPendingFiles();
  return {
    state: pending > 0 ? 'pending' : 'synced',
    pendingFiles: pending,
    lastSyncTime: config.lastSyncTime,
    backupAuthentication,
    ...(pending > 0 && nextAutomaticCheckpointAt ? { nextAutomaticCheckpointAt } : {}),
    ...details,
  };
}

export async function getCapabilities(): Promise<SyncCapabilities> {
  // Do not make opening the setup panel trigger a macOS Keychain prompt. A
  // fresh browser pairing keeps its credential in memory; a later app launch
  // offers an explicit “Use saved GitHub sign-in” action before touching
  // Keychain again.
  const [git, gh] = await Promise.all([isGitInstalled(), isGhInstalled()]);
  const config = await readProfileSyncConfig();
  const oauthToken = cachedOAuthCredentials.get(await keychainAccount())?.accessToken;
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
    oauthSaved: Boolean(config.gitOAuthLogin),
    ...(githubLogin ? { githubLogin } : {}),
    existingRepo: await isGitRepo(),
    remoteUrl,
    primaryWriter,
  };
}

/** Restore the durable pairing only after the author explicitly asks to use it.
 * This is the sole Keychain-read path after an app restart. */
export async function restoreOAuthSession(): Promise<SyncCapabilities> {
  const token = await getOAuthAccessToken();
  if (!token) {
    throw new Error('OpenWriter could not access the saved GitHub sign-in. Choose “Sign in with GitHub” to reconnect.');
  }
  // Any prior unauthenticated Git failure is now stale. Status calculation
  // below will accurately report whether there are changes waiting to back up.
  currentSyncState = 'synced';
  lastError = undefined;
  return getCapabilities();
}

/** Forget the current profile's OpenWriter device pairing. A later profile
 * setup can pair a different GitHub account without affecting the browser,
 * GitHub CLI, local writing, Git history, or the remote repository. */
export async function disconnectCurrentProfileGitHubAccount(): Promise<SyncCapabilities> {
  await deleteOAuthCredential();
  await saveProfileSyncConfig({ gitPat: undefined, gitOAuthLogin: undefined });
  return getCapabilities();
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

/**
 * A profile starts with one metadata-only Untitled document so the editor has
 * somewhere to focus. That is not author writing, and it must not prevent a
 * new profile from opening an established shared writing space. Be deliberately
 * strict: anything beyond this exact starter shape remains protected.
 */
function disposableStarterFiles(dir: string): string[] | null {
  let entries: Dirent<string>[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }

  const documents = entries.filter((entry) => entry.isFile() && entry.name.endsWith('.md'));
  if (documents.length > 1) return null;
  const starter = documents[0];
  if (starter) {
    if (!/^_untitled-[0-9a-f-]+\.md$/i.test(starter.name)) return null;
    let content = '';
    try {
      content = readFileSync(join(dir, starter.name), 'utf-8');
    } catch {
      return null;
    }
    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
    if (!match || match[2].trim()) return null;
    try {
      const metadata = JSON.parse(match[1]) as { title?: unknown };
      if (metadata.title !== 'Untitled') return null;
    } catch {
      return null;
    }
  }

  // The initial empty profile can either still have its blank Untitled file,
  // or have only the empty folders the editor creates before its first save.
  // Any other entry, a non-empty system folder, or more than one document is
  // treated as author state and left untouched.
  const allowed = new Set([
    ...(starter ? [starter.name] : []),
    '_doc-order.json',
    '_images',
    '_workspaces',
    '.git',
    '.DS_Store',
  ]);
  if (entries.some((entry) => !allowed.has(entry.name))) return null;
  for (const directory of entries.filter((entry) => entry.isDirectory() && (entry.name === '_images' || entry.name === '_workspaces'))) {
    try {
      if (readdirSync(join(dir, directory.name)).length) return null;
    } catch {
      return null;
    }
  }

  return [
    ...(starter ? [starter.name] : []),
    ...(entries.some((entry) => entry.name === '_doc-order.json') ? ['_doc-order.json'] : []),
  ];
}

function discardDisposableStarterWorkspace(dir: string): boolean {
  const files = disposableStarterFiles(dir);
  if (!files) return false;
  for (const file of files) {
    try { unlinkSync(join(dir, file)); }
    catch { return false; }
  }
  return true;
}

async function readRemoteManifest(dir: string, branch: string, pat?: string): Promise<CollaborationManifest | null> {
  try {
    const ref = `origin/${branch}:${COLLABORATION_DIR}/${COLLABORATION_FILE}`;
    const output = pat
      ? await execGitWithPat(['show', ref], dir, pat, NETWORK_TIMEOUT)
      : await exec('git', ['show', ref], dir, NETWORK_TIMEOUT);
    return collaborationManifestFromValue(JSON.parse(output));
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
  const paths = [
    '.gitignore',
    join(COLLABORATION_DIR, COLLABORATION_FILE),
    join(COLLABORATION_DIR, WORKFLOW_MANIFEST_FILE),
  ]
    .filter((path) => existsSync(join(dir, path)));
  if (!paths.length) return;
  await exec('git', ['add', '--', ...paths], dir);
  try {
    await exec('git', ['diff', '--cached', '--quiet'], dir);
    return;
  } catch {
    await exec('git', ['commit', '-m', 'Configure OpenWriter writing space'], dir);
  }
}

async function configurePrimaryWriter(
  dir: string,
  setup: CollaborationSetup,
  existing?: CollaborationManifest | null,
  fallbackPrimaryBranch = 'main',
): Promise<CollaborationSettings> {
  const displayName = cleanDisplayName(setup.githubLogin || setup.displayName || (await inferredPrimaryWriter(dir)).displayName);
  if (existing && !writerMatches(existing.primaryWriter, setup.githubLogin, displayName)) {
    throw new Error(
      `${existing.primaryWriter.displayName} is the primary writer for this repository. Connect as a contributor, then request a transfer in Writing roles if that responsibility should change.`,
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
  await saveProfileSyncConfig({ gitCollaboration: settings });
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
      'This profile contains local writing, so OpenWriter did not replace it. Keep this writing here, then use a new profile to join the shared writing space as a contributor.',
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
  await saveProfileSyncConfig({ gitCollaboration: settings });
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

async function mergeInProgress(dir: string): Promise<boolean> {
  try {
    await exec('git', ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'], dir);
    return true;
  } catch {
    return false;
  }
}

async function refExists(dir: string, ref: string): Promise<boolean> {
  try {
    await exec('git', ['rev-parse', '--verify', '--quiet', ref], dir);
    return true;
  } catch {
    return false;
  }
}

async function changedFilesFrom(dir: string, from: string, to: string): Promise<string[]> {
  try {
    const output = await exec('git', ['diff', '--name-only', `${from}..${to}`], dir, NETWORK_TIMEOUT);
    return output.split('\n').map((path) => path.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function isPreviewableWritingFile(path: string): boolean {
  return /(?:\.md|\.markdown|\.mdx|\.txt|\.json|\.ya?ml)$/i.test(path);
}

async function readRefText(dir: string, ref: string, path: string): Promise<string | undefined> {
  if (!isPreviewableWritingFile(path)) return undefined;
  try {
    return await exec('git', ['show', `${ref}:${path}`], dir, NETWORK_TIMEOUT);
  } catch {
    return undefined;
  }
}

async function reconciliationConflicts(dir: string): Promise<ReconciliationConflict[]> {
  const output = await exec('git', ['diff', '--name-only', '--diff-filter=U'], dir, NETWORK_TIMEOUT);
  const paths = output.split('\n').map((path) => path.trim()).filter(Boolean);
  return Promise.all(paths.map(async (path) => ({
    path,
    ...(await readRefText(dir, 'HEAD', path) ? { localContent: await readRefText(dir, 'HEAD', path) } : {}),
    ...(await readRefText(dir, 'MERGE_HEAD', path) ? { githubContent: await readRefText(dir, 'MERGE_HEAD', path) } : {}),
  })));
}

async function localRecoveryBranch(dir: string): Promise<string> {
  const now = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').toLowerCase();
  const branch = `openwriter/recovery/${now}`;
  await exec('git', ['branch', branch, 'HEAD'], dir);
  return branch;
}

async function reconciliationOverview(dir: string, message?: string): Promise<ReconciliationOverview> {
  const branch = await currentBranch(dir);
  const remoteBranch = `origin/${branch}`;
  const localEdits = await countPendingFiles();

  if (await mergeInProgress(dir)) {
    const conflicts = await reconciliationConflicts(dir);
    return {
      state: conflicts.length ? 'resolving' : 'ready-to-apply',
      branch,
      remoteBranch,
      localCommits: 0,
      githubCommits: 0,
      localEdits,
      localFiles: [],
      githubFiles: [],
      conflicts,
      ...(message ? { message } : {}),
    };
  }

  if (!(await refExists(dir, remoteBranch))) {
    return {
      state: localEdits ? 'local-changes' : 'up-to-date',
      branch,
      remoteBranch,
      localCommits: 0,
      githubCommits: 0,
      localEdits,
      localFiles: [],
      githubFiles: [],
      conflicts: [],
      ...(message ? { message } : {}),
    };
  }

  const counts = await exec('git', ['rev-list', '--left-right', '--count', `HEAD...${remoteBranch}`], dir, NETWORK_TIMEOUT);
  const [localCommits = 0, githubCommits = 0] = counts.trim().split(/\s+/).map(Number);
  let localFiles: string[] = [];
  let githubFiles: string[] = [];
  if (localCommits || githubCommits) {
    try {
      const base = await exec('git', ['merge-base', 'HEAD', remoteBranch], dir, NETWORK_TIMEOUT);
      localFiles = localCommits ? await changedFilesFrom(dir, base, 'HEAD') : [];
      githubFiles = githubCommits ? await changedFilesFrom(dir, base, remoteBranch) : [];
    } catch { /* A new remote has no common base yet. The branch counts remain the safe summary. */ }
  }
  if (localEdits) {
    const workingFiles = await getPendingFiles();
    localFiles = Array.from(new Set([...localFiles, ...workingFiles.map((file) => file.file)])).sort();
  }

  const state: ReconciliationState = githubCommits > 0 && (localCommits > 0 || localEdits > 0)
    ? 'diverged'
    : githubCommits > 0
      ? 'remote-updates'
      : localCommits > 0 || localEdits > 0
        ? 'local-changes'
        : 'up-to-date';
  return {
    state,
    branch,
    remoteBranch,
    localCommits,
    githubCommits,
    localEdits,
    localFiles,
    githubFiles,
    conflicts: [],
    ...(message ? { message } : {}),
  };
}

/** Explicitly fetch the shared writing branch. This is deliberately user-led,
 * not a hidden background pull, so a writer can see when the shared source has
 * changed and decide when to bring it into their active workspace. */
export async function checkWritingUpdates(): Promise<ReconciliationOverview> {
  const dir = await dataDir();
  if (!(await isGitRepo())) throw new Error('Set up GitHub backup before checking writing-space updates.');
  if (!(await mergeInProgress(dir))) await remoteCommand(['fetch', '--prune', 'origin'], dir);
  return reconciliationOverview(dir);
}

/** Read the last known branch state without fetching or touching Keychain. */
export async function getWritingUpdateOverview(): Promise<ReconciliationOverview> {
  const dir = await dataDir();
  if (!(await isGitRepo())) throw new Error('Set up GitHub backup before viewing writing-space updates.');
  return reconciliationOverview(dir);
}

async function commitSavedLocalWork(dir: string): Promise<void> {
  if (!(await hasUncommittedChanges(dir))) return;
  await exec('git', ['add', '-A'], dir);
  try {
    await exec('git', ['diff', '--cached', '--quiet'], dir);
  } catch {
    await exec('git', ['commit', '-m', 'Save local writing before reconciling GitHub updates'], dir);
  }
}

/** Start a reconciliation without ever overwriting the local branch. A named
 * recovery branch is made first; clean merges wait for the writer’s explicit
 * Apply action, while overlapping files are returned for a per-file choice. */
export async function beginWritingUpdateReconciliation(): Promise<ReconciliationOverview> {
  const srv = await getServerModules();
  const dir = await dataDir();
  if (!(await isGitRepo())) throw new Error('Set up GitHub backup before reconciling writing-space updates.');
  if (await mergeInProgress(dir)) return reconciliationOverview(dir);

  srv.cancelDebouncedSave();
  srv.save();
  await ensureGitignore();
  await writeWorkflowSettingsToRepository(dir);
  await commitSavedLocalWork(dir);
  await remoteCommand(['fetch', '--prune', 'origin'], dir);

  const before = await reconciliationOverview(dir);
  if (before.state === 'remote-updates') {
    await fastForwardRemoteChanges(dir);
    await restoreWorkflowSettingsFromRepository(dir);
    await saveProfileSyncConfig({ lastSyncTime: new Date().toISOString() });
    currentSyncState = 'synced';
    lastError = undefined;
    srv.reloadWorkspaceFromDisk();
    return reconciliationOverview(dir, 'GitHub updates are now in this writing space.');
  }
  if (before.state !== 'diverged') return before;

  const recoveryBranch = await localRecoveryBranch(dir);
  try {
    await exec('git', ['merge', '--no-commit', '--no-ff', before.remoteBranch], dir, NETWORK_TIMEOUT);
  } catch (error) {
    if (!(await mergeInProgress(dir))) throw error;
  }
  const result = await reconciliationOverview(dir, 'Your local checkpoint is also preserved on a recovery branch.');
  return { ...result, recoveryBranch };
}

async function finishWritingUpdateReconciliation(dir: string): Promise<ReconciliationOverview> {
  if (!(await mergeInProgress(dir))) throw new Error('There is no writing-space reconciliation ready to apply.');
  const conflicts = await reconciliationConflicts(dir);
  if (conflicts.length) throw new Error('Choose a version for each overlapping file before applying these updates.');
  await exec('git', ['add', '-A'], dir);
  await exec('git', ['commit', '-m', 'Reconcile GitHub updates in OpenWriter'], dir);
  const branch = await currentBranch(dir);
  await remoteCommand(['push', '-u', 'origin', branch], dir);
  await restoreWorkflowSettingsFromRepository(dir);
  await saveProfileSyncConfig({ lastSyncTime: new Date().toISOString() });
  currentSyncState = 'synced';
  lastError = undefined;
  const srv = await getServerModules();
  srv.reloadWorkspaceFromDisk();
  return reconciliationOverview(dir, 'The resolved writing space is now saved locally and on GitHub.');
}

export async function applyPreparedWritingUpdates(): Promise<ReconciliationOverview> {
  return finishWritingUpdateReconciliation(await dataDir());
}

export async function resolveWritingUpdateConflicts(resolutions: Array<{ path?: unknown; choice?: unknown }>): Promise<ReconciliationOverview> {
  const dir = await dataDir();
  if (!(await mergeInProgress(dir))) throw new Error('There is no writing-space reconciliation in progress.');
  const conflicts = await reconciliationConflicts(dir);
  const choiceByPath = new Map<string, 'local' | 'github'>();
  for (const resolution of resolutions) {
    if (typeof resolution.path !== 'string' || (resolution.choice !== 'local' && resolution.choice !== 'github')) continue;
    choiceByPath.set(resolution.path, resolution.choice);
  }
  for (const conflict of conflicts) {
    const choice = choiceByPath.get(conflict.path);
    if (!choice) throw new Error(`Choose whether to keep this Mac or GitHub for ${conflict.path}.`);
    await exec('git', ['checkout', choice === 'local' ? '--ours' : '--theirs', '--', conflict.path], dir);
    await exec('git', ['add', '--', conflict.path], dir);
  }
  return finishWritingUpdateReconciliation(dir);
}

export async function cancelWritingUpdateReconciliation(): Promise<ReconciliationOverview> {
  const dir = await dataDir();
  if (await mergeInProgress(dir)) await exec('git', ['merge', '--abort'], dir, NETWORK_TIMEOUT);
  return reconciliationOverview(dir, 'No writing was changed. Your local checkpoint remains in place.');
}

export async function setupWithGh(repoName: string, isPrivate: boolean, collaboration: CollaborationSetup = {}): Promise<void> {
  const srv = await getServerModules();
  const dir = await dataDir();
  await initRepo();
  const githubLogin = collaboration.githubLogin || await githubLoginWithGh();
  await configurePrimaryWriter(dir, { ...collaboration, role: 'primary', ...(githubLogin ? { githubLogin } : {}) });
  await writeWorkflowSettingsToRepository(dir);
  await initialCommit();

  const visibility = isPrivate ? '--private' : '--public';
  await exec('gh', ['repo', 'create', repoName, visibility, '--source=.', '--remote=origin'], dir, NETWORK_TIMEOUT);
  await exec('gh', ['auth', 'setup-git'], dir, NETWORK_TIMEOUT);
  await exec('git', ['push', '-u', 'origin', 'main'], dir, NETWORK_TIMEOUT);

  await saveProfileSyncConfig({
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
  await writeWorkflowSettingsToRepository(dir);
  await initialCommit();

  try { await exec('git', ['remote', 'remove', 'origin'], dir); } catch { /* no remote */ }
  await exec('git', ['remote', 'add', 'origin', remoteUrl], dir);
  await execGitWithPat(['push', '-u', 'origin', 'main'], dir, pat, NETWORK_TIMEOUT);

  await saveProfileSyncConfig({
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
  await writeWorkflowSettingsToRepository(dir);
  await initialCommit();
  try { await exec('git', ['remote', 'remove', 'origin'], dir); } catch { /* no remote */ }
  await exec('git', ['remote', 'add', 'origin', remoteUrl], dir);
  await execGitWithPat(['push', '-u', 'origin', 'main'], dir, token, NETWORK_TIMEOUT);

  await saveProfileSyncConfig({
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
  // Validate the remote before creating a local repository, adding an origin,
  // or writing OpenWriter's collaboration file. This lets setup distinguish a
  // writing space from an unrelated project repository without leaving any
  // trace in the author's local profile when they choose the wrong one.
  const finalUrl = sanitizeRemoteUrl(remoteUrl);
  const authentication = await resolveGitHubRequestAuthentication(authMethod, pat);
  const inspection = await inspectGitHubRepository(finalUrl, authentication);
  if (inspection.kind === 'other') {
    throw new Error('This repository looks like a project repository rather than a writing space. Choose one with manuscript Markdown files, or create a new private writing space.');
  }
  if (inspection.kind === 'unknown') {
    throw new Error('OpenWriter could not verify that this is a writing space. Choose another repository or check the link and try again.');
  }

  // Do not create a local .gitignore before checking out a remote: it could
  // collide with the repository's own file and make a clean workspace look
  // like it has unsaved author work.
  await initRepo({ ensureIgnore: false });

  // MCP-3: keep the remote credential-free; never splice the PAT into the URL.
  // Strip any credentials the caller may have included before storing/using it.
  try { await exec('git', ['remote', 'remove', 'origin'], dir); } catch { /* no remote */ }
  await exec('git', ['remote', 'add', 'origin', finalUrl], dir);
  const token = authentication.token;
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
  // Git setup creates a local repository before fetching the remote. If this
  // is the known empty starter profile, remove that generated placeholder now
  // so checkout can populate the shared workspace. Any real local writing
  // survives and still triggers the protective contributor/primary stop.
  if (!(await hasHead(dir)) && discardDisposableStarterWorkspace(dir)) {
    console.log('[Git sync] Replacing a blank starter profile with the shared writing space.');
  }
  // A repository that already identifies a primary writer is never silently
  // opened for direct writing by a different GitHub account. The selected
  // "Write directly" option is honored only for that established identity;
  // every other writer gets a review workspace until a primary transfer is
  // explicitly approved.
  const requestedRole = collaboration.role || 'primary';
  const continuingPrimary = Boolean(remoteManifest && writerMatches(
    remoteManifest.primaryWriter,
    githubLogin,
    authenticatedSetup.displayName,
  ));
  const role: CollaborationRole = remoteManifest
    ? (continuingPrimary && requestedRole === 'primary' ? 'primary' : 'contributor')
    : 'primary';

  if (role === 'contributor') {
    if (!remoteManifest) {
      throw new Error('This repository does not identify a primary writer yet. Ask the primary writer to finish backup setup before joining as a contributor.');
    }
    await configureContributor(dir, { ...authenticatedSetup, role }, remoteManifest);
    await restoreWorkflowSettingsFromRepository(dir);
  } else {
    // A blank profile can safely adopt the established primary branch. Never
    // check it out over local writing: that case stops with a clear message
    // rather than turning setup into an implicit overwrite.
    const primaryBranch = remoteManifest?.primaryBranch || defaultBranch;
    if (!(await hasHead(dir))) {
      if (await hasUncommittedChanges(dir)) {
        throw new Error('This profile contains local writing, so OpenWriter did not replace it. Keep this writing here, then use a new profile to open the shared writing space as the primary writer.');
      }
      if (await remoteBranchExists(dir, primaryBranch)) {
        await exec('git', ['checkout', '-b', primaryBranch, `origin/${primaryBranch}`], dir);
      }
    }
    await ensureGitignore();
    const restoredWorkflowSettings = await restoreWorkflowSettingsFromRepository(dir);
    if (!restoredWorkflowSettings) await writeWorkflowSettingsToRepository(dir);
    await configurePrimaryWriter(dir, { ...authenticatedSetup, role }, remoteManifest, primaryBranch);
    if (!(await hasHead(dir))) await initialCommit(primaryBranch);
    else await commitSetupMetadata(dir);
    const branch = await currentBranch(dir);
    if (token) await execGitWithPat(['push', '-u', 'origin', branch], dir, token, NETWORK_TIMEOUT);
    else await exec('git', ['push', '-u', 'origin', branch], dir, NETWORK_TIMEOUT);
  }

  await saveProfileSyncConfig({
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

const PRIMARY_TRANSFER_ISSUE_MARKER = '<!-- openwriter-primary-transfer -->';

interface GitHubCollaboratorResponse {
  login?: unknown;
  name?: unknown;
  permissions?: { push?: unknown };
}

interface GitHubIssueResponse {
  id?: unknown;
  number?: unknown;
  body?: unknown;
  created_at?: unknown;
  pull_request?: unknown;
  user?: { login?: unknown; name?: unknown };
}

interface GitHubPullRequestResponse {
  number?: unknown;
  title?: unknown;
  html_url?: unknown;
  updated_at?: unknown;
  user?: { login?: unknown; name?: unknown };
  head?: { ref?: unknown };
}

interface GitHubPullRequestFileResponse {
  filename?: unknown;
  additions?: unknown;
  deletions?: unknown;
}

interface GitHubApiOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT';
  body?: unknown;
}

/** Use the active OpenWriter pairing first, then the GitHub CLI fallback. The
 * browser never receives a credential; it gets only the small collaboration
 * summary it needs to present the writing-role controls. */
async function githubApi<T>(dir: string, path: string, options: GitHubApiOptions = {}): Promise<T> {
  const method = options.method || 'GET';
  const token = await repositoryToken();
  if (token) {
    const response = await fetch(`https://api.github.com${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({})) as { message?: string };
      throw new Error(payload.message || `GitHub could not complete this writing-role request (${response.status}).`);
    }
    return response.json() as Promise<T>;
  }

  if (await isGhAuthenticated()) {
    const args = ['api', path, '--method', method];
    const output = options.body === undefined
      ? await exec('gh', args, dir, NETWORK_TIMEOUT)
      : await execWithInput('gh', [...args, '--input', '-'], dir, JSON.stringify(options.body), NETWORK_TIMEOUT);
    return JSON.parse(output) as T;
  }

  throw new Error('Sign in with GitHub before managing writing roles.');
}

async function githubRepositoryForWorkspace(dir: string): Promise<{ owner: string; repo: string }> {
  const remoteUrl = await exec('git', ['remote', 'get-url', 'origin'], dir);
  const repository = parseGitHubRepository(remoteUrl);
  if (!repository) throw new Error('Writing roles are available for GitHub repositories only.');
  return repository;
}

async function sharedManifestFromRemote(dir: string): Promise<CollaborationManifest> {
  await remoteCommand(['fetch', '--prune', 'origin'], dir);
  // The local manifest records the durable primary branch. Avoid a second,
  // unauthenticated ls-remote call here: private writing repositories have
  // already been fetched through the author's selected GitHub sign-in.
  const branch = readCollaborationManifest(dir)?.primaryBranch || 'main';
  const manifest = await readRemoteManifest(dir, branch);
  if (!manifest) throw new Error('This writing space does not identify a primary writer yet.');
  return manifest;
}

async function currentGitHubIdentity(settings?: CollaborationSettings): Promise<string | undefined> {
  if (settings?.githubLogin) return settings.githubLogin;
  return authenticatedGitHubLogin(await repositoryToken());
}

function transferRequestFromIssue(issue: GitHubIssueResponse): PrimaryTransferRequest | undefined {
  if (
    typeof issue.number !== 'number'
    || typeof issue.body !== 'string'
    || !issue.body.includes(PRIMARY_TRANSFER_ISSUE_MARKER)
    || issue.pull_request
    || typeof issue.user?.login !== 'string'
  ) return undefined;
  const login = issue.user.login.trim();
  if (!login) return undefined;
  return {
    // GitHub's opaque `id` is not valid in the issue URL. Keep the
    // repository-local issue number as this request's action identifier.
    id: issue.number,
    githubLogin: login,
    displayName: typeof issue.user.name === 'string' && issue.user.name.trim() ? issue.user.name.trim() : login,
    ...(typeof issue.created_at === 'string' ? { createdAt: issue.created_at } : {}),
  };
}

async function listOpenPrimaryTransferRequests(
  dir: string,
  repository: { owner: string; repo: string },
): Promise<PrimaryTransferRequest[]> {
  const issues = await githubApi<GitHubIssueResponse[]>(
    dir,
    `/repos/${repository.owner}/${repository.repo}/issues?state=open&per_page=100`,
  );
  return issues.flatMap((issue) => {
    const request = transferRequestFromIssue(issue);
    return request ? [request] : [];
  });
}

async function listWritingCollaborators(
  dir: string,
  repository: { owner: string; repo: string },
  primaryWriter: PrimaryWriter,
): Promise<CollaborationMember[]> {
  const collaborators = await githubApi<GitHubCollaboratorResponse[]>(
    dir,
    `/repos/${repository.owner}/${repository.repo}/collaborators?affiliation=direct&per_page=100`,
  );
  const primaryLogin = normalizeGitHubLogin(primaryWriter.githubLogin);
  const members = collaborators.flatMap((collaborator): CollaborationMember[] => {
    if (typeof collaborator.login !== 'string' || collaborator.permissions?.push === false) return [];
    const githubLogin = collaborator.login.trim();
    if (!githubLogin) return [];
    return [{
      githubLogin,
      displayName: typeof collaborator.name === 'string' && collaborator.name.trim() ? collaborator.name.trim() : githubLogin,
      role: normalizeGitHubLogin(githubLogin) === primaryLogin ? 'primary' : 'contributor',
    }];
  });

  // Repository owners are not always returned as direct collaborators. The
  // manifest remains canonical, so always render the current primary once.
  if (!members.some((member) => writerMatches(primaryWriter, member.githubLogin, member.displayName))) {
    members.unshift({
      githubLogin: primaryWriter.githubLogin || primaryWriter.displayName,
      displayName: primaryWriter.displayName,
      role: 'primary',
    });
  }

  return members
    .map((member) => writerMatches(primaryWriter, member.githubLogin, member.displayName)
      ? { ...member, role: 'primary' as const, displayName: primaryWriter.displayName }
      : member)
    .filter((member, index, all) => all.findIndex((other) => normalizeGitHubLogin(other.githubLogin) === normalizeGitHubLogin(member.githubLogin)) === index)
    .sort((left, right) => (left.role === right.role ? left.displayName.localeCompare(right.displayName) : left.role === 'primary' ? -1 : 1));
}

function contributorReviewRequestFromPull(
  pull: GitHubPullRequestResponse,
  files: GitHubPullRequestFileResponse[],
): ContributorReviewRequest | undefined {
  if (
    typeof pull.number !== 'number'
    || typeof pull.title !== 'string'
    || typeof pull.html_url !== 'string'
    || typeof pull.user?.login !== 'string'
    || typeof pull.head?.ref !== 'string'
  ) return undefined;
  const githubLogin = pull.user.login.trim();
  const branch = pull.head.ref.trim();
  if (!githubLogin || !branch) return undefined;
  return {
    number: pull.number,
    title: pull.title.trim() || `Updates from @${githubLogin}`,
    githubLogin,
    displayName: typeof pull.user.name === 'string' && pull.user.name.trim() ? pull.user.name.trim() : githubLogin,
    branch,
    url: pull.html_url,
    changedFiles: files.length,
    additions: files.reduce((total, file) => total + (typeof file.additions === 'number' ? file.additions : 0), 0),
    deletions: files.reduce((total, file) => total + (typeof file.deletions === 'number' ? file.deletions : 0), 0),
    ...(typeof pull.updated_at === 'string' ? { updatedAt: pull.updated_at } : {}),
  };
}

async function listContributorReviewRequests(
  dir: string,
  repository: { owner: string; repo: string },
  primaryBranch: string,
): Promise<ContributorReviewRequest[]> {
  const pulls = await githubApi<GitHubPullRequestResponse[]>(
    dir,
    `/repos/${repository.owner}/${repository.repo}/pulls?state=open&base=${encodeURIComponent(primaryBranch)}&per_page=100`,
  );
  const requests = await Promise.all(pulls.map(async (pull) => {
    if (typeof pull.number !== 'number') return undefined;
    const files = await githubApi<GitHubPullRequestFileResponse[]>(
      dir,
      `/repos/${repository.owner}/${repository.repo}/pulls/${pull.number}/files?per_page=100`,
    );
    return contributorReviewRequestFromPull(pull, files);
  }));
  return requests.filter((request): request is ContributorReviewRequest => Boolean(request));
}

function isReviewableMarkdownPath(path: string): boolean {
  return /\.md$/i.test(path) && !path.startsWith('/') && !path.split('/').includes('..');
}

function withoutReviewAttrs(value: any): any {
  if (Array.isArray(value)) return value.map(withoutReviewAttrs);
  if (!value || typeof value !== 'object') return value;
  const next: Record<string, any> = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === 'id' || key === 'pendingStatus' || key === 'pendingOriginalContent' || key === 'pendingFeedback' || key.startsWith('pendingSelection') || key.startsWith('pendingOriginal')) continue;
    next[key] = withoutReviewAttrs(child);
  }
  return next;
}

function nodesMatch(left: any, right: any): boolean {
  return JSON.stringify(withoutReviewAttrs(left)) === JSON.stringify(withoutReviewAttrs(right));
}

function nodeId(node: any): string | undefined {
  return typeof node?.attrs?.id === 'string' && node.attrs.id ? node.attrs.id : undefined;
}

function proposalNode(node: any): any {
  const proposal = structuredClone(node);
  if (proposal?.attrs) {
    delete proposal.attrs.id;
    delete proposal.attrs.pendingStatus;
    delete proposal.attrs.pendingOriginalContent;
    delete proposal.attrs.pendingFeedback;
  }
  return proposal;
}

function contributorFeedback(request: ContributorReviewRequest): string {
  return `Change · Contributor review\nSignal: Yellow\nWhy: Proposed by @${request.githubLogin} in “${request.title}”.`;
}

/**
 * Convert a contributor's Markdown document into OpenWriter node changes.
 * Normal OpenWriter files retain stable node IDs, which lets ordinary edits
 * arrive as focused rewrites, inserts, and deletes. If an imported or legacy
 * file has no reliable shared identity, we deliberately fall back to one
 * document-shaped proposal instead of guessing where a paragraph belongs.
 */
function contributorNodeChanges(
  localContent: any[],
  incomingContent: any[],
  feedback: string,
): any[] {
  const local = localContent || [];
  const incoming = incomingContent || [];
  if (local.length === 0 && incoming.length === 0) return [];

  const localIds = local.map(nodeId);
  const incomingIds = incoming.map(nodeId);
  const reliableIds = local.length > 0 && localIds.every(Boolean) && incomingIds.every(Boolean);

  const fullDocumentProposal = (): any[] => {
    const firstId = localIds[0];
    if (!firstId) throw new Error('This document does not have stable OpenWriter block identities yet. Open it once in OpenWriter, then try the contributor review again.');
    const proposed = incoming.map(proposalNode);
    const changes: any[] = proposed.length
      ? [{ operation: 'rewrite', nodeId: firstId, content: proposed, feedback }]
      : [{ operation: 'delete', nodeId: firstId, feedback }];
    for (const id of localIds.slice(1)) {
      if (id) changes.push({ operation: 'delete', nodeId: id, feedback });
    }
    return changes;
  };

  // Empty documents still have an OpenWriter placeholder node. A single
  // rewrite keeps the proposal in the same review mechanics as ordinary text.
  if (!reliableIds) return fullDocumentProposal();

  const localById = new Map(local.map((node) => [nodeId(node)!, node]));
  const incomingById = new Map(incoming.map((node) => [nodeId(node)!, node]));
  const changes: any[] = [];

  for (const incomingNode of incoming) {
    const id = nodeId(incomingNode)!;
    const localNode = localById.get(id);
    if (localNode && !nodesMatch(localNode, incomingNode)) {
      changes.push({ operation: 'rewrite', nodeId: id, content: proposalNode(incomingNode), feedback });
    }
  }

  // Inserts can be placed faithfully after a shared predecessor. A request
  // that begins with a brand-new block has no “insert before” primitive in the
  // review engine, so use the safe full-document proposal for that one file.
  for (let index = 0; index < incoming.length; index++) {
    const incomingNode = incoming[index];
    const id = nodeId(incomingNode)!;
    if (localById.has(id)) continue;
    let afterNodeId: string | undefined;
    for (let previous = index - 1; previous >= 0; previous--) {
      const candidate = nodeId(incoming[previous]);
      if (candidate && localById.has(candidate)) {
        afterNodeId = candidate;
        break;
      }
    }
    if (!afterNodeId) return fullDocumentProposal();
    changes.push({ operation: 'insert', afterNodeId, content: proposalNode(incomingNode), feedback });
  }

  for (const localNode of local) {
    const id = nodeId(localNode)!;
    if (!incomingById.has(id)) changes.push({ operation: 'delete', nodeId: id, feedback });
  }

  return changes;
}

async function primaryReviewContext(): Promise<{
  dir: string;
  settings: CollaborationSettings;
  manifest: CollaborationManifest;
  repository: { owner: string; repo: string };
}> {
  const dir = await dataDir();
  const context = await collaborationContext();
  if (!context.settings || context.settings.role !== 'primary') {
    throw new Error('Only the primary writer can review contributor changes in the shared writing space.');
  }
  const githubLogin = await currentGitHubIdentity(context.settings);
  const manifest = await sharedManifestFromRemote(dir);
  if (!writerMatches(manifest.primaryWriter, githubLogin, context.settings.displayName)) {
    throw new Error('This profile is no longer the primary writer. Reopen Writing roles and continue as a contributor.');
  }
  if ((await currentBranch(dir)) !== manifest.primaryBranch) {
    throw new Error('This profile is not on the shared primary branch. Reopen the writing space before reviewing contributor changes.');
  }
  return { dir, settings: context.settings, manifest, repository: await githubRepositoryForWorkspace(dir) };
}

/** Stage one contributor PR directly into the existing Review tab. */
export async function stageContributorReviewRequest(requestNumber: number): Promise<CollaborationOverview> {
  const profile = await readProfileSyncConfig();
  if (profile.contributorReview) {
    throw new Error('Finish or discard the contributor review already open in OpenWriter before starting another one.');
  }

  const { dir, manifest, repository } = await primaryReviewContext();
  const srv = await getServerModules();
  const pending = srv.getPendingDocInfo();
  if (pending.filenames.length) {
    throw new Error('Finish the changes already waiting in OpenWriter’s Review tab before starting a contributor review.');
  }

  // Checkpoint the primary writer's accepted work before we make a temporary
  // review overlay. This gives every contributor request one unambiguous base.
  const checkpoint = await pushSync(() => undefined);
  if (checkpoint.state !== 'synced') {
    throw new Error(checkpoint.error || 'Sync this writing space before reviewing contributor changes.');
  }
  // A safe fast-forward during the checkpoint changes files beneath the core
  // server. Reload before staging so an active editor can never receive a
  // proposal against an older in-memory document.
  srv.reloadWorkspaceFromDisk();

  const request = (await listContributorReviewRequests(dir, repository, manifest.primaryBranch))
    .find((entry) => entry.number === requestNumber);
  if (!request) throw new Error('That contributor request is no longer open. Refresh Writing roles and try again.');

  const reviewRef = `origin/openwriter-review-${request.number}`;
  await remoteCommand([
    'fetch',
    'origin',
    `refs/pull/${request.number}/head:refs/remotes/${reviewRef}`,
  ], dir);
  const changedPaths = await changedFilesFrom(dir, `origin/${manifest.primaryBranch}`, reviewRef);
  const unsupported = changedPaths.filter((path) => !isReviewableMarkdownPath(path));
  if (unsupported.length) {
    throw new Error(`This request also changes ${unsupported.join(', ')}. OpenWriter can review Markdown writing here, but this request must keep non-writing setup changes separate.`);
  }
  if (!changedPaths.length) throw new Error('This contributor request has no Markdown writing changes to review.');

  const activeFilename = srv.getActiveFilename();
  const stagedFiles: string[] = [];
  let stagedChanges = 0;
  const feedback = contributorFeedback(request);

  for (const path of changedPaths) {
    const localPath = join(dir, path);
    if (!existsSync(localPath)) {
      throw new Error(`This request adds “${path}”. New documents need a dedicated review flow before they can be staged safely.`);
    }
    const local = srv.markdownToTiptap(readFileSync(localPath, 'utf-8'));
    const source = await readRefText(dir, reviewRef, path);
    const incoming = source === undefined
      ? { document: { content: [] } }
      : srv.markdownToTiptap(source);
    const changes = contributorNodeChanges(local.document.content, incoming.document.content, feedback);
    if (!changes.length) continue;
    const result = path === activeFilename
      ? srv.applyChanges(changes, { forcePending: true })
      : srv.applyChangesToFile(path, changes, { forcePending: true });
    if (result.count) {
      stagedFiles.push(path);
      stagedChanges += result.count;
    }
  }

  if (!stagedFiles.length) {
    throw new Error('OpenWriter found no text changes to stage. This request may contain only document metadata changes.');
  }

  // The active document needs its overlay persisted before a switch. Nonactive
  // documents save inside applyChangesToFile.
  srv.save();
  await saveProfileSyncConfig({
    contributorReview: {
      requestNumber: request.number,
      title: request.title,
      githubLogin: request.githubLogin,
      branch: request.branch,
      url: request.url,
      files: stagedFiles,
      stagedChanges,
      startedAt: new Date().toISOString(),
    },
  });
  if (stagedFiles[0] !== activeFilename) srv.switchDocument(stagedFiles[0]);
  srv.broadcastPendingDocsChanged();
  return getCollaborationOverview();
}

/**
 * Apply only the changes the primary writer accepted or rewrote in the normal
 * Review tab, then close the now-superseded GitHub request with an audit note.
 */
export async function finishContributorReviewRequest(requestNumber: number): Promise<CollaborationOverview> {
  const profile = await readProfileSyncConfig();
  const review = profile.contributorReview;
  if (!review || review.requestNumber !== requestNumber) {
    throw new Error('OpenWriter does not have an active review for that contributor request.');
  }
  const { dir, manifest, repository } = await primaryReviewContext();
  const srv = await getServerModules();
  srv.cancelDebouncedSave();
  srv.save();

  const unresolved = review.files.filter((file) => (srv.getPendingDocInfo().counts[file] || 0) > 0);
  if (unresolved.length) {
    throw new Error(`Finish the ${unresolved.length === 1 ? 'remaining change' : 'remaining changes'} in OpenWriter’s Review tab before completing this contributor review.`);
  }

  await exec('git', ['add', '--', ...review.files], dir);
  let committed = false;
  try {
    await exec('git', ['diff', '--cached', '--quiet'], dir);
  } catch {
    await exec('git', ['commit', '-m', `Review contributor changes from @${review.githubLogin}`], dir);
    committed = true;
  }

  if (committed) {
    try {
      await remoteCommand(['push', '-u', 'origin', manifest.primaryBranch], dir);
    } catch (error: any) {
      throw new Error(`Your reviewed writing is committed safely on this Mac, but GitHub changed before it could be shared. Use Writing space updates to reconcile it, then try finishing this review again. ${error?.message || ''}`.trim());
    }
  }

  try {
    await githubApi(dir, `/repos/${repository.owner}/${repository.repo}/issues/${requestNumber}/comments`, {
      method: 'POST',
      body: { body: committed
        ? 'Reviewed and applied in OpenWriter. The accepted edits were saved as a new shared-writing checkpoint.'
        : 'Reviewed in OpenWriter. No contributor edits were accepted into the shared writing space.' },
    });
    await githubApi(dir, `/repos/${repository.owner}/${repository.repo}/pulls/${requestNumber}`, {
      method: 'PATCH',
      body: { state: 'closed' },
    });
  } catch (error: any) {
    // The authoritative writing checkpoint is already on the primary branch.
    // Leaving the request open is a recoverable notification issue, never a
    // reason to undo an author-reviewed commit.
    console.warn('[GitHub Plugin] could not close contributor review request:', error?.message || error);
  }

  await saveProfileSyncConfig({
    contributorReview: undefined,
    ...(committed ? { lastSyncTime: new Date().toISOString() } : {}),
  });
  return getCollaborationOverview();
}

async function ensureContributorReadyForPrimaryTransfer(
  dir: string,
  settings: CollaborationSettings,
  primaryBranch: string,
): Promise<void> {
  if (await hasUncommittedChanges(dir)) {
    throw new Error('Back up or discard this device’s local edits before changing the primary writer.');
  }
  if ((await currentBranch(dir)) !== settings.branch) {
    throw new Error('This profile is not on its configured contributor branch. Reopen the writing space, then try again.');
  }
  await remoteCommand(['fetch', '--prune', 'origin'], dir);
  const remotePrimary = `origin/${primaryBranch}`;
  try { await exec('git', ['rev-parse', '--verify', '--quiet', remotePrimary], dir); }
  catch { throw new Error(`The shared ${primaryBranch} branch is not available yet.`); }
  const counts = await exec('git', ['rev-list', '--left-right', '--count', `HEAD...${remotePrimary}`], dir);
  const [ahead = 0] = counts.trim().split(/\s+/).map(Number);
  if (ahead > 0) {
    throw new Error('Finish or merge this contributor branch before changing the primary writer. Your review request still contains writing that is not on the shared branch.');
  }
}

export async function getCollaborationOverview(): Promise<CollaborationOverview> {
  const dir = await dataDir();
  const context = await collaborationContext();
  if (!context.settings || !(await isGitRepo())) throw new Error('Set up GitHub backup before managing writing roles.');
  const profileConfig = await readProfileSyncConfig();
  // The tracked manifest is already refreshed whenever OpenWriter syncs. Use
  // that local source for a read-only role view first, rather than making a
  // second Git fetch just to repeat metadata the workspace already has. This
  // keeps the role panel available on machines whose system Git is not set up.
  // State-changing handoff commands still re-fetch the remote manifest.
  const localManifest = readCollaborationManifest(dir);
  const activeToken = await activeRepositoryToken();
  const ghAuthenticated = activeToken ? false : await isGhAuthenticated();

  // A restarted app deliberately does not touch the Keychain until the author
  // asks it to. Keep the local, already-synced role information usable and
  // give the UI an explicit reconnect step instead of failing with an opaque
  // Git credential error.
  if (!activeToken && !ghAuthenticated) {
    return {
      ...(localManifest ? { primaryWriter: localManifest.primaryWriter } : context.primaryWriter ? { primaryWriter: context.primaryWriter } : {}),
      currentRole: context.settings.role,
      ...(context.settings.githubLogin ? { currentGitHubLogin: context.settings.githubLogin } : {}),
      contributors: [],
      reviewRequests: [],
      ...(profileConfig.contributorReview ? { activeReviewSession: profileConfig.contributorReview } : {}),
      transferRequests: [],
      canRequestPrimary: false,
      canApproveTransfers: false,
      canClaimPrimary: false,
      requestAlreadyOpen: false,
      needsGitHubSignIn: true,
      savedGitHubSignIn: Boolean(profileConfig.gitOAuthLogin),
    };
  }

  const repository = await githubRepositoryForWorkspace(dir);
  const primaryWriter = localManifest || await sharedManifestFromRemote(dir);
  const currentGitHubLogin = await currentGitHubIdentity(context.settings);
  const isPrimary = context.settings.role === 'primary'
    && writerMatches(primaryWriter.primaryWriter, currentGitHubLogin, context.settings.displayName);
  const contributors = (await listWritingCollaborators(dir, repository, primaryWriter.primaryWriter))
    .filter((member) => member.role === 'contributor');
  const transferRequests = await listOpenPrimaryTransferRequests(dir, repository);
  const reviewRequests = isPrimary
    ? await listContributorReviewRequests(dir, repository, primaryWriter.primaryBranch)
    : [];
  const requestAlreadyOpen = Boolean(currentGitHubLogin && transferRequests.some(
    (request) => normalizeGitHubLogin(request.githubLogin) === normalizeGitHubLogin(currentGitHubLogin),
  ));

  return {
    primaryWriter: primaryWriter.primaryWriter,
    currentRole: context.settings.role,
    ...(currentGitHubLogin ? { currentGitHubLogin } : {}),
    contributors,
    reviewRequests,
    ...(profileConfig.contributorReview ? { activeReviewSession: profileConfig.contributorReview } : {}),
    transferRequests,
    canRequestPrimary: context.settings.role === 'contributor' && Boolean(currentGitHubLogin) && !isPrimary,
    canApproveTransfers: isPrimary,
    canClaimPrimary: context.settings.role === 'contributor'
      && writerMatches(primaryWriter.primaryWriter, currentGitHubLogin, context.settings.displayName),
    requestAlreadyOpen,
    needsGitHubSignIn: false,
    savedGitHubSignIn: Boolean(profileConfig.gitOAuthLogin),
  };
}

export async function requestPrimaryWriterRole(): Promise<CollaborationOverview> {
  const dir = await dataDir();
  const context = await collaborationContext();
  if (!context.settings || context.settings.role !== 'contributor') {
    throw new Error('Only a contributor can request the primary writer role.');
  }
  const githubLogin = await currentGitHubIdentity(context.settings);
  if (!githubLogin) throw new Error('Sign in with GitHub before requesting the primary writer role.');
  const manifest = await sharedManifestFromRemote(dir);
  if (writerMatches(manifest.primaryWriter, githubLogin, context.settings.displayName)) {
    throw new Error('This GitHub account is already approved as the primary writer. Choose “Become primary writer” instead.');
  }
  await ensureContributorReadyForPrimaryTransfer(dir, context.settings, manifest.primaryBranch);
  const repository = await githubRepositoryForWorkspace(dir);
  const existing = await listOpenPrimaryTransferRequests(dir, repository);
  if (!existing.some((request) => normalizeGitHubLogin(request.githubLogin) === normalizeGitHubLogin(githubLogin))) {
    const displayName = cleanDisplayName(context.settings.displayName || githubLogin);
    await githubApi(dir, `/repos/${repository.owner}/${repository.repo}/issues`, {
      method: 'POST',
      body: {
        title: 'Request primary writer role',
        body: `${PRIMARY_TRANSFER_ISSUE_MARKER}\n\n@${githubLogin} (${displayName}) requests the primary writer role for this writing space.\n\nApprove this request in OpenWriter’s Writing roles panel after any active review changes are merged.`,
      },
    });
  }
  return getCollaborationOverview();
}

export async function approvePrimaryWriterTransfer(requestId: number): Promise<CollaborationOverview> {
  const dir = await dataDir();
  const context = await collaborationContext();
  if (!context.settings || context.settings.role !== 'primary') {
    throw new Error('Only the current primary writer can approve a primary-writer transfer.');
  }
  const githubLogin = await currentGitHubIdentity(context.settings);
  const manifest = await sharedManifestFromRemote(dir);
  if (!writerMatches(manifest.primaryWriter, githubLogin, context.settings.displayName)) {
    throw new Error('This profile is no longer the primary writer. Reopen Writing roles and continue as a contributor.');
  }
  if ((await currentBranch(dir)) !== manifest.primaryBranch) {
    throw new Error('This profile is not on the shared primary branch. Reopen the writing space before transferring the primary writer role.');
  }
  const repository = await githubRepositoryForWorkspace(dir);
  const request = (await listOpenPrimaryTransferRequests(dir, repository)).find((entry) => entry.id === requestId);
  if (!request) throw new Error('That primary-writer request is no longer open. Refresh Writing roles and try again.');
  const contributors = await listWritingCollaborators(dir, repository, manifest.primaryWriter);
  if (!contributors.some((member) => normalizeGitHubLogin(member.githubLogin) === normalizeGitHubLogin(request.githubLogin))) {
    throw new Error(`@${request.githubLogin} no longer has write access to this repository. Restore their GitHub access before approving the transfer.`);
  }

  const synced = await pushSync(() => undefined);
  if (synced.state !== 'synced') {
    throw new Error(synced.error || 'Back up the current primary writer’s changes before transferring the role.');
  }

  const nextManifest: CollaborationManifest = {
    ...manifest,
    primaryWriter: { displayName: request.displayName, githubLogin: request.githubLogin },
  };
  writeCollaborationManifest(dir, nextManifest);
  await commitSetupMetadata(dir);
  await remoteCommand(['push', '-u', 'origin', manifest.primaryBranch], dir);

  // The outgoing primary immediately adopts a contributor branch. Future
  // checkpoints are therefore review requests, even on this existing device.
  await configureContributor(dir, {
    role: 'contributor',
    githubLogin,
    displayName: context.settings.displayName,
    automaticCheckpoints: context.settings.automaticCheckpoints,
    checkpointDelayMs: context.settings.checkpointDelayMs,
  }, nextManifest);

  try {
    await githubApi(dir, `/repos/${repository.owner}/${repository.repo}/issues/${request.id}`, {
      method: 'PATCH',
      body: { state: 'closed' },
    });
  } catch (error: any) {
    // The manifest has already safely transferred the role. Leaving the
    // request visible in GitHub is preferable to rolling back that durable
    // handoff because a notification could not be closed.
    console.warn('[GitHub Plugin] could not close primary-transfer request:', error?.message || error);
  }
  return getCollaborationOverview();
}

export async function claimPrimaryWriterRole(): Promise<CollaborationOverview> {
  const dir = await dataDir();
  const context = await collaborationContext();
  if (!context.settings || context.settings.role !== 'contributor') {
    throw new Error('This profile already writes directly, or is not connected as a contributor.');
  }
  const githubLogin = await currentGitHubIdentity(context.settings);
  const manifest = await sharedManifestFromRemote(dir);
  if (!writerMatches(manifest.primaryWriter, githubLogin, context.settings.displayName)) {
    throw new Error('The current primary writer has not approved this transfer yet.');
  }
  await ensureContributorReadyForPrimaryTransfer(dir, context.settings, manifest.primaryBranch);

  if (await localBranchExists(dir, manifest.primaryBranch)) {
    await exec('git', ['checkout', manifest.primaryBranch], dir);
  } else {
    await exec('git', ['checkout', '-b', manifest.primaryBranch, `origin/${manifest.primaryBranch}`], dir);
  }
  await fastForwardRemoteChanges(dir);
  await configurePrimaryWriter(dir, {
    role: 'primary',
    githubLogin,
    displayName: context.settings.displayName,
    automaticCheckpoints: context.settings.automaticCheckpoints,
    checkpointDelayMs: context.settings.checkpointDelayMs,
  }, manifest, manifest.primaryBranch);
  return getCollaborationOverview();
}

function isReconciliationProblem(message: string): boolean {
  return /reconcile|both contain new writing|saved local edits while the remote/i.test(message);
}

async function statusWithContext(
  state: SyncState,
  extras: Omit<SyncStatus, 'state' | 'collaboration' | 'primaryWriter'> = {},
): Promise<SyncStatus> {
  const [context, config] = await Promise.all([collaborationContext(), readProfileSyncConfig()]);
  const backupAuthentication = config.gitConfigured
    ? await backupAuthenticationState(config)
    : undefined;
  return {
    state,
    ...extras,
    ...(backupAuthentication ? { backupAuthentication } : {}),
    ...(nextAutomaticCheckpointAt ? { nextAutomaticCheckpointAt } : {}),
    ...(context.settings ? { collaboration: context.settings } : {}),
    ...(context.primaryWriter ? { primaryWriter: context.primaryWriter } : {}),
  };
}

export async function pushSync(onStatus: (status: SyncStatus) => void): Promise<SyncStatus> {
  const srv = await getServerModules();
  const dir = await dataDir();
  const config = await readProfileSyncConfig();
  const backupAuthentication = await backupAuthenticationState(config);

  // Keep a retry or automatic checkpoint from ever falling through to a raw
  // Git credential error when the saved sign-in is not active in this session.
  if (backupAuthentication !== 'ready') {
    currentSyncState = 'attention';
    lastError = backupAuthenticationMessage(backupAuthentication);
    nextAutomaticCheckpointAt = undefined;
    const attention = await statusWithContext('attention', { error: lastError });
    onStatus(attention);
    return attention;
  }

  const context = await collaborationContext();

  currentSyncState = 'syncing';
  lastError = undefined;
  nextAutomaticCheckpointAt = undefined;
  onStatus(await statusWithContext('syncing'));

  try {
    srv.cancelDebouncedSave();
    srv.save();

    await ensureGitignore();
    // Older profiles may still hold the workflow definition only in local
    // settings. Materialize it before reconciliation so it becomes an
    // ordinary, reviewable writing-space change alongside Markdown/workspaces.
    await writeWorkflowSettingsToRepository(dir);
    // Fetch before this session becomes a local checkpoint. If both a remote
    // change and saved local edits exist, stop instead of attempting a hidden
    // merge of the author's prose.
    await fastForwardRemoteChanges(dir);
    await restoreWorkflowSettingsFromRepository(dir);
    if (context.settings?.role === 'primary') {
      const remoteManifest = await readRemoteManifest(dir, context.settings.baseBranch);
      if (remoteManifest && !writerMatches(
        remoteManifest.primaryWriter,
        context.settings.githubLogin,
        context.settings.displayName,
      )) {
        throw new Error('Primary writer status was transferred to another GitHub account. This device has not pushed anything; open Writing roles and continue as a contributor.');
      }
    }
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
    await saveProfileSyncConfig({ lastSyncTime: now });
    if (context.settings?.role === 'contributor') {
      try {
        const url = await createOrUpdatePullRequest(dir, context.settings);
        await saveProfileSyncConfig({ gitCollaboration: { ...context.settings, pullRequestUrl: url } });
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
  const config = await readProfileSyncConfig();
  if (!config.gitConfigured || !(await isGitRepo())) return;

  const dir = await dataDir();
  const schedule = async () => {
    const context = await collaborationContext();
    const settings = context.settings;
    if (!settings?.automaticCheckpoints || checkpointInFlight) {
      nextAutomaticCheckpointAt = undefined;
      return;
    }
    if (checkpointTimer) clearTimeout(checkpointTimer);
    nextAutomaticCheckpointAt = new Date(Date.now() + settings.checkpointDelayMs).toISOString();
    checkpointTimer = setTimeout(async () => {
      checkpointTimer = null;
      nextAutomaticCheckpointAt = undefined;
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
      // Schedule before publishing state so the UI can truthfully show the
      // quiet-period deadline rather than merely saying that changes exist.
      void schedule().then(() => getSyncStatus()).then(onStatus).catch(() => {});
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
  nextAutomaticCheckpointAt = undefined;
  checkpointWatcher?.close();
  checkpointWatcher = null;
}

/**
 * A profile switch changes the active writing directory underneath the GitHub
 * plugin. Rebuild the watcher rather than letting the prior profile continue
 * to schedule cloud checkpoints in the background.
 */
export async function activateCurrentProfileSync(onStatus: (status: SyncStatus) => void): Promise<SyncStatus> {
  stopAutomaticCheckpoints();
  currentSyncState = 'unconfigured';
  lastError = undefined;
  const status = await getSyncStatus();
  await startAutomaticCheckpoints(onStatus);
  onStatus(status);
  return status;
}

/**
 * Disconnect cloud backup from the active profile only. Nothing is deleted:
 * prose, local versions, the local Git history, and the GitHub repository all
 * remain available. Removing the remote is intentional so a later setup must
 * explicitly choose a writing space instead of accidentally resuming one.
 */
export async function disconnectCurrentProfile(): Promise<SyncStatus> {
  const srv = await getServerModules();
  const dir = await dataDir();
  stopAutomaticCheckpoints();
  srv.cancelDebouncedSave();
  srv.save();

  if (await isGitRepo()) {
    try { await exec('git', ['remote', 'remove', 'origin'], dir); } catch { /* no origin to remove */ }
  }

  await saveProfileSyncConfig({
    gitConfigured: false,
    gitRemote: undefined,
    gitPat: undefined,
    repoName: undefined,
    gitCollaboration: undefined,
    lastSyncTime: undefined,
  });
  currentSyncState = 'unconfigured';
  lastError = undefined;
  return { state: 'unconfigured' };
}
