/**
 * Right-rail UI state. Three values: open, activeTab, width.
 * Persisted to localStorage so opening the app restores the prior state.
 * adr: adr/right-rail.md
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { TabId } from './types';

const STORAGE_KEY = 'ow-right-rail';
const DEFAULT_WIDTH = 280;
const MIN_WIDTH = 220;
const MAX_WIDTH = 520;

interface PersistedState {
  open: boolean;
  activeTab: TabId | null;
  width: number;
}

interface RightRailContextValue extends PersistedState {
  openTab: (tab: TabId) => void;
  closeRail: () => void;
  toggleRail: () => void;
  setWidth: (width: number) => void;
}

const RightRailContext = createContext<RightRailContextValue | null>(null);

function loadPersisted(): PersistedState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { open: false, activeTab: null, width: DEFAULT_WIDTH };
    const parsed = JSON.parse(raw) as Partial<PersistedState>;
    return {
      open: Boolean(parsed.open),
      activeTab: (parsed.activeTab as TabId | null) ?? null,
      width: clampWidth(typeof parsed.width === 'number' ? parsed.width : DEFAULT_WIDTH),
    };
  } catch {
    return { open: false, activeTab: null, width: DEFAULT_WIDTH };
  }
}

function clampWidth(w: number): number {
  if (!Number.isFinite(w)) return DEFAULT_WIDTH;
  return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, w));
}

export function RightRailProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<PersistedState>(() => loadPersisted());

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      /* localStorage full or denied — non-fatal */
    }
  }, [state]);

  const openTab = useCallback((tab: TabId) => {
    setState((s) => ({ ...s, open: true, activeTab: tab }));
  }, []);

  const closeRail = useCallback(() => {
    setState((s) => ({ ...s, open: false }));
  }, []);

  const toggleRail = useCallback(() => {
    setState((s) => ({ ...s, open: !s.open }));
  }, []);

  const setWidth = useCallback((width: number) => {
    setState((s) => ({ ...s, width: clampWidth(width) }));
  }, []);

  const value = useMemo<RightRailContextValue>(
    () => ({ ...state, openTab, closeRail, toggleRail, setWidth }),
    [state, openTab, closeRail, toggleRail, setWidth],
  );

  return <RightRailContext.Provider value={value}>{children}</RightRailContext.Provider>;
}

export function useRightRail(): RightRailContextValue {
  const ctx = useContext(RightRailContext);
  if (!ctx) throw new Error('useRightRail must be used inside <RightRailProvider>');
  return ctx;
}

export { MIN_WIDTH, MAX_WIDTH, DEFAULT_WIDTH };
