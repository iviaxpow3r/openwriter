import { useState, useEffect, useRef } from 'react';
import './ConnectionsPanel.css';

interface Connection {
  id: string;
  type: 'newsletter';
  name: string;
  createdAt: string;
  credentials: Record<string, string>;
}

type FormMode = { kind: 'closed' } | { kind: 'add' } | { kind: 'edit'; id: string };

export default function ConnectionsPanel() {
  const [open, setOpen] = useState(false);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [formMode, setFormMode] = useState<FormMode>({ kind: 'closed' });
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [apiUrl, setApiUrl] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        resetForm();
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  useEffect(() => {
    if (open) fetchConnections();
  }, [open]);

  function fetchConnections() {
    fetch('/api/connections')
      .then(r => r.json())
      .then(data => setConnections(data.connections || []))
      .catch(() => {});
  }

  function resetForm() {
    setFormMode({ kind: 'closed' });
    setName('');
    setApiKey('');
    setApiUrl('');
    setConfirmDelete(null);
  }

  function startEdit(conn: Connection) {
    setFormMode({ kind: 'edit', id: conn.id });
    setName(conn.name);
    setApiKey(conn.credentials['api-key'] || '');
    setApiUrl(conn.credentials['api-url'] || '');
  }

  async function handleSave() {
    if (!name.trim() || !apiKey.trim()) return;
    const credentials: Record<string, string> = { 'api-key': apiKey.trim() };
    if (apiUrl.trim()) credentials['api-url'] = apiUrl.trim();

    if (formMode.kind === 'add') {
      await fetch('/api/connections', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'newsletter', name: name.trim(), credentials }),
      });
    } else if (formMode.kind === 'edit') {
      await fetch(`/api/connections/${formMode.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), credentials }),
      });
    }
    resetForm();
    fetchConnections();
  }

  async function handleDelete(id: string) {
    await fetch(`/api/connections/${id}`, { method: 'DELETE' });
    setConfirmDelete(null);
    fetchConnections();
  }

  const typeLabel = (type: string) => {
    switch (type) {
      case 'newsletter': return 'Newsletter';
      default: return type;
    }
  };

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
            {connections.length === 0 && formMode.kind === 'closed' && (
              <div className="connections-dropdown__empty">No connections yet</div>
            )}
            {connections.map(conn => (
              <div key={conn.id}>
                {confirmDelete === conn.id ? (
                  <div className="connections-dropdown__confirm">
                    <span>Delete?</span>
                    <div className="connections-dropdown__confirm-btns">
                      <button onClick={() => handleDelete(conn.id)}>Yes</button>
                      <button onClick={() => setConfirmDelete(null)}>No</button>
                    </div>
                  </div>
                ) : (
                  <div className="connections-dropdown__item">
                    <div className="connections-dropdown__icon">
                      {conn.type === 'newsletter' && (
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <rect x="2" y="4" width="20" height="16" rx="2" />
                          <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
                        </svg>
                      )}
                    </div>
                    <div className="connections-dropdown__info">
                      <div className="connections-dropdown__name">{conn.name}</div>
                      <div className="connections-dropdown__type">{typeLabel(conn.type)}</div>
                    </div>
                    <div className="connections-dropdown__actions">
                      <button
                        className="connections-dropdown__action-btn"
                        onClick={() => startEdit(conn)}
                        title="Edit"
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
                        </svg>
                      </button>
                      <button
                        className="connections-dropdown__action-btn connections-dropdown__action-btn--delete"
                        onClick={() => setConfirmDelete(conn.id)}
                        title="Delete"
                      >
                        &times;
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
          {formMode.kind !== 'closed' && (
            <div className="connections-form">
              <div className="connections-form__field">
                <label className="connections-form__label">Name</label>
                <input
                  className="connections-form__input"
                  value={name}
                  onChange={e => setName(e.target.value)}
                  placeholder="My Newsletter"
                  autoFocus
                />
              </div>
              <div className="connections-form__field">
                <label className="connections-form__label">API Key</label>
                <input
                  className="connections-form__input"
                  value={apiKey}
                  onChange={e => setApiKey(e.target.value)}
                  placeholder="ow_live_..."
                  type="password"
                />
              </div>
              <div className="connections-form__field">
                <label className="connections-form__label">API URL (optional)</label>
                <input
                  className="connections-form__input"
                  value={apiUrl}
                  onChange={e => setApiUrl(e.target.value)}
                  placeholder="https://publish.openwriter.io"
                />
              </div>
              <div className="connections-form__buttons">
                <button className="connections-form__btn" onClick={resetForm}>Cancel</button>
                <button
                  className="connections-form__btn connections-form__btn--primary"
                  onClick={handleSave}
                  disabled={!name.trim() || !apiKey.trim()}
                >
                  {formMode.kind === 'add' ? 'Save' : 'Update'}
                </button>
              </div>
            </div>
          )}
          {formMode.kind === 'closed' && (
            <button
              className="connections-dropdown__add"
              onClick={() => setFormMode({ kind: 'add' })}
            >
              <span>+</span>
              <span>Add Connection</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}
