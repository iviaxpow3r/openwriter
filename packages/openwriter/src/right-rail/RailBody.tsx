/**
 * Collapsible rail body — sits to the right of the editor in the content
 * row. Renders the active tab's component. When the rail is "closed" via
 * the icon strip, this returns null and the editor reflows wider.
 *
 * Owns the drag-to-resize handle on its left (inner) edge.
 *
 * adr: adr/right-rail.md
 */
import { useCallback, useEffect, useRef } from 'react';
import { useRightRail } from './RightRailContext';
import { findTab } from './tabs';
import type { RightRailTabProps } from './types';

interface RailBodyProps extends RightRailTabProps {}

export default function RailBody(props: RailBodyProps) {
  const { open, activeTab, width, setWidth, closeRail } = useRightRail();
  const railRef = useRef<HTMLDivElement>(null);

  const startResize = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = width;
    const onMove = (ev: PointerEvent) => {
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

  if (!open) return null;

  const active = findTab(activeTab);
  if (!active) return null;

  return (
    <aside
      ref={railRef}
      className="rail-body"
      style={{ width, minWidth: width }}
      aria-label={active.label}
    >
      <div className="rail-body-resize-handle" onPointerDown={startResize} aria-hidden="true" />
      <div className="rail-body-content" role="tabpanel">
        <active.Component {...props} />
      </div>
    </aside>
  );
}
