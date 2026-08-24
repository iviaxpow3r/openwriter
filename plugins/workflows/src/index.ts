/**
 * Workflows plugin — a reference implementation for OpenWriter's declarative
 * plugin host. It keeps editorial state separate from the core's agent-owned
 * `draft` / `canonical` lifecycle status.
 */
import type { Request, Response } from 'express';

const PLUGIN_NAME = '@openwriter/plugin-workflows';

type WorkflowState = {
  id: string;
  label: string;
  color: string;
  terminal?: boolean;
};

type WorkflowProfile = {
  id: string;
  name: string;
  states: WorkflowState[];
};

type WorkflowSettings = {
  profiles: WorkflowProfile[];
  settingsProfileId?: string;
};

type DocumentWorkflow = {
  state?: string;
  updatedAt?: string;
};

type WorkspaceWorkflow = {
  profileId?: string;
};

interface DocumentSummary {
  filename: string;
  title: string;
  docId?: string;
  wordCount: number;
  lastModified: string;
  contentType?: string;
}

interface WorkspaceSummary { filename: string; title: string; docCount: number; }

interface Host {
  pluginName: string;
  documents: {
    list(): DocumentSummary[];
    readPluginData<T>(filename: string): T | undefined;
    writePluginData<T>(filename: string, value: T | null): void;
  };
  workspaces: {
    list(): WorkspaceSummary[];
    readPluginData<T>(workspaceFile: string): T | undefined;
    writePluginData<T>(workspaceFile: string, value: T | null): void;
    findForDocument(filename: string): WorkspaceSummary[];
  };
  settings: {
    readData<T>(): T | undefined;
    writeData<T>(value: T | null): void;
  };
  notify: { documentsChanged(): void; workspacesChanged(): void; };
}

interface UiContribution {
  id: string;
  label: string;
  scope: 'document' | 'workspace' | 'settings';
  endpoint: string;
  icon?: 'workflow' | 'settings' | 'board' | 'check' | 'sparkle';
  order?: number;
}

interface Plugin {
  name: string;
  version: string;
  description?: string;
  category?: 'writing' | 'social-media' | 'image-generation' | 'publishing' | 'productivity' | 'analytics';
  registerRoutes?(ctx: { app: any; host: Host }): void | Promise<void>;
  mcpTools?(host: Host): Array<{ name: string; description: string; inputSchema: Record<string, unknown>; handler: (params: Record<string, unknown>) => Promise<unknown> }>;
  uiContributions?(): UiContribution[];
  documentBadges?(host: Host, documents: DocumentSummary[]): Array<{ filename: string; label: string; color?: string; tooltip?: string; contributionId?: string }>;
}

const COLORS = ['#64748b', '#7c3aed', '#2563eb', '#d97706', '#0891b2', '#16a34a', '#be123c'];

const DEFAULT_SETTINGS: WorkflowSettings = {
  profiles: [
    {
      id: 'novel-editorial',
      name: 'Novel editorial',
      states: [
        { id: 'first-draft', label: 'First draft', color: '#64748b' },
        { id: 'second-draft', label: 'Second draft', color: '#7c3aed' },
        { id: 'grammar-revision', label: 'Grammar revision', color: '#2563eb' },
        { id: 'copy-edit', label: 'Copy edit', color: '#d97706' },
        { id: 'ready-to-submit', label: 'Ready to submit', color: '#16a34a', terminal: true },
      ],
    },
    {
      id: 'newsletter-publishing',
      name: 'Newsletter publishing',
      states: [
        { id: 'draft', label: 'Draft', color: '#64748b' },
        { id: 'review', label: 'Review', color: '#7c3aed' },
        { id: 'approved', label: 'Approved', color: '#2563eb' },
        { id: 'scheduled', label: 'Scheduled', color: '#d97706' },
        { id: 'published', label: 'Published', color: '#16a34a', terminal: true },
      ],
    },
  ],
  settingsProfileId: 'novel-editorial',
};

