import { useCallback, useEffect, useState } from 'react';
import './SyncSetupModal.css';

interface SyncCapabilities {
  gitInstalled: boolean;
  ghInstalled: boolean;
  ghAuthenticated: boolean;
  deviceAuthAvailable: boolean;
  oauthAuthenticated: boolean;
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

export default function SyncSetupModal({ onClose, onSetupComplete }: SyncSetupModalProps) {
  const [phase, setPhase] = useState<Phase>('detecting');
  const [caps, setCaps] = useState<SyncCapabilities | null>(null);
  const [backupChoice, setBackupChoice] = useState<BackupChoice>('new');
  // No sign-in route is selected until OpenWriter finds an existing session or
  // the author deliberately chooses one. This keeps the fallback token route
  // from looking like a hidden default.
  const [mode, setMode] = useState<AuthMode | null>(null);
  const [repoName, setRepoName] = useState('openwriter-docs');
  const [pat, setPat] = useState('');
  const [remoteUrl, setRemoteUrl] = useState('');
  const [role, setRole] = useState<CollaborationRole>('primary');
  const [displayName, setDisplayName] = useState('');
  const [changeSetTitle, setChangeSetTitle] = useState('');
  const [automaticCheckpoints, setAutomaticCheckpoints] = useState(true);
  const [showAdvanced, setShowAdvanced] = useState(false);
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
      setBackupChoice(data.existingRepo && data.remoteUrl ? 'existing' : 'new');
      setDisplayName((current) => current || data.githubLogin || '');
      if (data.oauthAuthenticated) setMode('oauth');
      else if (data.ghAuthenticated) setMode('gh');
      else setMode(null);
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
    try {
      const response = await fetch('/api/sync/github/device/start', { method: 'POST' });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'GitHub sign-in could not start.');
      setDeviceAuthorization(data as DeviceAuthorizationStart);
      window.open(data.verificationUri, '_blank', 'noopener,noreferrer');
    } catch (err: any) {
      setPairingError(err?.message || 'GitHub sign-in could not start.');
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
          setCaps((current) => current ? { ...current, oauthAuthenticated: true, githubLogin: status.login || current.githubLogin } : current);
          setDisplayName((current) => current || status.login || '');
          setMode('oauth');
          setDeviceAuthorization(null);
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
  };

  const chooseRole = (nextRole: CollaborationRole) => {
    setRole(nextRole);
    if (nextRole === 'contributor') setBackupChoice('existing');
  };

  const usingExistingWritingSpace = backupChoice === 'existing';
  const selectedAuthenticationReady = (mode === 'oauth' && Boolean(caps?.oauthAuthenticated))
    || (mode === 'gh' && Boolean(caps?.ghAuthenticated))
    || (mode === 'pat' && Boolean(pat.trim()));
  const canSubmit = Boolean(
    displayName.trim()
    && selectedAuthenticationReady
    && (usingExistingWritingSpace ? remoteUrl.trim() : repoName.trim()),
  );
  const readinessMessage = !selectedAuthenticationReady
    ? 'Choose how to sign in before continuing.'
    : !displayName.trim()
      ? 'Enter your name for the backup history.'
      : usingExistingWritingSpace && !remoteUrl.trim()
      ? 'Paste the GitHub repository you want to open.'
      : '';
  const signInOptionsLabel = showAdvanced
    ? 'Hide sign-in options'
    : selectedAuthenticationReady
      ? 'Change sign-in method'
      : caps?.deviceAuthAvailable
        ? 'More sign-in options'
        : 'Choose a sign-in method';

  const handleSetup = useCallback(async () => {
    if (!canSubmit || !mode) return;
    setPhase('progress');
    const effectiveMode = usingExistingWritingSpace ? 'connect' : mode;
    setProgressMsg(role === 'contributor' ? 'Preparing your review workspace...' : effectiveMode === 'connect' ? 'Connecting your writing space...' : 'Creating private backup...');

    try {
      const body: Record<string, any> = {
        method: effectiveMode,
        repoName,
        isPrivate: true,
        collaboration: {
          role,
          displayName: displayName.trim(),
          ...(caps?.githubLogin ? { githubLogin: caps.githubLogin } : {}),
          changeSetTitle: changeSetTitle.trim() || undefined,
          automaticCheckpoints,
        },
      };
      if (mode === 'pat') body.pat = pat;
      if (effectiveMode === 'connect') body.remoteUrl = remoteUrl.trim();

      const res = await fetch('/api/sync/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `Setup failed (${res.status})`);
      }

      setPhase('done');
      onSetupComplete();
    } catch (err: any) {
      setErrorMsg(err.message);
      setPhase('error');
    }
  }, [canSubmit, mode, role, usingExistingWritingSpace, repoName, pat, remoteUrl, displayName, caps?.githubLogin, changeSetTitle, automaticCheckpoints, onSetupComplete]);

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
                <div className="sync-choice-label">Where is this writing space?</div>
                <div className="sync-destination-choice" role="group" aria-label="Cloud backup destination">
                  <button className={`sync-destination-option${backupChoice === 'new' ? ' selected' : ''}`} onClick={() => chooseBackup('new')} aria-pressed={backupChoice === 'new'}>
                    <strong>Create a private GitHub backup</strong>
                    <span>Start a new private repository for this profile.</span>
                  </button>
                  <button className={`sync-destination-option${backupChoice === 'existing' ? ' selected' : ''}`} onClick={() => chooseBackup('existing')} aria-pressed={backupChoice === 'existing'}>
                    <strong>Connect an existing writing space</strong>
                    <span>Open a GitHub repository that already holds your work.</span>
                  </button>
                </div>

