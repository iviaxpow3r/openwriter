import { useState, useEffect, useRef } from 'react';

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
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  useEffect(() => {
    if (adding && inputRef.current) inputRef.current.focus();
  }, [adding]);

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
            <div key={p} className="sidebar-profile-row">
              {confirmDelete === p ? (
                <div className="sidebar-profile-confirm">
                  <span>Delete?</span>
                  <div className="sidebar-inline-confirm">
                    <button onClick={() => { onDelete(p); setConfirmDelete(null); }}>Yes</button>
                    <button onClick={() => setConfirmDelete(null)}>No</button>
                  </div>
                </div>
              ) : (
                <button
                  className={`sidebar-profile-option ${p === activeProfile ? 'active' : ''}`}
                  onClick={() => { if (p !== activeProfile) onSwitch(p); setOpen(false); }}
                >
                  <span className="sidebar-profile-check">{p === activeProfile ? '\u2713' : ''}</span>
                  <span>{p}</span>
                </button>
              )}
              {p !== 'Default' && p !== activeProfile && confirmDelete !== p && (
                <button
                  className="sidebar-profile-delete-btn"
                  onClick={(e) => { e.stopPropagation(); setConfirmDelete(p); }}
                  title="Delete profile"
                >&times;</button>
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
