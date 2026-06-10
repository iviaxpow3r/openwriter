/**
 * Right-rail UI state. Persisted (intent): open, activeTab, width. Transient
 * (responsive overlay mode): overlay, drawerOpen — see the invariants in the
 * responsive-overlay ADR before touching how open/close route between them.
 * adr: adr/right-rail.md
 * adr: adr/responsive-overlay-layout.md
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
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
  /** Responsive overlay mode (narrow window). When true the rail floats over
   *  the doc instead of pushing it, and open/close target the transient
   *  `drawerOpen` rather than the persisted `open` intent — so flipping modes
   *  never mutates what the user wants docked. Set by App's ResizeObserver. */
  overlay: boolean;
  /** Transient drawer state — only meaningful in overlay mode. Not persisted. */
  drawerOpen: boolean;
  /** Effective "is the rail showing": overlay ? drawerOpen : open. */
  visible: boolean;
  openTab: (tab: TabId) => void;
  closeRail: () => void;
  toggleRail: () => void;
  setWidth: (width: number) => void;
  setOverlay: (v: boolean) => void;
}

const RightRailContext = createContext<RightRailContextValue | null>(null);

function loadPersisted(): PersistedState {
  // First-run default: rail OPEN with Activity active. The whole reason
  // the rail exists is so agent activity is visible; showing it on first
  // load is the discoverability win. User can collapse it (state persists).
  const FIRST_RUN: PersistedState = { open: true, activeTab: 'activity', width: DEFAULT_WIDTH };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return FIRST_RUN;
    const parsed = JSON.parse(raw) as Partial<PersistedState>;
    return {
      open: Boolean(parsed.open),
      activeTab: (parsed.activeTab as TabId | null) ?? null,
      width: clampWidth(typeof parsed.width === 'number' ? parsed.width : DEFAULT_WIDTH),
    };
  } catch {
    return FIRST_RUN;
  }
}

function clampWidth(w: number): number {
  if (!Number.isFinite(w)) return DEFAULT_WIDTH;
  return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, w));
}

export function RightRailProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<PersistedState>(() => loadPersisted());
  // Transient (never persisted): the responsive mode + the overlay drawer.
  const [overlay, setOverlayState] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  // Mirror overlay into a ref so the stable open/close callbacks can read the
  // current mode without being re-created (and without going stale).
  const overlayRef = useRef(overlay);
  overlayRef.current = overlay;

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      /* localStorage full or denied — non-fatal */
    }
  }, [state]);

  // In overlay mode every open/close targets the transient drawer; the
  // persisted `open` intent is left untouched so widening the window restores
  // exactly what was docked before.
  const openTab = useCallback((tab: TabId) => {
    if (overlayRef.current) {
      setDrawerOpen(true);
      setState((s) => ({ ...s, activeTab: tab }));
    } else {
      setState((s) => ({ ...s, open: true, activeTab: tab }));
    }
  }, []);

  const closeRail = useCallback(() => {
    if (overlayRef.current) setDrawerOpen(false);
    else setState((s) => ({ ...s, open: false }));
  }, []);

  const toggleRail = useCallback(() => {
    if (overlayRef.current) setDrawerOpen((d) => !d);
    else setState((s) => ({ ...s, open: !s.open }));
  }, []);

  const setWidth = useCallback((width: number) => {
    setState((s) => ({ ...s, width: clampWidth(width) }));
  }, []);

  const setOverlay = useCallback((v: boolean) => {
    setOverlayState((prev) => {
      if (prev === v) return prev;
      // Any mode flip resets the drawer: entering overlay starts closed (don't
      // cover the doc on resize); exiting drops the transient state entirely.
      setDrawerOpen(false);
      return v;
    });
  }, []);

  const visible = overlay ? drawerOpen : state.open;

  const value = useMemo<RightRailContextValue>(
    () => ({ ...state, overlay, drawerOpen, visible, openTab, closeRail, toggleRail, setWidth, setOverlay }),
    [state, overlay, drawerOpen, visible, openTab, closeRail, toggleRail, setWidth, setOverlay],
  );

  return <RightRailContext.Provider value={value}>{children}</RightRailContext.Provider>;
}

export function useRightRail(): RightRailContextValue {
  const ctx = useContext(RightRailContext);
  if (!ctx) throw new Error('useRightRail must be used inside <RightRailProvider>');
  return ctx;
}

export { MIN_WIDTH, MAX_WIDTH, DEFAULT_WIDTH };
