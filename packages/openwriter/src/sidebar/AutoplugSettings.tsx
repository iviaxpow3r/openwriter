import { useState, useEffect, useCallback } from 'react';
import './AutoplugSettings.css';

interface Goal {
  id: string;
  name: string;
  link: string | null;
  description: string | null;
  enabled: boolean;
  rule_count: number;
  pool_count: number;
  rule?: { metric: string; threshold: number; delay_minutes: number; mode: string; id: string } | null;
}

interface PoolMessage {
  id: string;
  content: string;
  enabled: boolean;
  times_used: number;
}

interface TrackingRow {
  id: string;
  tweet_id: string;
  screen_name: string;
  source: string;
  original_text: string | null;
  posted_at: string;
  likes: number;
  retweets: number;
  views: number;
  threshold_met_at: string | null;
  triggered: boolean;
  skipped: boolean;
  goal_name?: string;
}

interface AutoplugSettingsProps {
  onBack: () => void;
}

export default function AutoplugSettings({ onBack }: AutoplugSettingsProps) {
  const [goals, setGoals] = useState<Goal[]>([]);
  const [tracking, setTracking] = useState<TrackingRow[]>([]);
  const [expandedGoalId, setExpandedGoalId] = useState<string | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    try {
      const [goalsRes, trackingRes] = await Promise.all([
        fetch('/api/scheduler/autoplugs/goals'),
        fetch('/api/scheduler/autoplugs/tracking'),
      ]);
      if (goalsRes.ok) {
        const data = await goalsRes.json();
        setGoals(data.goals || []);
      }
      if (trackingRes.ok) {
        const data = await trackingRes.json();
        setTracking(data.tracking || []);
      }
    } catch { /* ignore */ }
    setLoading(false);
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  const handleToggleGoal = async (goal: Goal) => {
    const res = await fetch(`/api/scheduler/autoplugs/goals/${goal.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: !goal.enabled }),
    });
    if (res.ok) {
      setGoals(prev => prev.map(g => g.id === goal.id ? { ...g, enabled: !g.enabled } : g));
    }
  };

  const handleDeleteGoal = async (goalId: string) => {
    const res = await fetch(`/api/scheduler/autoplugs/goals/${goalId}`, { method: 'DELETE' });
    if (res.ok) {
      setGoals(prev => prev.filter(g => g.id !== goalId));
      setExpandedGoalId(null);
    }
  };

  const handleSkipTracking = async (id: string) => {
    const res = await fetch(`/api/scheduler/autoplugs/tracking/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ skipped: true }),
    });
    if (res.ok) {
      setTracking(prev => prev.map(t => t.id === id ? { ...t, skipped: true } : t));
    }
  };

  // Find the best rule threshold for progress bars
  const bestThreshold = goals.reduce((best, g) => {
    if (g.rule && g.enabled) return Math.min(best, g.rule.threshold);
    return best;
  }, Infinity);
  const threshold = bestThreshold === Infinity ? 50 : bestThreshold;

  return (
    <div className="sidebar-schedule">
      <div className="sidebar-schedule-header">
        <button className="sidebar-schedule-back" onClick={onBack} title="Back">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="m15 18-6-6 6-6" />
          </svg>
        </button>
        <h3>Autoplugs</h3>
        <button className="sidebar-schedule-btn" onClick={() => setShowAddForm(!showAddForm)}>
          {showAddForm ? 'Cancel' : '+ Add'}
        </button>
      </div>

      {showAddForm && (
        <AddGoalForm onCreated={(goal) => {
          setGoals(prev => [...prev, goal]);
          setShowAddForm(false);
        }} />
      )}

      {loading ? null : (
        <>
          {/* GOALS */}
          <div className="autoplug-section-header">Goals</div>
          {goals.length === 0 ? (
            <div className="schedule-empty">
              <div className="schedule-empty-title">No goals</div>
              <div className="schedule-empty-desc">Create a goal to start autoplugging your tweets.</div>
            </div>
          ) : (
            goals.map(goal => (
              <div key={goal.id}>
                <div
                  className="schedule-item"
                  onClick={() => setExpandedGoalId(expandedGoalId === goal.id ? null : goal.id)}
                >
                  <div className="schedule-item-content">
                    <div className="schedule-item-text">{goal.name}</div>
                    {goal.link && (
                      <div className="autoplug-goal-summary">{goal.link}</div>
                    )}
                    <div className="schedule-item-meta">
                      {goal.rule && (
                        <>
                          <span>{goal.rule.threshold}+ {goal.rule.metric}</span>
                          <span>{goal.rule.mode.toUpperCase()}</span>
                          <span>{goal.rule.delay_minutes}m delay</span>
                        </>
                      )}
                      <span>{goal.pool_count} pool msg{goal.pool_count !== 1 ? 's' : ''}</span>
                    </div>
                  </div>
                  <button
                    className={`autoplug-toggle ${goal.enabled ? 'autoplug-toggle--on' : 'autoplug-toggle--off'}`}
                    onClick={(e) => { e.stopPropagation(); handleToggleGoal(goal); }}
                    title={goal.enabled ? 'Disable' : 'Enable'}
                  />
                </div>
                {expandedGoalId === goal.id && (
                  <GoalEditor
                    goal={goal}
                    onSaved={(updated) => {
                      setGoals(prev => prev.map(g => g.id === updated.id ? updated : g));
                    }}
                    onDeleted={() => handleDeleteGoal(goal.id)}
                    onRefresh={fetchData}
                  />
                )}
              </div>
            ))
          )}

          {/* TRACKING */}
          <div className="autoplug-section-header">Tracking</div>
          {tracking.length === 0 ? (
            <div className="schedule-empty">
              <div className="schedule-empty-title">No tracked tweets</div>
              <div className="schedule-empty-desc">Tweets will appear here after posting.</div>
            </div>
          ) : (
            tracking.map(t => (
              <div key={t.id} className="autoplug-tracking-item">
                <div className="autoplug-tracking-header">
                  <div className="autoplug-tracking-text">
                    {t.original_text || `Tweet ${t.tweet_id}`}
                  </div>
                  {!t.triggered && !t.skipped && (
                    <button
                      className="autoplug-tracking-skip"
                      onClick={() => handleSkipTracking(t.id)}
                      title="Skip autoplug for this tweet"
                    >
                      &times;
                    </button>
                  )}
                </div>
                <div className="autoplug-tracking-meta">
                  <span>{timeAgo(t.posted_at)}</span>
                  <span>{t.likes} likes</span>
                  <span>{t.retweets} RTs</span>
                  {t.views > 0 && <span>{formatNumber(t.views)} views</span>}
                  <span>{t.source}</span>
                </div>
                {t.triggered ? (
                  <div className="autoplug-tracking-triggered">
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                    Autoplugged {t.goal_name ? `\u2192 ${t.goal_name}` : ''}
                  </div>
                ) : t.skipped ? (
                  <div style={{ fontSize: '10px', color: 'var(--sidebar-text-secondary)', opacity: 0.6 }}>
                    Skipped
                  </div>
                ) : (
                  <div className="autoplug-tracking-bar">
                    <div
                      className="autoplug-tracking-bar-fill"
                      style={{ width: `${Math.min(100, (t.likes / threshold) * 100)}%` }}
                    />
                  </div>
                )}
              </div>
            ))
          )}
        </>
      )}
    </div>
  );
}

