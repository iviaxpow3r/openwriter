import { useCallback, useEffect, useState } from 'react';
import './SyncSetupModal.css';
import './SyncCollaborationModal.css';

interface CollaborationMember {
  githubLogin: string;
  displayName: string;
  role: 'primary' | 'contributor';
}

interface PrimaryTransferRequest {
  id: number;
  githubLogin: string;
  displayName: string;
  createdAt?: string;
}

interface CollaborationOverview {
  primaryWriter?: { displayName: string; githubLogin?: string };
  currentRole?: 'primary' | 'contributor';
  currentGitHubLogin?: string;
  contributors: CollaborationMember[];
  transferRequests: PrimaryTransferRequest[];
  canRequestPrimary: boolean;
  canApproveTransfers: boolean;
  canClaimPrimary: boolean;
  requestAlreadyOpen: boolean;
}

interface SyncCollaborationModalProps {
  onClose: () => void;
  onUpdated: () => void;
}

type PendingAction = 'request' | 'claim' | number | null;

export default function SyncCollaborationModal({ onClose, onUpdated }: SyncCollaborationModalProps) {
  const [overview, setOverview] = useState<CollaborationOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [pendingAction, setPendingAction] = useState<PendingAction>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const response = await fetch('/api/sync/collaboration');
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Writing roles could not be loaded.');
      setOverview(data as CollaborationOverview);
    } catch (nextError: any) {
      setError(nextError?.message || 'Writing roles could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const act = useCallback(async (path: string, body?: Record<string, unknown>) => {
    setBusy(true);
    setError('');
    try {
      const response = await fetch(path, {
        method: 'POST',
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Writing roles could not be updated.');
      setOverview(data as CollaborationOverview);
      setPendingAction(null);
      onUpdated();
    } catch (nextError: any) {
      setError(nextError?.message || 'Writing roles could not be updated.');
    } finally {
      setBusy(false);
    }
  }, [onUpdated]);

  const primary = overview?.primaryWriter;

  return (
    <div className="sync-modal-overlay" onClick={onClose}>
      <div className="sync-modal sync-roles-modal" onClick={(event) => event.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="sync-writing-roles-title">
        <div className="sync-modal-header">
          <div>
            <h2 id="sync-writing-roles-title">Writing roles</h2>
            <p>One primary writer works directly in the shared writing space. Contributors prepare changes for review.</p>
          </div>
          <button className="sync-modal-close" onClick={onClose} aria-label="Close writing roles">&times;</button>
        </div>

        <div className="sync-modal-body sync-roles-body">
          {loading ? (
            <><div className="sync-spinner" /><p className="sync-roles-loading">Loading writing roles...</p></>
          ) : error && !overview ? (
            <div className="sync-error-msg"><strong>Writing roles are unavailable.</strong><span>{error}</span></div>
          ) : overview ? (
            <>
              {error && <div className="sync-error-msg"><strong>Nothing changed.</strong><span>{error}</span></div>}

              <section className="sync-roles-section">
                <div className="sync-choice-label">Primary writer</div>
                <div className="sync-role-person sync-role-person--primary">
                  <div>
                    <strong>{primary?.githubLogin ? `@${primary.githubLogin}` : primary?.displayName || 'Not set'}</strong>
                    {primary?.githubLogin && primary.displayName !== primary.githubLogin && <span>{primary.displayName}</span>}
                  </div>
                  <span className="sync-role-description">Writes directly</span>
                </div>
              </section>

              <section className="sync-roles-section">
                <div className="sync-choice-label">Contributors</div>
                {overview.contributors.length ? (
                  <div className="sync-role-list">
                    {overview.contributors.map((member) => (
                      <div className="sync-role-person" key={member.githubLogin}>
                        <div>
                          <strong>@{member.githubLogin}</strong>
                          {member.displayName !== member.githubLogin && <span>{member.displayName}</span>}
                        </div>
                        <span className="sync-role-description">Prepares changes for review</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="sync-roles-empty">No other GitHub writers have been added yet.</p>
                )}
                <p className="sync-roles-note">Repository access is managed in GitHub. OpenWriter shows people with direct write access here and keeps their writing on review branches.</p>
              </section>

              {overview.canApproveTransfers && (
                <section className="sync-roles-section">
                  <div className="sync-choice-label">Primary writer requests</div>
                  {overview.transferRequests.length ? (
                    <div className="sync-role-list">
                      {overview.transferRequests.map((request) => (
                        <div className="sync-transfer-request" key={request.id}>
                          <div>
                            <strong>@{request.githubLogin}</strong>
                            <span>Requested primary writer status{request.createdAt ? ` · ${new Date(request.createdAt).toLocaleDateString()}` : ''}</span>
                          </div>
                          {pendingAction === request.id ? (
                            <div className="sync-transfer-confirm">
                              <p>This makes @{request.githubLogin} the primary writer. This profile will prepare future changes for review.</p>
                              <div>
                                <button className="sync-btn secondary" disabled={busy} onClick={() => setPendingAction(null)}>Cancel</button>
                                <button className="sync-btn primary" disabled={busy} onClick={() => void act('/api/sync/collaboration/primary-transfer', { requestId: request.id })}>Approve transfer</button>
                              </div>
                            </div>
                          ) : (
                            <button className="sync-btn secondary sync-role-action" disabled={busy} onClick={() => setPendingAction(request.id)}>Review transfer</button>
                          )}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="sync-roles-empty">No contributor has requested primary writer status.</p>
                  )}
                </section>
              )}

              {overview.canClaimPrimary && (
                <section className="sync-roles-section sync-role-next-step">
                  <div className="sync-choice-label">Your next step</div>
                  <p>Your primary-writer request was approved. Finish switching this profile before making direct changes.</p>
                  {pendingAction === 'claim' ? (
                    <div className="sync-transfer-confirm">
                      <p>Any unmerged contributor changes must be resolved first. This profile will then write directly to the shared space.</p>
                      <div>
                        <button className="sync-btn secondary" disabled={busy} onClick={() => setPendingAction(null)}>Cancel</button>
                        <button className="sync-btn primary" disabled={busy} onClick={() => void act('/api/sync/collaboration/claim-primary')}>Become primary writer</button>
                      </div>
                    </div>
                  ) : (
                    <button className="sync-btn primary sync-role-action" disabled={busy} onClick={() => setPendingAction('claim')}>Become primary writer</button>
                  )}
                </section>
              )}

              {overview.canRequestPrimary && !overview.canClaimPrimary && (
                <section className="sync-roles-section sync-role-next-step">
                  <div className="sync-choice-label">Your next step</div>
                  {overview.requestAlreadyOpen ? (
                    <p>Your request is waiting for the current primary writer to review it.</p>
                  ) : pendingAction === 'request' ? (
                    <div className="sync-transfer-confirm">
                      <p>Your contributor branch must be fully merged first. The current primary writer will review this request in OpenWriter.</p>
                      <div>
                        <button className="sync-btn secondary" disabled={busy} onClick={() => setPendingAction(null)}>Cancel</button>
                        <button className="sync-btn primary" disabled={busy} onClick={() => void act('/api/sync/collaboration/primary-request')}>Send request</button>
                      </div>
                    </div>
                  ) : (
                    <button className="sync-btn secondary sync-role-action" disabled={busy} onClick={() => setPendingAction('request')}>Request primary writer status</button>
                  )}
                </section>
              )}
            </>
          ) : null}

          <div className="sync-modal-actions">
            {error && <button className="sync-btn secondary" disabled={loading || busy} onClick={() => void load()}>Try again</button>}
            <button className="sync-btn secondary" onClick={onClose}>Done</button>
          </div>
        </div>
      </div>
    </div>
  );
}
