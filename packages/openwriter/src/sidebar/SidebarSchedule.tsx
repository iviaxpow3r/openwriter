import { useState, useEffect, useCallback } from 'react';
import SlotSettings from './SlotSettings';
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

export default function SidebarSchedule() {
  const [items, setItems] = useState<QueueItem[]>([]);
  const [slots, setSlots] = useState<Slot[]>([]);
  const [showSettings, setShowSettings] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    try {
      const [queueRes, slotsRes] = await Promise.all([
        fetch('/api/scheduler/queue'),
        fetch('/api/scheduler/slots'),
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

  if (showSettings) {
    return <SlotSettings slots={slots} onBack={() => { setShowSettings(false); fetchData(); }} />;
  }

  // Group items by day
  const grouped = groupByDay(items);

  return (
    <div className="sidebar-schedule">
      <div className="sidebar-schedule-header">
        <h3>Schedule</h3>
        <div className="sidebar-schedule-actions">
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

      {loading ? null : items.length === 0 ? (
        <div className="schedule-empty">
          <div className="schedule-empty-title">No scheduled posts</div>
          <div className="schedule-empty-desc">
            {slots.length === 0
              ? 'Create time slots first, then queue content.'
              : 'Queue content using the schedule_post tool.'}
          </div>
        </div>
      ) : (
        grouped.map(({ label, dayItems }) => (
          <div key={label} className="schedule-day">
            <div className="schedule-day-header">{label}</div>
            {dayItems.map(item => (
              <div key={item.id}>
                <div
                  className="schedule-item"
                  onClick={() => setExpandedId(expandedId === item.id ? null : item.id)}
                >
                  <div className="schedule-item-time">
                    {formatTime(item.scheduled_at)}
                  </div>
                  <div className="schedule-item-content">
                    <div className="schedule-item-text">
                      {item.content?.text || JSON.stringify(item.content)}
                    </div>
                    <div className="schedule-item-meta">
                      <span className={`schedule-item-status schedule-item-status--${item.status}`} />
                      <span>{item.status}</span>
                      {item.connection_name && <span>{item.connection_name}</span>}
                      {item.provider && <span>{item.provider}</span>}
                    </div>
                  </div>
                </div>
                {expandedId === item.id && (
                  <div className="schedule-item-expanded">
                    <div className="schedule-item-full-text">
                      {item.content?.text || JSON.stringify(item.content, null, 2)}
                    </div>
                    <div className="schedule-item-actions">
                      <button
                        className="schedule-item-action schedule-item-action--danger"
                        onClick={() => handleCancel(item.id)}
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

function groupByDay(items: QueueItem[]): { label: string; dayItems: QueueItem[] }[] {
  const groups: Map<string, QueueItem[]> = new Map();
  const today = new Date();
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  for (const item of items) {
    const d = new Date(item.scheduled_at);
    let label: string;
    if (isSameDay(d, today)) label = 'Today';
    else if (isSameDay(d, tomorrow)) label = 'Tomorrow';
    else label = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });

    if (!groups.has(label)) groups.set(label, []);
    groups.get(label)!.push(item);
  }

  return Array.from(groups.entries()).map(([label, dayItems]) => ({ label, dayItems }));
}

function isSameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
}
