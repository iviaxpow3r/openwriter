/**
 * Declarative plugin view host.
 *
 * Plugins expose an endpoint and return a small UI model rather than shipping
 * arbitrary browser code. The editor keeps one native visual language while
 * plugins gain document/workspace/settings panels and board-like views.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useRightRail } from './RightRailContext';
import type { RightRailTabProps } from './types';
import { DocumentMetricsPanel, type DocumentMetricsBlock, type DocumentStatusBlock } from './DocumentMetricsView';
import './PluginUiTab.css';

type UiOption = { value: string; label: string; color?: string };
type UiConfirmation = { title: string; message: string; confirmLabel: string; cancelLabel?: string };
type UiButton = { id: string; label: string; tone?: 'default' | 'primary' | 'danger'; disabled?: boolean; opensForm?: string; confirm?: UiConfirmation };
type UiForm = {
  type: 'form';
  id: string;
  title: string;
  detail?: string;
  fields: Array<{ id: string; label: string; placeholder?: string; help?: string; required?: boolean }>;
  submit: UiButton;
  cancelLabel?: string;
};
type UiBlock =
  | { type: 'heading'; text: string; detail?: string }
  | { type: 'notice'; text: string; tone?: 'neutral' | 'success' | 'warning' }
  | { type: 'text'; id: string; label: string; value: string; placeholder?: string; help?: string }
  | { type: 'select'; id: string; label: string; value: string; options: UiOption[]; help?: string }
  | ({ type: 'button' } & UiButton)
  | {
    type: 'sequence';
    id: string;
    label: string;
    items: Array<{ id: string; label: string; color?: string; detail?: string; removable?: boolean }>;
    actions: { rename: string; move: string; remove: string; add: string; addLabel?: string; setColor?: string };
    help?: string;
  }
  | { type: 'buttons'; id: string; buttons: UiButton[] }
  | UiForm
  | DocumentMetricsBlock
  | DocumentStatusBlock
  | {
    type: 'kanban';
    id: string;
    actions?: { move?: string };
    columns: Array<{ id: string; label: string; color?: string; items: Array<{ id: string; title: string; detail?: string }> }>;
    groups?: Array<{ id: string; label: string; detail?: string; empty?: string; columns?: Array<{ id: string; label: string; color?: string; items: Array<{ id: string; title: string; detail?: string }> }>; groups?: any[] }>;
  };

export interface PluginUiContribution {
  id: string;
  tabId: string;
  label: string;
  scope: 'document' | 'workspace' | 'settings';
  endpoint: string;
  pluginName?: string;
  surface?: 'rail' | 'plugins' | 'sidebar-layout' | 'editor-status';
  openTabContributionId?: string;
}

interface UiModel { title?: string; blocks: UiBlock[] }

function InlineConfirmation({ confirmation, onCancel, onConfirm }: { confirmation: UiConfirmation; onCancel: () => void; onConfirm: () => void }) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();

  useEffect(() => {
    cancelRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') onCancel(); };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onCancel]);

  return (
    <section className="plugin-ui-confirmation" role="group" aria-labelledby={titleId}>
      <strong id={titleId}>{confirmation.title}</strong>
      <p>{confirmation.message}</p>
      <div className="plugin-ui-confirmation__actions">
        <button ref={cancelRef} type="button" className="plugin-ui-button" onClick={onCancel}>{confirmation.cancelLabel || 'Cancel'}</button>
        <button type="button" className="plugin-ui-button plugin-ui-button--danger plugin-ui-confirmation__confirm" onClick={onConfirm}>{confirmation.confirmLabel}</button>
      </div>
    </section>
  );
}

function InlineForm({ form, onCancel, onSubmit }: { form: UiForm; onCancel: () => void; onSubmit: (values: Record<string, string>) => Promise<boolean> }) {
  const firstFieldRef = useRef<HTMLInputElement>(null);
  const titleId = useId();
  const [values, setValues] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const requiredComplete = form.fields.filter((field) => field.required).every((field) => values[field.id]?.trim());

  useEffect(() => {
    firstFieldRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') onCancel(); };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onCancel]);

  return (
    <form className="plugin-ui-form" aria-labelledby={titleId} onSubmit={(event) => {
      event.preventDefault();
      const missing = form.fields.find((field) => field.required && !values[field.id]?.trim());
      if (missing) {
        setFormError(`Enter ${missing.label.toLocaleLowerCase()} to continue.`);
        return;
      }
      void onSubmit(Object.fromEntries(form.fields.map((field) => [field.id, values[field.id]?.trim() || '']))).then((saved) => {
        if (saved) onCancel();
      });
    }}>
      <div className="plugin-ui-form__heading">
        <strong id={titleId}>{form.title}</strong>
        {form.detail && <p>{form.detail}</p>}
      </div>
      {form.fields.map((field, index) => {
        const inputId = `${form.id}-${field.id}`;
        return (
          <label className="plugin-ui-form__field" key={field.id} htmlFor={inputId}>
            <span>{field.label}</span>
            <input
              ref={index === 0 ? firstFieldRef : undefined}
              id={inputId}
              value={values[field.id] || ''}
              placeholder={field.placeholder}
              required={field.required}
              onChange={(event) => { setValues((current) => ({ ...current, [field.id]: event.target.value })); setFormError(null); }}
            />
            {field.help && <small>{field.help}</small>}
          </label>
        );
      })}
      {formError && <p className="plugin-ui-form__error" role="alert">{formError}</p>}
      <div className="plugin-ui-form__actions">
        <button type="button" className="plugin-ui-button" onClick={onCancel}>{form.cancelLabel || 'Cancel'}</button>
        <button type="submit" className={`plugin-ui-button plugin-ui-button--${form.submit.tone || 'primary'}`} disabled={form.submit.disabled || !requiredComplete}>{form.submit.label}</button>
      </div>
    </form>
  );
}

export default function PluginUiTab(props: RightRailTabProps) {
  const { activeTab } = useRightRail();
  const [contributions, setContributions] = useState<PluginUiContribution[]>([]);

  useEffect(() => {
    let cancelled = false;
    const load = () => fetch('/api/plugin-ui/contributions')
      .then((response) => response.ok ? response.json() : Promise.reject(new Error('Unable to load plugin views')))
      .then((data) => { if (!cancelled) setContributions(data.contributions || []); })
      .catch(() => { if (!cancelled) setContributions([]); });
    load();
    window.addEventListener('ow-plugins-changed', load);
    return () => { cancelled = true; window.removeEventListener('ow-plugins-changed', load); };
  }, []);

  const contribution = useMemo(
    () => contributions.find((item) => item.tabId === activeTab && (item.surface === 'rail' || !item.surface)) || null,
    [contributions, activeTab],
  );

  if (!contribution) return <div className="plugin-ui-empty">Loading plugin view…</div>;
  return <PluginUiPanel {...props} contribution={contribution} />;
}

/** Reusable host-rendered plugin view. Settings-surface contributions embed
 * this inside the owning plugin’s entry rather than creating another rail icon. */
