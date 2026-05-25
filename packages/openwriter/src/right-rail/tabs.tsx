/**
 * Right-rail tab registry. Order here is the order tabs render in the strip.
 *
 * Order is user-priority, not scope: Review → Activity → Backlinks → Exports
 * are the day-to-day primary actions; Versions → Plugins → Connections →
 * Appearance are settings / history. A single visual divider sits between
 * Exports and Versions to mark that transition.
 *
 * Review leads the strip because pending agent writes are the most time-
 * sensitive surface. Activity sits second as the workspace-wide log; it
 * remains the first-run default tab (rail opens to Activity) — strip order
 * and default tab are independent decisions.
 *
 * Adding a tab: add an entry here, that's it. The container reads this
 * registry — no wiring elsewhere.
 *
 * adr: adr/right-rail.md
 */
import type { TabDefinition, TabId } from './types';
import {
  ReviewIcon,
  VersionsIcon,
  BacklinksIcon,
  ExportsIcon,
  ActivityIcon,
  PluginsIcon,
  ConnectionsIcon,
  AppearanceIcon,
} from './icons';
import ReviewTab from './tabs/ReviewTab';
import VersionsTab from './tabs/VersionsTab';
import BacklinksTab from './tabs/BacklinksTab';
import ExportsTab from './tabs/ExportsTab';
import ActivityTab from './tabs/ActivityTab';
import PluginsTab from './tabs/PluginsTab';
import ConnectionsTab from './tabs/ConnectionsTab';
import AppearanceTab from './tabs/AppearanceTab';

export const TAB_REGISTRY: TabDefinition[] = [
  { id: 'review',      label: 'Review',      scope: 'doc',       icon: <ReviewIcon />,      Component: ReviewTab },
  { id: 'activity',    label: 'Activity',    scope: 'workspace', icon: <ActivityIcon />,    Component: ActivityTab },
  { id: 'backlinks',   label: 'Backlinks',   scope: 'doc',       icon: <BacklinksIcon />,   Component: BacklinksTab },
  { id: 'exports',     label: 'Export',      scope: 'doc',       icon: <ExportsIcon />,     Component: ExportsTab },
  { id: 'versions',    label: 'Versions',    scope: 'doc',       icon: <VersionsIcon />,    Component: VersionsTab },
  { id: 'plugins',     label: 'Plugins',     scope: 'settings',  icon: <PluginsIcon />,     Component: PluginsTab },
  { id: 'connections', label: 'Connections', scope: 'settings',  icon: <ConnectionsIcon />, Component: ConnectionsTab },
  { id: 'appearance',  label: 'Appearance',  scope: 'settings',  icon: <AppearanceIcon />,  Component: AppearanceTab },
];

export function findTab(id: TabId | null): TabDefinition | null {
  if (!id) return null;
  return TAB_REGISTRY.find((t) => t.id === id) ?? null;
}
