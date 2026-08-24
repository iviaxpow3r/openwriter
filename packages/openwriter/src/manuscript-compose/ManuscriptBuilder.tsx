import { useCallback, useEffect, useMemo, useState, type DragEvent } from 'react';
import type { DocumentInfo, WorkspaceNode } from '../sidebar/sidebar-types';
import './ManuscriptBuilder.css';

type ManuscriptItem =
  | { kind: 'doc'; docId: string; title: string; filename?: string; unavailable?: boolean }
  | { kind: 'heading'; text: string; level: number }
  | { kind: 'toc' };

type BuilderItem = ManuscriptItem & { uiId: string };
type PickerWorkspace = { filename: string; title: string; root: WorkspaceNode[] };
type PickerEntry = { doc: DocumentInfo; workspace?: string; location?: string };

interface Props { docId?: string | null; onOpenDocument: (filename: string) => void; }

let nextUiId = 0;
function toBuilderItem(item: ManuscriptItem): BuilderItem { return { ...item, uiId: `manuscript-item-${nextUiId++}` } as BuilderItem; }
function toStructureItem({ uiId: _uiId, ...item }: BuilderItem): ManuscriptItem { return item; }

function itemKey(items: BuilderItem[]): string {
  return JSON.stringify(items.map(toStructureItem).map((item) => (
    item.kind === 'doc' ? { kind: item.kind, docId: item.docId, title: item.title, unavailable: !!item.unavailable }
      : item.kind === 'heading' ? { kind: item.kind, text: item.text, level: item.level } : item
  )));
}

function moveItem(items: BuilderItem[], from: number, insertion: number): BuilderItem[] {
  if (from === insertion || from + 1 === insertion) return items;
  const next = [...items];
  const [item] = next.splice(from, 1);
  const target = from < insertion ? insertion - 1 : insertion;
  next.splice(Math.max(0, Math.min(target, next.length)), 0, item);
  return next;
}

function sourceDocuments(documents: DocumentInfo[], currentDocId: string | null | undefined, items: BuilderItem[]): DocumentInfo[] {
  const included = new Set(items.filter((item): item is Extract<BuilderItem, { kind: 'doc' }> => item.kind === 'doc').map((item) => item.docId));
  return documents.filter((doc) => !!doc.docId && doc.docId !== currentDocId && doc.contentType !== 'manuscript' && !doc.archivedAt && !included.has(doc.docId));
}

function pickerEntriesFor(documents: DocumentInfo[], workspaces: PickerWorkspace[]): PickerEntry[] {
  const byFilename = new Map(documents.map((doc) => [doc.filename, doc]));
  const seen = new Set<string>();
  const entries: PickerEntry[] = [];
  const addNodes = (nodes: WorkspaceNode[], workspace: string, path: string[]) => {
    for (const node of nodes) {
      if (node.type === 'container') { addNodes(node.items || [], workspace, [...path, node.name || 'Untitled folder']); continue; }
      const doc = node.file ? byFilename.get(node.file) : undefined;
      if (doc?.docId && !seen.has(doc.docId)) { seen.add(doc.docId); entries.push({ doc, workspace, location: path.join(' / ') }); }
      for (const child of node.children || []) addNodes(child.items || [], workspace, [...path, node.title || doc?.title || 'Document', child.name]);
    }
  };
  for (const workspace of workspaces) addNodes(workspace.root || [], workspace.title, []);
  for (const doc of documents) if (doc.docId && !seen.has(doc.docId)) { seen.add(doc.docId); entries.push({ doc }); }
  return entries;
}

function groupedEntries(entries: PickerEntry[]): Array<{ label: string; entries: PickerEntry[] }> {
  const groups = new Map<string, PickerEntry[]>();
  for (const entry of entries) { const label = entry.workspace || 'Unassigned documents'; const group = groups.get(label) || []; group.push(entry); groups.set(label, group); }
  return [...groups.entries()].map(([label, group]) => ({ label, entries: group }));
}

