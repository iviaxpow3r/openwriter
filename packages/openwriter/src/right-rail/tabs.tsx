/**
 * Right-rail tab registry. Order here is the order tabs render in the strip.
 * Doc-scoped tabs first (Review, Versions, Backlinks, Exports), then the
 * workspace feed (Activity), then settings (Plugins, Connections, Appearance).
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
  { id: 'versions',    label: 'Versions',    scope: 'doc',       icon: <VersionsIcon />,    Component: VersionsTab },
  { id: 'backlinks',   label: 'Backlinks',   scope: 'doc',       icon: <BacklinksIcon />,   Component: BacklinksTab },
  { id: 'exports',     label: 'Export',      scope: 'doc',       icon: <ExportsIcon />,     Component: ExportsTab },
  { id: 'activity',    label: 'Activity',    scope: 'workspace', icon: <ActivityIcon />,    Component: ActivityTab },
  { id: 'plugins',     label: 'Plugins',     scope: 'settings',  icon: <PluginsIcon />,     Component: PluginsTab },
  { id: 'connections', label: 'Connections', scope: 'settings',  icon: <ConnectionsIcon />, Component: ConnectionsTab },
  { id: 'appearance',  label: 'Appearance',  scope: 'settings',  icon: <AppearanceIcon />,  Component: AppearanceTab },
];

export function findTab(id: TabId | null): TabDefinition | null {
  if (!id) return null;
  return TAB_REGISTRY.find((t) => t.id === id) ?? null;
}
