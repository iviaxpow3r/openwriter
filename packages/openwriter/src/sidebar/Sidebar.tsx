import { useState, useEffect, useRef, useCallback } from 'react';
import type { PendingDocsPayload } from '../ws/client';
import { useSidebarData } from './sidebar-data';
import { useSidebarActions } from './sidebar-actions';
import { getSidebarMode, getSidebarDensity, setSidebarDensity } from '../themes/appearance-store';
import type { SidebarDensity } from '../themes/appearance-store';
import type { SearchResult } from './sidebar-types';
import SidebarDefault from './SidebarDefault';
import SidebarTimeline from './SidebarTimeline';
import SidebarBoard from './SidebarBoard';
import SidebarShelf from './SidebarShelf';
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

const DENSITY_OPTIONS: { id: SidebarDensity; label: string; lines: number }[] = [
  { id: 'full', label: 'Full', lines: 3 },
  { id: 'compact', label: 'Compact', lines: 2 },
  { id: 'minimal', label: 'Minimal', lines: 1 },
];

function DensityDropdown() {
  const [open, setOpen] = useState(false);
  const [density, setDensity] = useState<SidebarDensity>(getSidebarDensity);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const handleSelect = (id: SidebarDensity) => {
    setDensity(id);
    setSidebarDensity(id);
    setOpen(false);
  };

  return (
    <div className="sidebar-density-wrapper" ref={ref}>
      <button className="sidebar-collapse-btn" onClick={() => setOpen(!open)} title="Card density">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <rect width="18" height="18" x="3" y="3" rx="2" />
          <path d="M21 9H3" />
          <path d="M21 15H3" />
        </svg>
      </button>
      {open && (
        <div className="sidebar-density-dropdown">
          {DENSITY_OPTIONS.map((opt) => (
            <button
              key={opt.id}
              className={`sidebar-density-option ${density === opt.id ? 'active' : ''}`}
              onClick={() => handleSelect(opt.id)}
            >
              <span className="sidebar-density-icon">
                {Array.from({ length: opt.lines }, (_, i) => (
                  <span key={i} className="sidebar-density-line" />
                ))}
              </span>
              <span>{opt.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default function Sidebar({ open, onSwitchDocument, onCreateDocument, refreshKey, workspacesRefreshKey, pendingDocs, writingTitle, writingTarget, onClose }: SidebarProps) {
  const { docs, workspaces, assignedFiles, fetchDocs, scrollRef } = useSidebarData(refreshKey, workspacesRefreshKey);
  const actions = useSidebarActions(workspaces, fetchDocs, refreshKey);
  const mode = getSidebarMode();

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
        const res = await fetch(`/api/documents/search?q=${encodeURIComponent(query.trim())}`);
        if (res.ok) setSearchResults(await res.json());
      } catch { /* ignore */ }
    }, 250);
  }, []);

  // Cleanup debounce on unmount
  useEffect(() => () => { if (debounceRef.current) clearTimeout(debounceRef.current); }, []);

  const modeProps = {
    docs, workspaces, assignedFiles, pendingDocs, writingTitle, writingTarget,
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
      <svg className="sidebar-search-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="11" cy="11" r="8" />
        <path d="m21 21-4.3-4.3" />
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
            <path d="M17 3a2.83 2.83 0 0 1 4 4L7.5 20.5 2 22l1.5-5.5Z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M15 5l4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span className="sidebar-logo-text">OpenWriter</span>
        </div>
        <div className="sidebar-topbar-actions">
          <DensityDropdown />
          {onClose && (
            <button className="sidebar-collapse-btn" onClick={onClose} title="Close sidebar">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
                <rect x="3" y="3" width="18" height="18" rx="2" stroke="currentColor" strokeWidth="1.5" />
                <path d="M9 3v18" stroke="currentColor" strokeWidth="1.5" />
                <path d="M15 10l-2 2 2 2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          )}
        </div>
      </div>
      {searchBar}
      {renderMode()}
    </div>
  );
}
