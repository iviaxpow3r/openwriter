import { useCallback, useEffect, useState } from 'react';
import './SyncSetupModal.css';

interface SyncCapabilities {
  gitInstalled: boolean;
  ghInstalled: boolean;
  ghAuthenticated: boolean;
  existingRepo: boolean;
  remoteUrl?: string;
  primaryWriter?: { displayName: string; githubLogin?: string };
}

interface SyncSetupModalProps {
  onClose: () => void;
  onSetupComplete: () => void;
}

type Phase = 'detecting' | 'setup' | 'progress' | 'done' | 'error';
type CollaborationRole = 'primary' | 'contributor';

export default function SyncSetupModal({ onClose, onSetupComplete }: SyncSetupModalProps) {
  const [phase, setPhase] = useState<Phase>('detecting');
  const [caps, setCaps] = useState<SyncCapabilities | null>(null);
  const [mode, setMode] = useState<'gh' | 'pat' | 'connect'>('gh');
  const [repoName, setRepoName] = useState('openwriter-docs');
  const [isPrivate, setIsPrivate] = useState(true);
  const [pat, setPat] = useState('');
  const [remoteUrl, setRemoteUrl] = useState('');
  const [role, setRole] = useState<CollaborationRole>('primary');
  const [displayName, setDisplayName] = useState('');
  const [automaticCheckpoints, setAutomaticCheckpoints] = useState(true);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [progressMsg, setProgressMsg] = useState('');

  // Detect capabilities on mount
  useEffect(() => {
    fetch('/api/sync/capabilities')
      .then((r) => r.json())
      .then((data: SyncCapabilities) => {
        setCaps(data);
        setRemoteUrl(data.remoteUrl || '');
        if (data.ghAuthenticated) setMode('gh');
        else if (data.gitInstalled) setMode('pat');
        else setMode('pat');
        setPhase('setup');
      })
      .catch(() => {
        setErrorMsg('Failed to detect git capabilities');
        setPhase('error');
      });
  }, []);

  const handleSetup = useCallback(async () => {
    setPhase('progress');
    const effectiveMode = role === 'contributor' || (caps?.existingRepo && remoteUrl.trim()) ? 'connect' : mode;
    setProgressMsg(role === 'contributor' ? 'Preparing your review branch...' : effectiveMode === 'connect' ? 'Connecting to repository...' : 'Creating private backup...');

    try {
      const body: Record<string, any> = {
        method: effectiveMode,
        repoName,
        isPrivate,
        collaboration: {
          role,
          displayName: displayName.trim(),
          automaticCheckpoints,
        },
      };
      if (mode === 'pat') body.pat = pat;
      if (effectiveMode === 'connect') { body.remoteUrl = remoteUrl; body.pat = pat || undefined; }

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
  }, [mode, role, caps?.existingRepo, repoName, isPrivate, pat, remoteUrl, displayName, automaticCheckpoints, onSetupComplete]);

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

        {phase === 'setup' && caps && (
          <div className="sync-modal-body">
            {!caps.gitInstalled && (
              <div className="sync-warning">
                Git is not installed. Please <a href="https://git-scm.com/downloads" target="_blank" rel="noreferrer">install git</a> first.
              </div>
            )}

            {caps.gitInstalled && (
              <>
                <div className="sync-role-choice" role="group" aria-label="Writing role">
                  <button className={`sync-role-option${role === 'primary' ? ' selected' : ''}`} onClick={() => setRole('primary')}>
                    <strong>Primary writer</strong>
                    <span>Back up directly to the shared writing space.</span>
                  </button>
                  <button className={`sync-role-option${role === 'contributor' ? ' selected' : ''}`} onClick={() => setRole('contributor')}>
                    <strong>Contributor</strong>
                    <span>Prepare changes for the primary writer to review.</span>
                  </button>
                </div>

                {caps.primaryWriter && role === 'primary' && (
                  <div className="sync-warning sync-existing-primary">
                    This writing space already identifies <strong>{caps.primaryWriter.displayName}</strong> as its primary writer. Choose Contributor unless you are continuing that primary-writing setup.
                  </div>
                )}

                <div className="sync-form">
                  <label>
                    Your name
                    <input type="text" value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="How should your work be identified?" autoFocus />
                  </label>
                  {role === 'contributor' || (caps.existingRepo && remoteUrl) ? (
                    <label>
                      Shared GitHub repository
                      <input type="text" value={remoteUrl} onChange={(e) => setRemoteUrl(e.target.value)} placeholder="https://github.com/owner/repository.git" />
                      <span className="sync-field-hint">{role === 'contributor' ? 'Your work will be sent to your own branch, never directly to the primary branch.' : 'This device will continue using the existing writing space.'}</span>
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
                  <label className="sync-checkbox">
                    <input type="checkbox" checked={automaticCheckpoints} onChange={(e) => setAutomaticCheckpoints(e.target.checked)} />
                    Back up automatically after I pause writing
                  </label>
                  <span className="sync-field-hint">OpenWriter saves local recovery history first, then creates a cloud checkpoint after a short quiet period.</span>
                </div>

                <button className="sync-advanced-toggle" onClick={() => setShowAdvanced((value) => !value)}>
                  {showAdvanced ? 'Hide advanced sign-in options' : 'Advanced sign-in options'}
                </button>
                {showAdvanced && (
                  <div className="sync-advanced">
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
                        Personal access token {role === 'contributor' ? '(optional when Git already has access)' : ''}
                        <input type="password" value={pat} onChange={(e) => setPat(e.target.value)} placeholder="github_pat_…" />
                      </label>
                    )}
                    {!caps.ghAuthenticated && <p className="sync-hint">A guided GitHub sign-in will replace this advanced path once it is registered for OpenWriter.</p>}
                  </div>
                )}

                <div className="sync-modal-actions">
                  <button className="sync-btn secondary" onClick={onClose}>Cancel</button>
                  <button
                    className="sync-btn primary"
                    onClick={handleSetup}
                    disabled={!displayName.trim() || (role === 'contributor' ? !remoteUrl.trim() : ((caps.existingRepo && remoteUrl) ? false : (mode === 'pat' && !pat.trim()) || !repoName.trim()))}
                  >
                    {role === 'contributor' ? 'Prepare changes for review' : 'Start private backup'}
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
            <p>{role === 'contributor' ? 'Your review branch is ready.' : 'Private backup is ready.'}</p>
            <div className="sync-modal-actions">
              <button className="sync-btn primary" onClick={onClose}>Done</button>
            </div>
          </div>
        )}

        {phase === 'error' && (
          <div className="sync-modal-body">
            <div className="sync-error-msg">{errorMsg}</div>
            <div className="sync-modal-actions">
              <button className="sync-btn secondary" onClick={() => setPhase('setup')}>Back</button>
              <button className="sync-btn secondary" onClick={onClose}>Close</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
