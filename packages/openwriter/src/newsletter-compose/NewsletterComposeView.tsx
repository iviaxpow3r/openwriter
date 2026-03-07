/**
 * Newsletter Compose View — card-based newsletter editing.
 *
 * Layout: subject line → preview text → body (inside outlined card).
 * Matches blog/article compose view conventions.
 */

import { type ReactNode, useCallback, useEffect, useState } from 'react';
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

interface NewsletterComposeViewProps {
  children: ReactNode;
  newsletterContext?: NewsletterContext;
}

export function TextNewsletterView({ children, newsletterContext }: NewsletterComposeViewProps) {
  const ctx = newsletterContext || {};
  const [subject, setSubject] = useState(ctx.subject || '');
  const [previewText, setPreviewText] = useState(ctx.previewText || '');

  useEffect(() => {
    setSubject(ctx.subject || '');
    setPreviewText(ctx.previewText || '');
  }, [newsletterContext]);

  const canSave = !!newsletterContext?.active;

  const saveFields = useCallback(() => {
    if (canSave) saveNewsletterMeta({ subject, previewText });
  }, [canSave, subject, previewText]);

  const previewCharCount = previewText.length;
  const previewOverLimit = previewCharCount > 150;

  return (
    <div className="nl-compose-wrapper">
      <div className="nl-compose-content">
        <input
          className="nl-subject-input"
          type="text"
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          onBlur={saveFields}
          placeholder="Email subject line (defaults to title if empty)"
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
    </div>
  );
}
