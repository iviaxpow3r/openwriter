import { useState, useEffect, useRef } from 'react';
import './ConnectionsPanel.css';
import NewsletterSetupModal from './NewsletterSetupModal';
import ConnectionConfigModal from './ConnectionConfigModal';

interface Connection {
  id: string;
  provider: string;
  display_name?: string;
  status: string;
  domain?: string;
  from_name?: string;
  created_at: string;
}

const ALL_PROVIDERS = [
  { id: 'x', label: 'X (Twitter)', oauth: true },
  { id: 'linkedin', label: 'LinkedIn', oauth: true },
  { id: 'github', label: 'GitHub', oauth: true },
  { id: 'newsletter', label: 'Newsletter', oauth: false },
] as const;

export default function ConnectionsPanel() {
  const [open, setOpen] = useState(false);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [connecting, setConnecting] = useState<string | null>(null);
  const [showSetup, setShowSetup] = useState<'new' | 'edit' | null>(null);
  const [configConnection, setConfigConnection] = useState<{ id: string; provider: string; display_name: string } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        setConfirmDelete(null);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  useEffect(() => {
    if (open) fetchConnections();
  }, [open]);

  // Cleanup polling on unmount
  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current); }, []);

  function fetchConnections() {
    fetch('/api/connections')
      .then(r => r.json())
      .then(data => {
        const conns = (data.connections || []).filter((c: any) => c && c.id && c.provider);
        setConnections(conns);
      })
      .catch(() => {});
  }

  async function startOAuth(provider: string) {
    setConnecting(provider);
    try {
      const res = await fetch(`/api/connections/oauth/${provider}/start`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok || !data.url) {
        setConnecting(null);
        return;
      }

      // Open OAuth consent in new window
      window.open(data.url, '_blank', 'width=600,height=700');

      // Poll for completion
      pollRef.current = setInterval(async () => {
        try {
          const statusRes = await fetch(`/api/connections/oauth/${provider}/status/${data.state}`);
          const statusData = await statusRes.json();
          if (statusData.status === 'completed') {
            if (pollRef.current) clearInterval(pollRef.current);
            pollRef.current = null;
            setConnecting(null);
            fetchConnections();
          } else if (statusData.status === 'failed') {
            if (pollRef.current) clearInterval(pollRef.current);
            pollRef.current = null;
            setConnecting(null);
          }
        } catch {
          // keep polling
        }
      }, 2000);
    } catch {
      setConnecting(null);
    }
  }

  async function handleDelete(id: string) {
    await fetch(`/api/connections/${id}`, { method: 'DELETE' });
    setConfirmDelete(null);
    fetchConnections();
  }

  function statusDot(status: string) {
    if (status === 'active') return 'connections-status--active';
    if (status === 'expired') return 'connections-status--expired';
    if (status === 'revoked') return 'connections-status--revoked';
    return 'connections-status--pending';
  }

  function providerIcon(provider: string) {
    switch (provider) {
      case 'x': return (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
          <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/>
        </svg>
      );
      case 'linkedin': return (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
          <path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433c-1.144 0-2.063-.926-2.063-2.065 0-1.138.92-2.063 2.063-2.063 1.14 0 2.064.925 2.064 2.063 0 1.139-.925 2.065-2.064 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z"/>
        </svg>
      );
      case 'github': return (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
          <path d="M12 0C5.374 0 0 5.373 0 12c0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23A11.509 11.509 0 0112 5.803c1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576C20.566 21.797 24 17.3 24 12c0-6.627-5.373-12-12-12z"/>
        </svg>
      );
      case 'newsletter': return (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="2" y="4" width="20" height="16" rx="2" />
          <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
        </svg>
      );
      default: return (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="10" />
          <line x1="2" y1="12" x2="22" y2="12" />
          <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
        </svg>
      );
    }
  }

  function providerLabel(provider: string) {
    switch (provider) {
      case 'x': return 'X';
      case 'linkedin': return 'LinkedIn';
      case 'github': return 'GitHub';
      case 'newsletter': return 'Newsletter';
      default: return provider || 'Unknown';
    }
  }

  // Map connections by provider for quick lookup
  const connectionsByProvider = new Map<string, Connection>();
  for (const conn of connections) {
    connectionsByProvider.set(conn.provider, conn);
  }

  return (
    <div className="connections-wrapper" ref={ref}>
      <button
        className={`titlebar-nav-btn${open ? ' titlebar-nav-btn--active' : ''}`}
        onClick={() => setOpen(!open)}
        title="Connections"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="5" r="3" />
          <circle cx="5" cy="19" r="3" />
          <circle cx="19" cy="19" r="3" />
          <line x1="12" y1="8" x2="5" y2="16" />
          <line x1="12" y1="8" x2="19" y2="16" />
        </svg>
      </button>
      {configConnection && (
        <ConnectionConfigModal
          connectionId={configConnection.id}
          provider={configConnection.provider}
          displayName={configConnection.display_name}
          onClose={() => setConfigConnection(null)}
          onSaved={() => fetchConnections()}
        />
      )}
      {showSetup && (
        <NewsletterSetupModal
          existingConnection={showSetup === 'edit' ? connectionsByProvider.get('newsletter') : null}
          onClose={() => setShowSetup(null)}
          onSaved={() => fetchConnections()}
        />
      )}
      {open && (
        <div className="connections-dropdown">
          <div className="connections-dropdown__header">Connections</div>
          <div className="connections-dropdown__list">
            {ALL_PROVIDERS.map(p => {
              const conn = connectionsByProvider.get(p.id);

              // Confirm-delete state
              if (conn && confirmDelete === conn.id) {
                return (
                  <div key={p.id} className="connections-dropdown__confirm">
                    <span>Disconnect {p.label}?</span>
                    <div className="connections-dropdown__confirm-btns">
                      <button onClick={() => handleDelete(conn.id)}>Yes</button>
                      <button onClick={() => setConfirmDelete(null)}>No</button>
                    </div>
                  </div>
                );
              }

              // Connected
              if (conn) {
                return (
                  <div key={p.id} className="connections-dropdown__item">
                    <div className="connections-dropdown__icon">
                      {providerIcon(p.id)}
                    </div>
                    <div className="connections-dropdown__info">
                      <div className="connections-dropdown__name">
                        {conn.display_name || conn.domain || p.label}
                      </div>
                      <div className="connections-dropdown__type">
                        <span className={`connections-status ${statusDot(conn.status)}`} />
                        Connected
                      </div>
                    </div>
                    <div className="connections-dropdown__actions">
                      <button
                        className="connections-dropdown__action-btn"
                        onClick={() => {
                          if (p.id === 'newsletter') {
                            setShowSetup('edit');
                          } else {
                            setConfigConnection({ id: conn.id, provider: p.id, display_name: conn.display_name || p.label });
                          }
                        }}
                        title="Settings"
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/>
                          <circle cx="12" cy="12" r="3"/>
                        </svg>
                      </button>
                      {p.oauth && (
                        <button
                          className="connections-dropdown__action-btn connections-dropdown__action-btn--delete"
                          onClick={() => setConfirmDelete(conn.id)}
                          title="Disconnect"
                        >
                          &times;
                        </button>
                      )}
                    </div>
                  </div>
                );
              }

              // Not connected — OAuth providers show Connect button
              if (p.oauth) {
                return (
                  <div key={p.id} className="connections-dropdown__item connections-dropdown__item--disconnected">
                    <div className="connections-dropdown__icon">
                      {providerIcon(p.id)}
                    </div>
                    <div className="connections-dropdown__info">
                      <div className="connections-dropdown__name">{p.label}</div>
                      <div className="connections-dropdown__type">Not connected</div>
                    </div>
                    <button
                      className="connections-dropdown__connect-inline-btn"
                      onClick={() => startOAuth(p.id)}
                      disabled={connecting !== null}
                    >
                      {connecting === p.id ? 'Connecting…' : 'Connect'}
                    </button>
                  </div>
                );
              }

              // Newsletter — not connected
              return (
                <div key={p.id} className="connections-dropdown__item connections-dropdown__item--disconnected">
                  <div className="connections-dropdown__icon">
                    {providerIcon(p.id)}
                  </div>
                  <div className="connections-dropdown__info">
                    <div className="connections-dropdown__name">{p.label}</div>
                    <div className="connections-dropdown__type">Built-in · Not configured</div>
                  </div>
                  <button
                    className="connections-dropdown__connect-inline-btn"
                    onClick={() => setShowSetup('new')}
                  >
                    Configure
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
