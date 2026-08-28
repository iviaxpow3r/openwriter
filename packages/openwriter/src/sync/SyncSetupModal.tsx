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
  const [mode, setMode] = useState<AuthMode>('pat');
  const [repoName, setRepoName] = useState('openwriter-docs');
  const [isPrivate, setIsPrivate] = useState(true);
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
      if (data.oauthAuthenticated) setMode('oauth');
      else if (data.ghAuthenticated) setMode('gh');
      else setMode('pat');
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
  const selectedAuthenticationReady = mode === 'oauth'
    ? Boolean(caps?.oauthAuthenticated)
    : mode === 'gh'
      ? Boolean(caps?.ghAuthenticated)
      : Boolean(pat.trim());
  const canSubmit = Boolean(
    displayName.trim()
    && selectedAuthenticationReady
    && (usingExistingWritingSpace ? remoteUrl.trim() : repoName.trim()),
  );

  const handleSetup = useCallback(async () => {
    setPhase('progress');
    const effectiveMode = usingExistingWritingSpace ? 'connect' : mode;
    setProgressMsg(role === 'contributor' ? 'Opening your review workspace...' : effectiveMode === 'connect' ? 'Opening your writing space...' : 'Creating private backup...');

    try {
      const body: Record<string, any> = {
        method: effectiveMode,
        repoName,
        isPrivate,
        collaboration: {
          role,
          displayName: displayName.trim(),
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
  }, [mode, role, usingExistingWritingSpace, repoName, isPrivate, pat, remoteUrl, displayName, changeSetTitle, automaticCheckpoints, onSetupComplete]);

  return (
    <div className="sync-modal-overlay" onClick={onClose}>
      <div className="sync-modal" onClick={(e) => e.stopPropagation()}>
        <div className="sync-modal-header">
          <div>
            <h2>Set up cloud backup</h2>
            <p>Keep this writing space safe without changing how you write.</p>
          </div>
          <button className="sync-modal-close" onClick={onClose}>&times;</button>
        </div>

        {phase === 'detecting' && (
          <div className="sync-modal-body">
            <div className="sync-spinner" />
            <p>Checking this Mac...</p>
          </div>
        )}

        {phase === 'plugin-disabled' && (
          <div className="sync-modal-body">
            <div className="sync-plugin-notice">
              <strong>Enable cloud backup</strong>
              <p>Cloud backup is provided by the GitHub plugin, which is currently turned off for this writing space.</p>
              <p>Enable it to connect a private backup or shared writing space.</p>
            </div>
            <div className="sync-modal-actions">
              <button className="sync-btn secondary" onClick={onClose}>Cancel</button>
              <button className="sync-btn primary" onClick={() => void enableGitHubBackup()}>Enable cloud backup</button>
            </div>
          </div>
        )}

        {phase === 'setup' && caps && (
          <div className="sync-modal-body">
            {!caps.gitInstalled && (
              <div className="sync-warning">
                Git is not installed. Please <a href="https://git-scm.com/downloads" target="_blank" rel="noreferrer">install git</a> first.
              </div>
            )}

            {caps.gitInstalled && (
              <>
                <div className="sync-choice-label">What would you like to do?</div>
                <div className="sync-destination-choice" role="group" aria-label="Cloud backup destination">
                  <button className={`sync-destination-option${backupChoice === 'new' ? ' selected' : ''}`} onClick={() => chooseBackup('new')} aria-pressed={backupChoice === 'new'}>
                    <strong>Create a new backup</strong>
                    <span>Start a private GitHub repository from this writing space.</span>
                  </button>
                  <button className={`sync-destination-option${backupChoice === 'existing' ? ' selected' : ''}`} onClick={() => chooseBackup('existing')} aria-pressed={backupChoice === 'existing'}>
                    <strong>Connect an existing writing space</strong>
                    <span>Open a GitHub repository that already contains your work.</span>
                  </button>
                </div>

                {usingExistingWritingSpace && (
                  <>
                    <div className="sync-choice-label">How will you work in it?</div>
                    <div className="sync-role-choice" role="group" aria-label="Writing role">
                      <button className={`sync-role-option${role === 'primary' ? ' selected' : ''}`} onClick={() => chooseRole('primary')} aria-pressed={role === 'primary'}>
                        <strong>Primary writer</strong>
                        <span>Back up directly to the shared writing space.</span>
                      </button>
                      <button className={`sync-role-option${role === 'contributor' ? ' selected' : ''}`} onClick={() => chooseRole('contributor')} aria-pressed={role === 'contributor'}>
                        <strong>Contributor</strong>
                        <span>Prepare changes for the primary writer to review.</span>
                      </button>
                    </div>
                  </>
                )}

                {caps.primaryWriter && usingExistingWritingSpace && role === 'primary' && (
                  <div className="sync-warning sync-existing-primary">
                    This local writing space already identifies <strong>{caps.primaryWriter.displayName}</strong> as its primary writer. Choose Contributor unless you are continuing that role.
                  </div>
                )}

                <div className="sync-form">
                  <label>
                    Your name
                    <input type="text" value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="How should your work be identified?" autoFocus />
                  </label>
                  {usingExistingWritingSpace ? (
                    <label>
                      Repository URL
                      <input type="text" value={remoteUrl} onChange={(e) => setRemoteUrl(e.target.value)} placeholder="https://github.com/owner/repository.git" />
                      <span className="sync-field-hint">Paste the repository’s HTTPS clone URL. OpenWriter will fetch it and open the writing space here.</span>
                    </label>
                  ) : (
                    <>
                      <label>
                        Private repository name
                        <input type="text" value={repoName} onChange={(e) => setRepoName(e.target.value)} placeholder="my-writing" />
                      </label>
                      <label className="sync-checkbox">
                        <input type="checkbox" checked={isPrivate} onChange={(e) => setIsPrivate(e.target.checked)} />
                        Keep this repository private
                      </label>
                    </>
                  )}
                  {role === 'contributor' && usingExistingWritingSpace && (
                    <label>
                      Review request title <span className="sync-field-optional">(optional)</span>
                      <input type="text" value={changeSetTitle} onChange={(e) => setChangeSetTitle(e.target.value)} placeholder="Updates from you · Aug 27" />
                      <span className="sync-field-hint">Leave this empty to use OpenWriter’s suggested title. Later checkpoints update the same request.</span>
                    </label>
                  )}
                  <label className="sync-checkbox">
                    <input type="checkbox" checked={automaticCheckpoints} onChange={(e) => setAutomaticCheckpoints(e.target.checked)} />
                    Back up automatically after I pause writing
                  </label>
                  <span className="sync-field-hint">OpenWriter saves local recovery history first, then creates a cloud checkpoint after a short quiet period.</span>
                </div>

                {caps.deviceAuthAvailable && (
                  <div className="sync-device-auth" aria-live="polite">
                    {caps.oauthAuthenticated ? (
                      <span><strong>GitHub connected</strong>{caps.githubLogin ? ` as ${caps.githubLogin}` : ''}</span>
                    ) : deviceAuthorization ? (
                      <>
                        <span>Enter this one-time code in GitHub:</span>
                        <strong className="sync-device-code">{deviceAuthorization.userCode}</strong>
                        <a href={deviceAuthorization.verificationUri} target="_blank" rel="noreferrer">Open GitHub sign-in</a>
                        <span className="sync-field-hint">Waiting for approval…</span>
                      </>
                    ) : (
                      <>
                        <span>Connect your GitHub account to keep backup private and automatic.</span>
                        <button className="sync-device-auth-button" onClick={startDeviceAuthorization}>Connect GitHub account</button>
                      </>
                    )}
                    {pairingError && <span className="sync-device-error">{pairingError}</span>}
                  </div>
                )}

                <button className="sync-advanced-toggle" onClick={() => setShowAdvanced((value) => !value)}>
                  {showAdvanced ? 'Hide advanced sign-in options' : 'Advanced sign-in options'}
                </button>
                {showAdvanced && (
                  <div className="sync-advanced">
                    {caps.deviceAuthAvailable && (
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
                    {!caps.deviceAuthAvailable && !caps.ghAuthenticated && <p className="sync-hint">This build does not yet include the GitHub account-pairing client ID. A personal access token is the temporary fallback.</p>}
                  </div>
                )}

                <div className="sync-modal-actions">
                  <button className="sync-btn secondary" onClick={onClose}>Cancel</button>
                  <button
                    className="sync-btn primary"
                    onClick={handleSetup}
                    disabled={!canSubmit}
                  >
                    {role === 'contributor' && usingExistingWritingSpace ? 'Open review workspace' : usingExistingWritingSpace ? 'Open writing space' : 'Create private backup'}
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
            <p>{role === 'contributor' && usingExistingWritingSpace ? 'Your review workspace is ready.' : usingExistingWritingSpace ? 'Your writing space is ready.' : 'Private backup is ready.'}</p>
            <div className="sync-modal-actions">
              <button className="sync-btn primary" onClick={onClose}>Done</button>
            </div>
          </div>
        )}

        {phase === 'error' && (
          <div className="sync-modal-body">
            <div className="sync-error-msg">{errorMsg}</div>
            <div className="sync-modal-actions">
              <button className="sync-btn secondary" onClick={() => void detectCapabilities()}>Try again</button>
              <button className="sync-btn secondary" onClick={onClose}>Close</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
