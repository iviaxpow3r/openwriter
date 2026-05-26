import { useState, useEffect, useRef } from 'react';
import './ConnectionConfigModal.css';

interface ConnectionConfigModalProps {
  connectionId: string;
  provider: string;
  displayName: string;
  onClose: () => void;
  onSaved: () => void;
}

interface ConfigField {
  key: string;
  label: string;
  placeholder: string;
  readonly?: boolean;
  required?: boolean;
}

const PROVIDER_FIELDS: Record<string, ConfigField[]> = {
  x: [],
  linkedin: [],
};

type Stage = 'loading' | 'form' | 'saving' | 'saved' | 'error';

export default function ConnectionConfigModal({ connectionId, provider, displayName, onClose, onSaved }: ConnectionConfigModalProps) {
  const [stage, setStage] = useState<Stage>('loading');
  const [config, setConfig] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  const fields = PROVIDER_FIELDS[provider] || [];

  useEffect(() => {
    fetch(`/api/connections/${connectionId}/config`)
      .then(r => r.json())
      .then(data => {
        setConfig(data.config || {});
        setStage('form');
      })
      .catch(err => {
        setError(err.message);
        setStage('error');
      });
  }, [connectionId]);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (stage !== 'saving' && ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose, stage]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && stage !== 'saving') onClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose, stage]);

  async function handleSave() {
    setStage('saving');
    setError(null);
    try {
      const res = await fetch(`/api/connections/${connectionId}/config`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to save');
      setStage('saved');
      onSaved();
      setTimeout(onClose, 800);
    } catch (err: any) {
      setError(err.message);
      setStage('error');
    }
  }

  function providerLabel(p: string) {
    switch (p) {
      case 'x': return 'X (Twitter)';
      case 'linkedin': return 'LinkedIn';
      default: return p;
    }
  }

  return (
    <div className="conn-config-overlay">
      <div className="conn-config-modal" ref={ref}>
        <div className="conn-config-modal__header">
          <div className="conn-config-modal__title">{providerLabel(provider)} Settings</div>
          <div className="conn-config-modal__subtitle">{displayName}</div>
        </div>

        {stage === 'loading' && (
          <div className="conn-config-modal__body conn-config-modal__center">
            <div className="conn-config-spinner" />
            <span>Loading configuration...</span>
          </div>
        )}

        {(stage === 'form' || stage === 'error') && fields.length > 0 && (
          <div className="conn-config-modal__body">
            {fields.map(f => (
              <div key={f.key} className="conn-config-field">
                <label className="conn-config-field__label">
                  {f.label}
                  {f.readonly && <span className="conn-config-field__badge">read-only</span>}
                </label>
                <input
                  className="conn-config-field__input"
                  value={config[f.key] || ''}
                  placeholder={f.placeholder}
                  readOnly={f.readonly}
                  onChange={e => setConfig(prev => ({ ...prev, [f.key]: e.target.value }))}
                />
              </div>
            ))}
            {error && <div className="conn-config-modal__error">{error}</div>}
          </div>
        )}

        {(stage === 'form' || stage === 'error') && fields.length === 0 && (
          <div className="conn-config-modal__body conn-config-modal__center">
            <span className="conn-config-modal__empty">No configuration needed for {providerLabel(provider)}.</span>
          </div>
        )}

        {stage === 'saving' && (
          <div className="conn-config-modal__body conn-config-modal__center">
            <div className="conn-config-spinner" />
            <span>Saving...</span>
          </div>
        )}

        {stage === 'saved' && (
          <div className="conn-config-modal__body conn-config-modal__center">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#22c55e" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="20 6 9 17 4 12" />
            </svg>
            <span>Saved</span>
          </div>
        )}

        <div className="conn-config-modal__footer">
          <button className="conn-config-btn conn-config-btn--secondary" onClick={onClose}>
            {stage === 'saved' ? 'Close' : 'Cancel'}
          </button>
          {fields.length > 0 && (stage === 'form' || stage === 'error') && (
            <button className="conn-config-btn conn-config-btn--primary" onClick={handleSave}>
              Save
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
