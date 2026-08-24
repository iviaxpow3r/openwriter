import { useCallback, useEffect, useMemo, useState, type DragEvent } from 'react';
import type { DocumentInfo } from '../sidebar/sidebar-types';
import './ManuscriptBuilder.css';

type ManuscriptItem =
  | { kind: 'doc'; docId: string; title: string; filename?: string; unavailable?: boolean }
  | { kind: 'heading'; text: string; level: number }
  | { kind: 'toc' };

interface Props {
  docId?: string | null;
  onOpenDocument: (filename: string) => void;
}

function itemKey(items: ManuscriptItem[]): string {
  return JSON.stringify(items.map((item) => (
    item.kind === 'doc'
      ? { kind: item.kind, docId: item.docId, title: item.title, unavailable: !!item.unavailable }
      : item.kind === 'heading'
        ? { kind: item.kind, text: item.text, level: item.level }
        : item
  )));
}

function moveItem(items: ManuscriptItem[], from: number, insertion: number): ManuscriptItem[] {
  if (from === insertion || from + 1 === insertion) return items;
  const next = [...items];
  const [item] = next.splice(from, 1);
  const target = from < insertion ? insertion - 1 : insertion;
  next.splice(Math.max(0, Math.min(target, next.length)), 0, item);
  return next;
}

function sourceDocuments(documents: DocumentInfo[], currentDocId: string | null | undefined, items: ManuscriptItem[]): DocumentInfo[] {
  const included = new Set(items.filter((item): item is Extract<ManuscriptItem, { kind: 'doc' }> => item.kind === 'doc').map((item) => item.docId));
  return documents.filter((doc) => (
    !!doc.docId
    && doc.docId !== currentDocId
    && doc.contentType !== 'manuscript'
    && !doc.archivedAt
    && !included.has(doc.docId)
  ));
}

