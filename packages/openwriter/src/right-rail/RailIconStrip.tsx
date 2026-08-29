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
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useRightRail } from './RightRailContext';
import { TAB_REGISTRY } from './tabs';
import type { PendingDocsPayload } from '../ws/client';

interface PluginRailContribution {
  id: string;
  tabId: string;
  label: string;
  scope: 'document' | 'workspace' | 'settings';
  icon?: 'pipeline' | 'workflow' | 'settings' | 'board' | 'check' | 'sparkle';
  surface?: 'rail' | 'plugins' | 'sidebar-layout';
}

function PluginRailIcon({ icon }: { icon?: PluginRailContribution['icon'] }) {
  if (icon === 'board') return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>;
  if (icon === 'pipeline' || icon === 'workflow') return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="4.5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19.5" cy="12" r="2"/><path d="M6.5 12h2.5m5 0h2.5"/><path d="m8 10.5 1.5 1.5L8 13.5m7.5-3 1.5 1.5-1.5 1.5"/></svg>;
  if (icon === 'check') return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M20 6 9 17l-5-5"/><path d="M4 4h6" opacity=".45"/><path d="M14 20h6" opacity=".45"/></svg>;
  if (icon === 'sparkle') return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="m12 3 1.7 5.3L19 10l-5.3 1.7L12 17l-1.7-5.3L5 10l5.3-1.7L12 3Z"/></svg>;
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="12" cy="12" r="8"/><path d="M12 8v8M8 12h8"/></svg>;
}

interface RailIconStripProps {
  pendingDocs: PendingDocsPayload;
}

// Last observed pending count, kept at MODULE scope so it survives this
// component unmount/remount. <RightRail> renders RailIconStrip at two
// positions — a hidden keepalive when the rail is closed and inside the
// column when open — so every visibility toggle remounts the strip. An
// instance-level ref would reset to 0 on each mount, making the 0→>0
// guard re-fire and re-open the rail on every close (the rail then can't
// be hidden, and focus mode can't keep it shut). Module scope makes the
// "already auto-opened for this batch" memory outlive the remount.
let lastPendingCount = 0;

// Keep the strip's primary, high-frequency tools stable. A document's workflow
// stage belongs beside the writing surface, while broader plugin settings stay
// in the labelled More tools menu rather than becoming invisible overflow.
const WORKFLOW_STAGE_TAB_ID = 'plugin:@openwriter/plugin-workflows:overview';
const DIRECT_TAB_IDS = new Set(['review', 'activity', 'backlinks', 'exports', WORKFLOW_STAGE_TAB_ID]);