function cloneDefaults(): WorkflowSettings {
  return JSON.parse(JSON.stringify(DEFAULT_SETTINGS)) as WorkflowSettings;
}

function settingsFor(host: Host): WorkflowSettings {
  const stored = host.settings.readData<WorkflowSettings>();
  if (!stored?.profiles?.length) return cloneDefaults();
  return {
    profiles: stored.profiles.filter((profile) => profile?.id && profile?.name && Array.isArray(profile.states) && profile.states.length > 0),
    settingsProfileId: stored.settingsProfileId,
  };
}

function saveSettings(host: Host, settings: WorkflowSettings): void {
  host.settings.writeData(settings);
}

function fallbackProfile(settings: WorkflowSettings): WorkflowProfile {
  return settings.profiles[0] || cloneDefaults().profiles[0];
}

function workspaceFor(host: Host, filename: string): WorkspaceSummary | undefined {
  return host.workspaces.findForDocument(filename)[0];
}

function profileForWorkspace(host: Host, settings: WorkflowSettings, workspace?: WorkspaceSummary): WorkflowProfile {
  const assignment = workspace ? host.workspaces.readPluginData<WorkspaceWorkflow>(workspace.filename) : undefined;
  return settings.profiles.find((profile) => profile.id === assignment?.profileId) || fallbackProfile(settings);
}

function contextForDocument(host: Host, filename: string) {
  const settings = settingsFor(host);
  const workspace = workspaceFor(host, filename);
  const profile = profileForWorkspace(host, settings, workspace);
  const data = host.documents.readPluginData<DocumentWorkflow>(filename) || {};
  const state = profile.states.find((item) => item.id === data.state) || profile.states[0];
  return { settings, workspace, profile, data, state };
}

function slug(value: string): string {
  return value.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'state';
}

function uniqueId(base: string, existing: Set<string>): string {
  let next = base;
  let index = 2;
  while (existing.has(next)) next = `${base}-${index++}`;
  return next;
}

function workflowPanel(host: Host, filename: string) {
  if (!filename) return { blocks: [{ type: 'notice', tone: 'warning', text: 'Open a document to set its workflow state.' }] };
  const { workspace, profile, data, state } = contextForDocument(host, filename);
  return {
    title: 'Workflow',
    blocks: [
      { type: 'heading', text: 'Editorial state', detail: workspace ? `${profile.name} · ${workspace.title}` : `${profile.name} · unassigned document` },
      { type: 'select', id: 'set-state', label: 'Current state', value: state.id, options: profile.states.map((item) => ({ value: item.id, label: item.label, color: item.color })), help: 'This is operational workflow metadata. It does not change OpenWriter’s draft/canonical status.' },
      { type: 'notice', tone: state.terminal ? 'success' : 'neutral', text: data.updatedAt ? `Updated ${new Date(data.updatedAt).toLocaleDateString()}` : 'State has not been explicitly set yet; the first workflow state is being shown.' },
    ],
  };
}

function workflowBoard(host: Host, filename: string) {
  if (!filename) return { blocks: [{ type: 'notice', tone: 'warning', text: 'Open a document in the workspace whose pipeline you want to view.' }] };
  const settings = settingsFor(host);
  const workspace = workspaceFor(host, filename);
  if (!workspace) return { blocks: [{ type: 'notice', tone: 'warning', text: 'This document is not in a workspace yet.' }] };
  const profile = profileForWorkspace(host, settings, workspace);
  const docs = host.documents.list().filter((doc) => host.workspaces.findForDocument(doc.filename).some((item) => item.filename === workspace.filename));
  const columns = profile.states.map((state) => ({
    id: state.id,
    label: state.label,
    color: state.color,
    items: docs.filter((doc) => {
      const data = host.documents.readPluginData<DocumentWorkflow>(doc.filename);
      return (data?.state || profile.states[0].id) === state.id;
    }).map((doc) => ({ id: doc.filename, title: doc.title, detail: doc.wordCount ? `${doc.wordCount.toLocaleString()} words` : undefined })),
  }));
  return { title: 'Pipeline', blocks: [{ type: 'heading', text: profile.name, detail: workspace.title }, { type: 'kanban', id: 'workflow-board', columns }] };
}

