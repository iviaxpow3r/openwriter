import { useEffect, useState } from 'react';
import { useRightRail } from './RightRailContext';
import type { RightRailTabProps } from './types';
import { DocumentStatusValue, type DocumentStatusBlock } from './DocumentMetricsView';
import './DocumentMetricsView.css';

type StatusContribution = {
  id: string;
  endpoint: string;
  pluginName?: string;
  surface?: 'editor-status';
  openTabContributionId?: string;
};

type StatusModel = {
  blocks?: Array<DocumentStatusBlock | { type?: string }>;
};

function PluginEditorStatusItem({
  contribution,
  editors,
  getDocument,
  currentFilename,
  onActivate,
}: Pick<RightRailTabProps, 'editors' | 'getDocument' | 'currentFilename'> & {
  contribution: StatusContribution;
  onActivate?: () => void;
}) {
  const [blocks, setBlocks] = useState<DocumentStatusBlock[]>([]);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      const query = new URLSearchParams({ filename: currentFilename || '' });
      fetch(`${contribution.endpoint}?${query.toString()}`)
        .then((response) => response.ok ? response.json() : Promise.reject(new Error('Unable to load editor status')))
        .then((data: StatusModel) => {
          if (!cancelled) setBlocks((data.blocks || []).filter((block): block is DocumentStatusBlock => block.type === 'document-status'));
        })
        .catch(() => { if (!cancelled) setBlocks([]); });
    };
    load();
    window.addEventListener('ow-plugin-ui-changed', load);
    return () => {
      cancelled = true;
      window.removeEventListener('ow-plugin-ui-changed', load);
    };
  }, [contribution.endpoint, currentFilename]);

  return (
    <>
      {blocks.map((block) => (
        <DocumentStatusValue key={`${contribution.pluginName || contribution.endpoint}:${block.id}`} block={block} editors={editors} getDocument={getDocument} onActivate={onActivate} />
      ))}
    </>
  );
}

/** Quiet lower-edge readouts contributed by enabled plugins. This is deliberately
 * host-rendered: a metric plugin can choose the slot, but the document text and
 * live selection always stay inside OpenWriter. */
export default function PluginEditorStatusBar({
  editors,
  getDocument,
  currentFilename,
}: Pick<RightRailTabProps, 'editors' | 'getDocument' | 'currentFilename'>) {
  const { openTab } = useRightRail();
  const [contributions, setContributions] = useState<StatusContribution[]>([]);

  useEffect(() => {
    let cancelled = false;
    const load = () => fetch('/api/plugin-ui/contributions')
      .then((response) => response.ok ? response.json() : Promise.reject(new Error('Unable to load editor status')))
      .then((data) => {
        if (!cancelled) setContributions((data.contributions || []).filter((item: StatusContribution) => item.surface === 'editor-status'));
      })
      .catch(() => { if (!cancelled) setContributions([]); });
    load();
    window.addEventListener('ow-plugins-changed', load);
    return () => {
      cancelled = true;
      window.removeEventListener('ow-plugins-changed', load);
    };
  }, []);

  if (!contributions.length) return null;

  return (
    <aside className="plugin-editor-status-bar" aria-label="Document status">
      {contributions.map((contribution) => (
        <PluginEditorStatusItem
          key={`${contribution.pluginName || contribution.endpoint}:${contribution.id}`}
          contribution={contribution}
          editors={editors}
          getDocument={getDocument}
          currentFilename={currentFilename}
          onActivate={contribution.pluginName && contribution.openTabContributionId
            ? () => openTab(`plugin:${contribution.pluginName}:${contribution.openTabContributionId}`)
            : undefined}
        />
      ))}
    </aside>
  );
}
