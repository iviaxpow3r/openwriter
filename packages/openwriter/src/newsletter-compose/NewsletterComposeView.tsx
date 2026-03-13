/**
 * Newsletter Compose View — card-based newsletter editing.
 *
 * Layout: subject line → preview text → body (inside outlined card).
 * Matches blog/article compose view conventions.
 */

import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import NewsletterComposeModal, { type SendResult } from '../newsletter/NewsletterComposeModal';
import SchedulePostModal from '../sidebar/SchedulePostModal';
import './NewsletterComposeView.css';

// ─── Types ──────────────────────────────────────────────────────

export interface NewsletterContext {
  active?: boolean;
  subject?: string;
  previewText?: string;
  lastSend?: { sentCount: number; sentAt: string; issueId?: string };
}

// ─── Metadata persistence ───────────────────────────────────────

function saveNewsletterMeta(partial: Partial<NewsletterContext>) {
  fetch('/api/metadata', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ newsletterContext: partial }),
  }).catch(() => {});
}

// ─── Newsletter Compose View ────────────────────────────────────

interface NewsletterConnection {
  id: string;
  provider: string;
  display_name: string;
  status: string;
}

interface NewsletterComposeViewProps {
  children: ReactNode;
  newsletterContext?: NewsletterContext;
  filename?: string;
  title?: string;
  onTitleChange?: (title: string) => void;
  onBeforeSend?: () => Promise<void>;
}

export function TextNewsletterView({ children, newsletterContext, filename, title, onTitleChange, onBeforeSend }: NewsletterComposeViewProps) {
  const ctx = newsletterContext || {};
  const [subject, setSubject] = useState(ctx.subject || '');
  const [previewText, setPreviewText] = useState(ctx.previewText || '');
  const [connections, setConnections] = useState<NewsletterConnection[]>([]);
  const [showSendModal, setShowSendModal] = useState<string | null>(null);
  const [showScheduleModal, setShowScheduleModal] = useState(false);
  const [lastSend, setLastSend] = useState<SendResult | null>(
    ctx.lastSend?.sentAt ? { sentCount: ctx.lastSend.sentCount, issueId: ctx.lastSend.issueId || null, sentAt: ctx.lastSend.sentAt } : null
  );
  // Track last subject value we auto-synced to the title
  const autoSyncedSubject = useRef<string | null>(null);
  const subjectRef = useRef(subject);
  subjectRef.current = subject;

  // Sync state from context (metadata reload or document switch)
  useEffect(() => {
    // Only reset subject if it actually changed (avoids flicker from our own title-sync reload)
    const newSubject = ctx.subject || '';
    if (newSubject !== subjectRef.current) setSubject(newSubject);
    setPreviewText(ctx.previewText || '');
    setLastSend(ctx.lastSend?.sentAt ? { sentCount: ctx.lastSend.sentCount, issueId: ctx.lastSend.issueId || null, sentAt: ctx.lastSend.sentAt } : null);
  }, [newsletterContext]);

  // Reset auto-sync tracking only on actual document switch
  useEffect(() => {
    autoSyncedSubject.current = null;
  }, [filename]);

  // Fetch newsletter connections for Send button
  useEffect(() => {
    fetch('/api/connections')
      .then(r => r.json())
      .then(data => {
        const conns = (data.connections || []).filter((c: any) => c.provider === 'newsletter' && c.status === 'active');
        setConnections(conns);
      })
      .catch(() => {});
  }, []);

  const canSave = !!newsletterContext?.active;

  // Use ref for title so the debounced effect always sees current value
  const titleRef = useRef(title);
  titleRef.current = title;

  // Debounced auto-sync: subject → title after 500ms of no typing
  const syncTimer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => {
    if (syncTimer.current) clearTimeout(syncTimer.current);
    if (!onTitleChange || !subject.trim()) return;
    syncTimer.current = setTimeout(() => {
      const cur = titleRef.current;
      const isUntitled = !cur || cur === 'Untitled';
      const wasAutoSynced = autoSyncedSubject.current !== null && cur === autoSyncedSubject.current;
      if (isUntitled || wasAutoSynced) {
        // Persist subject first — title update causes a doc reload from disk
        saveNewsletterMeta({ subject });
        onTitleChange(subject.trim());
        autoSyncedSubject.current = subject.trim();
        // Eagerly update so next debounce passes wasAutoSynced before prop round-trips
        titleRef.current = subject.trim();
      }
    }, 500);
    return () => { if (syncTimer.current) clearTimeout(syncTimer.current); };
  }, [subject, onTitleChange]);

  const saveFields = useCallback(() => {
    if (canSave) saveNewsletterMeta({ subject, previewText });
  }, [canSave, subject, previewText]);

  const previewCharCount = previewText.length;
  const previewFull = previewCharCount >= 90;
  const previewOverLimit = previewCharCount > 150;

  const handleSend = () => {
    if (connections.length === 1) {
      setShowSendModal(connections[0].id);
    }
    // If multiple connections, could show picker — for now use first
    if (connections.length > 1) {
      setShowSendModal(connections[0].id);
    }
  };

  return (
    <div className="nl-compose-wrapper">
      {lastSend && (
        <div className="nl-sent-status">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="20 6 9 17 4 12" />
          </svg>
          Sent {new Date(lastSend.sentAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} to {lastSend.sentCount} subscriber{lastSend.sentCount !== 1 ? 's' : ''}
        </div>
      )}
      <div className="nl-compose-content">
        <input
          className="nl-subject-input"
          type="text"
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          onBlur={saveFields}
          placeholder="Subject line (defaults to title if empty)"
          autoComplete="off"
          data-lpignore="true"
          data-1p-ignore
          spellCheck={false}
        />
        <div className="nl-preview-wrap">
          <textarea
            className={`nl-preview-input${previewOverLimit ? ' over-limit' : ''}`}
            value={previewText}
            onChange={(e) => setPreviewText(e.target.value)}
            onBlur={saveFields}
            placeholder="Preview text shown in inbox before opening..."
            rows={2}
            spellCheck={false}
          />
          <span className={`nl-preview-count${previewOverLimit ? ' over-limit' : previewFull ? ' full' : ''}`}>
            {previewCharCount}/90
          </span>
        </div>
        <div className="nl-compose-body">{children}</div>
      </div>

      {filename && (
        <div className="nl-compose-footer">
          {connections.length > 0 && (
            <button className="nl-footer-btn nl-footer-btn--primary" onClick={handleSend}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="22" y1="2" x2="11" y2="13" /><polygon points="22 2 15 22 11 13 2 9 22 2" />
              </svg>
              Send
            </button>
          )}
          <button className="nl-footer-btn" onClick={() => setShowScheduleModal(true)}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" />
            </svg>
            Schedule
          </button>
        </div>
      )}

      {showSendModal && filename && (
        <NewsletterComposeModal
          connectionId={showSendModal}
          subject={subject || title || 'Untitled'}
          filename={filename}
          onBeforeSend={onBeforeSend}
          onClose={(result) => {
            setShowSendModal(null);
            if (result) {
              setLastSend(result);
              saveNewsletterMeta({ lastSend: { sentCount: result.sentCount, sentAt: result.sentAt, issueId: result.issueId || undefined } });
            }
          }}
        />
      )}
      {showScheduleModal && filename && (
        <SchedulePostModal
          filename={filename}
          title={title || 'Untitled'}
          onClose={() => setShowScheduleModal(false)}
        />
      )}
    </div>
  );
}