export default function RailIconStrip({ pendingDocs }: RailIconStripProps) {
  const { visible, activeTab, openTab } = useRightRail();
  const [pulsingActivity, setPulsingActivity] = useState(false);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [pluginTabs, setPluginTabs] = useState<PluginRailContribution[]>([]);
  const [showOverflow, setShowOverflow] = useState(false);
  const overflowTriggerRef = useRef<HTMLButtonElement>(null);
  const overflowMenuRef = useRef<HTMLDivElement>(null);
  const [overflowPosition, setOverflowPosition] = useState<{ top: number; left: number; width: number } | null>(null);

  const allTabs = useMemo(() => [
    ...TAB_REGISTRY,
    ...pluginTabs.map((tab) => ({
      ...tab,
      // Plugin records carry their short contribution id (for example
      // "overview") as well as the fully-qualified right-rail tab id.
      // The latter is what RailBody uses to resolve a plugin panel.
      id: tab.tabId,
      icon: <PluginRailIcon icon={tab.icon} />,
    })),
  ], [pluginTabs]);

  const directTabs = useMemo(() => allTabs.filter((tab) => DIRECT_TAB_IDS.has(tab.id)), [allTabs]);
  const overflowTabs = useMemo(() => allTabs.filter((tab) => !DIRECT_TAB_IDS.has(tab.id)), [allTabs]);
  const overflowHasActiveTab = Boolean(activeTab && overflowTabs.some((tab) => tab.id === activeTab));

  const updateOverflowPosition = useCallback(() => {
    const trigger = overflowTriggerRef.current;
    if (!trigger) return;

    const margin = 10;
    const preferredWidth = 220;
    const rect = trigger.getBoundingClientRect();
    const width = Math.min(preferredWidth, window.innerWidth - margin * 2);
    const top = Math.max(margin, Math.min(rect.bottom + 6, window.innerHeight - margin - 40));
    const left = Math.max(margin, Math.min(rect.right - width, window.innerWidth - width - margin));
    setOverflowPosition({ top, left, width });
  }, []);

  useLayoutEffect(() => {
    if (!showOverflow) {
      setOverflowPosition(null);
      return;
    }
    const frame = window.requestAnimationFrame(updateOverflowPosition);
    window.addEventListener('resize', updateOverflowPosition);
    window.addEventListener('scroll', updateOverflowPosition, true);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener('resize', updateOverflowPosition);
      window.removeEventListener('scroll', updateOverflowPosition, true);
    };
  }, [showOverflow, updateOverflowPosition]);

  useEffect(() => {
    if (!showOverflow) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!overflowTriggerRef.current?.contains(target) && !overflowMenuRef.current?.contains(target)) {
        setShowOverflow(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setShowOverflow(false);
        overflowTriggerRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [showOverflow]);

  useEffect(() => {
    let cancelled = false;
    const load = () => fetch('/api/plugin-ui/contributions')
      .then((response) => response.ok ? response.json() : Promise.reject())
      .then((data) => { if (!cancelled) setPluginTabs((data.contributions || []).filter((tab: PluginRailContribution) => tab.surface === 'rail' || !tab.surface)); })
      .catch(() => { if (!cancelled) setPluginTabs([]); });
    load();
    window.addEventListener('ow-plugins-changed', load);
    return () => { cancelled = true; window.removeEventListener('ow-plugins-changed', load); };
  }, []);

  useEffect(() => {
    const cur = pendingDocs.filenames.length;
    const prev = lastPendingCount;
    lastPendingCount = cur;
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
      {directTabs.map((tab) => {
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
      {overflowTabs.length > 0 && (
        <>
          <button
            ref={overflowTriggerRef}
            type="button"
            className={`rail-icon-btn rail-icon-btn--more${overflowHasActiveTab ? ' rail-icon-btn--active' : ''}`}
            onClick={() => setShowOverflow((open) => !open)}
            title="More tools"
            aria-label="More tools"
            aria-haspopup="menu"
            aria-expanded={showOverflow}
            aria-controls="right-rail-more-tools"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <circle cx="5" cy="12" r="1.5" fill="currentColor" />
              <circle cx="12" cy="12" r="1.5" fill="currentColor" />
              <circle cx="19" cy="12" r="1.5" fill="currentColor" />
            </svg>
          </button>
          {showOverflow && overflowPosition && createPortal(
            <div
              id="right-rail-more-tools"
              ref={overflowMenuRef}
              className="rail-icon-overflow-menu"
              role="menu"
              aria-label="More tools"
              style={overflowPosition}
            >
              <span className="rail-icon-overflow-menu__label">More tools</span>
              {overflowTabs.map((tab) => {
                const selected = visible && activeTab === tab.id;
                return (
                  <button
                    key={tab.id}
                    type="button"
                    role="menuitem"
                    className={`rail-icon-overflow-menu__item${selected ? ' rail-icon-overflow-menu__item--active' : ''}`}
                    onClick={() => {
                      openTab(tab.id);
                      setShowOverflow(false);
                    }}
                  >
                    {tab.icon}
                    <span>{tab.label}</span>
                  </button>
                );
              })}
            </div>,
            document.body,
          )}
        </>
      )}
    </div>
  );
}
