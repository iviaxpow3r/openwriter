import { useEffect, useRef, useState } from 'react';
import './ManuscriptCreateModal.css';

export interface ManuscriptCreateItem {
  docId: string;
  title: string;
}

interface Props {
  items: ManuscriptCreateItem[];
  workspaceFile?: string;
  suggestedTitle: string;
  onClose: () => void;
  onCreated: (filename: string) => void;
}

function documentCount(count: number): string {
  return `${count} document${count === 1 ? '' : 's'}`;
}

/** A small confirmation step after the sidebar context-menu action. */
export default function ManuscriptCreateModal({ items, workspaceFile, suggestedTitle, onClose, onCreated }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState(suggestedTitle);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const create = async (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = title.trim();
    if (!trimmed || creating) return;

    setCreating(true);
    setError('');
    try {
      const response = await fetch('/api/manuscripts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: trimmed, docIds: items.map((item) => item.docId), workspaceFile }),
      });
      const result = await response.json();
      if (!response.ok || !result.filename) throw new Error(result.error || 'Could not create manuscript.');
      onCreated(result.filename);
      onClose();
    } catch (err: any) {
      setError(err?.message || 'Could not create manuscript.');
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="manuscript-create-overlay" role="presentation" onMouseDown={() => !creating && onClose()}>
      <form
        className="manuscript-create-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="manuscript-create-title"
        aria-describedby="manuscript-create-detail"
        onMouseDown={(event) => event.stopPropagation()}
        onSubmit={create}
      >
        <div className="manuscript-create-modal__header">
          <h2 id="manuscript-create-title">Create manuscript</h2>
          <p id="manuscript-create-detail" className="manuscript-create-modal__detail">
            {documentCount(items.length)} will remain separate and appear in the current sidebar order.
          </p>
        </div>
        <div className="manuscript-create-modal__body">
          <label htmlFor="manuscript-title">Title</label>
          <input
            ref={inputRef}
            id="manuscript-title"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            disabled={creating}
          />
          {error && <p className="manuscript-create-modal__error" role="alert">{error}</p>}
        </div>
        <div className="manuscript-create-modal__actions">
          <button type="button" onClick={onClose} disabled={creating}>Cancel</button>
          <button type="submit" className="primary" disabled={!title.trim() || creating}>
            {creating ? 'Creating…' : 'Create manuscript'}
          </button>
        </div>
      </form>
    </div>
  );
}
