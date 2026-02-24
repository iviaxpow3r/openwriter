import { useEffect, useRef, useState } from 'react';
import {
  COLORS, TYPEFACES, SIDEBAR_MODES, SIDEBAR_STYLES, SPACING_PRESETS, CANVAS_STYLES,
  getColor, getTypeface, getMode, getSidebarMode, getSidebarStyle, getSpacing, getCanvasStyle, applyAppearance,
} from './appearance-store';
import type { ColorPalette, Typeface, ThemeMode, SidebarMode, SidebarStyle, SpacingPreset, CanvasStyle } from './appearance-store';
import './AppearancePanel.css';

// SVG icons for sidebar modes
const ModeIcons: Record<string, JSX.Element> = {
  tree: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 3h7v7H3zM14 3h7v4h-7zM14 10h7v4h-7zM3 13h7v8H3z"/></svg>,
  timeline: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="2" x2="12" y2="22"/><circle cx="12" cy="6" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="18" r="2"/><line x1="14" y1="6" x2="20" y2="6"/><line x1="14" y1="12" x2="20" y2="12"/><line x1="14" y1="18" x2="20" y2="18"/></svg>,
  board: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="5" height="18" rx="1"/><rect x="10" y="3" width="5" height="12" rx="1"/><rect x="17" y="3" width="5" height="15" rx="1"/></svg>,
  shelf: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 19V5"/><path d="M8 19V7"/><path d="M12 19V4"/><path d="M16 19V8"/><path d="M20 19V6"/><line x1="2" y1="20" x2="22" y2="20"/></svg>,
};