function workflowSettingsPanel(host: Host, filename: string) {
  const settings = settingsFor(host);
  const workspace = filename ? workspaceFor(host, filename) : undefined;
  const profileId = settings.settingsProfileId && settings.profiles.some((profile) => profile.id === settings.settingsProfileId)
    ? settings.settingsProfileId
    : fallbackProfile(settings).id;
  const profile = settings.profiles.find((item) => item.id === profileId) || fallbackProfile(settings);
  const workspaceAssignment = workspace ? host.workspaces.readPluginData<WorkspaceWorkflow>(workspace.filename) : undefined;
  return {
    title: 'Workflow settings',
    blocks: [
      { type: 'heading', text: 'Workflow profiles', detail: 'Profiles can be reused by any workspace.' },
      { type: 'select', id: 'settings-profile', label: 'Edit profile', value: profile.id, options: settings.profiles.map((item) => ({ value: item.id, label: item.name })) },
      { type: 'text', id: 'settings-profile-name', label: 'Profile name', value: profile.name },
      { type: 'text', id: 'settings-states', label: 'Pipeline states', value: profile.states.map((item) => item.label).join(' | '), help: 'Use a vertical bar between states. The last state is treated as complete.' },
      { type: 'button', id: 'settings-add-profile', label: 'Add a workflow profile', tone: 'default' },
      ...(workspace ? [
        { type: 'heading' as const, text: 'This workspace', detail: workspace.title },
        { type: 'select' as const, id: 'settings-workspace-profile', label: 'Use this profile', value: workspaceAssignment?.profileId || fallbackProfile(settings).id, options: settings.profiles.map((item) => ({ value: item.id, label: item.name })) },
      ] : [{ type: 'notice' as const, tone: 'warning' as const, text: 'Open a document inside a workspace to assign that workspace a profile.' }]),
    ],
  };
}

function setDocumentState(host: Host, filename: string, stateId: string): DocumentWorkflow {
  const { profile, data } = contextForDocument(host, filename);
  if (!profile.states.some((state) => state.id === stateId)) throw new Error(`"${stateId}" is not a state in the ${profile.name} workflow`);
  const next = { ...data, state: stateId, updatedAt: new Date().toISOString() };
  host.documents.writePluginData(filename, next);
  host.notify.documentsChanged();
  return next;
}

