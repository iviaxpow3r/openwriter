import { useState, useEffect, useRef, useCallback } from 'react';
import type { PendingDocsPayload } from '../ws/client';
import { useSidebarData } from './sidebar-data';
import { useSidebarActions } from './sidebar-actions';
import { getSidebarMode } from '../themes/appearance-store';
import type { SearchResult, DocumentInfo } from './sidebar-types';
import SidebarDefault from './SidebarDefault';
import SidebarTimeline from './SidebarTimeline';
import SidebarBoard from './SidebarBoard';
import SidebarShelf from './SidebarShelf';
import SidebarSchedule from './SidebarSchedule';
import SidebarTasks from './SidebarTasks';
import ProfileSwitcher from './ProfileSwitcher';
import './Sidebar.css';

interface SidebarProps {
  open: boolean;
  onSwitchDocument: (filename: string) => void;
  onCreateDocument: () => void;
  refreshKey: number;
  workspacesRefreshKey: number;
  pendingDocs: PendingDocsPayload;
  writingTitle?: string | null;
  writingTarget?: { wsFilename: string; containerId: string | null } | null;
  onClose?: () => void;
}

export default function Sidebar({ open, onSwitchDocument, onCreateDocument, refreshKey, workspacesRefreshKey, pendingDocs, writingTitle, writingTarget, onClose }: SidebarProps) {
  const { docs, workspaces, assignedFiles, fetchDocs, scrollRef } = useSidebarData(refreshKey, workspacesRefreshKey);
  const actions = useSidebarActions(workspaces, fetchDocs, refreshKey);
  const mode = getSidebarMode();
  const [scheduleView, setScheduleView] = useState(false);
  const [tasksView, setTasksView] = useState(false);

  // Profile state
  const [profiles, setProfiles] = useState<string[]>([]);
  const [activeProfile, setActiveProfile] = useState('Default');

  const fetchProfiles = useCallback(async () => {
    try {
      const res = await fetch('/api/profiles');
      if (res.ok) {
        const data = await res.json();
        setProfiles(data.profiles);
        setActiveProfile(data.active);
      }
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { fetchProfiles(); }, [fetchProfiles]);

  const handleSwitchProfile = useCallback(async (name: string) => {
    try {
      const res = await fetch('/api/profiles/switch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      if (res.ok) {
        setActiveProfile(name);
        fetchProfiles();
      }
    } catch { /* ignore */ }
  }, [fetchProfiles]);

  const handleCreateProfile = useCallback(async (name: string) => {
    try {
      const res = await fetch('/api/profiles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      if (res.ok) fetchProfiles();
    } catch { /* ignore */ }
  }, [fetchProfiles]);

  // Trashed profiles
  const [trashedProfiles, setTrashedProfiles] = useState<string[]>([]);

  const fetchTrashedProfiles = useCallback(async () => {
    try {
      const res = await fetch('/api/profiles/trash');
      if (res.ok) {
        const data = await res.json();
        setTrashedProfiles(data.profiles);
      }
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { fetchTrashedProfiles(); }, [fetchTrashedProfiles]);

  const handleDeleteProfile = useCallback(async (name: string) => {
    try {
      const res = await fetch(`/api/profiles/${encodeURIComponent(name)}`, { method: 'DELETE' });
      if (res.ok) {
        fetchProfiles();
        fetchTrashedProfiles();
      }
    } catch { /* ignore */ }
  }, [fetchProfiles, fetchTrashedProfiles]);

  const handleRestoreProfile = useCallback(async (name: string) => {
    try {
      const res = await fetch('/api/profiles/restore', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      if (res.ok) {
        fetchProfiles();
        fetchTrashedProfiles();
      }
    } catch { /* ignore */ }
  }, [fetchProfiles, fetchTrashedProfiles]);

  // Search state
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResult[] | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();
  const searchInputRef = useRef<HTMLInputElement>(null);

  const onSearchChange = useCallback((query: string) => {
    setSearchQuery(query);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!query.trim()) {
      setSearchResults(null);
      return;
    }
    debounceRef.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/documents/search?q=${encodeURIComponent(query.trim())}&archived=true`);
        if (res.ok) setSearchResults(await res.json());
      } catch { /* ignore */ }
    }, 250);
  }, []);

  // Cleanup debounce on unmount
  useEffect(() => () => { if (debounceRef.current) clearTimeout(debounceRef.current); }, []);

  const modeProps = {
    docs, archivedDocs: [] as DocumentInfo[], workspaces, assignedFiles, pendingDocs, writingTitle, writingTarget,
    onSwitchDocument, onCreateDocument, actions, scrollRef,
    searchQuery, searchResults, onSearchChange,
  };

  const renderMode = () => {
    switch (mode) {
      case 'timeline': return <SidebarTimeline {...modeProps} />;
      case 'board': return <SidebarBoard {...modeProps} />;
      case 'shelf': return <SidebarShelf {...modeProps} />;
      default: return <SidebarDefault {...modeProps} />;
    }
  };

  const searchBar = (
    <div className="sidebar-search">
      <svg className="sidebar-search-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="10.5" cy="10.5" r="7" />
        <path d="m20 20-4.5-4.5" />
      </svg>
      <input
        ref={searchInputRef}
        className="sidebar-search-input"
        type="text"
        placeholder="Search..."
        value={searchQuery}
        onChange={(e) => onSearchChange(e.target.value)}
      />
      {searchQuery && (
        <button className="sidebar-search-clear" onClick={() => onSearchChange('')} title="Clear search">
          &times;
        </button>
      )}
    </div>
  );

  // Board mode uses horizontal layout — rendered differently in App
  if (mode === 'board') {
    return (
      <div className={`sidebar sidebar-board-mode ${open ? 'open' : ''}`}>
        {renderMode()}
      </div>
    );
  }

  return (
    <div className={`sidebar ${open ? 'open' : ''}`}>
      <div className="sidebar-topbar">
        <div className="sidebar-logo">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
            <path d="M17 3a2.83 2.83 0 0 1 4 4L7.5 20.5 2 22l1.5-5.5Z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M15 5l4 4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span className="sidebar-logo-text">OpenWriter</span>
        </div>
        <div className="sidebar-topbar-actions">
          <ProfileSwitcher profiles={profiles} activeProfile={activeProfile} trashedProfiles={trashedProfiles} onSwitch={handleSwitchProfile} onCreate={handleCreateProfile} onDelete={handleDeleteProfile} onRestore={handleRestoreProfile} />
          <button
            className={`sidebar-collapse-btn${scheduleView ? ' sidebar-collapse-btn--active' : ''}`}
            onClick={() => { setScheduleView(!scheduleView); setTasksView(false); }}
            title="Schedule"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect width="18" height="18" x="3" y="3" rx="2" />
              <line x1="16" x2="16" y1="1" y2="5" />
              <line x1="8" x2="8" y1="1" y2="5" />
              <line x1="3" x2="21" y1="9" y2="9" />
            </svg>
          </button>
          <button
            className={`sidebar-collapse-btn${tasksView ? ' sidebar-collapse-btn--active' : ''}`}
            onClick={() => { setTasksView(!tasksView); setScheduleView(false); }}
            title="Tasks"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect width="18" height="18" x="3" y="3" rx="2" />
              <path d="m9 12 2 2 4-4" />
            </svg>
          </button>
          {onClose && (
            <button className="sidebar-collapse-btn" onClick={onClose} title="Close sidebar">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                <rect x="3" y="3" width="18" height="18" rx="2" stroke="currentColor" strokeWidth="2" />
                <path d="M9 3v18" stroke="currentColor" strokeWidth="2" />
                <path d="M15 10l-2 2 2 2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          )}
        </div>
      </div>
      {tasksView ? (
        <SidebarTasks onBack={() => setTasksView(false)} />
      ) : scheduleView ? (
        <SidebarSchedule onBack={() => setScheduleView(false)} />
      ) : (
        <>
          {searchBar}
          {renderMode()}
        </>
      )}
    </div>
  );
}
