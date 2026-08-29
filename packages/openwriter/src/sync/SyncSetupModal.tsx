import { useCallback, useEffect, useRef, useState } from 'react';
import './SyncSetupModal.css';

interface SyncCapabilities {
  gitInstalled: boolean;
  ghInstalled: boolean;
  ghAuthenticated: boolean;
  deviceAuthAvailable: boolean;
  oauthAuthenticated: boolean;
  oauthSaved: boolean;
  githubLogin?: string;
  existingRepo: boolean;
  remoteUrl?: string;
  primaryWriter?: { displayName: string; githubLogin?: string };
}

interface SyncSetupModalProps {
  onClose: () => void;
  onSetupComplete: () => void;
}

type Phase = 'detecting' | 'plugin-disabled' | 'setup' | 'progress' | 'done' | 'error';
type BackupChoice = 'new' | 'existing';
type CollaborationRole = 'primary' | 'contributor';
type AuthMode = 'oauth' | 'gh' | 'pat';

interface DeviceAuthorizationStart {
  requestId: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
}

interface GitHubRepositoryOption {
  id: string;
  fullName: string;
  cloneUrl: string;
  private: boolean;
  updatedAt?: string;
  kind: GitHubRepositoryKind;
  markdownFiles?: number;
  workspaceFiles?: number;
  primaryWriter?: { displayName: string; githubLogin?: string };
}

type GitHubRepositoryKind = 'openwriter' | 'markdown' | 'empty' | 'other' | 'unknown';

interface GitHubRepositoryInspection {
  kind: GitHubRepositoryKind;
  markdownFiles: number;
  workspaceFiles: number;
  defaultBranch?: string;
  primaryWriter?: { displayName: string; githubLogin?: string };
}

type RepositoryLoadState = 'idle' | 'loading' | 'loaded' | 'error';
type RepositoryInspectionState = 'idle' | 'checking' | 'ready' | 'error';

function repositoryKindLabel(kind: GitHubRepositoryKind): string {
  if (kind === 'openwriter') return 'OpenWriter writing space';
  if (kind === 'markdown') return 'Markdown writing repository';
  if (kind === 'empty') return 'Empty repository — ready for writing';
  if (kind === 'other') return 'Not yet an OpenWriter writing space';
  return 'Could not classify';
}

function repositoryKindDescription(repository: Pick<GitHubRepositoryInspection, 'kind' | 'markdownFiles' | 'workspaceFiles' | 'primaryWriter'>): string {
  if (repository.kind === 'openwriter') {
    const documents = repository.markdownFiles === 1 ? '1 Markdown document' : `${repository.markdownFiles} Markdown documents`;
    return `${documents}${repository.primaryWriter ? ` · Primary writer: ${repository.primaryWriter.displayName}` : ''}`;
  }
  if (repository.kind === 'markdown') {
    const documents = repository.markdownFiles === 1 ? '1 Markdown document' : `${repository.markdownFiles} Markdown documents`;
    return `${documents}. OpenWriter can add its lightweight workspace settings; your writing stays unchanged.`;
  }
  if (repository.kind === 'empty') return 'No files yet. OpenWriter will create this as a new writing space.';
  if (repository.kind === 'other') return 'No Markdown writing was found. Add or export Markdown writing before connecting this repository.';
  return 'OpenWriter could not inspect this repository completely. Check its link after confirming it contains Markdown writing.';
}

