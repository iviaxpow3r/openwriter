import { useState, useEffect, useRef } from 'react';
import './NewsletterComposeModal.css';

interface NewsletterComposeModalProps {
  connectionId: string;
  documentTitle: string;
  filename: string;
  onClose: () => void;
}

type Stage = 'compose' | 'drafting' | 'drafted' | 'sending' | 'sent' | 'error';

export default function NewsletterComposeModal({ connectionId, documentTitle, filename, onClose }: NewsletterComposeModalProps) {
  const [subject, setSubject] = useState(documentTitle);
  const [connectionName, setConnectionName] = useState('');
  const [subscriberCount, setSubscriberCount] = useState<number | null>(null);
  const [stage, setStage] = useState<Stage>('compose');
  const [issueId, setIssueId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sentCount, setSentCount] = useState(0);
  const ref = useRef<HTMLDivElement>(null);

  // Fetch connection info
  useEffect(() => {
    fetch(`/api/connections/${connectionId}/test`, { method: 'POST' })
      .then(r => r.json())
      .then(data => {
        if (data.ok) setSubscriberCount(data.subscriberCount);
      })
      .catch(() => {});

    fetch('/api/connections')
      .then(r => r.json())
      .then(data => {
        const conn = (data.connections || []).find((c: any) => c.id === connectionId);
        if (conn) setConnectionName(conn.name);
      })
      .catch(() => {});
  }, [connectionId]);

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

  async function handleCreateDraft() {
    setStage('drafting');
    setError(null);
    try {
      // First switch to the document so it becomes the active doc for compose
      await fetch('/api/documents/switch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename }),
      });

      // Call MCP compose tool via HTTP proxy
      const res = await fetch('/api/mcp-call', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tool: 'compose_newsletter',
          arguments: { subject, connectionId },
        }),
      });
      const data = await res.json();
      if (data.error) {
        setError(typeof data.error === 'string' ? data.error : data.content?.[0]?.text || 'Failed to create draft');
        setStage('error');
        return;
      }
      // MCP tools return { content: [{ type: 'text', text: JSON }] }
      const result = data.content?.[0]?.text ? JSON.parse(data.content[0].text) : data;
      if (result.error) {
        setError(result.error);
        setStage('error');
        return;
      }
      setIssueId(result.issueId);
      if (result.subscriberCount !== undefined) setSubscriberCount(result.subscriberCount);
      setStage('drafted');
    } catch (err: any) {
      setError(err.message);
      setStage('error');
    }
  }

  async function handleSend() {
    if (!issueId) return;
    setStage('sending');
    setError(null);
    try {
      const res = await fetch('/api/mcp-call', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tool: 'send_newsletter',
          arguments: { issue_id: issueId, connectionId },
        }),
      });
      const data = await res.json();
      const result = data.content?.[0]?.text ? JSON.parse(data.content[0].text) : data;
      if (result.error) {
        setError(result.error);
        setStage('error');
        return;
      }
      setSentCount(result.sent || 0);
      setStage('sent');
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
          <button className="newsletter-modal__close" onClick={onClose}>&times;</button>
        </div>

        <div className="newsletter-modal__body">
          {connectionName && (
            <div className="newsletter-modal__info">
              <span className="newsletter-modal__conn-name">{connectionName}</span>
              {subscriberCount !== null && (
                <span className="newsletter-modal__sub-count">{subscriberCount} subscriber{subscriberCount !== 1 ? 's' : ''}</span>
              )}
            </div>
          )}

          {(stage === 'compose' || stage === 'error') && (
            <>
              <div className="newsletter-modal__field">
                <label>Subject</label>
                <input
                  value={subject}
                  onChange={e => setSubject(e.target.value)}
                  placeholder="Newsletter subject..."
                  autoFocus
                />
              </div>
              {error && <div className="newsletter-modal__error">{error}</div>}
              <div className="newsletter-modal__actions">
                <button className="newsletter-modal__btn" onClick={onClose}>Cancel</button>
                <button
                  className="newsletter-modal__btn newsletter-modal__btn--primary"
                  onClick={handleCreateDraft}
                  disabled={!subject.trim()}
                >
                  Create Draft
                </button>
              </div>
            </>
          )}

          {stage === 'drafting' && (
            <div className="newsletter-modal__status">
              <div className="newsletter-modal__spinner" />
              <span>Creating draft...</span>
            </div>
          )}

          {stage === 'drafted' && (
            <>
              <div className="newsletter-modal__status newsletter-modal__status--success">
                Draft created: "{subject}"
              </div>
              <div className="newsletter-modal__actions">
                <button className="newsletter-modal__btn" onClick={onClose}>Close</button>
                <button
                  className="newsletter-modal__btn newsletter-modal__btn--primary"
                  onClick={handleSend}
                >
                  Send Now
                </button>
              </div>
            </>
          )}

          {stage === 'sending' && (
            <div className="newsletter-modal__status">
              <div className="newsletter-modal__spinner" />
              <span>Sending to {subscriberCount || '?'} subscribers...</span>
            </div>
          )}

          {stage === 'sent' && (
            <>
              <div className="newsletter-modal__status newsletter-modal__status--success">
                Sent to {sentCount} subscriber{sentCount !== 1 ? 's' : ''}!
              </div>
              <div className="newsletter-modal__actions">
                <button className="newsletter-modal__btn newsletter-modal__btn--primary" onClick={onClose}>Done</button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