// ── Add Goal Form ──

function AddGoalForm({ onCreated }: { onCreated: (goal: Goal) => void }) {
  const [name, setName] = useState('');
  const [link, setLink] = useState('');
  const [desc, setDesc] = useState('');
  const [metric, setMetric] = useState('likes');
  const [threshold, setThreshold] = useState(50);
  const [delay, setDelay] = useState(30);
  const [mode, setMode] = useState('static');
  const [saving, setSaving] = useState(false);

  const handleCreate = async () => {
    if (!name.trim()) return;
    setSaving(true);
    try {
      // Create goal
      const goalRes = await fetch('/api/scheduler/autoplugs/goals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), link: link.trim() || null, description: desc.trim() || null }),
      });
      if (!goalRes.ok) { setSaving(false); return; }
      const { goal } = await goalRes.json();

      // Create rule
      await fetch('/api/scheduler/autoplugs/rules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ goal_id: goal.id, metric, threshold, delay_minutes: delay, mode }),
      });

      // Re-fetch to get counts
      const refreshRes = await fetch('/api/scheduler/autoplugs/goals');
      if (refreshRes.ok) {
        const data = await refreshRes.json();
        const created = (data.goals || []).find((g: Goal) => g.id === goal.id);
        if (created) { onCreated(created); return; }
      }
      onCreated({ ...goal, rule_count: 1, pool_count: 0, rule: { metric, threshold, delay_minutes: delay, mode, id: '' } });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="autoplug-editor">
      <label>
        Name
        <input value={name} onChange={e => setName(e.target.value)} placeholder="Newsletter, Course..." />
      </label>
      <label>
        Link
        <input value={link} onChange={e => setLink(e.target.value)} placeholder="https://..." />
      </label>
      <label>
        Description (context for LLM)
        <textarea value={desc} onChange={e => setDesc(e.target.value)} placeholder="Weekly engineering insights..." rows={2} />
      </label>
      <div className="autoplug-editor-row">
        <input type="number" value={threshold} onChange={e => setThreshold(Number(e.target.value))} min={1} />
        <select value={metric} onChange={e => setMetric(e.target.value)}>
          <option value="likes">likes</option>
          <option value="retweets">retweets</option>
          <option value="views">views</option>
        </select>
        <span style={{ fontSize: '11px', color: 'var(--sidebar-text-secondary)' }}>wait</span>
        <input type="number" value={delay} onChange={e => setDelay(Number(e.target.value))} min={0} style={{ width: '50px' }} />
        <span style={{ fontSize: '11px', color: 'var(--sidebar-text-secondary)' }}>min</span>
      </div>
      <div className="autoplug-mode-toggle">
        {(['static', 'llm', 'hybrid'] as const).map(m => (
          <button key={m} className={mode === m ? 'active' : ''} onClick={() => setMode(m)}>
            {m === 'llm' ? 'LLM' : m.charAt(0).toUpperCase() + m.slice(1)}
          </button>
        ))}
      </div>
      <button
        className="sidebar-schedule-btn sidebar-schedule-btn--active"
        onClick={handleCreate}
        disabled={saving || !name.trim()}
        style={{ width: '100%' }}
      >
        {saving ? 'Creating...' : 'Create Goal'}
      </button>
    </div>
  );
}

