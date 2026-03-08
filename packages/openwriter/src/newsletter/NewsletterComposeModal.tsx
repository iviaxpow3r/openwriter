import { useState, useEffect, useRef } from 'react';
import './NewsletterComposeModal.css';

export interface SendResult {
  sentCount: number;
  issueId: string | null;
  sentAt: string;
}

interface NewsletterComposeModalProps {
  connectionId: string;
  subject: string;
  filename: string;
  onBeforeSend?: () => Promise<void>;
  onClose: (result?: SendResult) => void;
}

type Stage = 'confirm' | 'sending' | 'testing' | 'sent' | 'error';
type Format = 'html' | 'plaintext';

export default function NewsletterComposeModal({ connectionId, subject, filename, onBeforeSend, onClose }: NewsletterComposeModalProps) {
  const [stage, setStage] = useState<Stage>('confirm');
  const [format, setFormat] = useState<Format>('html');
  const [testEmail, setTestEmail] = useState('');
  const [testSentTo, setTestSentTo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sentCount, setSentCount] = useState(0);
  const [issueId, setIssueId] = useState<string | null>(null);
  const [subscriberCount, setSubscriberCount] = useState<number | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  // Fetch subscriber count on mount
  useEffect(() => {
    fetch('/api/mcp-call', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool: 'list_subscribers', arguments: { limit: 1 } }),
    })
      .then(r => r.json())
      .then(data => {
        const result = data.content?.[0]?.text ? JSON.parse(data.content[0].text) : data;
        if (result.count != null) setSubscriberCount(result.count);
      })
      .catch(() => {});
  }, []);

  // Build result for dismiss handlers (pass result if already sent)
  const getDismissResult = (): SendResult | undefined =>
    stage === 'sent' ? { sentCount, issueId, sentAt: new Date().toISOString() } : undefined;

  // Close on click outside (only when not mid-send)
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (stage !== 'sending' && stage !== 'testing' && ref.current && !ref.current.contains(e.target as Node)) onClose(getDismissResult());
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose, stage, sentCount, issueId]);

  // Close on Escape (only when not mid-send)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && stage !== 'sending' && stage !== 'testing') onClose(getDismissResult());
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose, stage, sentCount, issueId]);

  async function callSend(testAddr?: string) {
    setStage(testAddr ? 'testing' : 'sending');
    setError(null);
    try {
      if (onBeforeSend) await onBeforeSend();

      const args: Record<string, string> = { subject, connectionId, format };
      if (testAddr) args.test_email = testAddr;

      const res = await fetch('/api/mcp-call', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tool: 'send_newsletter', arguments: args }),
      });
      const data = await res.json();
      const result = data.content?.[0]?.text ? JSON.parse(data.content[0].text) : data;

      if (result.error) {
        setError(result.error);
        setStage('error');
        return;
      }

      if (result.test) {
        setTestSentTo(result.sent_to);
        setStage('confirm'); // Stay on confirm so they can send for real
        return;
      }

      const count = result.sent || 0;
      const newIssueId = result.issueId || null;
      const sentAt = new Date().toISOString();
      setSentCount(count);
      setIssueId(newIssueId);
      setStage('sent');

      // Save metadata immediately so status persists regardless of how modal is closed
      fetch('/api/metadata', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newsletterContext: { lastSend: { sentCount: count, sentAt, issueId: newIssueId || undefined } } }),
      }).catch(() => {});
    } catch (err: any) {
      setError(err.message);
      setStage('error');
    }
  }

  return (
    <div className="newsletter-modal-overlay">
      <div className="newsletter-modal" ref={ref}>
        <div className="newsletter-modal__header">
          <h3>Send Newsletter</h3>
          <button className="newsletter-modal__close" onClick={() => onClose(getDismissResult())}>&times;</button>
        </div>

        <div className="newsletter-modal__body">
          {stage === 'confirm' && (
            <>
              <p className="newsletter-modal__confirm-text">
                Send "<strong>{subject}</strong>" to {subscriberCount != null ? <>{subscriberCount.toLocaleString()} subscriber{subscriberCount !== 1 ? 's' : ''}</> : <span style={{ visibility: 'hidden' }}>all subscribers</span>}?
              </p>
              <div className="newsletter-modal__format-toggle">
                <button
                  className={`newsletter-modal__format-btn${format === 'html' ? ' active' : ''}`}
                  onClick={() => setFormat('html')}
                >
                  HTML
                </button>
                <button
                  className={`newsletter-modal__format-btn${format === 'plaintext' ? ' active' : ''}`}
                  onClick={() => setFormat('plaintext')}
                >
                  Plaintext
                </button>
              </div>

              <div className="newsletter-modal__test-section">
                <div className="newsletter-modal__test-row">
                  <input
                    type="email"
                    className="newsletter-modal__test-input"
                    placeholder="Test email address"
                    value={testEmail}
                    onChange={(e) => setTestEmail(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter' && testEmail.trim()) callSend(testEmail.trim()); }}
                  />
                  <button
                    className="newsletter-modal__btn newsletter-modal__btn--test"
                    disabled={!testEmail.trim()}
                    onClick={() => callSend(testEmail.trim())}
                  >
                    Send Test
                  </button>
                </div>
                {testSentTo && (
                  <p className="newsletter-modal__test-success">Test sent to {testSentTo}</p>
                )}
              </div>

              <div className="newsletter-modal__actions">
                <button className="newsletter-modal__btn" onClick={onClose}>Cancel</button>
                <button
                  className="newsletter-modal__btn newsletter-modal__btn--primary"
                  onClick={() => callSend()}
                >
                  Send Now
                </button>
              </div>
            </>
          )}

          {(stage === 'sending' || stage === 'testing') && (
            <div className="newsletter-modal__status">
              <div className="newsletter-modal__spinner" />
              <span>{stage === 'testing' ? 'Sending test...' : 'Sending...'}</span>
            </div>
          )}

          {stage === 'sent' && (
            <>
              <div className="newsletter-modal__status newsletter-modal__status--success">
                Sent to {sentCount} subscriber{sentCount !== 1 ? 's' : ''}!
              </div>
              <div className="newsletter-modal__actions">
                <button className="newsletter-modal__btn newsletter-modal__btn--primary" onClick={() => onClose({ sentCount, issueId, sentAt: new Date().toISOString() })}>Done</button>
              </div>
            </>
          )}

          {stage === 'error' && (
            <>
              <div className="newsletter-modal__error">{error}</div>
              <div className="newsletter-modal__actions">
                <button className="newsletter-modal__btn" onClick={onClose}>Cancel</button>
                <button
                  className="newsletter-modal__btn newsletter-modal__btn--primary"
                  onClick={() => callSend()}
                >
                  Retry
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
