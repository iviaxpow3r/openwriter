import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { SIDEBAR_MODES, getSidebarMode, setSidebarMode } from '../themes/appearance-store';
import type { SidebarMode } from '../themes/appearance-store';

type PluginSidebarLayout = {
  tabId: `plugin:${string}:${string}`;
  label: string;
  icon?: string;
  surface?: 'rail' | 'plugins' | 'sidebar-layout';
};

export function SidebarViewIcon({ icon, size = 14 }: { icon?: string; size?: number }) {
  const common = { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
  if (icon === 'tree') return <svg {...common}><path d="M3 3h7v7H3zM14 3h7v4h-7zM14 10h7v4h-7zM3 13h7v8H3z"/></svg>;
  if (icon === 'timeline') return <svg {...common}><line x1="12" y1="2" x2="12" y2="22"/><circle cx="12" cy="6" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="18" r="2"/><line x1="14" y1="6" x2="20" y2="6"/><line x1="14" y1="12" x2="20" y2="12"/><line x1="14" y1="18" x2="20" y2="18"/></svg>;
  if (icon === 'board') return <svg {...common}><rect x="3" y="3" width="5" height="18" rx="1"/><rect x="10" y="3" width="5" height="12" rx="1"/><rect x="17" y="3" width="5" height="15" rx="1"/></svg>;
  if (icon === 'pipeline' || icon === 'workflow') return <svg {...common}><circle cx="4.5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19.5" cy="12" r="2"/><path d="M6.5 12h2.5m5 0h2.5"/><path d="m8 10.5 1.5 1.5L8 13.5m7.5-3 1.5 1.5-1.5 1.5"/></svg>;
  if (icon === 'shelf') return <svg {...common}><path d="M4 19V5"/><path d="M8 19V7"/><path d="M12 19V4"/><path d="M16 19V8"/><path d="M20 19V6"/><line x1="2" y1="20" x2="22" y2="20"/></svg>;
  return <svg {...common}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>;
}

/**
 * A local navigation control, kept beside search because it changes how the
 * left rail organizes writing. The panel is portaled so the sidebar's own
 * clipping boundary never truncates its choices.
 */
export default function SidebarViewSwitcher() {
  const [mode, setMode] = useState<SidebarMode>(getSidebarMode);
  const [pluginLayouts, setPluginLayouts] = useState<PluginSidebarLayout[]>([]);
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ top: number; left: number; width: number } | null>(null);

  const layouts = useMemo(() => [
    ...SIDEBAR_MODES,
    ...pluginLayouts.map((layout) => ({ id: layout.tabId as SidebarMode, label: layout.label, icon: layout.icon || 'files' })),
  ], [pluginLayouts]);
  const activeLayout = layouts.find((layout) => layout.id === mode) || layouts[0];

  const updatePosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const margin = 10;
    const width = Math.min(220, window.innerWidth - margin * 2);
    const rect = trigger.getBoundingClientRect();
    const top = Math.max(margin, Math.min(rect.bottom + 6, window.innerHeight - margin - 40));
    const left = Math.max(margin, Math.min(rect.right - width, window.innerWidth - width - margin));
    setPosition({ top, left, width });
  }, []);

  useEffect(() => {
    let cancelled = false;
    const load = () => fetch('/api/plugin-ui/contributions')
      .then((response) => response.ok ? response.json() : Promise.reject())
      .then((data) => {
        if (!cancelled) setPluginLayouts((data.contributions || []).filter((view: PluginSidebarLayout) => view.surface === 'sidebar-layout'));
      })
      .catch(() => { if (!cancelled) setPluginLayouts([]); });
    load();
    window.addEventListener('ow-plugins-changed', load);
    return () => { cancelled = true; window.removeEventListener('ow-plugins-changed', load); };
  }, []);

  useEffect(() => {
    const syncMode = () => setMode(getSidebarMode());
    window.addEventListener('ow-sidebar-mode-change', syncMode);
    return () => window.removeEventListener('ow-sidebar-mode-change', syncMode);
  }, []);

  useLayoutEffect(() => {
    if (!open) {
      setPosition(null);
      return;
    }
    const frame = window.requestAnimationFrame(updatePosition);
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [open, updatePosition]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!triggerRef.current?.contains(target) && !menuRef.current?.contains(target)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const selectLayout = (id: SidebarMode) => {
    setMode(id);
    setSidebarMode(id);
    setOpen(false);
  };

  return (
    <div className="sidebar-view-switcher">
      <button
        ref={triggerRef}
        type="button"
        className={`sidebar-view-switcher__trigger${open ? ' sidebar-view-switcher__trigger--open' : ''}`}
        onClick={() => setOpen((visible) => !visible)}
        title={`Document view: ${activeLayout.label}`}
        aria-label={`Change document view, currently ${activeLayout.label}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls="sidebar-document-view-menu"
      >
        <SidebarViewIcon icon={activeLayout.icon} />
        <svg className="sidebar-view-switcher__chevron" width="10" height="10" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="m4 6 4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && position && createPortal(
        <div
          id="sidebar-document-view-menu"
          ref={menuRef}
          className="sidebar-view-switcher__menu"
          role="menu"
          aria-label="Document view"
          style={position}
        >
          <span className="sidebar-view-switcher__menu-label">Document view</span>
          {layouts.map((layout) => {
            const selected = layout.id === mode;
            return (
              <button
                key={layout.id}
                type="button"
                role="menuitemradio"
                aria-checked={selected}
                className={`sidebar-view-switcher__option${selected ? ' sidebar-view-switcher__option--selected' : ''}`}
                onClick={() => selectLayout(layout.id)}
              >
                <SidebarViewIcon icon={layout.icon} />
                <span>{layout.label}</span>
                {selected && <span className="sidebar-view-switcher__check" aria-hidden="true">✓</span>}
              </button>
            );
          })}
        </div>,
        document.body,
      )}
    </div>
  );
}
