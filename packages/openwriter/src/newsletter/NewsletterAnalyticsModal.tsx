import { useState, useEffect, useRef } from 'react';
import './NewsletterAnalyticsModal.css';

interface NewsletterAnalyticsModalProps {
  docId: string;
  title: string;
  onClose: () => void;
}

interface IssueOverview {
  id: string;
  subject: string;
  sent_at: string;
  recipient_count: number;
  unique_opens: number;
  unique_clicks: number;
}

interface AnalyticsData {
  issue: { id: string; subject: string; status: string; sent_at: string; recipient_count: number };
  stats: { delivered: number; unique_opens: number; unique_clicks: number; bounces: number; complaints: number; unsubscribes: number };
  subscriber_events: Array<{ email: string; event_type: string; timestamp: string; url?: string }>;
  recipients: Array<{ subscriber_id: string; email: string; status: string; created_at: string }>;
}

interface LinkStat {
  url: string;
  uniqueClicks: number;
  totalClicks: number;
}

type EventFilter = 'all' | 'open' | 'click' | 'bounce' | 'dropped' | 'unsubscribe';

type Stage = 'loading' | 'loaded' | 'no-data' | 'error';

async function mcpCall(tool: string, args: Record<string, any> = {}) {
  const res = await fetch('/api/mcp-call', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tool, arguments: args }),
  });
  const data = await res.json();
  return data.content?.[0]?.text ? JSON.parse(data.content[0].text) : data;
}

function pct(n: number, total: number): string {
  if (!total) return '0%';
  return (n / total * 100).toFixed(1) + '%';
}

function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function truncateUrl(url: string, max = 50): string {
  try {
    const u = new URL(url);
    const display = u.hostname + u.pathname + u.search;
    return display.length > max ? display.slice(0, max) + '...' : display;
  } catch {
    return url.length > max ? url.slice(0, max) + '...' : url;
  }
}

