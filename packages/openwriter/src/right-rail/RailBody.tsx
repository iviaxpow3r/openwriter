/**
 * Rail body — bottom slot of the right rail column, occupying everything
 * below the icon strip. Renders the active tab's component. Width and
 * resize handle are owned by the parent <RightRail>; the body is just a
 * fill element.
 *
 * adr: adr/right-rail.md
 */
import { useRightRail } from './RightRailContext';
import { findTab } from './tabs';
import type { RightRailTabProps } from './types';

interface RailBodyProps extends RightRailTabProps {}

export default function RailBody(props: RailBodyProps) {
  const { activeTab } = useRightRail();
  const active = findTab(activeTab);

  return (
    <div className="rail-body" role="tabpanel">
      {active ? <active.Component {...props} /> : null}
    </div>
  );
}
