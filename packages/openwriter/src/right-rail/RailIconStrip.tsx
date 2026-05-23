/**
 * Always-visible row of tab icons. Sits at toolbar/search-row Y position
 * on the right side, mirroring the search input on the left. Persists
 * regardless of whether the rail body is open or closed — clicking an
 * icon toggles the body underneath.
 *
 * The Activity icon owns the bell behavior that used to live in the
 * titlebar: pulse animation on live `ow-activity-event`, one-time
 * onboarding tooltip on first agent action.
 *
 * Auto-open of Review on pending-writes arrival lives here too — the
 * strip is always mounted, so the 0 → >0 transition is always observable
 * even when the rail body is closed.
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
  const { open, activeTab, width, openTab, closeRail } = useRightRail();
  const [pulsingActivity, setPulsingActivity] = useState(false);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const prevPendingRef = useRef(0);

  // Auto-open Review on the 0 → >0 transition. Closing the rail after
  // dismissing pending does NOT block re-opens — new pending re-triggers.
  useEffect(() => {
    const cur = pendingDocs.filenames.length;
    const prev = prevPendingRef.current;
    prevPendingRef.current = cur;
    if (prev === 0 && cur > 0) openTab('review');
  }, [pendingDocs.filenames.length, openTab]);

  // Activity icon pulse on live arrivals + one-time onboarding tooltip.
  useEffect(() => {
    const handler = () => {
      const lookingAtActivity = open && activeTab === 'activity';
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
  }, [open, activeTab]);

  return (
    <div
      className="rail-icon-strip"
      role="tablist"
      aria-label="Right rail tabs"
      style={{ width }}
    >
      {TAB_REGISTRY.map((tab) => {
        const selected = open && activeTab === tab.id;
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
            onClick={() => {
              if (open && activeTab === tab.id) closeRail();
              else openTab(tab.id);
            }}
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
