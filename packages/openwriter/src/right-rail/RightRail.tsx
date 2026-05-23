/**
 * Right rail container. Tab strip + resize handle + active tab body.
 * Mirrors the left sidebar's chrome on the opposite edge.
 *
 * State lives in RightRailContext (open / activeTab / width, persisted to
 * localStorage). The rail is a flex peer of `.app-main`, NOT a child — so
 * the editor stays centered between left and right rails when both are open.
 *
 * adr: adr/right-rail.md
 */
import { useCallback, useEffect, useRef } from 'react';
import './RightRail.css';
import { useRightRail } from './RightRailContext';
import { TAB_REGISTRY, findTab } from './tabs';
import { CloseIcon } from './icons';
import type { RightRailTabProps } from './types';

interface RightRailProps extends RightRailTabProps {}

export default function RightRail(props: RightRailProps) {
  const { open, activeTab, width, openTab, closeRail, setWidth } = useRightRail();
  const railRef = useRef<HTMLDivElement>(null);

  // Auto-open Review when pending writes arrive. Tracks the previous count
  // via a ref so the effect only fires on the 0 → >0 transition, not on
  // every change. Re-opening behavior matches the prior floating-bar UX:
  // closing the rail does NOT dismiss pending; if more pending writes
  // arrive after a close, the rail re-opens to Review.
  // adr: adr/right-rail.md
  const prevPendingRef = useRef(0);
  useEffect(() => {
    const cur = props.pendingDocs.filenames.length;
    const prev = prevPendingRef.current;
    prevPendingRef.current = cur;
    if (prev === 0 && cur > 0) {
      openTab('review');
    }
  }, [props.pendingDocs.filenames.length, openTab]);

  // Drag-to-resize. Pointer down on the handle starts a resize; pointer up
  // ends it. Width updates fire on every pointer move while the gesture is
  // active — the .open[style*="width"] CSS rule disables the width transition
  // so the rail tracks the cursor without lag.
  const startResize = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = width;
    const onMove = (ev: PointerEvent) => {
      // Pulling LEFT (negative dx) grows the rail (its left edge moves toward the editor).
      const dx = startX - ev.clientX;
      setWidth(startWidth + dx);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, [width, setWidth]);

  // Esc closes the rail when focus is inside it.
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (!railRef.current) return;
      if (railRef.current.contains(document.activeElement)) {
        e.preventDefault();
        closeRail();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, closeRail]);

  const active = findTab(activeTab);

  return (
    <aside
      ref={railRef}
      className={`right-rail${open ? ' open' : ''}`}
      style={open ? { width, minWidth: width } : undefined}
      aria-hidden={!open}
    >
      <div className="right-rail-resize-handle" onPointerDown={startResize} aria-hidden="true" />
      <div className="right-rail-header">
        <span className="right-rail-header-label">{active?.label ?? ''}</span>
        <button
          type="button"
          className="right-rail-close"
          onClick={closeRail}
          title="Close (Esc)"
          aria-label="Close right rail"
        >
          <CloseIcon />
        </button>
      </div>
      <nav className="right-rail-tabs" role="tablist" aria-label="Right rail tabs">
        {TAB_REGISTRY.map((tab) => {
          const Icon = tab.icon;
          const selected = tab.id === activeTab;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={selected}
              className={`right-rail-tab${selected ? ' right-rail-tab--active' : ''} right-rail-tab--scope-${tab.scope}`}
              onClick={() => openTab(tab.id)}
              title={tab.label}
            >
              {Icon}
            </button>
          );
        })}
      </nav>
      <div className="right-rail-body" role="tabpanel">
        {active && <active.Component {...props} />}
      </div>
    </aside>
  );
}
