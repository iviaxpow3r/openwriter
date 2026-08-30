import { useCallback, useEffect, useState } from 'react';
import type { RightRailTabProps } from './types';
import {
  formatMetricDecimal,
  formatMetricNumber,
  formatReadingTime,
  readDocumentMetrics,
  type DocumentMetrics,
  type DocumentMetricsSnapshot,
} from '../document-metrics';
import './DocumentMetricsView.css';

export type DocumentMetricsBlock = {
  type: 'document-metrics';
  id: string;
  label?: string;
  detail?: string;
  showLines?: boolean;
  showPages?: boolean;
};

export type DocumentStatusBlock = {
  type: 'document-status';
  id: string;
  metric: 'words';
  label?: string;
};

function useLiveMetrics({ editors, getDocument }: Pick<RightRailTabProps, 'editors' | 'getDocument'>): DocumentMetricsSnapshot {
  const calculate = useCallback(() => readDocumentMetrics(editors, getDocument()), [editors, getDocument]);
  const [metrics, setMetrics] = useState<DocumentMetricsSnapshot>(() => calculate());

  useEffect(() => {
    const refresh = () => window.requestAnimationFrame(() => setMetrics(calculate()));
    refresh();
    editors.forEach((editor) => {
      editor.on('update', refresh);
      editor.on('selectionUpdate', refresh);
      editor.on('focus', refresh);
      editor.on('blur', refresh);
    });
    window.addEventListener('resize', refresh);
    return () => {
      editors.forEach((editor) => {
        editor.off('update', refresh);
        editor.off('selectionUpdate', refresh);
        editor.off('focus', refresh);
        editor.off('blur', refresh);
      });
      window.removeEventListener('resize', refresh);
    };
  }, [calculate, editors]);

  return metrics;
}

function MetricValue({
  selected,
  document,
  format = (value) => value === null ? '—' : formatMetricNumber(value),
}: {
  selected: number | null;
  document: number | null;
  format?: (value: number | null) => string;
}) {
  if (selected === null) return <dd className="document-metrics__value">{format(document)}</dd>;
  return (
    <dd className="document-metrics__value document-metrics__value--paired">
      <strong>{format(selected)}</strong><span aria-hidden="true"> / </span><span>{format(document)}</span>
    </dd>
  );
}

function CounterRow({ label, selected, document, format }: { label: string; selected: DocumentMetrics | null; document: DocumentMetrics; format?: (value: number | null) => string }) {
  const selectedValue = selected ? (label === 'Characters' ? selected.characters : label === 'Without spaces' ? selected.charactersWithoutSpaces : label === 'Words' ? selected.words : label === 'Sentences' ? selected.sentences : label === 'Paragraphs' ? selected.paragraphs : label === 'Lines' ? selected.lines : selected.pages) : null;
  const documentValue = label === 'Characters' ? document.characters : label === 'Without spaces' ? document.charactersWithoutSpaces : label === 'Words' ? document.words : label === 'Sentences' ? document.sentences : label === 'Paragraphs' ? document.paragraphs : label === 'Lines' ? document.lines : document.pages;
  return <div className="document-metrics__row"><dt>{label}</dt><MetricValue selected={selectedValue} document={documentValue} format={format} /></div>;
}

export function DocumentMetricsPanel({ block, ...props }: Pick<RightRailTabProps, 'editors' | 'getDocument'> & { block: DocumentMetricsBlock }) {
  const metrics = useLiveMetrics(props);
  const selection = metrics.selection;
  const readingLabel = selection ? 'Selection reading time' : 'Document reading time';

  return (
    <section className="document-metrics" aria-label={block.label || 'Document counter'}>
      <header className="document-metrics__header">
        <div><strong>{block.label || 'Counter'}</strong>{block.detail && <span>{block.detail}</span>}</div>
        <span className="document-metrics__legend">{selection ? 'Selection / document' : 'Document'}</span>
      </header>
      <dl className="document-metrics__table">
        <CounterRow label="Characters" selected={selection} document={metrics.document} />
        <CounterRow label="Without spaces" selected={selection} document={metrics.document} />
        <CounterRow label="Words" selected={selection} document={metrics.document} />
        <CounterRow label="Sentences" selected={selection} document={metrics.document} />
        <div className="document-metrics__row"><dt>Words / sentence</dt><MetricValue selected={selection?.wordsPerSentence ?? null} document={metrics.document.wordsPerSentence} format={(value) => formatMetricDecimal(value)} /></div>
        <CounterRow label="Paragraphs" selected={selection} document={metrics.document} />
        {block.showLines !== false && <CounterRow label="Lines" selected={selection} document={metrics.document} />}
        {block.showPages !== false && <CounterRow label="Pages" selected={selection} document={metrics.document} format={(value) => formatMetricDecimal(value)} />}
      </dl>
      <section className="document-metrics__reading" aria-label={readingLabel}>
        <strong>Reading time</strong>
        <dl>
          <div><dt>Slow</dt><dd>{formatReadingTime(metrics.reading.slow)}</dd></div>
          <div><dt>Average</dt><dd>{formatReadingTime(metrics.reading.average)}</dd></div>
          <div><dt>Fast</dt><dd>{formatReadingTime(metrics.reading.fast)}</dd></div>
          <div><dt>Aloud</dt><dd>{formatReadingTime(metrics.reading.aloud)}</dd></div>
        </dl>
      </section>
    </section>
  );
}

export function DocumentStatusValue({ block, ...props }: Pick<RightRailTabProps, 'editors' | 'getDocument'> & { block: DocumentStatusBlock }) {
  const metrics = useLiveMetrics(props);
  if (block.metric !== 'words') return null;
  const label = block.label || 'words';
  const count = formatMetricNumber(metrics.document.words);
  return <span className="document-status-value" aria-label={`${count} ${label}`}>{count} {label}</span>;
}