function updateSettings(host: Host, action: string, value: string | undefined, filename: string): void {
  const settings = settingsFor(host);
  const selectedId = settings.settingsProfileId && settings.profiles.some((profile) => profile.id === settings.settingsProfileId)
    ? settings.settingsProfileId
    : fallbackProfile(settings).id;
  const selectedIndex = settings.profiles.findIndex((profile) => profile.id === selectedId);
  const selected = settings.profiles[selectedIndex];

  if (action === 'settings-profile') {
    if (!settings.profiles.some((profile) => profile.id === value)) throw new Error('Workflow profile not found');
    settings.settingsProfileId = value;
  } else if (action === 'settings-profile-name') {
    const name = value?.trim();
    if (!name) throw new Error('A profile needs a name');
    selected.name = name;
  } else if (action === 'settings-states') {
    const labels = (value || '').split('|').map((part) => part.trim()).filter(Boolean);
    if (labels.length < 2) throw new Error('A workflow needs at least two states');
    const existingByLabel = new Map(selected.states.map((state) => [state.label.toLocaleLowerCase(), state]));
    const used = new Set<string>();
    selected.states = labels.map((label, index) => {
      const previous = existingByLabel.get(label.toLocaleLowerCase());
      const id = previous?.id || uniqueId(slug(label), used);
      used.add(id);
      return { id, label, color: previous?.color || COLORS[index % COLORS.length], terminal: index === labels.length - 1 };
    });
  } else if (action === 'settings-add-profile') {
    const existing = new Set(settings.profiles.map((profile) => profile.id));
    const id = uniqueId('new-workflow', existing);
    settings.profiles.push({
      id,
      name: 'New workflow',
      states: [
        { id: 'draft', label: 'Draft', color: COLORS[0] },
        { id: 'review', label: 'Review', color: COLORS[1] },
        { id: 'complete', label: 'Complete', color: COLORS[5], terminal: true },
      ],
    });
    settings.settingsProfileId = id;
  } else if (action === 'settings-workspace-profile') {
    const workspace = workspaceFor(host, filename);
    if (!workspace) throw new Error('Open a document inside a workspace first');
    if (!settings.profiles.some((profile) => profile.id === value)) throw new Error('Workflow profile not found');
    host.workspaces.writePluginData<WorkspaceWorkflow>(workspace.filename, { profileId: value });
    host.notify.workspacesChanged();
  } else {
    throw new Error('Unknown workflow settings action');
  }

  saveSettings(host, settings);
}

function mcpTools(host: Host) {
  const profilesSchema = { type: 'object', properties: {}, required: [] };
  return [
    {
      name: 'workflow_list_profiles',
      description: 'List available workflow profiles and their ordered operational states. Workflow state is separate from OpenWriter draft/canonical status.',
      inputSchema: profilesSchema,
      handler: async (_params: Record<string, unknown>) => ({ profiles: settingsFor(host).profiles }),
    },
    {
      name: 'workflow_get_state',
      description: 'Read a document’s workflow profile and current operational state.',
      inputSchema: { type: 'object', properties: { filename: { type: 'string', description: 'OpenWriter filename' } }, required: ['filename'] },
      handler: async (params: Record<string, unknown>) => {
        const target = String(params.filename || '');
        const { workspace, profile, data, state } = contextForDocument(host, target);
        return { filename: target, workspace, profile: profile.name, profileId: profile.id, state, updatedAt: data.updatedAt || null };
      },
    },
    {
      name: 'workflow_set_state',
      description: 'Set a document’s workflow state after validating it against that workspace’s selected workflow profile.',
      inputSchema: { type: 'object', properties: { filename: { type: 'string' }, state: { type: 'string' } }, required: ['filename', 'state'] },
      handler: async (params: Record<string, unknown>) => ({ filename: String(params.filename), ...setDocumentState(host, String(params.filename), String(params.state)) }),
    },
    {
      name: 'workflow_advance_state',
      description: 'Move a document to the next state in its workspace workflow profile.',
      inputSchema: { type: 'object', properties: { filename: { type: 'string' } }, required: ['filename'] },
      handler: async (params: Record<string, unknown>) => {
        const target = String(params.filename);
        const { profile, state } = contextForDocument(host, target);
        const index = profile.states.findIndex((item) => item.id === state.id);
        const next = profile.states[index + 1];
        if (!next) throw new Error(`${state.label} is already the final workflow state`);
        return { filename: target, ...setDocumentState(host, target, next.id) };
      },
    },
    {
      name: 'workflow_list_documents_by_state',
      description: 'List documents in a workflow state, optionally limited to a workspace.',
      inputSchema: { type: 'object', properties: { state: { type: 'string' }, workspaceFile: { type: 'string' } }, required: ['state'] },
      handler: async (params: Record<string, unknown>) => {
        const requested = String(params.state);
        const workspace = params.workspaceFile ? String(params.workspaceFile) : undefined;
        const documents = host.documents.list().filter((document) => {
          const memberships = host.workspaces.findForDocument(document.filename);
          if (workspace && !memberships.some((item) => item.filename === workspace)) return false;
          const profile = profileForWorkspace(host, settingsFor(host), workspace ? memberships.find((item) => item.filename === workspace) : memberships[0]);
          const data = host.documents.readPluginData<DocumentWorkflow>(document.filename);
          return (data?.state || profile.states[0].id) === requested;
        });
        return { state: requested, workspaceFile: workspace || null, documents };
      },
    },
    {
      name: 'workflow_set_workspace_profile',
      description: 'Choose the workflow profile used by a workspace.',
      inputSchema: { type: 'object', properties: { workspaceFile: { type: 'string' }, profileId: { type: 'string' } }, required: ['workspaceFile', 'profileId'] },
      handler: async (params: Record<string, unknown>) => {
        const workspaceFile = String(params.workspaceFile);
        const profileId = String(params.profileId);
        const settings = settingsFor(host);
        if (!settings.profiles.some((profile) => profile.id === profileId)) throw new Error('Workflow profile not found');
        host.workspaces.writePluginData<WorkspaceWorkflow>(String(workspaceFile), { profileId: String(profileId) });
        host.notify.workspacesChanged();
        return { workspaceFile, profileId };
      },
    },
  ];
}

