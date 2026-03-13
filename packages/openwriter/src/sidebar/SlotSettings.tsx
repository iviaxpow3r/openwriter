import { useState } from 'react';

interface Slot {
  id: string;
  time: string;
  days: string[];
  filter_type: string;
  filter_value: string | null;
  timezone: string;
}

interface SlotSettingsProps {
  slots: Slot[];
  onBack: () => void;
}

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const FILTER_OPTIONS = [
  { value: 'any', label: 'Any' },
  { value: 'content_type', label: 'Content Type' },
  { value: 'connection', label: 'Connection' },
];

const TIMEZONES = [
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Anchorage',
  'Pacific/Honolulu',
  'America/Phoenix',
  'America/Toronto',
  'America/Vancouver',
  'America/Sao_Paulo',
  'America/Mexico_City',
  'Europe/London',
  'Europe/Paris',
  'Europe/Berlin',
  'Europe/Amsterdam',
  'Europe/Rome',
  'Europe/Madrid',
  'Europe/Moscow',
  'Asia/Tokyo',
  'Asia/Shanghai',
  'Asia/Kolkata',
  'Asia/Dubai',
  'Asia/Singapore',
  'Asia/Seoul',
  'Australia/Sydney',
  'Australia/Melbourne',
  'Pacific/Auckland',
];

function formatTzLabel(tz: string): string {
  try {
    const now = new Date();
    const fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' });
    const parts = fmt.formatToParts(now);
    const abbr = parts.find(p => p.type === 'timeZoneName')?.value || '';
    const city = tz.split('/').pop()!.replace(/_/g, ' ');
    return `${city} (${abbr})`;
  } catch {
    return tz;
  }
}

function detectTimezone(slots: Slot[]): string {
  if (slots.length > 0) return slots[0].timezone;
  try {
    const local = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (TIMEZONES.includes(local)) return local;
  } catch { /* ignore */ }
  return 'America/New_York';
}