export default function SyncSetupModal({ onClose, onSetupComplete }: SyncSetupModalProps) {
  const [phase, setPhase] = useState<Phase>('detecting');
  const [caps, setCaps] = useState<SyncCapabilities | null>(null);
  const [backupChoice, setBackupChoice] = useState<BackupChoice>('existing');
  // No sign-in route is selected until OpenWriter finds an existing session or
  // the author deliberately chooses one. This keeps the fallback token route
  // from looking like a hidden default.
  const [mode, setMode] = useState<AuthMode | null>(null);
  const [accountConfirmed, setAccountConfirmed] = useState(false);
  const [repoName, setRepoName] = useState('openwriter-docs');
  const [pat, setPat] = useState('');
  const [remoteUrl, setRemoteUrl] = useState('');
  const [repositories, setRepositories] = useState<GitHubRepositoryOption[]>([]);
  const [repositoryLoadState, setRepositoryLoadState] = useState<RepositoryLoadState>('idle');
  const repositoryLoadRequestRef = useRef(0);
  const [repositoryError, setRepositoryError] = useState('');
  const [repositoryFilter, setRepositoryFilter] = useState('');
  const [useRepositoryLink, setUseRepositoryLink] = useState(false);
  const [showRepositoryBrowser, setShowRepositoryBrowser] = useState(false);
  const [showOtherRepositories, setShowOtherRepositories] = useState(false);
  const [repositoryInspection, setRepositoryInspection] = useState<GitHubRepositoryInspection | null>(null);
  const [repositoryInspectionState, setRepositoryInspectionState] = useState<RepositoryInspectionState>('idle');
  const [repositoryInspectionError, setRepositoryInspectionError] = useState('');
  const [role, setRole] = useState<CollaborationRole>('primary');
  const [changeSetTitle, setChangeSetTitle] = useState('');
  const [showChangeSetTitle, setShowChangeSetTitle] = useState(false);
  const [automaticCheckpoints, setAutomaticCheckpoints] = useState(true);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [restoringSavedSignIn, setRestoringSavedSignIn] = useState(false);
  const [confirmForgetSavedSignIn, setConfirmForgetSavedSignIn] = useState(false);
  const [deviceAuthorization, setDeviceAuthorization] = useState<DeviceAuthorizationStart | null>(null);
  const [pairingError, setPairingError] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  const [progressMsg, setProgressMsg] = useState('');

  const detectCapabilities = useCallback(async () => {
    setErrorMsg('');
    setPhase('detecting');

    try {
      // Sync is provided by the optional GitHub plugin. Check its state first
      // so a disabled plugin does not surface as a misleading Git failure.
      const pluginResponse = await fetch('/api/plugins/github/status');
      if (pluginResponse.ok) {
        const plugin = await pluginResponse.json() as { enabled?: boolean };
        if (plugin.enabled === false) {
          setPhase('plugin-disabled');
          return;
        }
      }

      const response = await fetch('/api/sync/capabilities');
      if (!response.ok) {
        throw new Error('Cloud backup is enabled, but this OpenWriter service is not ready yet. Restart OpenWriter and try again.');
      }

      const data = await response.json() as SyncCapabilities;
      if (typeof data.gitInstalled !== 'boolean') {
        throw new Error('Cloud backup returned an unexpected response. Restart OpenWriter and try again.');
      }

      setCaps(data);
      setRemoteUrl(data.remoteUrl || '');
      setBackupChoice('existing');
      // Discovering repositories is intentionally a second step. The author
      // first confirms which GitHub account this profile will use, so setup
      // never loads a stale or surprising account's writing spaces.
      setMode(null);
      setAccountConfirmed(false);
      setPhase('setup');
    } catch (error: any) {
      setErrorMsg(error?.message || 'Cloud backup could not be checked. Restart OpenWriter and try again.');
      setPhase('error');
    }
  }, []);

  // Detect the plugin and Git capabilities on mount.
  useEffect(() => {
    void detectCapabilities();
  }, [detectCapabilities]);

  const enableGitHubBackup = useCallback(async () => {
    setErrorMsg('');
    setPhase('detecting');

    try {
      const response = await fetch('/api/plugins/enable', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: '@openwriter/plugin-github' }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result.success) {
        throw new Error(result.error || 'Cloud backup could not be enabled.');
      }
      await detectCapabilities();
    } catch (error: any) {
      setErrorMsg(error?.message || 'Cloud backup could not be enabled.');
      setPhase('error');
    }
  }, [detectCapabilities]);

  const startDeviceAuthorization = useCallback(async () => {
    setPairingError('');
    setAccountConfirmed(false);
    setMode(null);
    try {
      const response = await fetch('/api/sync/github/device/start', { method: 'POST' });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'GitHub sign-in could not start.');
      const authorization = data as DeviceAuthorizationStart;
      setDeviceAuthorization(authorization);
      void navigator.clipboard?.writeText(authorization.userCode).catch(() => undefined);
      window.open(authorization.verificationUri, '_blank', 'noopener,noreferrer');
    } catch (err: any) {
      setPairingError(err?.message || 'GitHub sign-in could not start.');
    }
  }, []);

  const restoreSavedGitHubSignIn = useCallback(async () => {
    setPairingError('');
    setRestoringSavedSignIn(true);
    try {
      const response = await fetch('/api/sync/github/session/restore', { method: 'POST' });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.oauthAuthenticated) {
        throw new Error(data.error || 'GitHub sign-in could not be restored.');
      }
      setCaps(data as SyncCapabilities);
      setMode('oauth');
      // The author explicitly chose this saved account, so repository
      // discovery can start after the Keychain restore succeeds.
      setAccountConfirmed(true);
    } catch (error: any) {
      setPairingError(error?.message || 'GitHub sign-in could not be restored.');
    } finally {
      setRestoringSavedSignIn(false);
    }
  }, []);

  const disconnectGitHubAccount = useCallback(async () => {
    setPairingError('');
    try {
      const response = await fetch('/api/sync/github/session/disconnect', { method: 'POST' });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.success || !data.capabilities) {
        throw new Error(data.error || 'GitHub sign-in could not be disconnected.');
      }
      setCaps(data.capabilities as SyncCapabilities);
      setMode(null);
      setAccountConfirmed(false);
      setDeviceAuthorization(null);
      setRepositories([]);
      setRepositoryLoadState('idle');
      setRemoteUrl('');
      setConfirmForgetSavedSignIn(false);
      setShowAdvanced(false);
    } catch (error: any) {
      setPairingError(error?.message || 'GitHub sign-in could not be disconnected.');
    }
  }, []);

  useEffect(() => {
    if (!deviceAuthorization) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const response = await fetch(`/api/sync/github/device/${deviceAuthorization.requestId}`);
        const status = await response.json();
        if (cancelled) return;
        if (status.state === 'authorized') {
          setDeviceAuthorization(null);
          // The pairing endpoint stored the credential before reporting
          // success. Re-read capabilities so the UI never claims “Connected”
          // if that secure-storage step is unavailable in this installation.
          try {
            const capabilityResponse = await fetch('/api/sync/capabilities');
            const nextCapabilities = await capabilityResponse.json() as SyncCapabilities;
            if (!capabilityResponse.ok || !nextCapabilities.oauthAuthenticated) {
              throw new Error('GitHub sign-in could not be saved on this Mac. Start again after updating OpenWriter.');
            }
            setCaps(nextCapabilities);
            // Device authorization may have completed under a different
            // GitHub account. Show that identity and wait for the author's
            // explicit confirmation before listing its repositories.
            setMode(null);
            setAccountConfirmed(false);
          } catch (error: any) {
            setPairingError(error?.message || 'GitHub sign-in could not be confirmed. Start again.');
          }
          return;
        }
        if (status.state === 'pending') {
          timer = setTimeout(poll, status.retryAfterMs || deviceAuthorization.interval * 1000);
          return;
        }
        setDeviceAuthorization(null);
        setPairingError(status.error || 'GitHub sign-in expired. Start again.');
      } catch {
        if (!cancelled) {
          setDeviceAuthorization(null);
          setPairingError('GitHub sign-in could not be completed.');
        }
      }
    };
    timer = setTimeout(poll, deviceAuthorization.interval * 1000);
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [deviceAuthorization]);

  const chooseBackup = (choice: BackupChoice) => {
    setBackupChoice(choice);
    if (choice === 'new') setRole('primary');
    if (choice === 'new') {
      setUseRepositoryLink(false);
      setRemoteUrl('');
      setRepositoryInspection(null);
      setRepositoryInspectionState('idle');
      setRepositoryInspectionError('');
    }
  };

  const usingExistingWritingSpace = backupChoice === 'existing';
  const selectedAuthenticationReady = (mode === 'oauth' && Boolean(caps?.oauthAuthenticated))
    || (mode === 'gh' && Boolean(caps?.ghAuthenticated))
    || (mode === 'pat' && Boolean(pat.trim()));
  const accountNeedsConfirmation = (mode === 'oauth' || mode === 'gh') && !accountConfirmed;
  const canChooseRepository = accountConfirmed
    && selectedAuthenticationReady
    && (mode === 'oauth' || mode === 'gh');
  const repositoryDiscoveryLoading = canChooseRepository && (repositoryLoadState === 'idle' || repositoryLoadState === 'loading');
  const filteredRepositories = repositories.filter((repository) =>
    repository.fullName.toLocaleLowerCase().includes(repositoryFilter.trim().toLocaleLowerCase()),
  );
  const openWriterRepositories = filteredRepositories.filter((repository) => repository.kind === 'openwriter');
  const adoptableRepositories = filteredRepositories.filter((repository) => repository.kind === 'markdown' || repository.kind === 'empty');
  const otherRepositories = filteredRepositories.filter((repository) => repository.kind === 'other' || repository.kind === 'unknown');
  const selectedRepository = repositories.find((repository) => repository.cloneUrl === remoteUrl);
  const selectedInspection = selectedRepository || repositoryInspection;
  const selectedRepositoryIsUsable = selectedInspection
    && (selectedInspection.kind === 'openwriter' || selectedInspection.kind === 'markdown' || selectedInspection.kind === 'empty');
  const hasSelectedRepository = Boolean(selectedRepository && selectedRepositoryIsUsable);
  const recommendedOpenWriterRepositories = openWriterRepositories.slice(0, 3);

  const loadRepositories = useCallback(async () => {
    if (!accountConfirmed || (mode !== 'oauth' && mode !== 'gh')) return;
    const requestId = ++repositoryLoadRequestRef.current;
    setRepositoryLoadState('loading');
    setRepositoryError('');
    try {
      const response = await fetch(`/api/sync/github/repositories?auth=${mode}`);
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'GitHub could not load repositories.');
      const nextRepositories = Array.isArray(data.repositories) ? data.repositories as GitHubRepositoryOption[] : [];
      if (requestId !== repositoryLoadRequestRef.current) return;
      setRepositories(nextRepositories);
      setRepositoryLoadState('loaded');
    } catch (error: any) {
      if (requestId !== repositoryLoadRequestRef.current) return;
      setRepositoryError(error?.message || 'GitHub could not load repositories.');
      setRepositoryLoadState('error');
    }
  }, [mode, accountConfirmed]);

  const confirmConnectedGitHubAccount = useCallback(() => {
    setPairingError('');
    setMode('oauth');
    setAccountConfirmed(true);
  }, []);

  useEffect(() => {
    repositoryLoadRequestRef.current += 1;
    setRepositoryLoadState('idle');
    setRepositoryError('');
    setRepositories([]);
    setRepositoryFilter('');
    setShowRepositoryBrowser(false);
    setShowOtherRepositories(false);
    setRepositoryInspection(null);
    setRepositoryInspectionState('idle');
    setRepositoryInspectionError('');
  }, [mode, accountConfirmed]);

  useEffect(() => {
    if (!canChooseRepository || repositoryLoadState !== 'idle') return;
    void loadRepositories();
  }, [canChooseRepository, loadRepositories, repositoryLoadState]);

  const currentAccountIsPrimary = useCallback((primaryWriter?: { githubLogin?: string }) => {
    if (!primaryWriter?.githubLogin || !caps?.githubLogin) return false;
    return primaryWriter.githubLogin.trim().toLocaleLowerCase() === caps.githubLogin.trim().toLocaleLowerCase();
  }, [caps?.githubLogin]);

  // An established OpenWriter space has one deterministic writing role per
  // GitHub account. Showing a choice here would imply a contributor can write
  // directly, or that a space without a primary can safely accept reviewers.
  // Neither is true, so setup explains the role OpenWriter will use instead.
  const selectedRepositoryIsOpenWriterSpace = selectedInspection?.kind === 'openwriter';
  const selectedRepositoryHasPrimaryWriter = Boolean(selectedInspection?.primaryWriter);
  const selectedRepositoryRequiresPrimary = selectedRepositoryIsOpenWriterSpace && !selectedRepositoryHasPrimaryWriter;
  const selectedRepositoryWillBePrimary = selectedRepositoryIsOpenWriterSpace
    && (!selectedRepositoryHasPrimaryWriter || currentAccountIsPrimary(selectedInspection?.primaryWriter));
  const selectedRepositoryWillBeContributor = selectedRepositoryIsOpenWriterSpace
    && selectedRepositoryHasPrimaryWriter
    && !selectedRepositoryWillBePrimary;

  const selectRepository = useCallback((repository: GitHubRepositoryOption) => {
    setBackupChoice('existing');
    setUseRepositoryLink(false);
    setRemoteUrl(repository.cloneUrl);
    setRepositoryInspection(null);
    setRepositoryInspectionState('ready');
    setRepositoryInspectionError('');
    setRepositoryFilter('');
    setShowRepositoryBrowser(false);
    setShowOtherRepositories(false);
    setRole(repository.kind === 'openwriter' && repository.primaryWriter && !currentAccountIsPrimary(repository.primaryWriter) ? 'contributor' : 'primary');
  }, [currentAccountIsPrimary]);

  const chooseAnotherRepository = useCallback(() => {
    setRemoteUrl('');
    setRepositoryInspection(null);
    setRepositoryInspectionState('idle');
    setRepositoryInspectionError('');
    setRepositoryFilter('');
    setShowOtherRepositories(false);
    setShowRepositoryBrowser(true);
  }, []);

  const inspectRepositoryLink = useCallback(async () => {
    if (!remoteUrl.trim() || !mode) return;
    setRepositoryInspectionState('checking');
    setRepositoryInspectionError('');
    try {
      const response = await fetch('/api/sync/github/repository-inspect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ remoteUrl: remoteUrl.trim(), authMethod: mode, ...(mode === 'pat' ? { pat } : {}) }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'GitHub could not check this repository.');
      const inspection = data as GitHubRepositoryInspection;
      setRepositoryInspection(inspection);
      setRepositoryInspectionState('ready');
      setRole(inspection.kind === 'openwriter' && inspection.primaryWriter && !currentAccountIsPrimary(inspection.primaryWriter) ? 'contributor' : 'primary');
    } catch (error: any) {
      setRepositoryInspection(null);
      setRepositoryInspectionState('error');
      setRepositoryInspectionError(error?.message || 'GitHub could not check this repository.');
    }
  }, [currentAccountIsPrimary, mode, pat, remoteUrl]);

  const canSubmit = Boolean(
    selectedAuthenticationReady
    && !accountNeedsConfirmation
    && (usingExistingWritingSpace ? remoteUrl.trim() && selectedRepositoryIsUsable : repoName.trim()),
  );
  const signInOptionsLabel = showAdvanced
    ? 'Hide other sign-in options'
    : 'Other sign-in options';

  const handleSetup = useCallback(async () => {
    if (!canSubmit || !mode) return;
    const effectiveRole: CollaborationRole = selectedRepositoryIsOpenWriterSpace
      ? (selectedRepositoryWillBeContributor ? 'contributor' : 'primary')
      : role;
    setPhase('progress');
    const effectiveMode = usingExistingWritingSpace ? 'connect' : mode;
    setProgressMsg(effectiveRole === 'contributor' ? 'Preparing your review workspace...' : effectiveMode === 'connect' ? 'Connecting your writing space...' : 'Creating private backup...');

    try {
      const body: Record<string, any> = {
        method: effectiveMode,
        repoName,
        isPrivate: true,
        collaboration: {
          role: effectiveRole,
          changeSetTitle: changeSetTitle.trim() || undefined,
          automaticCheckpoints,
        },
      };
      if (mode === 'pat') body.pat = pat;
      if (effectiveMode === 'connect') {
        body.remoteUrl = remoteUrl.trim();
        body.authMethod = mode;
      }

      const res = await fetch('/api/sync/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({})) as { error?: string; status?: { collaboration?: { role?: CollaborationRole } } };

      if (!res.ok) {
        throw new Error(data.error || `Setup failed (${res.status})`);
      }

      // The server verifies the established primary GitHub identity. If this
      // is another author’s writing space, it deliberately opens as a review
      // workspace even when the initial choice was left on "Write directly".
      // Reflect that safe role in the completion copy rather than implying a
      // direct-writing permission that was not granted.
      if (data.status?.collaboration?.role) setRole(data.status.collaboration.role);
      setPhase('done');
      onSetupComplete();
    } catch (err: any) {
      setErrorMsg(err.message);
      setPhase('error');
    }
  }, [canSubmit, mode, role, selectedRepositoryIsOpenWriterSpace, selectedRepositoryWillBeContributor, usingExistingWritingSpace, repoName, pat, remoteUrl, changeSetTitle, automaticCheckpoints, onSetupComplete]);

  return (
    <div className="sync-modal-overlay" onClick={onClose}>
      <div className="sync-modal" onClick={(e) => e.stopPropagation()}>
        <div className="sync-modal-header">
          <div>
            <h2>Back up your writing</h2>
            <p>Keep a private copy in GitHub while OpenWriter saves local history on this Mac.</p>
          </div>
          <button className="sync-modal-close" onClick={onClose}>&times;</button>
        </div>

        {phase === 'detecting' && (
          <div className="sync-modal-body">
            <div className="sync-spinner" />
            <p>Checking backup options...</p>
          </div>
        )}

        {phase === 'plugin-disabled' && (
          <div className="sync-modal-body">
            <div className="sync-plugin-notice">
              <strong>GitHub backup is turned off</strong>
              <p>Turn on the GitHub plugin to create a backup or connect an existing writing space.</p>
            </div>
            <div className="sync-modal-actions">
              <button className="sync-btn secondary" onClick={onClose}>Cancel</button>
              <button className="sync-btn primary" onClick={() => void enableGitHubBackup()}>Enable GitHub backup</button>
            </div>
          </div>
        )}

        {phase === 'setup' && caps && (
          <div className="sync-modal-body">
            {!caps.gitInstalled && (
              <div className="sync-warning">
                Install <a href="https://git-scm.com/downloads" target="_blank" rel="noreferrer">Git</a> to use GitHub backup, then reopen this setup.
              </div>
            )}

            {caps.gitInstalled && (
              <>
                <div className="sync-github-account-section">
                  {caps.deviceAuthAvailable ? (
                    <section className="sync-github-auth" aria-live="polite">
                    <div className={`sync-github-auth-copy${caps.oauthAuthenticated && !accountConfirmed ? ' sync-github-auth-copy-full' : ''}`}>
                      <div className="sync-choice-label">GitHub account</div>
                      {caps.oauthAuthenticated ? (
                        <p><strong>{accountConfirmed ? `Using${caps.githubLogin ? ` @${caps.githubLogin}` : ' your connected GitHub account'}` : `Connected${caps.githubLogin ? ` as @${caps.githubLogin}` : ''}`}</strong><span>{accountConfirmed ? 'OpenWriter is finding writing spaces for this account.' : 'Confirm this is the account you want to use before OpenWriter looks for writing spaces.'}</span></p>
                      ) : deviceAuthorization ? (
                        <p><strong>Finish signing in with GitHub</strong><span>The one-time code is copied. After approval, this profile will use the selected GitHub account.</span></p>
                      ) : caps.oauthSaved ? (
                        <p><strong>Saved GitHub sign-in{caps.githubLogin ? ` for @${caps.githubLogin}` : ''}</strong><span>Use this saved account before OpenWriter looks for writing spaces. macOS may ask you to unlock it.</span></p>
                      ) : (
                        <p><strong>Sign in once to continue</strong><span>OpenWriter will use your GitHub account to create or open a private writing space.</span></p>
                      )}
                    </div>
                    {caps.oauthAuthenticated ? (
                      accountConfirmed ? (
                        <button className="sync-btn secondary sync-github-auth-button" onClick={() => void disconnectGitHubAccount()}>Disconnect account</button>
                      ) : (
                        <div className="sync-github-account-actions">
                          <button className="sync-btn primary sync-github-auth-button" onClick={confirmConnectedGitHubAccount}>Continue{caps.githubLogin ? ` as @${caps.githubLogin}` : ''}</button>
                          <button className="sync-btn secondary sync-github-auth-button" onClick={startDeviceAuthorization}>Use a different account</button>
                        </div>
                      )
                    ) : deviceAuthorization ? (
                      <div className="sync-github-pair-actions">
                        <strong className="sync-device-code">{deviceAuthorization.userCode}</strong>
                        <button className="sync-device-auth-button" onClick={() => window.open(deviceAuthorization.verificationUri, '_blank', 'noopener,noreferrer')}>Open GitHub</button>
                      </div>
                    ) : caps.oauthSaved ? (
                      <div className="sync-github-pair-actions">
                        <button className="sync-btn primary sync-github-auth-button" disabled={restoringSavedSignIn} onClick={() => void restoreSavedGitHubSignIn()}>{restoringSavedSignIn ? 'Unlocking saved sign-in…' : 'Use saved sign-in'}</button>
                        <button className="sync-btn secondary sync-github-auth-button" onClick={startDeviceAuthorization}>Use a different account</button>
                      </div>
                    ) : (
                      <button className="sync-btn primary sync-github-auth-button" onClick={startDeviceAuthorization}>Sign in with GitHub</button>
                    )}
                    {pairingError && <span className="sync-device-error">{pairingError}</span>}
                    </section>
                  ) : (
                    <div className="sync-github-unavailable">
                      <strong>GitHub sign-in is unavailable in this installation.</strong>
                      <span>Use another way to sign in below, or install a build configured for GitHub pairing.</span>
                    </div>
                  )}
                  <div className="sync-github-auth-alternatives">
                    <button
                      type="button"
                      className="sync-advanced-toggle"
                      onClick={() => setShowAdvanced((value) => !value)}
                      aria-expanded={showAdvanced}
                      aria-controls="sync-other-sign-in-options"
                    >
                      {signInOptionsLabel}
                    </button>
                    {showAdvanced && (
                      <div className="sync-advanced" id="sync-other-sign-in-options">
                        {caps.oauthAuthenticated && (
                          <label className="sync-checkbox">
                            <input type="radio" checked={mode === 'oauth'} onChange={() => { setMode('oauth'); setAccountConfirmed(true); }} />
                            Use the connected GitHub account
                          </label>
                        )}
                        {caps.ghAuthenticated && (
                          <label className="sync-checkbox">
                            <input type="radio" checked={mode === 'gh'} onChange={() => { setMode('gh'); setAccountConfirmed(true); }} />
                            Use the GitHub sign-in already available on this Mac
                          </label>
                        )}
                        <label className="sync-checkbox">
                          <input type="radio" checked={mode === 'pat'} onChange={() => { setMode('pat'); setAccountConfirmed(false); }} />
                          Use a personal access token
                        </label>
                        {mode === 'pat' && (
                          <label>
                            Personal access token
                            <input type="password" value={pat} onChange={(e) => setPat(e.target.value)} placeholder="github_pat_…" />
                          </label>
                        )}
                        {caps.oauthSaved && !caps.oauthAuthenticated && (
                          <section className="sync-account-management" aria-label="Saved GitHub sign-in">
                            {confirmForgetSavedSignIn ? (
                              <>
                                <p>Forget this saved sign-in for this OpenWriter profile? You can sign in again later.</p>
                                <div className="sync-account-management-actions">
                                  <button type="button" className="sync-btn secondary" onClick={() => setConfirmForgetSavedSignIn(false)}>Keep saved sign-in</button>
                                  <button type="button" className="sync-btn danger" onClick={() => void disconnectGitHubAccount()}>Forget sign-in</button>
                                </div>
                              </>
                            ) : (
                              <button type="button" className="sync-link-button" onClick={() => setConfirmForgetSavedSignIn(true)}>Forget saved sign-in</button>
                            )}
                          </section>
                        )}
                        {!caps.deviceAuthAvailable && !caps.ghAuthenticated && <p className="sync-hint">This build cannot sign in to GitHub directly. Use a personal access token to continue.</p>}
                      </div>
                    )}
                  </div>
                  {caps.oauthAuthenticated ? (
                    <p className="sync-github-account-note">Disconnecting forgets this profile’s OpenWriter sign-in only. It does not sign out of GitHub in your browser or GitHub CLI.</p>
                  ) : null}
                </div>

                {backupChoice === 'existing' ? (
                  <section className="sync-writing-space-selection" aria-label="Choose a writing space">
                    <div className="sync-choice-label">Choose a writing space</div>
                    {!accountConfirmed && mode !== 'pat' ? (
                      <div className="sync-account-confirmation-prompt" role="status" aria-live="polite">
                        <strong>{caps.oauthAuthenticated ? 'Confirm the connected GitHub account above' : 'Sign in with GitHub above'}</strong>
                        <span>After you confirm the account for this profile, OpenWriter will look for writing spaces you can access.</span>
                      </div>
                    ) : canChooseRepository && !useRepositoryLink ? (
                      <div className="sync-repository-picker">
                        <div className="sync-repository-picker-heading">
                          <span>Writing spaces you can access</span>
                          <button type="button" className="sync-inline-action" onClick={() => void loadRepositories()} disabled={repositoryDiscoveryLoading}>{repositoryDiscoveryLoading ? 'Looking…' : 'Refresh'}</button>
                        </div>
                        {repositoryDiscoveryLoading ? (
                          <div className="sync-repository-loading" role="status" aria-live="polite">
                            <div>
                              <strong>Looking through your GitHub repositories…</strong>
                              <span>Checking for OpenWriter spaces and Markdown writing you can use.</span>
                            </div>
                            <div className="sync-repository-loading-skeleton" aria-hidden="true">
                              <span /><span />
                            </div>
                          </div>
                        ) : repositoryLoadState === 'error' ? (
                          <div className="sync-repository-error" role="status"><span>{repositoryError}</span><button type="button" className="sync-inline-action" onClick={() => void loadRepositories()}>Try again</button></div>
                        ) : (
                          <>
                            {hasSelectedRepository ? (
                              <section className="sync-selected-repository" aria-live="polite">
                                <div>
                                  <strong>{selectedRepository.fullName}</strong>
                                  <span className="sync-repository-kind">{repositoryKindLabel(selectedRepository.kind)}</span>
                                  <span>{repositoryKindDescription(selectedRepository)}</span>
                                </div>
                                <button type="button" className="sync-link-button" onClick={chooseAnotherRepository}>Choose a different repository</button>
                              </section>
                            ) : showRepositoryBrowser ? (
                              <section className="sync-repository-browser" aria-label="Other GitHub repositories">
                                <div className="sync-repository-picker-heading">
                                  <span>Find a GitHub repository</span>
                                  <button type="button" className="sync-inline-action" onClick={() => { setShowRepositoryBrowser(false); setShowOtherRepositories(false); setRepositoryFilter(''); }}>Show recommended choices</button>
                                </div>
                                <input id="sync-repository-filter" type="search" value={repositoryFilter} onChange={(e) => setRepositoryFilter(e.target.value)} placeholder="Search repositories" aria-label="Search repositories" />
                                {openWriterRepositories.length ? (
                                  <section className="sync-repository-group" aria-label="OpenWriter writing spaces">
                                    <div className="sync-repository-group-heading"><strong>OpenWriter writing spaces</strong><span>Already set up for OpenWriter</span></div>
                                    <div className="sync-repository-options" role="list">
                                    {openWriterRepositories.map((repository) => (
                                      <button type="button" role="listitem" key={repository.id} className="sync-repository-option" onClick={() => selectRepository(repository)}>
                                        <strong>{repository.fullName}</strong>
                                        <span className="sync-repository-kind">{repositoryKindLabel(repository.kind)}</span>
                                        <span>{repositoryKindDescription(repository)}</span>
                                      </button>
                                    ))}
                                    </div>
                                  </section>
                                ) : null}
                                {adoptableRepositories.length ? (
                                  <section className="sync-repository-group" aria-label="Repositories to bring into OpenWriter">
                                    <div className="sync-repository-group-heading"><strong>Markdown writing and empty repositories</strong><span>OpenWriter can add its lightweight workspace settings without changing your writing.</span></div>
                                    <div className="sync-repository-options" role="list">
                                    {adoptableRepositories.map((repository) => (
                                      <button type="button" role="listitem" key={repository.id} className="sync-repository-option" onClick={() => selectRepository(repository)}>
                                        <strong>{repository.fullName}</strong>
                                        <span className="sync-repository-kind">{repositoryKindLabel(repository.kind)}</span>
                                        <span>{repositoryKindDescription(repository)}</span>
                                      </button>
                                    ))}
                                    </div>
                                  </section>
                                ) : null}
                                {!openWriterRepositories.length && !adoptableRepositories.length && repositoryLoadState === 'loaded' ? (
                                  <span className="sync-field-hint">No OpenWriter or Markdown writing spaces match that search.</span>
                                ) : null}
                                <button type="button" className="sync-link-button" onClick={() => setShowOtherRepositories((value) => !value)}>
                                  {showOtherRepositories ? 'Hide other repositories' : 'Browse other writable repositories'}
                                </button>
                                {showOtherRepositories && (
                                  <div className="sync-other-repositories">
                                    {otherRepositories.length ? otherRepositories.map((repository) => (
                                      <div key={repository.id} className="sync-repository-option sync-repository-option-muted">
                                        <strong>{repository.fullName}</strong>
                                        <span>{repositoryKindDescription(repository)}</span>
                                      </div>
                                    )) : <span className="sync-field-hint">No other repositories match that search.</span>}
                                  </div>
                                )}
                              </section>
                            ) : (
                              <section className="sync-repository-recommendations" aria-label="Recommended writing spaces">
                                {recommendedOpenWriterRepositories.length ? (
                                  <div className="sync-repository-group">
                                    <div className="sync-repository-group-heading"><strong>Recommended</strong><span>Writing spaces already set up for OpenWriter</span></div>
                                    <div className="sync-repository-options sync-repository-options-compact" role="list">
                                    {recommendedOpenWriterRepositories.map((repository) => (
                                      <button type="button" role="listitem" key={repository.id} className="sync-repository-option" onClick={() => selectRepository(repository)}>
                                        <strong>{repository.fullName}</strong>
                                        <span>{repositoryKindDescription(repository)}</span>
                                      </button>
                                    ))}
                                    </div>
                                  </div>
                                ) : (
                                  <span className="sync-field-hint">No existing OpenWriter writing spaces are available for this account.</span>
                                )}
                                <button type="button" className="sync-repository-path" onClick={() => setShowRepositoryBrowser(true)}>
                                  <strong>{recommendedOpenWriterRepositories.length ? 'Use a different GitHub repository' : 'Choose a GitHub repository'}</strong>
                                  <span>Find Markdown writing or an empty repository to use with OpenWriter.</span>
                                </button>
                              </section>
                            )}
                          </>
                        )}
                        <span className="sync-field-hint">OpenWriter checks the repository before connecting it. Your writing is not changed during this check.</span>
                        {!hasSelectedRepository && <button type="button" className="sync-link-button" onClick={() => { setUseRepositoryLink(true); setRemoteUrl(''); setRepositoryInspection(null); setRepositoryInspectionState('idle'); setRepositoryInspectionError(''); setShowRepositoryBrowser(false); }}>Paste a repository link instead</button>}
                      </div>
                    ) : (
                      <div className="sync-repository-picker">
                        <label>
                          GitHub repository link
                          <input type="text" value={remoteUrl} onChange={(e) => { setRemoteUrl(e.target.value); setRepositoryInspection(null); setRepositoryInspectionState('idle'); setRepositoryInspectionError(''); }} placeholder="https://github.com/owner/repository" />
                        </label>
                        <div className="sync-repository-link-actions">
                          <button type="button" className="sync-btn secondary" onClick={() => void inspectRepositoryLink()} disabled={!remoteUrl.trim() || repositoryInspectionState === 'checking'}>
                            {repositoryInspectionState === 'checking' ? 'Checking…' : 'Check repository'}
                          </button>
                          {canChooseRepository && <button type="button" className="sync-link-button" onClick={() => { setUseRepositoryLink(false); setRemoteUrl(''); setRepositoryInspection(null); setRepositoryInspectionState('idle'); setRepositoryInspectionError(''); }}>Choose from my repositories</button>}
                        </div>
                        <span className="sync-field-hint">Paste a GitHub repository link, then check it before opening it in this profile.</span>
                        {repositoryInspectionState === 'error' && <div className="sync-repository-error" role="status">{repositoryInspectionError}</div>}
                      </div>
                    )}

                    {useRepositoryLink && selectedInspection && repositoryInspectionState === 'ready' && (
                      <div className={`sync-repository-summary sync-repository-summary-${selectedInspection.kind}`} role="status">
                        <strong>{repositoryKindLabel(selectedInspection.kind)}</strong>
                        <span>{repositoryKindDescription(selectedInspection)}</span>
                      </div>
                    )}

                    {(accountConfirmed || mode === 'pat') && <button type="button" className="sync-link-button sync-create-writing-space-link" onClick={() => chooseBackup('new')}>Create a new private writing space</button>}
                  </section>
                ) : (
                  <section className="sync-new-writing-space">
                    <div className="sync-choice-label">Create a new private writing space</div>
                    <p>OpenWriter will create a private GitHub repository and start backing up this profile.</p>
                    <button type="button" className="sync-link-button" onClick={() => chooseBackup('existing')}>Choose an existing writing space instead</button>
                  </section>
                )}

                {usingExistingWritingSpace && selectedRepositoryIsOpenWriterSpace && selectedRepositoryIsUsable && (
                  <section className="sync-writing-role-summary" aria-live="polite">
                    {selectedRepositoryRequiresPrimary ? (
                      <>
                        <strong>This writing space needs a primary writer</strong>
                        <span>No primary writer is recorded yet. Continue as the primary writer so future contributors have a clear person to review their changes.</span>
                      </>
                    ) : selectedRepositoryWillBePrimary ? (
                      <>
                        <strong>You are the primary writer</strong>
                        <span>You will write directly in the shared space. You can transfer this responsibility later from Writing roles.</span>
                      </>
                    ) : (
                      <>
                        <strong>You will join as a contributor</strong>
                        <span>{selectedInspection?.primaryWriter?.displayName} is the primary writer. Your changes will stay on a review branch, and you can request a transfer later from Writing roles.</span>
                      </>
                    )}
                  </section>
                )}

                <div className="sync-form">
                  {!usingExistingWritingSpace && (
                    <label>
                      Repository name
                      <input type="text" value={repoName} onChange={(e) => setRepoName(e.target.value)} placeholder="my-writing" />
                      <span className="sync-field-hint">Creates a private GitHub repository for this writing space.</span>
                    </label>
                  )}
                  {role === 'contributor' && usingExistingWritingSpace && (
                    <div className="sync-review-request-title">
                      {showChangeSetTitle ? (
                        <>
                          <label>
                            Custom review request title <span className="sync-field-optional">(optional)</span>
                            <input type="text" value={changeSetTitle} onChange={(e) => setChangeSetTitle(e.target.value)} placeholder="Updates from you · Aug 27" />
                          </label>
                          <span className="sync-field-hint">Leave this blank to use OpenWriter’s suggested title. Later checkpoints update the same review request.</span>
                          <button type="button" className="sync-link-button" onClick={() => { setChangeSetTitle(''); setShowChangeSetTitle(false); }}>Use the suggested title</button>
                        </>
                      ) : (
                        <>
                          <span className="sync-field-hint">OpenWriter will name this review request automatically and keep later checkpoints in it.</span>
                          <button type="button" className="sync-link-button" onClick={() => setShowChangeSetTitle(true)}>Customize review request title</button>
                        </>
                      )}
                    </div>
                  )}
                  <label className="sync-checkbox">
                    <input type="checkbox" checked={automaticCheckpoints} onChange={(e) => setAutomaticCheckpoints(e.target.checked)} />
                    Back up automatically after I pause writing
                  </label>
                  <span className="sync-field-hint">OpenWriter saves locally first, then sends a GitHub checkpoint after a short pause.</span>
                </div>

                <div className="sync-modal-actions">
                  <button className="sync-btn secondary" onClick={onClose}>Cancel</button>
                  <button
                    className="sync-btn primary"
                    onClick={handleSetup}
                    disabled={!canSubmit}
                  >
                    {role === 'contributor' && usingExistingWritingSpace ? 'Open review workspace' : usingExistingWritingSpace ? 'Open writing space' : 'Create GitHub backup'}
                  </button>
                </div>
              </>
            )}
          </div>
        )}

        {phase === 'progress' && (
          <div className="sync-modal-body">
            <div className="sync-spinner" />
            <p>{progressMsg}</p>
          </div>
        )}

        {phase === 'done' && (
          <div className="sync-modal-body">
            <div className="sync-success-icon">&#10003;</div>
            <p>{role === 'contributor' && usingExistingWritingSpace ? 'Your review workspace is ready.' : usingExistingWritingSpace ? 'Your writing space is ready.' : 'Your private GitHub backup is ready.'}</p>
            <p className="sync-success-copy">OpenWriter will keep saving local history first, then back up after you pause writing.</p>
            <div className="sync-modal-actions">
              <button className="sync-btn primary" onClick={onClose}>Done</button>
            </div>
          </div>
        )}

        {phase === 'error' && (
          <div className="sync-modal-body">
            <div className="sync-error-msg"><strong>Cloud backup was not set up.</strong><span>{errorMsg}</span></div>
            <div className="sync-modal-actions">
              <button className="sync-btn secondary" onClick={() => caps ? setPhase('setup') : void detectCapabilities()}>Review setup</button>
              <button className="sync-btn secondary" onClick={onClose}>Close</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
