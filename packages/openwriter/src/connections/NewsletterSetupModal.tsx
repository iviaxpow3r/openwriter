import { useState, useEffect, useRef } from 'react';
import '../newsletter/NewsletterComposeModal.css';

interface Connection {
  id: string;
  provider: string;
  display_name?: string;
  status: string;
  domain?: string;
  from_name?: string;
}

interface NewsletterSetupModalProps {
  existingConnection?: Connection | null;
  onClose: () => void;
  onSaved: () => void;
}

type Stage = 'form' | 'submitting' | 'verifying' | 'done' | 'error';

interface VerifyStatus {
  dns_verified: boolean;
  sender_verified: boolean;
}

export default function NewsletterSetupModal({ existingConnection, onClose, onSaved }: NewsletterSetupModalProps) {
  const [stage, setStage] = useState<Stage>('form');
  const [error, setError] = useState<string | null>(null);
  const [domain, setDomain] = useState(existingConnection?.domain || '');
  const [fromEmail, setFromEmail] = useState('');
  const [fromName, setFromName] = useState(existingConnection?.from_name || '');
  const [physicalAddress, setPhysicalAddress] = useState('');
  const [connectionId, setConnectionId] = useState(existingConnection?.id || '');
  const [verifyStatus, setVerifyStatus] = useState<VerifyStatus>({ dns_verified: false, sender_verified: false });
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (stage !== 'submitting' && stage !== 'verifying' && ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose, stage]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && stage !== 'submitting' && stage !== 'verifying') onClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose, stage]);

  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current); }, []);

  async function handleSubmit() {
    setStage('submitting');
    setError(null);
    try {
      const res = await fetch('/api/mcp-call', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tool: 'setup_custom_domain',
          arguments: {
            domain,
            from_email: fromEmail,
            from_name: fromName || undefined,
            physical_address: physicalAddress,
          },
        }),
      });
      const data = await res.json();
      const result = data.content?.[0]?.text ? JSON.parse(data.content[0].text) : data;
      if (result.error) {
        setError(result.error);
        setStage('error');
        return;
      }
      const connId = result.connectionId || result.connection_id || connectionId;
      if (connId) setConnectionId(connId);
      startPolling(connId);
    } catch (err: any) {
      setError(err.message);
      setStage('error');
    }
  }

  async function handleUpdate() {
    setStage('submitting');
    setError(null);
    try {
      const res = await fetch('/api/mcp-call', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tool: 'setup_custom_domain',
          arguments: {
            domain,
            from_email: fromEmail || undefined,
            from_name: fromName || undefined,
            physical_address: physicalAddress || undefined,
          },
        }),
      });
      const data = await res.json();
      const result = data.content?.[0]?.text ? JSON.parse(data.content[0].text) : data;
      if (result.error) {
        setError(result.error);
        setStage('error');
        return;
      }
      setStage('done');
    } catch (err: any) {
      setError(err.message);
      setStage('error');
    }
  }

  function startPolling(connId: string) {
    setStage('verifying');
    pollRef.current = setInterval(async () => {
      try {
        const res = await fetch('/api/mcp-call', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            tool: 'check_domain_status',
            arguments: { connectionId: connId },
          }),
        });
        const data = await res.json();
        const result = data.content?.[0]?.text ? JSON.parse(data.content[0].text) : data;
        const dns = !!result.dns_verified;
        const sender = !!result.sender_verified;
        setVerifyStatus({ dns_verified: dns, sender_verified: sender });
        if (dns && sender) {
          if (pollRef.current) clearInterval(pollRef.current);
          pollRef.current = null;
          setStage('done');
        }
      } catch {
        // keep polling
      }
    }, 5000);
  }

  function handleResendVerification() {
    if (!connectionId) return;
    fetch('/api/mcp-call', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tool: 'resend_domain_verification',
        arguments: { connectionId },
      }),
    }).catch(() => {});
  }

  const isEdit = !!existingConnection;
  const canSubmit = domain.trim() && fromEmail.trim() && physicalAddress.trim();

  return (
    <div className="newsletter-modal-overlay">
      <div className="newsletter-modal newsletter-modal--setup" ref={ref}>
        <div className="newsletter-modal__header">
          <h3>{isEdit ? 'Newsletter Settings' : 'Set Up Newsletter'}</h3>
          <button className="newsletter-modal__close" onClick={onClose}>&times;</button>
        </div>

        <div className="newsletter-modal__body">
          {stage === 'form' && (
            <>
              <div className="newsletter-modal__field">
                <label className="newsletter-modal__label">Domain</label>
                <input
                  className="newsletter-modal__input"
                  type="text"
                  placeholder="yourdomain.com"
                  value={domain}
                  onChange={e => setDomain(e.target.value)}
                  disabled={isEdit}
                  autoComplete="off"
                />
              </div>
              <div className="newsletter-modal__field">
                <label className="newsletter-modal__label">From Email</label>
                <input
                  className="newsletter-modal__input"
                  type="email"
                  placeholder="newsletter@yourdomain.com"
                  value={fromEmail}
                  onChange={e => setFromEmail(e.target.value)}
                  autoComplete="off"
                />
              </div>
              <div className="newsletter-modal__field">
                <label className="newsletter-modal__label">From Name <span className="newsletter-modal__optional">(optional)</span></label>
                <input
                  className="newsletter-modal__input"
                  type="text"
                  placeholder="Your Name or Brand"
                  value={fromName}
                  onChange={e => setFromName(e.target.value)}
                  autoComplete="off"
                />
              </div>
              <div className="newsletter-modal__field">
                <label className="newsletter-modal__label">Physical Address <span className="newsletter-modal__required">*</span></label>
                <textarea
                  className="newsletter-modal__input newsletter-modal__textarea"
                  rows={2}
                  placeholder="123 Main St, City, State 12345"
                  value={physicalAddress}
                  onChange={e => setPhysicalAddress(e.target.value)}
                />
                <span className="newsletter-modal__hint">Required by CAN-SPAM. Included in email footer.</span>
              </div>
              <div className="newsletter-modal__actions">
                <button className="newsletter-modal__btn" onClick={onClose}>Cancel</button>
                <button
                  className="newsletter-modal__btn newsletter-modal__btn--primary"
                  onClick={isEdit ? handleUpdate : handleSubmit}
                  disabled={!canSubmit}
                >
                  {isEdit ? 'Save' : 'Set Up Domain'}
                </button>
              </div>
            </>
          )}

          {stage === 'submitting' && (
            <div className="newsletter-modal__status">
              <div className="newsletter-modal__spinner" />
              <span>{isEdit ? 'Saving...' : 'Setting up domain...'}</span>
            </div>
          )}

          {stage === 'verifying' && (
            <>
              <div className="newsletter-modal__verify">
                <p className="newsletter-modal__verify-title">Verifying domain setup...</p>
                <div className="newsletter-modal__verify-checks">
                  <div className={`newsletter-modal__verify-item${verifyStatus.dns_verified ? ' newsletter-modal__verify-item--done' : ''}`}>
                    {verifyStatus.dns_verified ? '\u2713' : <span className="newsletter-modal__spinner newsletter-modal__spinner--sm" />}
                    <span>DNS records</span>
                  </div>
                  <div className={`newsletter-modal__verify-item${verifyStatus.sender_verified ? ' newsletter-modal__verify-item--done' : ''}`}>
                    {verifyStatus.sender_verified ? '\u2713' : <span className="newsletter-modal__spinner newsletter-modal__spinner--sm" />}
                    <span>Sender verification</span>
                  </div>
                </div>
                <p className="newsletter-modal__hint">This may take a few minutes. You can close and check back later.</p>
              </div>
              <div className="newsletter-modal__actions">
                <button className="newsletter-modal__btn" onClick={handleResendVerification}>Resend Verification</button>
                <button className="newsletter-modal__btn newsletter-modal__btn--primary" onClick={() => { onSaved(); onClose(); }}>Close</button>
              </div>
            </>
          )}

          {stage === 'done' && (
            <>
              <div className="newsletter-modal__status newsletter-modal__status--success">
                {isEdit ? 'Settings saved!' : 'Newsletter domain configured!'}
              </div>
              <div className="newsletter-modal__actions">
                <button className="newsletter-modal__btn newsletter-modal__btn--primary" onClick={() => { onSaved(); onClose(); }}>Done</button>
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
                  onClick={() => setStage('form')}
                >
                  Try Again
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
