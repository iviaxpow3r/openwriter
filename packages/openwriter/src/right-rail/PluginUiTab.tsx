/**
 * Declarative plugin view host.
 *
 * Plugins expose an endpoint and return a small UI model rather than shipping
 * arbitrary browser code. The editor keeps one native visual language while
 * plugins gain document/workspace/settings panels and board-like views.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRightRail } from './RightRailContext';
import type { RightRailTabProps } from './types';
import './PluginUiTab.css';

type UiOption = { value: string; label: string; color?: string };
type UiBlock =
  | { type: 'heading'; text: string; detail?: string }
  | { type: 'notice'; text: string; tone?: 'neutral' | 'success' | 'warning' }
  | { type: 'text'; id: string; label: string; value: string; placeholder?: string; help?: string }
  | { type: 'select'; id: string; label: string; value: string; options: UiOption[]; help?: string }
  | { type: 'button'; id: string; label: string; tone?: 'default' | 'primary' | 'danger'; disabled?: boolean }
  | { type: 'kanban'; id: string; columns: Array<{ id: string; label: string; color?: string; items: Array<{ id: string; title: string; detail?: string }> }> };

interface Contribution {
  id: string;
  tabId: string;
  label: string;
  scope: 'document' | 'workspace' | 'settings';
  endpoint: string;
}

interface UiModel { title?: string; blocks: UiBlock[] }

export default function PluginUiTab(props: RightRailTabProps) {
  const { activeTab } = useRightRail();
  const [contributions, setContributions] = useState<Contribution[]>([]);
  const [model, setModel] = useState<UiModel | null>(null);
  const [error, setError] = useState<string | null>(null);
  const contribution = useMemo(() => contributions.find((item) => item.tabId === activeTab) || null, [contributions, activeTab]);

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

  const loadModel = useCallback(async () => {
    if (!contribution) return;
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

  const act = useCallback(async (action: string, value?: string) => {
    if (!contribution) return;
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
    } catch (err: any) {
      setError(err?.message || 'Unable to save plugin changes');
    }
  }, [contribution, loadModel, props.currentFilename]);

  if (!contribution) return <div className="plugin-ui-empty">Loading plugin view…</div>;

  return (
    <div className="plugin-ui-tab">
      {error && <div className="plugin-ui-error">{error}</div>}
      {!model && !error && <div className="plugin-ui-empty">Loading…</div>}
      {model?.blocks.map((block) => {
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
        if (block.type === 'button') return <button key={block.id} className={`plugin-ui-button plugin-ui-button--${block.tone || 'default'}`} disabled={block.disabled} onClick={() => { void act(block.id); }}>{block.label}</button>;
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