export default function AppearancePanel() {
  const [open, setOpen] = useState(false);
  const [color, setColor] = useState<ColorPalette>(getColor);
  const [typeface, setTypeface] = useState<Typeface>(getTypeface);
  const [mode, setMode] = useState<ThemeMode>(getMode);
  const [sidebarMode, setSidebarMode] = useState<SidebarMode>(getSidebarMode);
  const [sidebarStyle, setSidebarStyle] = useState<SidebarStyle>(getSidebarStyle);
  const [spacing, setSpacing] = useState<SpacingPreset>(getSpacing);
  const [canvasStyle, setCanvasStyle] = useState<CanvasStyle>(getCanvasStyle);
  const ref = useRef<HTMLDivElement>(null);

  const apply = (
    c: ColorPalette = color,
    tf: Typeface = typeface,
    m: ThemeMode = mode,
    sm: SidebarMode = sidebarMode,
    ss: SidebarStyle = sidebarStyle,
    sp: SpacingPreset = spacing,
    cs: CanvasStyle = canvasStyle,
  ) => {
    applyAppearance(c, tf, m, sm, ss, sp, cs);
  };

  const handleColor = (id: ColorPalette) => { setColor(id); apply(id); };
  const handleTypeface = (id: Typeface) => { setTypeface(id); apply(undefined, id); };
  const handleMode = () => {
    const next = mode === 'light' ? 'dark' : 'light';
    setMode(next);
    apply(undefined, undefined, next);
  };
  const handleSidebarMode = (id: SidebarMode) => {
    setSidebarMode(id);
    apply(undefined, undefined, undefined, id);
    window.dispatchEvent(new CustomEvent('ow-sidebar-mode-change', { detail: id }));
  };
  const handleSidebarStyle = (id: SidebarStyle) => { setSidebarStyle(id); apply(undefined, undefined, undefined, undefined, id); };
  const handleSpacing = (id: SpacingPreset) => { setSpacing(id); apply(undefined, undefined, undefined, undefined, undefined, id); };
  const handleCanvasStyle = (id: CanvasStyle) => { setCanvasStyle(id); apply(undefined, undefined, undefined, undefined, undefined, undefined, id); };

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  return (
    <div className="appearance-wrapper" ref={ref}>
      <button
        className={`titlebar-nav-btn${open ? ' titlebar-nav-btn--active' : ''}`}
        onClick={() => setOpen(!open)}
        title="Appearance"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 22a1 1 0 0 1 0-20 10 9 0 0 1 10 9 5 5 0 0 1-5 5h-2.25a1.75 1.75 0 0 0-1.4 2.8l.3.4a1.75 1.75 0 0 1-1.4 2.8z" />
          <circle cx="13.5" cy="6.5" r="1" fill="currentColor" stroke="none" />
          <circle cx="17.5" cy="10.5" r="1" fill="currentColor" stroke="none" />
          <circle cx="6.5" cy="12.5" r="1" fill="currentColor" stroke="none" />
          <circle cx="8.5" cy="7.5" r="1" fill="currentColor" stroke="none" />
        </svg>
      </button>
      {open && (
        <div className="appearance-dropdown">
          {/* Colors section */}
          <div className="appearance-section">
            <div className="appearance-section-header">
              <span className="appearance-section-title">Colors</span>
              <button className="appearance-mode-btn" onClick={handleMode} title={mode === 'light' ? 'Switch to dark' : 'Switch to light'}>
                {mode === 'light' ? (
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>
                ) : (
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
                )}
                <span>{mode === 'light' ? 'Light' : 'Dark'}</span>
              </button>
            </div>
            <div className="appearance-theme-grid">
              {COLORS.map((c) => (
                <button
                  key={c.id}
                  className={`appearance-swatch ${color === c.id ? 'active' : ''}`}
                  onClick={() => handleColor(c.id)}
                  title={c.label}
                >
                  <span className="appearance-swatch-color" style={{ background: c.swatch[mode] }} />
                  <span className="appearance-swatch-label">{c.label}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Typography (typeface) section */}
          <div className="appearance-section">
            <div className="appearance-section-header">
              <span className="appearance-section-title">Typography</span>
            </div>
            <div className="appearance-typeface-grid">
              {TYPEFACES.map((t) => (
                <button
                  key={t.id}
                  className={`appearance-style-option ${typeface === t.id ? 'active' : ''}`}
                  onClick={() => handleTypeface(t.id)}
                  title={t.description}
                >
                  {t.label}
                </button>
              ))}
            </div>
          </div>

          {/* Spacing preset section */}
          <div className="appearance-section">
            <div className="appearance-section-header">
              <span className="appearance-section-title">Spacing</span>
            </div>
            <div className="appearance-typography-grid">
              {SPACING_PRESETS.map((s) => (
                <button
                  key={s.id}
                  className={`appearance-style-option ${spacing === s.id ? 'active' : ''}`}
                  onClick={() => handleSpacing(s.id)}
                >
                  {s.label}
                </button>
              ))}
            </div>
          </div>

          {/* Canvas style section */}
          <div className="appearance-section">
            <div className="appearance-section-header">
              <span className="appearance-section-title">Canvas</span>
            </div>
            <div className="appearance-style-grid">
              {CANVAS_STYLES.map((c) => (
                <button
                  key={c.id}
                  className={`appearance-style-option ${canvasStyle === c.id ? 'active' : ''}`}
                  onClick={() => handleCanvasStyle(c.id)}
                >
                  {c.label}
                </button>
              ))}
            </div>
          </div>

          {/* Sidebar Layout section */}
          <div className="appearance-section">
            <div className="appearance-section-header">
              <span className="appearance-section-title">Layout</span>
            </div>
            <div className="appearance-mode-grid">
              {SIDEBAR_MODES.map((m) => (
                <button
                  key={m.id}
                  className={`appearance-mode-option ${sidebarMode === m.id ? 'active' : ''}`}
                  onClick={() => handleSidebarMode(m.id)}
                >
                  {ModeIcons[m.icon]}
                  <span>{m.label}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Sidebar Style section */}
          <div className="appearance-section">
            <div className="appearance-section-header">
              <span className="appearance-section-title">Sidebar</span>
            </div>
            <div className="appearance-style-grid">
              {SIDEBAR_STYLES.map((s) => (
                <button
                  key={s.id}
                  className={`appearance-style-option ${sidebarStyle === s.id ? 'active' : ''}`}
                  onClick={() => handleSidebarStyle(s.id)}
                >
                  {s.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
