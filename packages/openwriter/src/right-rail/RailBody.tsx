/**
 * Rail body — bottom slot of the right rail column, occupying everything
 * below the icon strip. Renders the active tab's component. Width and
 * resize handle are owned by the parent <RightRail>; the body is just a
 * fill element.
 *
 * adr: adr/right-rail.md
 */
import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { useRightRail } from './RightRailContext';
import { findTab } from './tabs';
import type { RightRailTabProps } from './types';
import PluginUiTab from './PluginUiTab';

interface RailBodyProps extends RightRailTabProps {}

export default function RailBody(props: RailBodyProps) {
  const { activeTab } = useRightRail();
  const active = findTab(activeTab);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [hasMoreContent, setHasMoreContent] = useState(false);
  const isPluginSettings = activeTab === 'plugins' || activeTab?.startsWith('plugin:');

  const updateScrollCue = useCallback(() => {
    const body = bodyRef.current;
    if (!body || !isPluginSettings) {
      setHasMoreContent(false);
      return;
    }
    setHasMoreContent(body.scrollTop + body.clientHeight < body.scrollHeight - 2);
  }, [isPluginSettings]);

  // The rail has one scroll owner. Plugin panels can grow as plugins add
  // controls, and this cue makes that continuing content apparent before a
  // writer has to guess that the narrow panel will scroll.
  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (!body) return;

    const frame = window.requestAnimationFrame(updateScrollCue);
    const observer = new MutationObserver(() => window.requestAnimationFrame(updateScrollCue));
    observer.observe(body, { childList: true, subtree: true });
    window.addEventListener('resize', updateScrollCue);
    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener('resize', updateScrollCue);
    };
  }, [activeTab, updateScrollCue]);

  return (
    <div className="rail-body" ref={bodyRef} role="tabpanel" onScroll={updateScrollCue}>
      {active ? <active.Component {...props} /> : activeTab?.startsWith('plugin:') ? <PluginUiTab {...props} /> : null}
      {hasMoreContent && (
        <div className="rail-body-scroll-cue" aria-hidden="true">
          <span>More plugin settings below</span>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </div>
      )}
    </div>
  );
}