export function PluginUiPanel({ contribution, ...props }: RightRailTabProps & { contribution: PluginUiContribution }) {
  const [model, setModel] = useState<UiModel | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmingAction, setConfirmingAction] = useState<{ id: string; confirmation: UiConfirmation } | null>(null);
  const [openForm, setOpenForm] = useState<string | null>(null);

  const loadModel = useCallback(async () => {
    setError(null);
    try {
      const query = new URLSearchParams({ filename: props.currentFilename || '' });
      const response = await fetch(`${contribution.endpoint}?${query.toString()}`);
      if (!response.ok) throw new Error((await response.json().catch(() => null))?.error || 'Unable to load this plugin view');
      setModel(await response.json());
    } catch (err: any) {
      setModel(null);
      setError(err?.message || 'Unable to load this plugin view');
    }
  }, [contribution, props.currentFilename]);

  useEffect(() => { void loadModel(); }, [loadModel]);

  const act = useCallback(async (action: string, value?: string): Promise<boolean> => {
    if (!contribution) return false;
    setError(null);
    try {
      const response = await fetch(contribution.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, value, filename: props.currentFilename || '' }),
      });
      if (!response.ok) throw new Error((await response.json().catch(() => null))?.error || 'Unable to save plugin changes');
      window.dispatchEvent(new CustomEvent('ow-plugin-ui-changed'));
      await loadModel();
      return true;
    } catch (err: any) {
      setError(err?.message || 'Unable to save plugin changes');
      return false;
    }
  }, [contribution, loadModel, props.currentFilename]);

  useEffect(() => { setConfirmingAction(null); setOpenForm(null); }, [contribution.tabId, props.currentFilename]);

  return (
    <div className="plugin-ui-tab">
      {error && <div className="plugin-ui-error">{error}</div>}
      {!model && !error && <div className="plugin-ui-empty">Loading…</div>}
      {model?.blocks.map((block) => {
        if (block.type === 'document-metrics') return <DocumentMetricsPanel key={block.id} block={block} editors={props.editors} getDocument={props.getDocument} />;
        // Editor-status blocks are rendered by PluginEditorStatusBar. They
        // intentionally do not duplicate themselves in the rail panel.
        if (block.type === 'document-status') return null;
        if (block.type === 'heading') return <div className="plugin-ui-heading" key={`${block.type}-${block.text}`}><strong>{block.text}</strong>{block.detail && <span>{block.detail}</span>}</div>;
        if (block.type === 'notice') return <div className={`plugin-ui-notice plugin-ui-notice--${block.tone || 'neutral'}`} key={`${block.type}-${block.text}`}>{block.text}</div>;
        if (block.type === 'text') return (
          <label className="plugin-ui-select" key={block.id}>
            <span>{block.label}</span>
            <input defaultValue={block.value} placeholder={block.placeholder} onBlur={(event) => { if (event.target.value !== block.value) void act(block.id, event.target.value); }} />
            {block.help && <small>{block.help}</small>}
          </label>
        );
        if (block.type === 'select') return (
          <label className="plugin-ui-select" key={block.id}>
            <span>{block.label}</span>
            <select value={block.value} onChange={(event) => { void act(block.id, event.target.value); }}>
              {block.options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
            {block.help && <small>{block.help}</small>}
          </label>
        );
        if (block.type === 'button') return (
          <div className="plugin-ui-action" key={block.id}>
            <button className={`plugin-ui-button plugin-ui-button--${block.tone || 'default'}`} disabled={block.disabled} onClick={() => {
              if (block.opensForm) { setConfirmingAction(null); setOpenForm(block.opensForm); }
              else if (block.confirm) setConfirmingAction({ id: block.id, confirmation: block.confirm });
              else void act(block.id);
            }}>{block.label}</button>
            {confirmingAction?.id === block.id && <InlineConfirmation confirmation={confirmingAction.confirmation} onCancel={() => setConfirmingAction(null)} onConfirm={() => { void act(block.id).then((saved) => { if (saved) setConfirmingAction(null); }); }} />}
          </div>
        );
        if (block.type === 'buttons') return (
          <div className="plugin-ui-action" key={block.id}>
            <div className="plugin-ui-button-row">
              {block.buttons.map((button) => (
                <button key={button.id} className={`plugin-ui-button plugin-ui-button--${button.tone || 'default'}`} disabled={button.disabled} onClick={() => {
                  if (button.opensForm) { setConfirmingAction(null); setOpenForm(button.opensForm); }
                  else if (button.confirm) { setOpenForm(null); setConfirmingAction({ id: button.id, confirmation: button.confirm }); }
                  else void act(button.id);
                }}>{button.label}</button>
              ))}
            </div>
            {block.buttons.map((button) => confirmingAction?.id === button.id && <InlineConfirmation key={`confirm-${button.id}`} confirmation={confirmingAction.confirmation} onCancel={() => setConfirmingAction(null)} onConfirm={() => { void act(button.id).then((saved) => { if (saved) setConfirmingAction(null); }); }} />)}
          </div>
        );
        if (block.type === 'form') {
          if (openForm !== block.id) return null;
          return <InlineForm key={block.id} form={block} onCancel={() => setOpenForm(null)} onSubmit={(values) => act(block.submit.id, JSON.stringify(values))} />;
        }
        if (block.type === 'sequence') return (
          <section className="plugin-ui-sequence" key={block.id}>
            <div className="plugin-ui-sequence__heading"><strong>{block.label}</strong>{block.help && <small>{block.help}</small>}</div>
            <div className="plugin-ui-sequence__items">
              {block.items.map((item, index) => (
                <div className="plugin-ui-sequence__item" key={item.id}>
                  {block.actions.setColor ? (
                    <input
                      className="plugin-ui-sequence__color"
                      type="color"
                      value={item.color || '#64748b'}
                      aria-label={`Stage color for ${item.label}`}
                      title={`Choose color for ${item.label}`}
                      onChange={(event) => { void act(block.actions.setColor!, JSON.stringify({ id: item.id, color: event.target.value })); }}
                    />
                  ) : <span className="plugin-ui-color-dot" style={{ backgroundColor: item.color || 'var(--muted)' }} />}
                  <input
                    aria-label={`${block.label}: ${item.label}`}
                    defaultValue={item.label}
                    onBlur={(event) => {
                      const label = event.target.value.trim();
                      if (label && label !== item.label) void act(block.actions.rename, JSON.stringify({ id: item.id, label }));
                    }}
                    onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); }}
                  />
                  {item.detail && <span className="plugin-ui-sequence__detail">{item.detail}</span>}
                  <div className="plugin-ui-sequence__actions">
                    <button type="button" aria-label={`Move ${item.label} up`} title="Move up" disabled={index === 0} onClick={() => { void act(block.actions.move, JSON.stringify({ id: item.id, direction: 'up' })); }}>↑</button>
                    <button type="button" aria-label={`Move ${item.label} down`} title="Move down" disabled={index === block.items.length - 1} onClick={() => { void act(block.actions.move, JSON.stringify({ id: item.id, direction: 'down' })); }}>↓</button>
                    {item.removable !== false && <button type="button" className="plugin-ui-sequence__remove" onClick={() => { void act(block.actions.remove, item.id); }}>Remove</button>}
                  </div>
                </div>
              ))}
            </div>
            <button className="plugin-ui-sequence__add" onClick={() => { void act(block.actions.add); }}>+ {block.actions.addLabel || 'Add item'}</button>
          </section>
        );
        return (
          <div className="plugin-ui-kanban" key={block.id}>
            {block.columns.map((column) => (
              <section className="plugin-ui-kanban-column" key={column.id}>
                <header><span className="plugin-ui-color-dot" style={{ backgroundColor: column.color || 'var(--muted)' }} />{column.label}<em>{column.items.length}</em></header>
                <div>{column.items.map((item) => (
                  <button className="plugin-ui-kanban-card" key={item.id} onClick={() => props.onSwitchDocument(item.id)} title={`Open ${item.title}`}>
                    <strong>{item.title}</strong>{item.detail && <span>{item.detail}</span>}
                  </button>
                ))}</div>
              </section>
            ))}
          </div>
        );
      })}
    </div>
  );
}
