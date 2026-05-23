/**
 * Tab strip icons. 16x16, currentColor stroke, 1.75 stroke width to match
 * the titlebar icon weight. Pulled out of the registry so the same icon
 * can be re-used in titlebar trigger buttons during the migration window.
 * adr: adr/right-rail.md
 */
const s = { strokeWidth: 1.75, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };

export const ReviewIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
    <path d="M9 12l2 2 4-4" stroke="currentColor" {...s} />
    <path d="M21 12c0 4.97-4.03 9-9 9s-9-4.03-9-9 4.03-9 9-9c2.3 0 4.4.86 6 2.27" stroke="currentColor" {...s} />
  </svg>
);

export const VersionsIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
    <circle cx="12" cy="12" r="9" stroke="currentColor" {...s} />
    <path d="M12 7v5l3 3" stroke="currentColor" {...s} />
  </svg>
);

export const BacklinksIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
    <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" stroke="currentColor" {...s} />
    <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" stroke="currentColor" {...s} />
  </svg>
);

export const ExportsIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" stroke="currentColor" {...s} />
    <polyline points="7 10 12 15 17 10" stroke="currentColor" {...s} />
    <line x1="12" y1="15" x2="12" y2="3" stroke="currentColor" {...s} />
  </svg>
);

/** Sparkline / activity wave — distinct from the bell, which is the titlebar trigger. */
export const ActivityIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
    <path d="M3 12h3l3-8 4 16 3-8h5" stroke="currentColor" {...s} />
  </svg>
);

export const PluginsIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
    <path d="M12 22v-6" stroke="currentColor" {...s} />
    <path d="M9 7V2" stroke="currentColor" {...s} />
    <path d="M15 7V2" stroke="currentColor" {...s} />
    <path d="M16 7H8v5a4 4 0 0 0 8 0V7z" stroke="currentColor" {...s} />
  </svg>
);

export const ConnectionsIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
    <circle cx="12" cy="5" r="3" stroke="currentColor" {...s} />
    <circle cx="5" cy="19" r="3" stroke="currentColor" {...s} />
    <circle cx="19" cy="19" r="3" stroke="currentColor" {...s} />
    <line x1="12" y1="8" x2="5" y2="16" stroke="currentColor" {...s} />
    <line x1="12" y1="8" x2="19" y2="16" stroke="currentColor" {...s} />
  </svg>
);

export const AppearanceIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
    <path d="M12 22a1 1 0 0 1 0-20 10 9 0 0 1 10 9 5 5 0 0 1-5 5h-2.25a1.75 1.75 0 0 0-1.4 2.8l.3.4a1.75 1.75 0 0 1-1.4 2.8z" stroke="currentColor" {...s} />
    <circle cx="13.5" cy="6.5" r="1" fill="currentColor" stroke="none" />
    <circle cx="17.5" cy="10.5" r="1" fill="currentColor" stroke="none" />
    <circle cx="6.5" cy="12.5" r="1" fill="currentColor" stroke="none" />
    <circle cx="8.5" cy="7.5" r="1" fill="currentColor" stroke="none" />
  </svg>
);

/** Titlebar bell — opens the rail to Activity. Pulses on live arrivals. */
export const BellIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
    <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" stroke="currentColor" {...s} />
    <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" stroke="currentColor" {...s} />
  </svg>
);

/** Close (×) for the rail header. */
export const CloseIcon = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
    <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/** Focus mode — four corner brackets pointing outward. Universal
 *  "maximize / fullscreen / focus mode" pictogram. Lives next to the
 *  format-toolbar toggle so the user can collapse all chrome (left
 *  sidebar + right rail + format bar) with a single click. */
export const FocusModeIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
    <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/** "Hide right rail" — mirror of the left sidebar's collapse icon.
 *  Rectangle with vertical line on the right edge + chevron pointing
 *  right (rail will collapse to the right). Lives in the rail topbar. */
export const HideRailIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
    <rect x="3" y="3" width="18" height="18" rx="2" stroke="currentColor" strokeWidth="2" />
    <path d="M15 3v18" stroke="currentColor" strokeWidth="2" />
    <path d="M9 10l2 2-2 2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/** "Open right rail" — mirror of the left sidebar's open icon.
 *  Rectangle with vertical line on the right edge + chevron pointing
 *  left (rail will expand to the left). Lives in the titlebar when the
 *  rail is closed. */
export const OpenRailIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
    <rect x="3" y="3" width="18" height="18" rx="2" stroke="currentColor" strokeWidth="2" />
    <path d="M15 3v18" stroke="currentColor" strokeWidth="2" />
    <path d="M10 10l-2 2 2 2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