                {usingExistingWritingSpace && (
                  <>
                    <div className="sync-choice-label">How will you work here?</div>
                    <div className="sync-role-choice" role="group" aria-label="Writing role">
                      <button className={`sync-role-option${role === 'primary' ? ' selected' : ''}`} onClick={() => chooseRole('primary')} aria-pressed={role === 'primary'}>
                        <strong>Write directly</strong>
                        <span>Your changes back up to the main writing space.</span>
                      </button>
                      <button className={`sync-role-option${role === 'contributor' ? ' selected' : ''}`} onClick={() => chooseRole('contributor')} aria-pressed={role === 'contributor'}>
                        <strong>Prepare changes for review</strong>
                        <span>Your changes stay separate until the primary writer reviews them.</span>
                      </button>
                    </div>
                  </>
                )}

                {caps.primaryWriter && usingExistingWritingSpace && role === 'primary' && (
                  <div className="sync-warning sync-existing-primary">
                    This profile already identifies <strong>{caps.primaryWriter.displayName}</strong> as the primary writer. Choose “Prepare changes for review” unless you are continuing that role.
                  </div>
                )}

                <div className="sync-form">
                  <label>
                    Your name
                    <input type="text" value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Your name" autoFocus />
                    <span className="sync-field-hint">Shown on backup history and review requests. It does not change your GitHub account.</span>
                  </label>
                  {usingExistingWritingSpace ? (
                    <label>
                      GitHub repository
                      <input type="text" value={remoteUrl} onChange={(e) => setRemoteUrl(e.target.value)} placeholder="https://github.com/owner/repository" />
                      <span className="sync-field-hint">Paste the repository link or HTTPS clone URL. OpenWriter will open it in this profile.</span>
                    </label>
                  ) : (
                    <label>
                      Repository name
                      <input type="text" value={repoName} onChange={(e) => setRepoName(e.target.value)} placeholder="my-writing" />
                      <span className="sync-field-hint">Creates a private GitHub repository for this profile. It is separate from your name.</span>
                    </label>
                  )}
                  {role === 'contributor' && usingExistingWritingSpace && (
                    <label>
                      Review request title <span className="sync-field-optional">(optional)</span>
                      <input type="text" value={changeSetTitle} onChange={(e) => setChangeSetTitle(e.target.value)} placeholder="Updates from you · Aug 27" />
                      <span className="sync-field-hint">Leave this blank to use OpenWriter’s suggested title. Later checkpoints update the same request.</span>
                    </label>
                  )}
                  <label className="sync-checkbox">
                    <input type="checkbox" checked={automaticCheckpoints} onChange={(e) => setAutomaticCheckpoints(e.target.checked)} />
                    Back up automatically after I pause writing
                  </label>
                  <span className="sync-field-hint">OpenWriter saves locally first, then sends a GitHub checkpoint after a short pause.</span>
                </div>

                {caps.deviceAuthAvailable && (
                  <div className="sync-device-auth" aria-live="polite">
                    {caps.oauthAuthenticated ? (
                      <span><strong>GitHub account connected</strong>{caps.githubLogin ? ` as ${caps.githubLogin}` : ''}</span>
                    ) : deviceAuthorization ? (
                      <>
                        <span>Enter this code in GitHub:</span>
                        <strong className="sync-device-code">{deviceAuthorization.userCode}</strong>
                        <a href={deviceAuthorization.verificationUri} target="_blank" rel="noreferrer">Continue to GitHub</a>
                        <span className="sync-field-hint">Waiting for approval…</span>
                      </>
                    ) : (
                      <>
                        <span>Sign in to GitHub to create or open this private writing space.</span>
                        <button className="sync-device-auth-button" onClick={startDeviceAuthorization}>Sign in to GitHub</button>
                      </>
                    )}
                    {pairingError && <span className="sync-device-error">{pairingError}</span>}
                  </div>
                )}

                <button className="sync-advanced-toggle" onClick={() => setShowAdvanced((value) => !value)}>
                  {signInOptionsLabel}
                </button>
                {showAdvanced && (
                  <div className="sync-advanced">
                    {caps.oauthAuthenticated && (
                      <label className="sync-checkbox">
                        <input type="radio" checked={mode === 'oauth'} onChange={() => setMode('oauth')} />
                        Use the connected GitHub account
                      </label>
                    )}
                    {caps.ghAuthenticated && (
                      <label className="sync-checkbox">
                        <input type="radio" checked={mode === 'gh'} onChange={() => setMode('gh')} />
                        Use the GitHub sign-in already available on this Mac
                      </label>
                    )}
                    <label className="sync-checkbox">
                      <input type="radio" checked={mode === 'pat'} onChange={() => setMode('pat')} />
                      Use a personal access token
                    </label>
                    {mode === 'pat' && (
                      <label>
                        Personal access token
                        <input type="password" value={pat} onChange={(e) => setPat(e.target.value)} placeholder="github_pat_…" />
                      </label>
                    )}
                    {!caps.deviceAuthAvailable && !caps.ghAuthenticated && <p className="sync-hint">This build cannot sign in to GitHub directly. Use a personal access token to continue.</p>}
                  </div>
                )}

                {readinessMessage && <p className="sync-readiness" aria-live="polite">{readinessMessage}</p>}
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