const plugin: Plugin = {
  name: PLUGIN_NAME,
  version: '0.1.0',
  description: 'Reusable editorial and publishing workflow states, separate from document lifecycle status.',
  category: 'writing',
  uiContributions: () => [
    { id: 'state', label: 'Workflow', scope: 'document', endpoint: '/api/workflows/panel', icon: 'workflow', order: 5 },
    { id: 'board', label: 'Pipeline', scope: 'workspace', endpoint: '/api/workflows/board', icon: 'board', order: 6 },
    { id: 'settings', label: 'Workflow settings', scope: 'settings', endpoint: '/api/workflows/settings', icon: 'settings', order: 7 },
  ],
  documentBadges: (host, documents) => documents.map((document) => {
    const { profile, state } = contextForDocument(host, document.filename);
    return { filename: document.filename, label: state.label, color: state.color, tooltip: `${profile.name}: ${state.label}`, contributionId: 'state' };
  }),
  registerRoutes({ app, host }) {
    app.get('/api/workflows/panel', (req: Request, res: Response) => {
      try { res.json(workflowPanel(host, String(req.query.filename || ''))); }
      catch (err: any) { res.status(400).json({ error: err?.message || 'Unable to load workflow state' }); }
    });
    app.post('/api/workflows/panel', (req: Request, res: Response) => {
      try {
        if (req.body?.action !== 'set-state') throw new Error('Unknown workflow action');
        setDocumentState(host, String(req.body.filename || ''), String(req.body.value || ''));
        res.json({ success: true });
      } catch (err: any) { res.status(400).json({ error: err?.message || 'Unable to update workflow state' }); }
    });
    app.get('/api/workflows/board', (req: Request, res: Response) => {
      try { res.json(workflowBoard(host, String(req.query.filename || ''))); }
      catch (err: any) { res.status(400).json({ error: err?.message || 'Unable to load workflow board' }); }
    });
    app.post('/api/workflows/board', (_req: Request, res: Response) => res.status(405).json({ error: 'The workflow board is read-only in this release.' }));
    app.get('/api/workflows/settings', (req: Request, res: Response) => {
      try { res.json(workflowSettingsPanel(host, String(req.query.filename || ''))); }
      catch (err: any) { res.status(400).json({ error: err?.message || 'Unable to load workflow settings' }); }
    });
    app.post('/api/workflows/settings', (req: Request, res: Response) => {
      try {
        updateSettings(host, String(req.body?.action || ''), typeof req.body?.value === 'string' ? req.body.value : undefined, String(req.body?.filename || ''));
        res.json({ success: true });
      } catch (err: any) { res.status(400).json({ error: err?.message || 'Unable to update workflow settings' }); }
    });
  },
  mcpTools,
};

export default plugin;
