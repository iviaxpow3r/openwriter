/**
 * Persistent row of tab icons inside the rail's column. Sits at search-row
 * height (36px) directly under the rail topbar. Click an icon to switch
 * tabs. Clicking the already-active icon navigates back to Activity (the
 * default tab) — it does NOT close the rail (use HideRail in the topbar
 * to close). This mirrors the left sidebar: clicking the active tree icon
 * returns to the file tree default rather than collapsing the sidebar.
 *
 * The Activity icon owns the bell behavior from the original titlebar
 * bell: pulse on live `ow-activity-event`, one-time onboarding tooltip
 * on first agent action.
 *
 * Auto-open of Review on pending-writes arrival lives here too — even
 * when the rail is "closed", the parent <RightRail> still mounts this
 * component (display: none) so the 0 → >0 pending transition is observed.
 *
 * adr: adr/right-rail.md
 */
import { useEffect, useRef, useState } from 'react';
import { useRightRail } from './RightRailContext';
import { TAB_REGISTRY } from './tabs';
import type { PendingDocsPayload } from '../ws/client';

interface RailIconStripProps {
  pendingDocs: PendingDocsPayload;
}

export default function RailIconStrip({ pendingDocs }: RailIconStripProps) {
  const { visible, activeTab, openTab } = useRightRail();
  const [pulsingActivity, setPulsingActivity] = useState(false);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const prevPendingRef = useRef(0);

  useEffect(() => {
    const cur = pendingDocs.filenames.length;
    const prev = prevPendingRef.current;
    prevPendingRef.current = cur;
    if (prev === 0 && cur > 0) openTab('review');
  }, [pendingDocs.filenames.length, openTab]);

  // Right-click actions (enhance, author's voice) apply pending changes directly
  // into the editor — the server's pending-docs-changed WebSocket event only arrives
  // after the auto-save debounce, and the 0→>0 guard above misses it entirely if any
  // other doc is already pending. Switch to Review immediately on the client event.
  useEffect(() => {
    const handler = () => openTab('review');
    window.addEventListener('ow-pending-write-applied', handler);
    return () => window.removeEventListener('ow-pending-write-applied', handler);
  }, [openTab]);

  useEffect(() => {
    const handler = () => {
      const lookingAtActivity = visible && activeTab === 'activity';
      if (lookingAtActivity) return;
      setPulsingActivity(true);
      window.setTimeout(() => setPulsingActivity(false), 500);

      try {
        if (!localStorage.getItem('ow-bell-hint-seen')) {
          setShowOnboarding(true);
          localStorage.setItem('ow-bell-hint-seen', '1');
          window.setTimeout(() => setShowOnboarding(false), 6000);
        }
      } catch { /* private-mode storage denied */ }
    };
    window.addEventListener('ow-activity-event', handler);
    return () => window.removeEventListener('ow-activity-event', handler);
  }, [visible, activeTab]);

  return (
    <div
      className="rail-icon-strip"
      role="tablist"
      aria-label="Right rail tabs"
    >
      {TAB_REGISTRY.map((tab) => {
        const selected = visible && activeTab === tab.id;
        const isActivity = tab.id === 'activity';
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={selected}
            className={[
              'rail-icon-btn',
              selected ? 'rail-icon-btn--active' : '',
              `rail-icon-btn--scope-${tab.scope}`,
              isActivity && pulsingActivity ? 'rail-icon-btn--pulsing' : '',
            ].filter(Boolean).join(' ')}
            onClick={() => openTab(tab.id)}
            title={tab.label}
            aria-label={tab.label}
          >
            {tab.icon}
            {isActivity && showOnboarding && (
              <div className="rail-icon-hint" role="tooltip">
                <span>Agent activity lives here.</span>
                <button
                  type="button"
                  className="rail-icon-hint-close"
                  onClick={(e) => { e.stopPropagation(); setShowOnboarding(false); }}
                  aria-label="Dismiss"
                >×</button>
              </div>
            )}
          </button>
        );
      })}
    </div>
  );
}
