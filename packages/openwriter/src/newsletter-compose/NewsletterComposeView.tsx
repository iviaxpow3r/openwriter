/**
 * Newsletter Compose View — card-based newsletter editing.
 *
 * Layout: subject line → preview text → body (inside outlined card).
 * Matches blog/article compose view conventions.
 */

import { type ReactNode, useCallback, useEffect, useState } from 'react';
import NewsletterComposeModal from '../newsletter/NewsletterComposeModal';
import SchedulePostModal from '../sidebar/SchedulePostModal';
import './NewsletterComposeView.css';

// ─── Types ──────────────────────────────────────────────────────

export interface NewsletterContext {
  active?: boolean;
  subject?: string;
  previewText?: string;
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
}

export function TextNewsletterView({ children, newsletterContext, filename, title }: NewsletterComposeViewProps) {
  const ctx = newsletterContext || {};
  const [subject, setSubject] = useState(ctx.subject || '');
  const [previewText, setPreviewText] = useState(ctx.previewText || '');
  const [connections, setConnections] = useState<NewsletterConnection[]>([]);
  const [showSendModal, setShowSendModal] = useState<string | null>(null);
  const [showScheduleModal, setShowScheduleModal] = useState(false);

  useEffect(() => {
    setSubject(ctx.subject || '');
    setPreviewText(ctx.previewText || '');
  }, [newsletterContext]);

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

  const saveFields = useCallback(() => {
    if (canSave) saveNewsletterMeta({ subject, previewText });
  }, [canSave, subject, previewText]);

  const previewCharCount = previewText.length;
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
          <span className={`nl-preview-count${previewOverLimit ? ' over-limit' : ''}`}>
            {previewCharCount}/150
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
          onClose={() => setShowSendModal(null)}
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