export default function NewsletterAnalyticsModal({ docId, title, onClose }: NewsletterAnalyticsModalProps) {
  const [stage, setStage] = useState<Stage>('loading');
  const [issues, setIssues] = useState<IssueOverview[]>([]);
  const [selectedIssueId, setSelectedIssueId] = useState<string>('');
  const [analytics, setAnalytics] = useState<AnalyticsData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'links' | 'activity'>('links');
  const [eventFilter, setEventFilter] = useState<EventFilter>('all');
  const [loadingAnalytics, setLoadingAnalytics] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Load issues on mount
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const result = await mcpCall('list_newsletter_issues', { limit: 20 });
        if (cancelled) return;
        if (!result.issues || result.issues.length === 0) {
          setStage('no-data');
          return;
        }
        setIssues(result.issues);
        const firstId = result.issues[0].id;
        setSelectedIssueId(firstId);
      } catch (err: any) {
        if (!cancelled) { setError(err.message); setStage('error'); }
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Load analytics when selected issue changes
  useEffect(() => {
    if (!selectedIssueId) return;
    let cancelled = false;
    setLoadingAnalytics(true);
    (async () => {
      try {
        const result = await mcpCall('get_newsletter_analytics', { issue_id: selectedIssueId });
        if (cancelled) return;
        if (result.error) {
          setError(result.error);
          setStage('error');
          return;
        }
        setAnalytics(result);
        setStage('loaded');
      } catch (err: any) {
        if (!cancelled) { setError(err.message); setStage('error'); }
      } finally {
        if (!cancelled) setLoadingAnalytics(false);
      }
    })();
    return () => { cancelled = true; };
  }, [selectedIssueId]);

  // Close on click outside
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  // Compute link stats from subscriber_events
  const linkStats: LinkStat[] = analytics ? computeLinkStats(analytics.subscriber_events) : [];

  // Compute effective stats — use recipient_count as base, detect unsubs from click events
  const sent = analytics?.issue.recipient_count ?? 0;
  const effectiveDelivered = analytics ? (analytics.stats.delivered || sent - analytics.stats.bounces) : 0;
  const unsubClicks = analytics
    ? new Set(analytics.subscriber_events.filter(e => e.event_type === 'click' && e.url?.includes('/newsletter/unsubscribe/')).map(e => e.email)).size
    : 0;
  const effectiveUnsubs = analytics ? (analytics.stats.unsubscribes || unsubClicks) : 0;
  const droppedCount = analytics
    ? analytics.subscriber_events.filter(e => e.event_type === 'dropped').length
    : 0;

  const isUnsubEvent = (e: AnalyticsData['subscriber_events'][0]) =>
    e.event_type === 'unsubscribe' || (e.event_type === 'click' && !!e.url?.includes('/newsletter/unsubscribe/'));

  // Filter subscriber events
  const filteredEvents = analytics
    ? analytics.subscriber_events
        .filter(e => {
          if (eventFilter === 'all') return true;
          if (eventFilter === 'unsubscribe') return isUnsubEvent(e);
          return e.event_type === eventFilter;
        })
        .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
    : [];

  return (
    <div className="newsletter-modal-overlay">
      <div className="na-modal" ref={ref}>
        <div className="na-header">
          <h3>Newsletter Analytics</h3>
          <button className="newsletter-modal__close" onClick={onClose}>&times;</button>
        </div>

        {stage === 'loading' && !analytics && (
          <div className="na-body">
            <div className="newsletter-modal__status">
              <div className="newsletter-modal__spinner" />
              <span>Loading analytics...</span>
            </div>
          </div>
        )}

        {stage === 'no-data' && (
          <div className="na-body">
            <div className="newsletter-modal__status">
              <span>No newsletter sends found yet.</span>
            </div>
            <div className="newsletter-modal__actions">
              <button className="newsletter-modal__btn newsletter-modal__btn--primary" onClick={onClose}>Done</button>
            </div>
          </div>
        )}

        {stage === 'error' && (
          <div className="na-body">
            <div className="newsletter-modal__error">{error}</div>
            <div className="newsletter-modal__actions">
              <button className="newsletter-modal__btn newsletter-modal__btn--primary" onClick={onClose}>Done</button>
            </div>
          </div>
        )}

        {stage === 'loaded' && analytics && (
          <div className="na-body">
            {/* Issue selector */}
            {issues.length > 1 && (
              <select
                className="newsletter-modal__select na-issue-select"
                value={selectedIssueId}
                onChange={(e) => setSelectedIssueId(e.target.value)}
              >
                {issues.map(issue => (
                  <option key={issue.id} value={issue.id}>
                    {issue.subject} — {shortDate(issue.sent_at)}
                  </option>
                ))}
              </select>
            )}

            {loadingAnalytics ? (
              <div className="newsletter-modal__status">
                <div className="newsletter-modal__spinner" />
                <span>Loading...</span>
              </div>
            ) : (
              <>
                {/* KPI Cards */}
                <div className="na-kpi-row">
                  <div className="na-kpi">
                    <div className="na-kpi__value">{effectiveDelivered.toLocaleString()}</div>
                    <div className="na-kpi__label">Delivered</div>
                    <div className="na-kpi__sub">{sent.toLocaleString()} sent</div>
                  </div>
                  <div className="na-kpi">
                    <div className="na-kpi__value">{pct(analytics.stats.unique_opens, effectiveDelivered)}</div>
                    <div className="na-kpi__label">Open rate</div>
                    <div className="na-kpi__sub">{analytics.stats.unique_opens.toLocaleString()} opens</div>
                  </div>
                  <div className="na-kpi">
                    <div className="na-kpi__value">{pct(analytics.stats.unique_clicks, effectiveDelivered)}</div>
                    <div className="na-kpi__label">Click rate</div>
                    <div className="na-kpi__sub">{analytics.stats.unique_clicks.toLocaleString()} clicks</div>
                  </div>
                </div>
                <div className="na-kpi-row na-kpi-row--secondary">
                  <div className="na-kpi na-kpi--sm">
                    <span className="na-kpi__value--sm">{analytics.stats.bounces}</span>
                    <span className="na-kpi__label--sm">Bounces</span>
                  </div>
                  <div className="na-kpi na-kpi--sm">
                    <span className="na-kpi__value--sm">{effectiveUnsubs}</span>
                    <span className="na-kpi__label--sm">Unsubs</span>
                  </div>
                  <div className="na-kpi na-kpi--sm">
                    <span className="na-kpi__value--sm">{droppedCount}</span>
                    <span className="na-kpi__label--sm">Dropped</span>
                  </div>
                  {analytics.stats.complaints > 0 && (
                    <div className="na-kpi na-kpi--sm">
                      <span className="na-kpi__value--sm">{analytics.stats.complaints}</span>
                      <span className="na-kpi__label--sm">Spam</span>
                    </div>
                  )}
                </div>

                {/* Tabs */}
                <div className="na-tabs">
                  <button className={`na-tab${activeTab === 'links' ? ' active' : ''}`} onClick={() => setActiveTab('links')}>
                    Links ({linkStats.length})
                  </button>
                  <button className={`na-tab${activeTab === 'activity' ? ' active' : ''}`} onClick={() => setActiveTab('activity')}>
                    Activity ({analytics.subscriber_events.length})
                  </button>
                </div>

                {/* Links tab */}
                {activeTab === 'links' && (
                  <div className="na-table-wrap">
                    {linkStats.length === 0 ? (
                      <div className="na-empty">No link clicks recorded yet.</div>
                    ) : (
                      <table className="na-table">
                        <thead>
                          <tr>
                            <th>Link</th>
                            <th>Unique</th>
                            <th>Total</th>
                            <th>CTR</th>
                          </tr>
                        </thead>
                        <tbody>
                          {linkStats.map((link) => (
                            <tr key={link.url}>
                              <td className="na-table__url" title={link.url}>
                                <a href={link.url} target="_blank" rel="noopener noreferrer">{truncateUrl(link.url)}</a>
                              </td>
                              <td>{link.uniqueClicks}</td>
                              <td>{link.totalClicks}</td>
                              <td>{pct(link.uniqueClicks, effectiveDelivered)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </div>
                )}

                {/* Activity tab */}
                {activeTab === 'activity' && (
                  <div className="na-activity">
                    <div className="na-filter-row">
                      {(['all', 'open', 'click', 'bounce', 'dropped', 'unsubscribe'] as EventFilter[]).map(f => (
                        <button
                          key={f}
                          className={`na-filter-btn${eventFilter === f ? ' active' : ''}`}
                          onClick={() => setEventFilter(f)}
                        >
                          {f === 'all' ? 'All' : f.charAt(0).toUpperCase() + f.slice(1) + 's'}
                        </button>
                      ))}
                    </div>
                    <div className="na-table-wrap">
                      {filteredEvents.length === 0 ? (
                        <div className="na-empty">No {eventFilter === 'all' ? '' : eventFilter + ' '}events recorded.</div>
                      ) : (
                        <table className="na-table">
                          <thead>
                            <tr>
                              <th>Email</th>
                              <th>Event</th>
                              <th>Detail</th>
                              <th>Time</th>
                            </tr>
                          </thead>
                          <tbody>
                            {filteredEvents.slice(0, 100).map((ev, i) => (
                              <tr key={`${ev.email}-${ev.event_type}-${ev.timestamp}-${i}`}>
                                <td className="na-table__email">{ev.email}</td>
                                <td><span className={`na-badge na-badge--${ev.event_type}`}>{ev.event_type}</span></td>
                                <td className="na-table__url">{ev.url ? <a href={ev.url} target="_blank" rel="noopener noreferrer">{truncateUrl(ev.url, 35)}</a> : '—'}</td>
                                <td className="na-table__time">{shortDate(ev.timestamp)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      )}
                      {filteredEvents.length > 100 && (
                        <div className="na-truncated">Showing 100 of {filteredEvents.length} events</div>
                      )}
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function computeLinkStats(events: AnalyticsData['subscriber_events']): LinkStat[] {
  const clickEvents = events.filter(e => e.event_type === 'click' && e.url);
  const byUrl = new Map<string, { emails: Set<string>; total: number }>();

  for (const ev of clickEvents) {
    const url = ev.url!;
    let entry = byUrl.get(url);
    if (!entry) {
      entry = { emails: new Set(), total: 0 };
      byUrl.set(url, entry);
    }
    entry.emails.add(ev.email);
    entry.total++;
  }

  return Array.from(byUrl.entries())
    .map(([url, { emails, total }]) => ({ url, uniqueClicks: emails.size, totalClicks: total }))
    .sort((a, b) => b.uniqueClicks - a.uniqueClicks);
}
