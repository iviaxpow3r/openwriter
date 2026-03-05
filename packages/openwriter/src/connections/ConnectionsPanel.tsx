import { useState, useEffect, useRef } from 'react';
import './ConnectionsPanel.css';

interface Connection {
  id: string;
  provider: string;
  display_name?: string;
  status: string;
  domain?: string;
  from_name?: string;
  created_at: string;
}

const OAUTH_PROVIDERS = [
  { id: 'x', label: 'X (Twitter)' },
  { id: 'linkedin', label: 'LinkedIn' },
] as const;

export default function ConnectionsPanel() {
  const [open, setOpen] = useState(false);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [connecting, setConnecting] = useState<string | null>(null);
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
      .then(data => setConnections(data.connections || []))
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
      case 'newsletter': return (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="2" y="4" width="20" height="16" rx="2" />
          <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
        </svg>
      );
      default: return null;
    }
  }

  function providerLabel(provider: string) {
    switch (provider) {
      case 'x': return 'X';
      case 'linkedin': return 'LinkedIn';
      case 'newsletter': return 'Newsletter';
      default: return provider;
    }
  }

  // Which OAuth providers aren't connected yet
  const connectedProviders = new Set(connections.filter(c => c.provider !== 'newsletter').map(c => c.provider));

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
      {open && (
        <div className="connections-dropdown">
          <div className="connections-dropdown__header">Connections</div>
          <div className="connections-dropdown__list">
            {connections.length === 0 && (
              <div className="connections-dropdown__empty">No connections yet</div>
            )}
            {connections.map(conn => (
              <div key={conn.id}>
                {confirmDelete === conn.id ? (
                  <div className="connections-dropdown__confirm">
                    <span>Disconnect?</span>
                    <div className="connections-dropdown__confirm-btns">
                      <button onClick={() => handleDelete(conn.id)}>Yes</button>
                      <button onClick={() => setConfirmDelete(null)}>No</button>
                    </div>
                  </div>
                ) : (
                  <div className="connections-dropdown__item">
                    <div className="connections-dropdown__icon">
                      {providerIcon(conn.provider)}
                    </div>
                    <div className="connections-dropdown__info">
                      <div className="connections-dropdown__name">
                        {conn.display_name || conn.domain || providerLabel(conn.provider)}
                      </div>
                      <div className="connections-dropdown__type">
                        <span className={`connections-status ${statusDot(conn.status)}`} />
                        {providerLabel(conn.provider)}
                      </div>
                    </div>
                    {conn.provider !== 'newsletter' && (
                      <div className="connections-dropdown__actions">
                        <button
                          className="connections-dropdown__action-btn connections-dropdown__action-btn--delete"
                          onClick={() => setConfirmDelete(conn.id)}
                          title="Disconnect"
                        >
                          &times;
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
          {OAUTH_PROVIDERS.filter(p => !connectedProviders.has(p.id)).length > 0 && (
            <div className="connections-dropdown__connect-section">
              {OAUTH_PROVIDERS.filter(p => !connectedProviders.has(p.id)).map(p => (
                <button
                  key={p.id}
                  className="connections-dropdown__connect-btn"
                  onClick={() => startOAuth(p.id)}
                  disabled={connecting !== null}
                >
                  {providerIcon(p.id)}
                  <span>{connecting === p.id ? 'Connecting...' : `Connect ${p.label}`}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
