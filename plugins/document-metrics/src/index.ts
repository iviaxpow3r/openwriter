/**
 * Document Metrics — an intentionally small, host-rendered plugin.
 *
 * The plugin contributes placement and labels only. OpenWriter computes all
 * live values from the editor, which keeps document text and selection data
 * local while giving future plugins a reusable status-slot surface.
 */
import type { Request, Response } from 'express';

const PLUGIN_NAME = '@openwriter/plugin-document-metrics';

type UiContribution = {
  id: string;
  label: string;
  scope: 'document' | 'workspace' | 'settings';
  endpoint: string;
  icon?: 'counter';
  order?: number;
  surface?: 'rail' | 'editor-status';
  openTabContributionId?: string;
};

type Plugin = {
  name: string;
  version: string;
  description: string;
  category: 'productivity';
  uiContributions(): UiContribution[];
  registerRoutes(context: { app: { get(path: string, handler: (req: Request, res: Response) => void): void } }): void;
};

const plugin: Plugin = {
  name: PLUGIN_NAME,
  version: '0.1.0',
  description: 'Live document and selection counts, reading time, and a quiet word count at the edge of the editor.',
  category: 'productivity',

  uiContributions() {
    return [
      {
        id: 'counter',
        label: 'Counter',
        scope: 'document',
        endpoint: '/api/document-metrics/counter',
        icon: 'counter',
        order: 6,
        surface: 'rail',
      },
      {
        id: 'word-count',
        label: 'Word count',
        scope: 'document',
        endpoint: '/api/document-metrics/status',
        order: 1,
        surface: 'editor-status',
        openTabContributionId: 'counter',
      },
    ];
  },

  registerRoutes({ app }) {
    app.get('/api/document-metrics/counter', (_req, res) => {
      res.json({
        title: 'Counter',
        blocks: [
          {
            type: 'document-metrics',
            id: 'counter',
            label: 'Counter',
            detail: 'Selection / document',
            showLines: true,
            showPages: true,
          },
        ],
      });
    });

    app.get('/api/document-metrics/status', (_req, res) => {
      res.json({
        blocks: [
          {
            type: 'document-status',
            id: 'word-count',
            metric: 'words',
            label: 'words',
          },
        ],
      });
    });
  },
};

export default plugin;
