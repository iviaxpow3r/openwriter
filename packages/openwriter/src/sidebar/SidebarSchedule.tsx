import { useState, useEffect, useCallback } from 'react';
import SlotSettings from './SlotSettings';
import AutoplugSettings from './AutoplugSettings';
import './SidebarSchedule.css';

interface QueueItem {
  id: string;
  content_type: string;
  content: { text?: string };
  scheduled_at: string;
  status: string;
  connection_name?: string;
  provider?: string;
}

interface Slot {
  id: string;
  time: string;
  days: string[];
  filter_type: string;
  filter_value: string | null;
  timezone: string;
}

// A row in the timeline — either a filled queue item or an empty slot marker
interface TimelineEntry {
  type: 'filled' | 'empty';
  time: Date;
  item?: QueueItem;
  slot?: Slot;
}

const DAY_MAP: Record<string, number> = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
};

export default function SidebarSchedule({ onBack }: { onBack: () => void }) {
  const [items, setItems] = useState<QueueItem[]>([]);
  const [slots, setSlots] = useState<Slot[]>([]);
  const [showSettings, setShowSettings] = useState(false);
  const [showAutoplugs, setShowAutoplugs] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    try {
      const [queueRes, slotsRes] = await Promise.all([
        fetch('/api/scheduler/queue'),
        fetch('/api/scheduler/slots'),
        // Sync post history from platform → local doc frontmatter
        fetch('/api/scheduler/sync', { method: 'POST' }),
      ]);
      if (queueRes.ok) {
        const data = await queueRes.json();
        setItems(data.items || []);
      }
      if (slotsRes.ok) {
        const data = await slotsRes.json();
        setSlots(data.slots || []);
      }
    } catch { /* ignore */ }
    setLoading(false);
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  const handleCancel = async (id: string) => {
    const res = await fetch(`/api/scheduler/queue/${id}`, { method: 'DELETE' });
    if (res.ok) {
      setItems(prev => prev.filter(i => i.id !== id));
      setExpandedId(null);
    }
  };

  if (showAutoplugs) {
    return <AutoplugSettings onBack={() => { setShowAutoplugs(false); fetchData(); }} />;
  }

  if (showSettings) {
    return <SlotSettings slots={slots} onBack={() => { setShowSettings(false); fetchData(); }} />;
  }

  // Build 7-day timeline with slot markers
  const timeline = buildTimeline(slots, items);

  return (
    <div className="sidebar-schedule">
      <div className="sidebar-schedule-header">
        <button className="sidebar-schedule-back" onClick={onBack} title="Back to documents">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="m15 18-6-6 6-6" />
          </svg>
        </button>
        <h3>Schedule</h3>
        <div className="sidebar-schedule-actions">
          <button
            className="sidebar-schedule-btn"
            onClick={() => setShowAutoplugs(true)}
            title="Autoplugs"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
            </svg>
          </button>
          <button
            className="sidebar-schedule-btn"
            onClick={() => setShowSettings(true)}
            title="Manage slots"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
          </button>
        </div>
      </div>

      {loading ? null : slots.length === 0 ? (
        <div className="schedule-empty">
          <div className="schedule-empty-title">No time slots</div>
          <div className="schedule-empty-desc">
            Create time slots to define your posting schedule.
          </div>
        </div>
      ) : (
        timeline.map(({ label, entries }) => (
          <div key={label} className="schedule-day">
            <div className="schedule-day-header">{label}</div>
            {entries.map((entry, i) => entry.type === 'empty' ? (
              <div key={`empty-${i}`} className="schedule-slot-empty">
                <div className="schedule-item-time">
                  {formatTimeFromDate(entry.time)}
                </div>
                <div className="schedule-slot-empty-label">
                  {entry.slot?.filter_type === 'any'
                    ? 'Open slot'
                    : `${entry.slot?.filter_type}: ${entry.slot?.filter_value || 'any'}`}
                </div>
              </div>
            ) : (
              <div key={entry.item!.id}>
                <div
                  className="schedule-item"
                  onClick={() => setExpandedId(expandedId === entry.item!.id ? null : entry.item!.id)}
                >
                  <div className="schedule-item-time">
                    {formatTimeFromDate(entry.time)}
                  </div>
                  <div className="schedule-item-content">
                    <div className="schedule-item-text">
                      {entry.item!.content?.text || JSON.stringify(entry.item!.content)}
                    </div>
                    <div className="schedule-item-meta">
                      <span className={`schedule-item-status schedule-item-status--${entry.item!.status}`} />
                      <span>{entry.item!.status}</span>
                      {entry.item!.connection_name && <span>{entry.item!.connection_name}</span>}
                      {entry.item!.provider && <span>{entry.item!.provider}</span>}
                    </div>
                  </div>
                </div>
                {expandedId === entry.item!.id && (
                  <div className="schedule-item-expanded">
                    <div className="schedule-item-full-text">
                      {entry.item!.content?.text || JSON.stringify(entry.item!.content, null, 2)}
                    </div>
                    <div className="schedule-item-actions">
                      <button
                        className="schedule-item-action schedule-item-action--danger"
                        onClick={() => handleCancel(entry.item!.id)}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        ))
      )}
    </div>
  );
}

/** Build a 7-day timeline merging slot occurrences with queue items */
function buildTimeline(
  slots: Slot[],
  items: QueueItem[],
): { label: string; entries: TimelineEntry[] }[] {
  const now = new Date();
  const days: { label: string; date: Date }[] = [];

  for (let i = 0; i < 7; i++) {
    const d = new Date(now);
    d.setDate(d.getDate() + i);
    d.setHours(0, 0, 0, 0);
    let label: string;
    if (i === 0) label = 'Today';
    else if (i === 1) label = 'Tomorrow';
    else label = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    days.push({ label, date: d });
  }

  // Index queue items by date+time for matching
  const itemsByTime = new Map<string, QueueItem>();
  for (const item of items) {
    const d = new Date(item.scheduled_at);
    const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}-${d.getHours()}-${d.getMinutes()}`;
    itemsByTime.set(key, item);
  }

  // Track which queue items got matched to a slot
  const matchedItemIds = new Set<string>();

  const result: { label: string; entries: TimelineEntry[] }[] = [];

  for (const { label, date } of days) {
    const entries: TimelineEntry[] = [];
    const dayOfWeek = date.getDay(); // 0=Sun
    const dayNames = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
    const dayName = dayNames[dayOfWeek];

    for (const slot of slots) {
      // Check if this slot fires on this day
      const fires = slot.days.includes('default') || slot.days.includes(dayName);
      if (!fires) continue;

      const [h, m] = slot.time.split(':').map(Number);
      const slotTime = new Date(date);
      slotTime.setHours(h, m, 0, 0);

      // Skip past slot times for today
      if (isSameDay(date, now) && slotTime < now) continue;

      // Check if a queue item occupies this slot
      const key = `${slotTime.getFullYear()}-${slotTime.getMonth()}-${slotTime.getDate()}-${h}-${m}`;
      const matched = itemsByTime.get(key);

      if (matched) {
        entries.push({ type: 'filled', time: slotTime, item: matched, slot });
        matchedItemIds.add(matched.id);
      } else {
        entries.push({ type: 'empty', time: slotTime, slot });
      }
    }

    // Add any unmatched queue items for this day (custom-scheduled, etc.)
    for (const item of items) {
      if (matchedItemIds.has(item.id)) continue;
      const d = new Date(item.scheduled_at);
      if (!isSameDay(d, date)) continue;
      entries.push({ type: 'filled', time: d, item });
      matchedItemIds.add(item.id);
    }

    // Sort by time
    entries.sort((a, b) => a.time.getTime() - b.time.getTime());

    // Only include days that have entries
    if (entries.length > 0) {
      result.push({ label, entries });
    }
  }

  return result;
}

function isSameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function formatTimeFromDate(d: Date): string {
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
}