export default function SlotSettings({ slots: initialSlots, onBack }: SlotSettingsProps) {
  const [slots, setSlots] = useState<Slot[]>(initialSlots);
  const [timezone, setTimezone] = useState(() => detectTimezone(initialSlots));
  const [tzOpen, setTzOpen] = useState(false);
  const [newTime, setNewTime] = useState('09:00');
  const [newDays, setNewDays] = useState<string[]>(['default']);
  const [newFilter, setNewFilter] = useState('any');
  const [adding, setAdding] = useState(false);

  async function handleTimezoneChange(newTz: string) {
    setTimezone(newTz);
    // Bulk-update all existing slots to the new timezone
    const updated: Slot[] = [];
    for (const slot of slots) {
      const res = await fetch(`/api/scheduler/slots/${slot.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ timezone: newTz }),
      });
      if (res.ok) {
        const data = await res.json();
        updated.push(data.slot);
      } else {
        updated.push(slot);
      }
    }
    if (updated.length > 0) setSlots(updated);
  }

  async function handleCreate() {
    const res = await fetch('/api/scheduler/slots', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        time: newTime,
        days: newDays.includes('default') ? ['default'] : newDays,
        filter_type: newFilter,
        timezone,
      }),
    });
    if (res.ok) {
      const data = await res.json();
      setSlots(prev => [...prev, data.slot]);
      setAdding(false);
      setNewTime('09:00');
      setNewDays(['default']);
      setNewFilter('any');
    }
  }

  async function handleDelete(id: string) {
    const res = await fetch(`/api/scheduler/slots/${id}`, { method: 'DELETE' });
    if (res.ok) {
      setSlots(prev => prev.filter(s => s.id !== id));
    }
  }

  function toggleDay(day: string) {
    setNewDays(prev => {
      if (day === 'default') return ['default'];
      const without = prev.filter(d => d !== 'default');
      if (without.includes(day)) {
        const result = without.filter(d => d !== day);
        return result.length === 0 ? ['default'] : result;
      }
      return [...without, day];
    });
  }

  return (
    <div className="sidebar-schedule">
      <div className="sidebar-schedule-header">
        <button className="sidebar-schedule-btn" onClick={onBack} title="Back">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="m15 18-6-6 6-6" />
          </svg>
        </button>
        <h3>Slot Settings</h3>
        <button className="sidebar-schedule-btn" onClick={() => setAdding(!adding)}>
          {adding ? 'Cancel' : '+ Add'}
        </button>
      </div>

      <div style={{ padding: '10px 12px', borderBottom: '1px solid var(--sidebar-border)', position: 'relative' }}>
        <label style={{ fontSize: '10px', color: 'var(--sidebar-text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', display: 'block', marginBottom: '4px' }}>
          Timezone
        </label>
        <button
          onClick={() => setTzOpen(!tzOpen)}
          style={{
            width: '100%',
            background: 'var(--sidebar-bg)',
            border: '1px solid var(--sidebar-border)',
            borderRadius: '4px',
            padding: '5px 8px',
            color: 'var(--sidebar-text)',
            fontSize: '12px',
            textAlign: 'left',
            cursor: 'pointer',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <span>{formatTzLabel(timezone)}</span>
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ transform: tzOpen ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }}>
            <path d="m6 9 6 6 6-6" />
          </svg>
        </button>
        {tzOpen && (
          <div style={{
            position: 'absolute',
            top: '100%',
            left: '12px',
            right: '12px',
            maxHeight: '200px',
            overflowY: 'auto',
            background: 'var(--sidebar-bg)',
            border: '1px solid var(--sidebar-border)',
            borderRadius: '4px',
            zIndex: 10,
            scrollbarWidth: 'thin',
            scrollbarColor: 'var(--scrollbar-thumb) var(--scrollbar-track)',
          }}>
            {TIMEZONES.map(tz => (
              <div
                key={tz}
                onClick={() => { handleTimezoneChange(tz); setTzOpen(false); }}
                style={{
                  padding: '6px 10px',
                  fontSize: '12px',
                  cursor: 'pointer',
                  color: tz === timezone ? 'var(--sidebar-text)' : 'var(--sidebar-text-muted)',
                  background: tz === timezone ? 'var(--sidebar-hover)' : 'transparent',
                }}
                onMouseEnter={e => { (e.target as HTMLElement).style.background = 'var(--sidebar-hover)'; }}
                onMouseLeave={e => { (e.target as HTMLElement).style.background = tz === timezone ? 'var(--sidebar-hover)' : 'transparent'; }}
              >
                {formatTzLabel(tz)}
              </div>
            ))}
          </div>
        )}
      </div>

      {adding && (
        <div style={{ padding: '12px', borderBottom: '1px solid var(--sidebar-border)' }}>
          <div style={{ display: 'flex', gap: '8px', marginBottom: '8px', alignItems: 'center' }}>
            <input
              type="time"
              value={newTime}
              onChange={e => setNewTime(e.target.value)}
              style={{
                background: 'var(--sidebar-bg)',
                border: '1px solid var(--sidebar-border)',
                borderRadius: '4px',
                padding: '4px 8px',
                color: 'var(--sidebar-text)',
                fontSize: '12px',
              }}
            />
            <select
              value={newFilter}
              onChange={e => setNewFilter(e.target.value)}
              style={{
                background: 'var(--sidebar-bg)',
                border: '1px solid var(--sidebar-border)',
                borderRadius: '4px',
                padding: '4px 8px',
                color: 'var(--sidebar-text)',
                fontSize: '12px',
              }}
            >
              {FILTER_OPTIONS.map(f => (
                <option key={f.value} value={f.value}>{f.label}</option>
              ))}
            </select>
          </div>
          <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap', marginBottom: '8px' }}>
            <button
              className={`sidebar-schedule-btn ${newDays.includes('default') ? 'sidebar-schedule-btn--active' : ''}`}
              onClick={() => toggleDay('default')}
              style={{ fontSize: '10px', padding: '2px 6px' }}
            >
              Every day
            </button>
            {DAYS.map(d => (
              <button
                key={d}
                className={`sidebar-schedule-btn ${newDays.includes(d.toLowerCase()) ? 'sidebar-schedule-btn--active' : ''}`}
                onClick={() => toggleDay(d.toLowerCase())}
                style={{ fontSize: '10px', padding: '2px 6px' }}
              >
                {d}
              </button>
            ))}
          </div>
          <button
            className="sidebar-schedule-btn sidebar-schedule-btn--active"
            onClick={handleCreate}
            style={{ width: '100%' }}
          >
            Create Slot
          </button>
        </div>
      )}

      <div style={{ flex: 1, overflow: 'auto' }}>
        {slots.length === 0 ? (
          <div className="schedule-empty">
            <div className="schedule-empty-title">No slots</div>
            <div className="schedule-empty-desc">Create time slots to define your posting schedule.</div>
          </div>
        ) : (
          slots.map(slot => (
            <div key={slot.id} className="schedule-item" style={{ cursor: 'default' }}>
              <div className="schedule-item-time" style={{ width: '60px', fontWeight: 600 }}>
                {formatSlotTime(slot.time)}
              </div>
              <div className="schedule-item-content">
                <div className="schedule-item-text">
                  {slot.days.includes('default') ? 'Every day' : slot.days.join(', ')}
                </div>
                <div className="schedule-item-meta">
                  <span>Filter: {slot.filter_type}</span>
                  {slot.filter_value && <span>({slot.filter_value})</span>}
                </div>
              </div>
              <button
                className="schedule-item-action schedule-item-action--danger"
                onClick={() => handleDelete(slot.id)}
                title="Delete slot"
                style={{ alignSelf: 'center' }}
              >
                &times;
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function formatSlotTime(time: string): string {
  const [h, m] = time.split(':').map(Number);
  const period = h >= 12 ? 'PM' : 'AM';
  const hour = h % 12 || 12;
  return `${hour}:${String(m).padStart(2, '0')} ${period}`;
}
