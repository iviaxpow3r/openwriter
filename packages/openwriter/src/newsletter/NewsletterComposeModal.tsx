import { useState, useEffect, useRef } from 'react';
import './NewsletterComposeModal.css';

interface NewsletterComposeModalProps {
  connectionId: string;
  subject: string;
  filename: string;
  onClose: () => void;
}

type Stage = 'confirm' | 'sending' | 'sent' | 'error';
type Format = 'html' | 'plaintext';

export default function NewsletterComposeModal({ connectionId, subject, filename, onClose }: NewsletterComposeModalProps) {
  const [stage, setStage] = useState<Stage>('confirm');
  const [format, setFormat] = useState<Format>('html');
  const [error, setError] = useState<string | null>(null);
  const [sentCount, setSentCount] = useState(0);
  const ref = useRef<HTMLDivElement>(null);

  // Close on click outside (only when not mid-send)
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (stage !== 'sending' && ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose, stage]);

  // Close on Escape (only when not mid-send)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && stage !== 'sending') onClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose, stage]);

  async function handleSend() {
    setStage('sending');
    setError(null);
    try {
      // Switch to the document so it becomes active for compose
      await fetch('/api/documents/switch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename }),
      });

      // Step 1: Create draft via compose_newsletter
      const composeRes = await fetch('/api/mcp-call', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tool: 'compose_newsletter',
          arguments: { subject, connectionId, format },
        }),
      });
      const composeData = await composeRes.json();
      if (composeData.error) {
        setError(typeof composeData.error === 'string' ? composeData.error : composeData.content?.[0]?.text || 'Failed to compose');
        setStage('error');
        return;
      }
      const composeResult = composeData.content?.[0]?.text ? JSON.parse(composeData.content[0].text) : composeData;
      if (composeResult.error) {
        setError(composeResult.error);
        setStage('error');
        return;
      }

      // Step 2: Send immediately
      const sendRes = await fetch('/api/mcp-call', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tool: 'send_newsletter',
          arguments: { issue_id: composeResult.issueId, connectionId },
        }),
      });
      const sendData = await sendRes.json();
      const sendResult = sendData.content?.[0]?.text ? JSON.parse(sendData.content[0].text) : sendData;
      if (sendResult.error) {
        setError(sendResult.error);
        setStage('error');
        return;
      }
      setSentCount(sendResult.sent || 0);
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
          {stage === 'confirm' && (
            <>
              <p className="newsletter-modal__confirm-text">
                Send "<strong>{subject}</strong>" to all subscribers?
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
              <div className="newsletter-modal__actions">
                <button className="newsletter-modal__btn" onClick={onClose}>Cancel</button>
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
              <span>Sending...</span>
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

          {stage === 'error' && (
            <>
              <div className="newsletter-modal__error">{error}</div>
              <div className="newsletter-modal__actions">
                <button className="newsletter-modal__btn" onClick={onClose}>Cancel</button>
                <button
                  className="newsletter-modal__btn newsletter-modal__btn--primary"
                  onClick={handleSend}
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