export default function ManuscriptBuilder({ docId, onOpenDocument }: Props) {
  const [items, setItems] = useState<ManuscriptItem[]>([]);
  const [savedKey, setSavedKey] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [hasUnsupportedText, setHasUnsupportedText] = useState(false);
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [documents, setDocuments] = useState<DocumentInfo[]>([]);
  const [pickerQuery, setPickerQuery] = useState('');
  const [pickedIds, setPickedIds] = useState<Set<string>>(new Set());

  const currentKey = itemKey(items);
  const dirty = !loading && currentKey !== savedKey;

  useEffect(() => {
    if (!docId) {
      setItems([]);
      setSavedKey('');
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError('');
    setPickerOpen(false);
    fetch(`/api/manuscript/structure?docId=${encodeURIComponent(docId)}`, { cache: 'no-store' })
      .then(async (response) => {
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || 'Could not load manuscript contents.');
        return result;
      })
      .then((result) => {
        if (cancelled) return;
        const next = Array.isArray(result.items) ? result.items as ManuscriptItem[] : [];
        setItems(next);
        setSavedKey(itemKey(next));
        setHasUnsupportedText(result.hasUnsupportedText === true);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message || 'Could not load manuscript contents.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [docId]);

  useEffect(() => {
    if (!pickerOpen) return;
    let cancelled = false;
    fetch('/api/documents', { cache: 'no-store' })
      .then((response) => response.json())
      .then((result) => {
        if (!cancelled && Array.isArray(result)) setDocuments(result as DocumentInfo[]);
      })
      .catch(() => {
        if (!cancelled) setError('Could not load source documents.');
      });
    return () => { cancelled = true; };
  }, [pickerOpen]);

  const save = useCallback(async (): Promise<boolean> => {
    if (!docId || saving || !dirty) return !error;
    setSaving(true);
    setError('');
    try {
      const response = await fetch('/api/manuscript/structure', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ docId, items }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Could not save manuscript contents.');
      const next = Array.isArray(result.items) ? result.items as ManuscriptItem[] : items;
      setItems(next);
      setSavedKey(itemKey(next));
      setHasUnsupportedText(false);
      return true;
    } catch (err: any) {
      setError(err?.message || 'Could not save manuscript contents.');
      return false;
    } finally {
      setSaving(false);
    }
  }, [dirty, docId, error, items, saving]);

  const update = useCallback((next: ManuscriptItem[]) => {
    setItems(next);
    setError('');
  }, []);

  const addHeading = () => update([...items, { kind: 'heading', text: 'Untitled section', level: 2 }]);
  const addToc = () => update([...items, { kind: 'toc' }]);
  const hasToc = items.some((item) => item.kind === 'toc');

  const availableSources = useMemo(
    () => sourceDocuments(documents, docId, items).filter((doc) => doc.title.toLowerCase().includes(pickerQuery.trim().toLowerCase())),
    [docId, documents, items, pickerQuery],
  );

  const openPicker = () => {
    setPickerQuery('');
    setPickedIds(new Set());
    setPickerOpen(true);
  };

  const addPickedDocuments = () => {
    const selected = availableSources.filter((doc) => doc.docId && pickedIds.has(doc.docId));
    if (selected.length === 0) return;
    update([
      ...items,
      ...selected.map((doc) => ({ kind: 'doc' as const, docId: doc.docId!, title: doc.title, filename: doc.filename })),
    ]);
    setPickerOpen(false);
  };

  const updateHeading = (index: number, patch: Partial<Extract<ManuscriptItem, { kind: 'heading' }>>) => {
    update(items.map((item, itemIndex) => itemIndex === index && item.kind === 'heading' ? { ...item, ...patch } : item));
  };

  const removeItem = (index: number) => update(items.filter((_, itemIndex) => itemIndex !== index));
  const nudgeItem = (from: number, offset: number) => update(moveItem(items, from, from + offset));

  const dragStart = (event: DragEvent<HTMLButtonElement>, index: number) => {
    setDraggedIndex(index);
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', String(index));
  };
  const dragOver = (event: DragEvent<HTMLDivElement>, index: number) => {
    event.preventDefault();
    if (draggedIndex === null) return;
    const rect = event.currentTarget.getBoundingClientRect();
    setDropIndex(index + (event.clientY > rect.top + rect.height / 2 ? 1 : 0));
    event.dataTransfer.dropEffect = 'move';
  };
  const drop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    if (draggedIndex !== null && dropIndex !== null) update(moveItem(items, draggedIndex, dropIndex));
    setDraggedIndex(null);
    setDropIndex(null);
  };
  const endDrag = () => {
    setDraggedIndex(null);
    setDropIndex(null);
  };

  const openSource = async (filename: string) => {
    if (dirty && !(await save())) return;
    onOpenDocument(filename);
  };

  if (loading) {
    return <div className="manuscript-builder manuscript-builder--loading">Loading contents…</div>;
  }

  return (
    <section className="manuscript-builder" aria-label="Manuscript contents">
      <div className="manuscript-builder__toolbar">
        <div className="manuscript-builder__status" aria-live="polite">
          <span className="manuscript-builder__title">Contents</span>
          {saving ? 'Saving…' : dirty ? 'Unsaved changes' : 'Saved'}
        </div>
        <div className="manuscript-builder__actions">
          <button type="button" onClick={openPicker}>Add documents</button>
          <button type="button" onClick={addHeading}>Add heading</button>
          <button type="button" onClick={addToc} disabled={hasToc}>Add table of contents</button>
          <button type="button" className="manuscript-builder__save" onClick={() => void save()} disabled={!dirty || saving}>
            Save changes
          </button>
        </div>
      </div>

      {hasUnsupportedText && (
        <p className="manuscript-builder__notice" role="status">
          This manifest contains text that cannot appear in exports. Move that writing into a source document, then save these contents to remove it.
        </p>
      )}
      {error && <p className="manuscript-builder__error" role="alert">{error}</p>}

      {items.length === 0 ? (
        <div className="manuscript-builder__empty">
          <p>Add source documents or headings to outline this manuscript.</p>
          <button type="button" onClick={openPicker}>Add documents</button>
        </div>
      ) : (
        <div className="manuscript-builder__list" onDragOver={(event) => { event.preventDefault(); }} onDrop={drop}>
          {items.map((item, index) => (
            <div
              key={`${item.kind}-${item.kind === 'doc' ? item.docId : item.kind === 'heading' ? `${item.level}-${item.text}` : 'toc'}-${index}`}
              className={`manuscript-builder__row${draggedIndex === index ? ' manuscript-builder__row--dragging' : ''}${dropIndex === index ? ' manuscript-builder__row--drop-before' : ''}${dropIndex === index + 1 ? ' manuscript-builder__row--drop-after' : ''}`}
              onDragOver={(event) => dragOver(event, index)}
              onDrop={drop}
            >
              <button
                type="button"
                className="manuscript-builder__drag-handle"
                draggable
                onDragStart={(event) => dragStart(event, index)}
                onDragEnd={endDrag}
                aria-label={`Move ${item.kind === 'doc' ? item.title : item.kind === 'heading' ? item.text : 'table of contents'}`}
                title="Drag to reorder"
              >
                ⠿
              </button>

              {item.kind === 'doc' ? (
                <div className="manuscript-builder__source">
                  <button
                    type="button"
                    className="manuscript-builder__source-title"
                    disabled={item.unavailable}
                    onClick={() => { if (item.filename) void openSource(item.filename); }}
                    title={item.unavailable ? 'This source is unavailable' : 'Open source document'}
                  >
                    {item.title}
                  </button>
                  <span>{item.unavailable ? 'Unavailable source' : 'Source document'}</span>
                </div>
              ) : item.kind === 'heading' ? (
                <div className="manuscript-builder__heading">
                  <select
                    aria-label="Heading level"
                    value={item.level}
                    onChange={(event) => updateHeading(index, { level: Number(event.target.value) })}
                  >
                    <option value={1}>Heading 1</option>
                    <option value={2}>Heading 2</option>
                    <option value={3}>Heading 3</option>
                    <option value={4}>Heading 4</option>
                    <option value={5}>Heading 5</option>
                    <option value={6}>Heading 6</option>
                  </select>
                  <input
                    aria-label="Heading text"
                    value={item.text}
                    onChange={(event) => updateHeading(index, { text: event.target.value })}
                  />
                </div>
              ) : (
                <div className="manuscript-builder__toc">
                  <span>Table of contents</span>
                  <small>Generated in the compiled manuscript</small>
                </div>
              )}

              <div className="manuscript-builder__row-actions">
                <button type="button" onClick={() => nudgeItem(index, -1)} disabled={index === 0} aria-label="Move up" title="Move up">↑</button>
                <button type="button" onClick={() => nudgeItem(index, 1)} disabled={index === items.length - 1} aria-label="Move down" title="Move down">↓</button>
                <button type="button" onClick={() => removeItem(index)} aria-label="Remove from manuscript">Remove</button>
              </div>
            </div>
          ))}
          {dropIndex === items.length && <div className="manuscript-builder__drop-end" aria-hidden="true" />}
        </div>
      )}

      {pickerOpen && (
        <div className="manuscript-builder__picker-overlay" role="presentation" onMouseDown={() => setPickerOpen(false)}>
          <section className="manuscript-builder__picker" role="dialog" aria-modal="true" aria-labelledby="manuscript-source-picker-title" onMouseDown={(event) => event.stopPropagation()}>
            <div className="manuscript-builder__picker-header">
              <h2 id="manuscript-source-picker-title">Add source documents</h2>
              <input
                autoFocus
                value={pickerQuery}
                onChange={(event) => setPickerQuery(event.target.value)}
                placeholder="Filter documents"
                aria-label="Filter source documents"
              />
            </div>
            <div className="manuscript-builder__picker-list">
              {availableSources.length === 0 ? <p>No eligible documents found.</p> : availableSources.map((doc) => (
                <label key={doc.docId}>
                  <input
                    type="checkbox"
                    checked={!!doc.docId && pickedIds.has(doc.docId)}
                    onChange={() => {
                      if (!doc.docId) return;
                      setPickedIds((previous) => {
                        const next = new Set(previous);
                        if (next.has(doc.docId!)) next.delete(doc.docId!);
                        else next.add(doc.docId!);
                        return next;
                      });
                    }}
                  />
                  <span>{doc.title}</span>
                </label>
              ))}
            </div>
            <div className="manuscript-builder__picker-actions">
              <button type="button" onClick={() => setPickerOpen(false)}>Cancel</button>
              <button type="button" className="manuscript-builder__save" disabled={pickedIds.size === 0} onClick={addPickedDocuments}>
                Add {pickedIds.size || ''} document{pickedIds.size === 1 ? '' : 's'}
              </button>
            </div>
          </section>
        </div>
      )}
    </section>
  );
}