// ── Goal Editor (inline expand) ──

function GoalEditor({ goal, onSaved, onDeleted, onRefresh }: {
  goal: Goal;
  onSaved: (g: Goal) => void;
  onDeleted: () => void;
  onRefresh: () => void;
}) {
  const [name, setName] = useState(goal.name);
  const [link, setLink] = useState(goal.link || '');
  const [desc, setDesc] = useState(goal.description || '');
  const [metric, setMetric] = useState(goal.rule?.metric || 'likes');
  const [threshold, setThreshold] = useState(goal.rule?.threshold || 50);
  const [delay, setDelay] = useState(goal.rule?.delay_minutes || 30);
  const [mode, setMode] = useState(goal.rule?.mode || 'static');
  const [pool, setPool] = useState<PoolMessage[]>([]);
  const [newMsg, setNewMsg] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch(`/api/scheduler/autoplugs/goals/${goal.id}/pool`)
      .then(r => r.json())
      .then(data => setPool(data.pool || []))
      .catch(() => {});
  }, [goal.id]);

  const handleSave = async () => {
    setSaving(true);
    try {
      // Update goal
      await fetch(`/api/scheduler/autoplugs/goals/${goal.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, link: link || null, description: desc || null }),
      });

      // Update or create rule
      if (goal.rule?.id) {
        await fetch(`/api/scheduler/autoplugs/rules/${goal.rule.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ metric, threshold, delay_minutes: delay, mode }),
        });
      } else {
        await fetch('/api/scheduler/autoplugs/rules', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ goal_id: goal.id, metric, threshold, delay_minutes: delay, mode }),
        });
      }

      onRefresh();
    } finally {
      setSaving(false);
    }
  };

  const handleAddMsg = async () => {
    if (!newMsg.trim()) return;
    const res = await fetch(`/api/scheduler/autoplugs/goals/${goal.id}/pool`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: newMsg.trim() }),
    });
    if (res.ok) {
      const data = await res.json();
      setPool(prev => [...prev, data.message]);
      setNewMsg('');
    }
  };

  const handleDeleteMsg = async (msgId: string) => {
    const res = await fetch(`/api/scheduler/autoplugs/pool/${msgId}`, { method: 'DELETE' });
    if (res.ok) {
      setPool(prev => prev.filter(m => m.id !== msgId));
    }
  };

  return (
    <div className="autoplug-editor">
      <label>
        Name
        <input value={name} onChange={e => setName(e.target.value)} />
      </label>
      <label>
        Link
        <input value={link} onChange={e => setLink(e.target.value)} placeholder="https://..." />
      </label>
      <label>
        Description
        <textarea value={desc} onChange={e => setDesc(e.target.value)} rows={2} />
      </label>

      <div style={{ fontSize: '10px', fontWeight: 600, color: 'var(--sidebar-text-secondary)', textTransform: 'uppercase', letterSpacing: '0.3px' }}>
        Trigger
      </div>
      <div className="autoplug-editor-row">
        <input type="number" value={threshold} onChange={e => setThreshold(Number(e.target.value))} min={1} />
        <select value={metric} onChange={e => setMetric(e.target.value)}>
          <option value="likes">likes</option>
          <option value="retweets">retweets</option>
          <option value="views">views</option>
        </select>
        <span style={{ fontSize: '11px', color: 'var(--sidebar-text-secondary)' }}>wait</span>
        <input type="number" value={delay} onChange={e => setDelay(Number(e.target.value))} min={0} style={{ width: '50px' }} />
        <span style={{ fontSize: '11px', color: 'var(--sidebar-text-secondary)' }}>min</span>
      </div>
      <div className="autoplug-mode-toggle">
        {(['static', 'llm', 'hybrid'] as const).map(m => (
          <button key={m} className={mode === m ? 'active' : ''} onClick={() => setMode(m)}>
            {m === 'llm' ? 'LLM' : m.charAt(0).toUpperCase() + m.slice(1)}
          </button>
        ))}
      </div>

      <div className="autoplug-pool-section">
        <div className="autoplug-pool-label">Static Pool</div>
        {pool.map(msg => (
          <div key={msg.id} className="autoplug-pool-item">
            <span>{msg.content}</span>
            <button onClick={() => handleDeleteMsg(msg.id)} title="Remove">&times;</button>
          </div>
        ))}
        <div className="autoplug-pool-add">
          <input
            value={newMsg}
            onChange={e => setNewMsg(e.target.value)}
            placeholder="Add message... (use {{link}} for link)"
            onKeyDown={e => e.key === 'Enter' && handleAddMsg()}
          />
          <button onClick={handleAddMsg}>+</button>
        </div>
      </div>

      {(mode === 'llm' || mode === 'hybrid') && (
        <div style={{ fontSize: '11px', color: 'var(--sidebar-text-secondary)', padding: '4px 0' }}>
          LLM mode uses Author's Voice to generate contextual replies referencing the original tweet.
        </div>
      )}

      <div className="autoplug-editor-actions">
        <button
          className="sidebar-schedule-btn sidebar-schedule-btn--active"
          onClick={handleSave}
          disabled={saving}
        >
          {saving ? 'Saving...' : 'Save'}
        </button>
        <button
          className="schedule-item-action schedule-item-action--danger"
          onClick={onDeleted}
        >
          Delete
        </button>
      </div>
    </div>
  );
}

// ── Helpers ──

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatNumber(n: number): string {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}
