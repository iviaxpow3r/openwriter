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
  issue: { id: string; subject: string; status: string; sent_at: string; recipient_count: number; resent_at?: string; resend_subject?: string };
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
  const [resendOpen, setResendOpen] = useState(false);
  const [resendSubject, setResendSubject] = useState('');
  const [resendSending, setResendSending] = useState(false);
  const [resendResult, setResendResult] = useState<{ sent: number; failed: number } | null>(null);
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
    setResendOpen(false);
    setResendResult(null);
    setResendSubject('');
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

  const nonOpenerCount = analytics ? Math.max(0, sent - analytics.stats.unique_opens) : 0;
  const elapsedMs = analytics?.issue.sent_at ? Date.now() - new Date(analytics.issue.sent_at).getTime() : 0;
  const elapsedHours = Math.floor(elapsedMs / 3600000);
  const alreadyResent = !!(analytics?.issue.resent_at || resendResult);

  const elapsedDisplay = (ms: number) => {
    const h = Math.floor(ms / 3600000);
    if (h < 1) return 'just now';
    if (h < 24) return `${h}h ago`;
    const d = Math.floor(h / 24);
    return `${d}d ${h % 24}h ago`;
  };

  const handleResend = async () => {
    if (!resendSubject.trim() || resendSending) return;
    setResendSending(true);
    try {
      const result = await mcpCall('resend_to_unopened', {
        issue_id: selectedIssueId,
        subject: resendSubject,
      });
      if (result.error) {
        setError(result.error);
        setStage('error');
      } else {
        setResendResult({ sent: result.sent, failed: result.failed });
        setResendOpen(false);
      }
    } catch (err: any) {
      setError(err.message);
      setStage('error');
    } finally {
      setResendSending(false);
    }
  };

  const isUnsubEvent = (e: AnalyticsData['subscriber_events'][0]) =>
    e.event_type === 'unsubscribe' || (e.event_type === 'click' && !!e.url?.includes('/newsletter/unsubscribe/'));

  // Filter and deduplicate subscriber events (group by email + event_type + url)
  const groupedEvents = analytics
    ? dedupeEvents(
        analytics.subscriber_events.filter(e => {
          if (eventFilter === 'all') return true;
          if (eventFilter === 'unsubscribe') return isUnsubEvent(e);
          return e.event_type === eventFilter;
        })
      )
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

                {/* Resend to non-openers */}
                {nonOpenerCount > 0 && !alreadyResent && (
                  <div className="na-resend">
                    {!resendOpen ? (
                      <button
                        className="na-resend-toggle"
                        onClick={() => {
                          setResendOpen(true);
                          setResendSubject(analytics.issue.subject);
                        }}
                      >
                        Resend to {nonOpenerCount.toLocaleString()} non-openers <span style={{ float: 'right' }}>›</span>
                      </button>
                    ) : (
                      <div className="na-resend-panel">
                        <div className="na-resend-label-row">
                          <span className="na-resend-label">New subject line</span>
                          <span className="na-resend-meta">sent {elapsedDisplay(elapsedMs)}{elapsedHours < 48 ? ' · consider waiting 48h' : ''}</span>
                        </div>
                        <input
                          className="na-resend-input"
                          type="text"
                          value={resendSubject}
                          onChange={(e) => setResendSubject(e.target.value)}
                          placeholder="Try a different angle"
                        />
                        <div className="na-resend-actions">
                          <button className="na-resend-cancel" onClick={() => setResendOpen(false)}>Cancel</button>
                          <button
                            className="na-resend-send"
                            onClick={handleResend}
                            disabled={resendSending || !resendSubject.trim()}
                          >
                            {resendSending ? 'Sending...' : `Send to ${nonOpenerCount.toLocaleString()}`}
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                )}
                {alreadyResent && (
                  <div className="na-resend-done">
                    Resent {analytics.issue.resent_at ? elapsedDisplay(Date.now() - new Date(analytics.issue.resent_at).getTime()) : 'just now'}
                    {resendResult ? ` — ${resendResult.sent} sent` : ''}
                    {analytics.issue.resend_subject ? ` — "${analytics.issue.resend_subject}"` : ''}
                  </div>
                )}

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
                      {groupedEvents.length === 0 ? (
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
                            {groupedEvents.slice(0, 100).map((ev) => (
                              <tr key={ev.key}>
                                <td className="na-table__email">{ev.email}</td>
                                <td>
                                  <span className={`na-badge na-badge--${ev.event_type}`}>{ev.event_type}</span>
                                  {ev.count > 1 && <span className="na-count">{ev.count}x</span>}
                                </td>
                                <td className="na-table__url">{ev.url ? <a href={ev.url} target="_blank" rel="noopener noreferrer">{truncateUrl(ev.url, 35)}</a> : '—'}</td>
                                <td className="na-table__time">{shortDate(ev.latestTimestamp)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      )}
                      {groupedEvents.length > 100 && (
                        <div className="na-truncated">Showing 100 of {groupedEvents.length} events</div>
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

interface GroupedEvent {
  key: string;
  email: string;
  event_type: string;
  url?: string;
  latestTimestamp: string;
  count: number;
}

function dedupeEvents(events: AnalyticsData['subscriber_events']): GroupedEvent[] {
  const groups = new Map<string, GroupedEvent>();

  for (const ev of events) {
    const key = `${ev.email}|${ev.event_type}|${ev.url || ''}`;
    const existing = groups.get(key);
    if (existing) {
      existing.count++;
      if (ev.timestamp > existing.latestTimestamp) existing.latestTimestamp = ev.timestamp;
    } else {
      groups.set(key, { key, email: ev.email, event_type: ev.event_type, url: ev.url, latestTimestamp: ev.timestamp, count: 1 });
    }
  }

  return Array.from(groups.values()).sort((a, b) => new Date(b.latestTimestamp).getTime() - new Date(a.latestTimestamp).getTime());
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
