import { useState, useEffect, useRef } from 'react';

interface Connection {
  id: string;
  type: string;
  name: string;
}

interface ProfileSwitcherProps {
  profiles: string[];
  activeProfile: string;
  trashedProfiles: string[];
  onSwitch: (name: string) => void;
  onCreate: (name: string) => void;
  onDelete: (name: string) => void;
  onRestore: (name: string) => void;
}

export default function ProfileSwitcher({ profiles, activeProfile, trashedProfiles, onSwitch, onCreate, onDelete, onRestore }: ProfileSwitcherProps) {
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState('');
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [expandedProfile, setExpandedProfile] = useState<string | null>(null);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [activeIds, setActiveIds] = useState<Record<string, string[]>>({});
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        setAdding(false);
        setNewName('');
        setConfirmDelete(null);
        setExpandedProfile(null);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  useEffect(() => {
    if (adding && inputRef.current) inputRef.current.focus();
  }, [adding]);

  // Auto-expand active profile when dropdown opens
  useEffect(() => {
    if (open) {
      setExpandedProfile(activeProfile);
      fetchConnections(activeProfile);
    }
  }, [open, activeProfile]);

  function fetchConnections(profile: string) {
    fetch(`/api/connections?profile=${encodeURIComponent(profile)}`)
      .then(r => r.json())
      .then(data => {
        setConnections(data.connections || []);
        setActiveIds(prev => ({ ...prev, [profile]: data.activeIds || [] }));
      })
      .catch(() => {});
  }

  function toggleExpand(profile: string) {
    if (expandedProfile === profile) {
      setExpandedProfile(null);
    } else {
      setExpandedProfile(profile);
      if (!activeIds[profile]) fetchConnections(profile);
    }
  }

  async function toggleConnection(profile: string, connectionId: string) {
    const res = await fetch(`/api/connections/${connectionId}/toggle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile }),
    });
    if (res.ok) {
      const data = await res.json();
      setActiveIds(prev => {
        const current = prev[profile] || [];
        if (data.active) {
          return { ...prev, [profile]: [...current, connectionId] };
        } else {
          return { ...prev, [profile]: current.filter(id => id !== connectionId) };
        }
      });
    }
  }

  const handleCreate = () => {
    const trimmed = newName.trim();
    if (!trimmed) return;
    onCreate(trimmed);
    setNewName('');
    setAdding(false);
  };

  return (
    <div className="sidebar-profile-wrapper" ref={ref}>
      <button className="sidebar-collapse-btn" onClick={() => setOpen(!open)} title={`Profile: ${activeProfile}`}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="8" r="4" />
          <path d="M5.5 21a8.38 8.38 0 0 1 13 0" />
        </svg>
      </button>
      {open && (
        <div className="sidebar-profile-dropdown">
          {profiles.map((p) => (
            <div key={p}>
              <div className="sidebar-profile-row">
                {confirmDelete === p ? (
                  <div className="sidebar-profile-confirm">
                    <span>Delete?</span>
                    <div className="sidebar-inline-confirm">
                      <button onClick={() => { onDelete(p); setConfirmDelete(null); }}>Yes</button>
                      <button onClick={() => setConfirmDelete(null)}>No</button>
                    </div>
                  </div>
                ) : (
                  <>
                    {connections.length > 0 && (
                      <button
                        className="sidebar-profile-expand-btn"
                        onClick={(e) => { e.stopPropagation(); toggleExpand(p); }}
                        title={expandedProfile === p ? 'Collapse' : 'Expand connections'}
                      >
                        <span className={`sidebar-profile-arrow${expandedProfile === p ? ' expanded' : ''}`}>&#9654;</span>
                      </button>
                    )}
                    <button
                      className={`sidebar-profile-option ${p === activeProfile ? 'active' : ''}`}
                      onClick={() => { if (p !== activeProfile) onSwitch(p); setOpen(false); }}
                    >
                      <span className="sidebar-profile-check">{p === activeProfile ? '\u2713' : ''}</span>
                      <span>{p}</span>
                    </button>
                  </>
                )}
                {p !== 'Default' && p !== activeProfile && confirmDelete !== p && (
                  <button
                    className="sidebar-profile-delete-btn"
                    onClick={(e) => { e.stopPropagation(); setConfirmDelete(p); }}
                    title="Delete profile"
                  >&times;</button>
                )}
              </div>
              {expandedProfile === p && connections.length > 0 && (
                <div className="sidebar-profile-connections">
                  {connections.map(conn => {
                    const isActive = (activeIds[p] || []).includes(conn.id);
                    return (
                      <label key={conn.id} className="sidebar-profile-conn-toggle">
                        <input
                          type="checkbox"
                          checked={isActive}
                          onChange={() => toggleConnection(p, conn.id)}
                        />
                        <span className="sidebar-profile-conn-name">{conn.name}</span>
                      </label>
                    );
                  })}
                </div>
              )}
            </div>
          ))}
          {trashedProfiles.length > 0 && (
            <>
              <div className="sidebar-profile-divider" />
              <div className="sidebar-profile-trash-label">Trash</div>
              {trashedProfiles.map((p) => (
                <div key={p} className="sidebar-profile-row sidebar-profile-trashed">
                  <span className="sidebar-profile-trash-name">{p}</span>
                  <button
                    className="sidebar-profile-restore-btn"
                    onClick={() => onRestore(p)}
                  >Restore</button>
                </div>
              ))}
            </>
          )}
          <div className="sidebar-profile-divider" />
          {adding ? (
            <div className="sidebar-profile-add-input">
              <input
                ref={inputRef}
                type="text"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleCreate(); if (e.key === 'Escape') { setAdding(false); setNewName(''); } }}
                placeholder="Profile name..."
              />
            </div>
          ) : (
            <button className="sidebar-profile-option sidebar-profile-add" onClick={() => setAdding(true)}>
              <span className="sidebar-profile-check">+</span>
              <span>New Profile</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}