export default function ManuscriptBuilder({ docId, onOpenDocument }: Props) {
  const [items, setItems] = useState<BuilderItem[]>([]);
  const [savedKey, setSavedKey] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [legacyText, setLegacyText] = useState('');
  const [legacyPanelOpen, setLegacyPanelOpen] = useState(false);
  const [confirmLegacyRemoval, setConfirmLegacyRemoval] = useState(false);
  const [legacyCopyStatus, setLegacyCopyStatus] = useState('');
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [insertAt, setInsertAt] = useState(0);
  const [documents, setDocuments] = useState<DocumentInfo[]>([]);
  const [pickerWorkspaces, setPickerWorkspaces] = useState<PickerWorkspace[]>([]);
  const [pickerQuery, setPickerQuery] = useState('');
  const [pickedIds, setPickedIds] = useState<Set<string>>(new Set());
  const [focusHeadingId, setFocusHeadingId] = useState<string | null>(null);
  const [pendingOpenFilename, setPendingOpenFilename] = useState<string | null>(null);

  const currentKey = itemKey(items);
  const dirty = !loading && currentKey !== savedKey;
  const hasLegacyWriting = legacyText.length > 0;

  useEffect(() => {
    if (!docId) { setItems([]); setSavedKey(''); setLegacyText(''); setLoading(false); return; }
    let cancelled = false;
    setLoading(true); setError(''); setPickerOpen(false); setPendingOpenFilename(null); setLegacyPanelOpen(false); setConfirmLegacyRemoval(false); setLegacyCopyStatus('');
    fetch(`/api/manuscript/structure?docId=${encodeURIComponent(docId)}`, { cache: 'no-store' })
      .then(async (response) => { const result = await response.json(); if (!response.ok) throw new Error(result.error || 'Could not load manuscript contents.'); return result; })
      .then((result) => {
        if (cancelled) return;
        const next = (Array.isArray(result.items) ? result.items : []).map((item: ManuscriptItem) => toBuilderItem(item));
        setItems(next); setSavedKey(itemKey(next)); setLegacyText(typeof result.legacyText === 'string' ? result.legacyText : '');
      })
      .catch((err: Error) => { if (!cancelled) setError(err.message || 'Could not load manuscript contents.'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [docId]);

  useEffect(() => {
    if (!pickerOpen) return;
    let cancelled = false;
    const load = async () => {
      try {
        const docsResponse = await fetch('/api/documents', { cache: 'no-store' });
        const docs = await docsResponse.json();
        if (!docsResponse.ok || !Array.isArray(docs)) throw new Error('Could not load source documents.');
        const workspaceResponse = await fetch('/api/workspaces', { cache: 'no-store' });
        const summaries = await workspaceResponse.json();
        const workspaceDetails = workspaceResponse.ok && Array.isArray(summaries) ? await Promise.all(summaries.map(async (workspace: { filename: string; title: string }) => {
          const response = await fetch(`/api/workspaces/${encodeURIComponent(workspace.filename)}`, { cache: 'no-store' });
          if (!response.ok) return null;
          const detail = await response.json();
          return { filename: workspace.filename, title: detail.title || workspace.title, root: detail.root || [] } as PickerWorkspace;
        })) : [];
        if (cancelled) return;
        setDocuments(docs as DocumentInfo[]);
        setPickerWorkspaces(workspaceDetails.filter((workspace): workspace is PickerWorkspace => !!workspace));
      } catch (err: any) { if (!cancelled) setError(err?.message || 'Could not load source documents.'); }
    };
    void load();
    return () => { cancelled = true; };
  }, [pickerOpen]);

  const save = useCallback(async ({ removeLegacyWriting = false }: { removeLegacyWriting?: boolean } = {}): Promise<boolean> => {
    if (!docId || saving) return false;
    if (hasLegacyWriting && !removeLegacyWriting) {
      setLegacyPanelOpen(true);
      setError('Move or remove the text outside Contents before saving.');
      return false;
    }
    if (!dirty && !hasLegacyWriting) return true;
    setSaving(true); setError('');
    try {
      const response = await fetch('/api/manuscript/structure', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ docId, items: items.map(toStructureItem) }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Could not save manuscript contents.');
      const next = (Array.isArray(result.items) ? result.items : items).map((item: ManuscriptItem) => toBuilderItem(item));
      setItems(next); setSavedKey(itemKey(next)); setLegacyText(''); setLegacyPanelOpen(false); setConfirmLegacyRemoval(false); setLegacyCopyStatus('');
      return true;
    } catch (err: any) { setError(err?.message || 'Could not save manuscript contents.'); return false; }
    finally { setSaving(false); }
  }, [dirty, docId, hasLegacyWriting, items, saving]);

  useEffect(() => {
    const saveBeforeOutput = (event: Event) => { const detail = (event as CustomEvent<{ onSaved?: () => void }>).detail; void save().then((saved) => { if (saved) detail?.onSaved?.(); }); };
    window.addEventListener('ow-manuscript-save-before-output', saveBeforeOutput);
    return () => window.removeEventListener('ow-manuscript-save-before-output', saveBeforeOutput);
  }, [save]);

  useEffect(() => {
    if (!focusHeadingId) return;
    const input = document.querySelector<HTMLInputElement>(`[data-manuscript-heading-id="${focusHeadingId}"]`);
    input?.focus(); input?.select(); setFocusHeadingId(null);
  }, [focusHeadingId, items]);

  useEffect(() => {
    if (!pickerOpen) return;
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); setPickerOpen(false); } };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [pickerOpen]);

  const update = useCallback((next: BuilderItem[]) => { setItems(next); setError(''); }, []);
  const addHeading = (at = items.length) => { const next = toBuilderItem({ kind: 'heading', text: 'Untitled section', level: 2 }); update([...items.slice(0, at), next, ...items.slice(at)]); setFocusHeadingId(next.uiId); };
  const addToc = (at = items.length) => update([...items.slice(0, at), toBuilderItem({ kind: 'toc' }), ...items.slice(at)]);
  const hasToc = items.some((item) => item.kind === 'toc');

  const eligibleSources = useMemo(() => sourceDocuments(documents, docId, items), [docId, documents, items]);
  const allPickerEntries = useMemo(() => pickerEntriesFor(eligibleSources, pickerWorkspaces), [eligibleSources, pickerWorkspaces]);
  const pickerEntries = useMemo(() => {
    const query = pickerQuery.trim().toLowerCase();
    return query ? allPickerEntries.filter(({ doc, workspace, location }) => [doc.title, workspace, location].filter(Boolean).join(' ').toLowerCase().includes(query)) : allPickerEntries;
  }, [allPickerEntries, pickerQuery]);
  const pickerGroups = useMemo(() => groupedEntries(pickerEntries), [pickerEntries]);
  const openPicker = (at = items.length) => { setInsertAt(at); setPickerQuery(''); setPickedIds(new Set()); setPickerOpen(true); };
  const addPickedDocuments = () => {
    const chosen = allPickerEntries.filter(({ doc }) => !!doc.docId && pickedIds.has(doc.docId));
    if (chosen.length === 0) return;
    const inserted = chosen.map(({ doc }) => toBuilderItem({ kind: 'doc', docId: doc.docId!, title: doc.title, filename: doc.filename }));
    update([...items.slice(0, insertAt), ...inserted, ...items.slice(insertAt)]); setPickerOpen(false);
  };
  const updateHeading = (index: number, patch: Partial<Extract<BuilderItem, { kind: 'heading' }>>) => update(items.map((item, itemIndex) => itemIndex === index && item.kind === 'heading' ? { ...item, ...patch } : item));
  const removeItem = (index: number) => update(items.filter((_, itemIndex) => itemIndex !== index));
  const nudgeItem = (from: number, offset: number) => update(moveItem(items, from, from + offset));
  const dragStart = (event: DragEvent<HTMLButtonElement>, index: number) => { setDraggedIndex(index); event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', String(index)); };
  const dragOver = (event: DragEvent<HTMLDivElement>, index: number) => { event.preventDefault(); if (draggedIndex === null) return; const rect = event.currentTarget.getBoundingClientRect(); setDropIndex(index + (event.clientY > rect.top + rect.height / 2 ? 1 : 0)); event.dataTransfer.dropEffect = 'move'; };
  const drop = (event: DragEvent<HTMLDivElement>) => { event.preventDefault(); if (draggedIndex !== null && dropIndex !== null) update(moveItem(items, draggedIndex, dropIndex)); setDraggedIndex(null); setDropIndex(null); };
  const endDrag = () => { setDraggedIndex(null); setDropIndex(null); };
  const requestOpenSource = (filename: string) => { if (dirty) setPendingOpenFilename(filename); else onOpenDocument(filename); };
  const openAfterSave = async () => { if (!pendingOpenFilename) return; if (await save()) { onOpenDocument(pendingOpenFilename); setPendingOpenFilename(null); } };
  const requestSave = () => {
    if (hasLegacyWriting) { setLegacyPanelOpen(true); setConfirmLegacyRemoval(false); return; }
    void save();
  };
  const copyLegacyWriting = async () => {
    try {
      if (!navigator.clipboard) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(legacyText);
      setLegacyCopyStatus('Copied');
    } catch {
      setLegacyCopyStatus('Select the text and copy it manually.');
    }
  };
  const addControls = (at: number, variant: 'append' | 'inline' = 'append') => (
    <div className={`manuscript-builder__add-actions manuscript-builder__add-actions--${variant}`} role="group" aria-label={variant === 'inline' ? 'Insert into manuscript' : 'Add to manuscript'}>
      <button type="button" className="manuscript-builder__add-button" onClick={() => openPicker(at)}>Add documents</button>
      <button type="button" className="manuscript-builder__add-button" onClick={() => addHeading(at)}>Add heading</button>
      {!hasToc && <button type="button" className="manuscript-builder__add-button" onClick={() => addToc(at)}>Add table of contents</button>}
    </div>
  );

  if (loading) return <div className="manuscript-builder manuscript-builder--loading">Loading contents…</div>;
  return (
    <section className="manuscript-builder" aria-label="Manuscript contents">
      <div className="manuscript-builder__toolbar">
        <span className="manuscript-builder__title">Contents</span>
        <button type="button" className="manuscript-builder__button manuscript-builder__button--save" onClick={requestSave} disabled={(!dirty && !hasLegacyWriting) || saving}>{saving ? 'Saving changes…' : 'Save changes'}</button>
      </div>
      {hasLegacyWriting && <section className="manuscript-builder__notice manuscript-builder__legacy" aria-labelledby="manuscript-legacy-title"><div className="manuscript-builder__legacy-summary"><div><strong id="manuscript-legacy-title">Text outside Contents</strong><p>This text is not included in Preview or exports. Copy it into a source document, then remove it here.</p></div><button type="button" className="manuscript-builder__button" aria-expanded={legacyPanelOpen} onClick={() => { setLegacyPanelOpen((open) => !open); setConfirmLegacyRemoval(false); }}>{legacyPanelOpen ? 'Hide text' : 'Show text'}</button></div>{legacyPanelOpen && <div className="manuscript-builder__legacy-panel"><label>Text to move<textarea readOnly value={legacyText} /></label><p>Copy this text, then open a source document from the list below to place it where it belongs.</p><div className="manuscript-builder__legacy-actions"><button type="button" className="manuscript-builder__button" onClick={() => void copyLegacyWriting()}>Copy text</button>{legacyCopyStatus && <span aria-live="polite">{legacyCopyStatus}</span>}{confirmLegacyRemoval ? <><span>Remove this text from the manuscript?</span><button type="button" className="manuscript-builder__button" onClick={() => setConfirmLegacyRemoval(false)}>Cancel</button><button type="button" className="manuscript-builder__button manuscript-builder__button--danger" onClick={() => void save({ removeLegacyWriting: true })} disabled={saving}>Remove text</button></> : <button type="button" className="manuscript-builder__button manuscript-builder__button--danger" onClick={() => setConfirmLegacyRemoval(true)}>Remove text</button>}</div></div>}</section>}
      {error && <p className="manuscript-builder__error" role="alert">{error}</p>}
      {items.length === 0 ? <div className="manuscript-builder__empty"><p>Choose source documents to set what appears in this manuscript. Edit prose in the source document.</p>{addControls(0)}</div> : (
        <div className="manuscript-builder__list" onDragOver={(event) => event.preventDefault()} onDrop={drop}>
          {items.map((item, index) => <div className="manuscript-builder__outline-item" key={item.uiId}>
            <div className={`manuscript-builder__row${draggedIndex === index ? ' manuscript-builder__row--dragging' : ''}${dropIndex === index ? ' manuscript-builder__row--drop-before' : ''}${dropIndex === index + 1 ? ' manuscript-builder__row--drop-after' : ''}`} onDragOver={(event) => dragOver(event, index)} onDrop={drop}>
              <button type="button" className="manuscript-builder__drag-handle" draggable onDragStart={(event) => dragStart(event, index)} onDragEnd={endDrag} aria-label={`Drag ${item.kind === 'doc' ? item.title : item.kind === 'heading' ? item.text : 'table of contents'} to reorder`} title="Drag to reorder">⠿</button><span className="manuscript-builder__position" aria-hidden="true">{index + 1}</span>
              {item.kind === 'doc' ? <div className="manuscript-builder__source"><span className="manuscript-builder__kind-icon" aria-hidden="true">▧</span><button type="button" className="manuscript-builder__source-title" disabled={item.unavailable} onClick={() => { if (item.filename) requestOpenSource(item.filename); }} title={item.unavailable ? 'This source is unavailable' : 'Open source document'}>{item.title}</button>{item.unavailable && <span className="manuscript-builder__unavailable">Unavailable</span>}</div>
                : item.kind === 'heading' ? <div className="manuscript-builder__heading"><select aria-label="Heading level" value={item.level} onChange={(event) => updateHeading(index, { level: Number(event.target.value) })}>{[1, 2, 3, 4, 5, 6].map((level) => <option key={level} value={level}>H{level}</option>)}</select><input data-manuscript-heading-id={item.uiId} aria-label="Heading text" value={item.text} onChange={(event) => updateHeading(index, { text: event.target.value })} /></div>
                  : <div className="manuscript-builder__toc"><span className="manuscript-builder__kind-icon" aria-hidden="true">☷</span><span>Table of contents</span></div>}
              <div className="manuscript-builder__row-actions"><button type="button" onClick={() => nudgeItem(index, -1)} disabled={index === 0} aria-label="Move earlier" title="Move earlier">↑</button><button type="button" onClick={() => nudgeItem(index, 1)} disabled={index === items.length - 1} aria-label="Move later" title="Move later">↓</button><button type="button" onClick={() => removeItem(index)} aria-label="Remove from manuscript" title="Remove from manuscript">×</button></div>
            </div>
            <div className="manuscript-builder__insert-row">{addControls(index + 1, 'inline')}</div>
          </div>)}
          {dropIndex === items.length && <div className="manuscript-builder__drop-end" aria-hidden="true" />}
          <div className="manuscript-builder__append-row">{addControls(items.length)}</div>
        </div>
      )}
      {pickerOpen && <div className="manuscript-builder__picker-overlay" role="presentation"><div className="manuscript-builder__picker" role="dialog" aria-modal="true" aria-labelledby="manuscript-source-picker-title"><div className="manuscript-builder__picker-header"><div><h2 id="manuscript-source-picker-title">Add documents</h2><p>{pickedIds.size ? `${pickedIds.size} selected` : 'Choose one or more source documents.'}</p></div><label className="manuscript-builder__search-label"><span>Search documents</span><input autoFocus value={pickerQuery} onChange={(event) => setPickerQuery(event.target.value)} placeholder="Search titles and folders" /></label></div><div className="manuscript-builder__picker-list">{pickerGroups.length === 0 ? <p>No eligible documents found.</p> : pickerGroups.map((group) => <section className="manuscript-builder__picker-group" key={group.label}><h3>{group.label}</h3>{group.entries.map(({ doc, location }) => <label key={doc.docId} className="manuscript-builder__picker-option"><input type="checkbox" checked={!!doc.docId && pickedIds.has(doc.docId)} onChange={() => { if (!doc.docId) return; setPickedIds((previous) => { const next = new Set(previous); next.has(doc.docId!) ? next.delete(doc.docId!) : next.add(doc.docId!); return next; }); }} /><span className="manuscript-builder__picker-option-copy"><strong>{doc.title}</strong>{location && <small>{location}</small>}</span></label>)}</section>)}</div><div className="manuscript-builder__picker-actions"><button type="button" className="manuscript-builder__button" onClick={() => setPickerOpen(false)}>Cancel</button><button type="button" className="manuscript-builder__button manuscript-builder__button--save" disabled={pickedIds.size === 0} onClick={addPickedDocuments}>{pickedIds.size ? `Add ${pickedIds.size} document${pickedIds.size === 1 ? '' : 's'}` : 'Add documents'}</button></div></div></div>}
      {pendingOpenFilename && <div className="manuscript-builder__picker-overlay" role="presentation"><div className="manuscript-builder__confirm" role="dialog" aria-modal="true" aria-labelledby="manuscript-open-source-title"><h2 id="manuscript-open-source-title">Save changes before opening this document?</h2><p>Your manuscript contents have unsaved changes.</p><div><button type="button" className="manuscript-builder__button" onClick={() => setPendingOpenFilename(null)}>Cancel</button><button type="button" className="manuscript-builder__button" onClick={() => { onOpenDocument(pendingOpenFilename); setPendingOpenFilename(null); }}>Open without saving</button><button type="button" className="manuscript-builder__button manuscript-builder__button--save" onClick={() => void openAfterSave()}>Save and open</button></div></div></div>}
    </section>
  );
}
