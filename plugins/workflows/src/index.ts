/**
 * Workflows plugin — a reference implementation for OpenWriter's declarative
 * plugin host. It keeps editorial state separate from the core's agent-owned
 * `draft` / `canonical` lifecycle status.
 */
import type { Request, Response } from 'express';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const PLUGIN_NAME = '@openwriter/plugin-workflows';
const WORKFLOW_MANIFEST_DIR = '.openwriter';
const WORKFLOW_MANIFEST_FILE = 'workflows.json';

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
  /** Explicit per-document workflow override. Omit it to inherit. */
  profileId?: string;
  state?: string;
  updatedAt?: string;
};

type WorkspaceWorkflow = {
  profileId?: string;
};

type ContainerWorkflow = WorkspaceWorkflow;

interface DocumentSummary {
  filename: string;
  title: string;
  docId?: string;
  wordCount: number;
  lastModified: string;
  contentType?: string;
}

interface WorkspaceSummary { filename: string; title: string; docCount: number; }
interface WorkspaceDocumentSummary { filename: string; title: string; }
interface WorkspaceContainerSummary { id: string; name: string; path: string; }

interface Host {
  pluginName: string;
  dataDir: string;
  documents: {
    list(): DocumentSummary[];
    readPluginData<T>(filename: string): T | undefined;
    writePluginData<T>(filename: string, value: T | null): void;
  };
  workspaces: {
    list(): WorkspaceSummary[];
    listDocuments(workspaceFile: string): WorkspaceDocumentSummary[];
    listContainers(workspaceFile: string): WorkspaceContainerSummary[];
    readPluginData<T>(workspaceFile: string): T | undefined;
    writePluginData<T>(workspaceFile: string, value: T | null): void;
    readContainerPluginData<T>(workspaceFile: string, containerId: string): T | undefined;
    writeContainerPluginData<T>(workspaceFile: string, containerId: string, value: T | null): void;
    findContainerPathForDocument(workspaceFile: string, filename: string): WorkspaceContainerSummary[];
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
  icon?: 'pipeline' | 'workflow' | 'settings' | 'board' | 'check' | 'sparkle';
  order?: number;
  surface?: 'rail' | 'plugins' | 'sidebar-layout';
}

type SidebarTarget = { type: 'document' | 'folder' | 'workspace'; filename?: string; workspaceFile?: string; containerId?: string };
type SidebarMenuItem = { label: string; action: string; disabled?: boolean; detail?: string; target?: 'document' | 'folder' | 'workspace'; menuGroup?: string };

interface Plugin {
  name: string;
  version: string;
  description?: string;
  category?: 'writing' | 'social-media' | 'image-generation' | 'publishing' | 'productivity' | 'analytics';
  registerRoutes?(ctx: { app: any; host: Host }): void | Promise<void>;
  mcpTools?(host: Host): Array<{ name: string; description: string; inputSchema: Record<string, unknown>; handler: (params: Record<string, unknown>) => Promise<unknown> }>;
  sidebarMenuItems?(host: Host): SidebarMenuItem[];
  sidebarMenuItemsForTarget?(host: Host, target: SidebarTarget): SidebarMenuItem[];
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

function validSettings(value: unknown): WorkflowSettings | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const candidate = value as Partial<WorkflowSettings>;
  if (!Array.isArray(candidate.profiles)) return undefined;
  const profiles = candidate.profiles.filter((profile) => profile?.id && profile?.name && Array.isArray(profile.states) && profile.states.length > 0);
  if (!profiles.length) return undefined;
  return { profiles, settingsProfileId: candidate.settingsProfileId };
}

function workflowManifestPath(host: Host): string {
  return join(host.dataDir, WORKFLOW_MANIFEST_DIR, WORKFLOW_MANIFEST_FILE);
}

function readPortableSettings(host: Host): WorkflowSettings | undefined {
  const path = workflowManifestPath(host);
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as { version?: unknown; settings?: unknown };
    return parsed.version === 1 ? validSettings(parsed.settings) : undefined;
  } catch {
    return undefined;
  }
}

function writePortableSettings(host: Host, settings: WorkflowSettings): void {
  const path = workflowManifestPath(host);
  const next = `${JSON.stringify({ version: 1, settings }, null, 2)}\n`;
  if (existsSync(path) && readFileSync(path, 'utf-8') === next) return;
  mkdirSync(join(host.dataDir, WORKFLOW_MANIFEST_DIR), { recursive: true });
  writeFileSync(path, next, 'utf-8');
}

function settingsFor(host: Host): WorkflowSettings {
  const portable = readPortableSettings(host);
  if (portable) {
    const stored = validSettings(host.settings.readData<WorkflowSettings>());
    if (JSON.stringify(stored) !== JSON.stringify(portable)) host.settings.writeData(portable);
    return portable;
  }
  return validSettings(host.settings.readData<WorkflowSettings>()) || cloneDefaults();
}

function saveSettings(host: Host, settings: WorkflowSettings): void {
  host.settings.writeData(settings);
  // Workflow definitions are writing-space data once Git backup is configured.
  // The manifest is safe, portable JSON (stage labels, colors, and ordering),
  // so the existing Git watcher publishes it with the workspace source.
  if (existsSync(join(host.dataDir, '.git'))) writePortableSettings(host, settings);
}

function profileById(settings: WorkflowSettings, profileId: string | undefined): WorkflowProfile | undefined {
  return settings.profiles.find((profile) => profile.id === profileId);
}

function replacementForDeletedProfile(settings: WorkflowSettings, profileId: string): WorkflowProfile | undefined {
  const selectedIndex = settings.profiles.findIndex((profile) => profile.id === profileId);
  const remaining = settings.profiles.filter((profile) => profile.id !== profileId);
  if (!remaining.length) return undefined;
  return remaining[Math.min(Math.max(selectedIndex, 0), remaining.length - 1)] || remaining[0];
}

function workspaceFor(host: Host, filename: string): WorkspaceSummary | undefined {
  return host.workspaces.findForDocument(filename)[0];
}

type ProfileSource = 'document' | 'folder' | 'workspace' | 'none';

type ProfileResolution = {
  profile?: WorkflowProfile;
  source: ProfileSource;
  sourceLabel: string;
  sourceId?: string;
};

function resolveProfile(
  host: Host,
  settings: WorkflowSettings,
  filename: string,
  workspace: WorkspaceSummary | undefined,
  data: DocumentWorkflow,
): ProfileResolution {
  if (data.profileId === '__none__') return { source: 'document', sourceLabel: 'no workflow on this document', sourceId: filename };
  const documentProfile = profileById(settings, data.profileId);
  if (documentProfile) return { profile: documentProfile, source: 'document', sourceLabel: 'this document', sourceId: filename };

  if (workspace) {
    const path = host.workspaces.findContainerPathForDocument(workspace.filename, filename);
    for (const folder of [...path].reverse()) {
      const assignment = host.workspaces.readContainerPluginData<ContainerWorkflow>(workspace.filename, folder.id);
      if (assignment?.profileId === '__none__') return { source: 'folder', sourceLabel: `no workflow in folder ${folder.path}`, sourceId: folder.id };
      const folderProfile = profileById(settings, assignment?.profileId);
      if (folderProfile) return { profile: folderProfile, source: 'folder', sourceLabel: `folder ${folder.path}`, sourceId: folder.id };
    }

    const assignment = host.workspaces.readPluginData<WorkspaceWorkflow>(workspace.filename);
    if (assignment?.profileId === '__none__') return { source: 'workspace', sourceLabel: `no workflow in workspace ${workspace.title}`, sourceId: workspace.filename };
    const workspaceProfile = profileById(settings, assignment?.profileId);
    if (workspaceProfile) return { profile: workspaceProfile, source: 'workspace', sourceLabel: `workspace ${workspace.title}`, sourceId: workspace.filename };
  }

  return { source: 'none', sourceLabel: 'no workflow assigned' };
}

function contextForDocument(host: Host, filename: string, providedSettings?: WorkflowSettings, providedWorkspace?: WorkspaceSummary) {
  const settings = providedSettings || settingsFor(host);
  const workspace = providedWorkspace === undefined ? workspaceFor(host, filename) : providedWorkspace;
  const data = host.documents.readPluginData<DocumentWorkflow>(filename) || {};
  const resolution = resolveProfile(host, settings, filename, workspace, data);
  const profile = resolution.profile;
  const state = profile?.states.find((item) => item.id === data.state) || profile?.states[0];
  return { settings, workspace, profile, data, state, resolution };
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

function refreshTerminalState(profile: WorkflowProfile): void {
  profile.states = profile.states.map((state, index) => ({ ...state, terminal: index === profile.states.length - 1 }));
}

function actionValue(value: string | undefined, action: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch {
    throw new Error(`Invalid ${action} request`);
  }
}

function documentsUsingProfile(host: Host, settings: WorkflowSettings, profileId: string): DocumentSummary[] {
  return host.documents.list().filter((document) => contextForDocument(host, document.filename, settings).profile?.id === profileId);
}

function equivalentState(from: WorkflowProfile, stateId: string, to: WorkflowProfile): WorkflowState {
  const sourceIndex = from.states.findIndex((state) => state.id === stateId);
  const source = sourceIndex >= 0 ? from.states[sourceIndex] : undefined;
  return to.states.find((state) => source && state.label.localeCompare(source.label, undefined, { sensitivity: 'accent' }) === 0)
    || to.states[Math.max(0, Math.min(sourceIndex, to.states.length - 1))]
    || to.states[0];
}

type WorkflowSnapshot = { filename: string; profile?: WorkflowProfile; stateId?: string };

function workflowSnapshots(host: Host, settings: WorkflowSettings): WorkflowSnapshot[] {
  return host.documents.list().map((document) => {
    const context = contextForDocument(host, document.filename, settings);
    return { filename: document.filename, profile: context.profile, stateId: context.data.state };
  });
}

/** Keep an existing document at the closest matching stage after an inherited
 * workflow assignment changes. This is metadata migration, not a new edit. */
function reconcileWorkflowStates(host: Host, snapshots: WorkflowSnapshot[], settings: WorkflowSettings): void {
  for (const snapshot of snapshots) {
    if (!snapshot.stateId || !snapshot.profile) continue;
    const current = host.documents.readPluginData<DocumentWorkflow>(snapshot.filename);
    if (!current || current.state !== snapshot.stateId) continue;
    const next = contextForDocument(host, snapshot.filename, settings);
    if (!next.profile) {
      const { state: _state, ...withoutState } = current;
      host.documents.writePluginData(snapshot.filename, Object.keys(withoutState).length ? withoutState : null);
      continue;
    }
    if (next.profile.id === snapshot.profile.id || next.profile.states.some((state) => state.id === snapshot.stateId)) continue;
    host.documents.writePluginData(snapshot.filename, { ...current, state: equivalentState(snapshot.profile, snapshot.stateId, next.profile).id });
  }
}

function profileOptions(settings: WorkflowSettings, includeNone = false): Array<{ value: string; label: string }> {
  return [
    ...(includeNone ? [{ value: '__none__', label: 'No workflow' }] : []),
    ...settings.profiles.map((profile) => ({ value: profile.id, label: profile.name })),
  ];
}

function workflowPanel(host: Host, filename: string) {
  if (!filename) return { blocks: [{ type: 'notice', tone: 'warning', text: 'Open a document to set its workflow state.' }] };
  const { profile, state, resolution } = contextForDocument(host, filename);
  if (!profile || !state) {
    return {
      title: 'Workflow',
      blocks: [
        { type: 'heading', text: 'Document workflow', detail: 'No workflow' },
        { type: 'notice', tone: 'neutral', text: 'Assign a workflow from this document or its folder menu to set an editorial state.' },
      ],
    };
  }
  return {
    title: 'Workflow',
    blocks: [
      { type: 'heading', text: 'Document state', detail: profile.name },
      { type: 'notice', tone: 'neutral', text: `Using ${resolution.sourceLabel}.` },
      { type: 'select', id: 'set-state', label: 'Current state', value: state.id, options: profile.states.map((item) => ({ value: item.id, label: item.label, color: item.color })) },
    ],
  };
}

function workflowBoard(host: Host, filename: string) {
  if (!filename) return { blocks: [{ type: 'notice', tone: 'warning', text: 'Open a document in the workspace whose pipeline you want to view.' }] };
  const settings = settingsFor(host);
  const workspace = workspaceFor(host, filename);
  if (!workspace) return { blocks: [{ type: 'notice', tone: 'warning', text: 'This document is not in a workspace yet.' }] };
  const canonicalDocuments = new Map(host.documents.list().map((document) => [document.filename, document]));
  const workspaceDocs = host.workspaces.listDocuments(workspace.filename);
  const containers = host.workspaces.listContainers(workspace.filename);
  const groups = new Map<string, {
    id: string;
    label: string;
    detail: string;
    profile: WorkflowProfile;
    docs: WorkspaceDocumentSummary[];
  }>();

  for (const document of workspaceDocs) {
    const context = contextForDocument(host, document.filename, settings, workspace);
    if (!context.profile || !context.state) continue;
    const source = context.resolution;
    const groupKey = source.source === 'folder'
      ? `folder:${source.sourceId}`
      : source.source === 'document'
        ? `document:${context.profile.id}`
        : `workspace:${workspace.filename}`;
    const folder = source.source === 'folder' ? containers.find((item) => item.id === source.sourceId) : undefined;
    const label = source.source === 'folder'
      ? folder?.name || 'Folder workflow'
      : source.source === 'document'
        ? 'Individual documents'
        : workspace.title;
    const detail = source.source === 'folder'
      ? context.profile.name
      : source.source === 'document'
        ? `${context.profile.name} · document overrides`
        : `${context.profile.name} · workspace workflow`;
    const group = groups.get(groupKey) || { id: groupKey, label, detail, profile: context.profile, docs: [] };
    group.docs.push(document);
    groups.set(groupKey, group);
  }

  // Preserve deliberately configured folders even when they have no documents
  // yet. That makes the layout a faithful view of the workspace setup rather
  // than an incidental view of only non-empty columns.
  for (const folder of containers) {
    const assignment = host.workspaces.readContainerPluginData<ContainerWorkflow>(workspace.filename, folder.id);
    const profile = profileById(settings, assignment?.profileId);
    if (!profile) continue;
    const key = `folder:${folder.id}`;
    if (!groups.has(key)) groups.set(key, { id: key, label: folder.name, detail: profile.name, profile, docs: [] });
  }

  const boardGroups = [...groups.values()].map((group) => ({
    id: group.id,
    label: group.label,
    detail: group.detail,
    columns: group.profile.states.map((state) => ({
      id: `${group.id}::${state.id}`,
      label: state.label,
      color: state.color,
      items: group.docs.filter((document) => contextForDocument(host, document.filename, settings, workspace).state?.id === state.id)
        .map((document) => {
          // listDocuments projects the workspace title onto the item. Navigation
          // views use the primary document title, so use that same projection.
          const canonical = canonicalDocuments.get(document.filename);
          return { id: document.filename, title: canonical?.title || document.title };
        }),
    })),
  }));
  return {
    // Match Tree's hierarchy: the workspace is the primary collapsible group,
    // then only its configured workflow folders/document groups appear below.
    blocks: boardGroups.length
      ? [{ type: 'kanban', id: 'workflow-board', actions: { move: 'move-to-state' }, columns: [], groups: [{
        id: `workspace:${workspace.filename}`,
        kind: 'workspace',
        label: workspace.title,
        groups: boardGroups,
      }] }]
      : [{ type: 'notice', tone: 'neutral', text: 'No folders or documents in this workspace use a workflow.' }],
  };
}

function workflowOverview(host: Host, filename: string) {
  return workflowPanel(host, filename);
}

function workflowSettingsPanel(host: Host, filename: string) {
  const settings = settingsFor(host);
  const workspace = filename ? workspaceFor(host, filename) : undefined;
  const profileId = settings.settingsProfileId && settings.profiles.some((profile) => profile.id === settings.settingsProfileId)
    ? settings.settingsProfileId
    : settings.profiles[0].id;
  const profile = settings.profiles.find((item) => item.id === profileId) || settings.profiles[0];
  const workspaceAssignment = workspace ? host.workspaces.readPluginData<WorkspaceWorkflow>(workspace.filename) : undefined;
  return {
    title: 'Workflow settings',
    blocks: [
      { type: 'heading', text: 'Workflow profiles', detail: 'Profiles can be reused by any workspace.' },
      { type: 'select', id: 'settings-profile', label: 'Edit profile', value: profile.id, options: settings.profiles.map((item) => ({ value: item.id, label: item.name })) },
      { type: 'text', id: 'settings-profile-name', label: 'Profile name', value: profile.name },
      {
        type: 'sequence',
        id: 'settings-stages',
        label: 'Pipeline stages',
        help: 'Rename stages in place, or click a color swatch to change its board color. The final stage is treated as complete.',
        items: profile.states.map((item, index) => ({
          id: item.id,
          label: item.label,
          color: item.color,
          detail: index === profile.states.length - 1 ? 'Complete stage' : undefined,
          removable: profile.states.length > 2,
        })),
        actions: {
          rename: 'settings-stage-rename',
          setColor: 'settings-stage-color',
          move: 'settings-stage-move',
          remove: 'settings-stage-remove',
          add: 'settings-stage-add',
          addLabel: 'Add stage',
        },
      },
      {
        type: 'buttons',
        id: 'settings-profile-actions',
        buttons: [
          { id: 'settings-add-profile', label: 'Add workflow', tone: 'default', opensForm: 'settings-new-profile' },
          {
            id: 'settings-delete-profile',
            label: 'Delete workflow',
            tone: 'danger',
            disabled: settings.profiles.length <= 1,
            ...(settings.profiles.length > 1 ? (() => {
              const replacement = replacementForDeletedProfile(settings, profile.id)!;
              return {
                confirm: {
                  title: `Delete “${profile.name}”?`,
                  message: `Workspaces using it will move to ${replacement.name}. Their documents will keep an equivalent stage where one is available.`,
                  confirmLabel: 'Delete workflow',
                },
              };
            })() : {}),
          },
        ],
      },
      {
        type: 'form',
        id: 'settings-new-profile',
        title: 'New workflow',
        detail: 'Name the workflow before adding it. You can edit its starter stages next.',
        fields: [
          { id: 'name', label: 'Workflow name', placeholder: 'e.g. Novel revision', required: true },
        ],
        submit: { id: 'settings-add-profile', label: 'Create workflow', tone: 'primary' },
        cancelLabel: 'Cancel',
      },
      ...(workspace ? [
        { type: 'heading' as const, text: 'This workspace', detail: workspace.title },
        {
          type: 'select' as const,
          id: 'settings-workspace-profile',
          label: 'Workspace workflow',
          value: workspaceAssignment?.profileId || '__none__',
          options: profileOptions(settings, true),
          help: 'Leave this unassigned when only selected folders need a workflow.',
        },
      ] : [{ type: 'notice' as const, tone: 'warning' as const, text: 'Open a document inside a workspace to assign that workspace a profile.' }]),
    ],
  };
}

function setDocumentState(host: Host, filename: string, stateId: string): DocumentWorkflow {
  const { profile, data } = contextForDocument(host, filename);
  if (!profile) throw new Error('Assign a workflow before choosing a state');
  if (!profile.states.some((state) => state.id === stateId)) throw new Error(`"${stateId}" is not a state in the ${profile.name} workflow`);
  const next = { ...data, state: stateId, updatedAt: new Date().toISOString() };
  host.documents.writePluginData(filename, next);
  host.notify.documentsChanged();
  return next;
}

function setDocumentProfile(host: Host, filename: string, profileId: string): DocumentWorkflow {
  const settings = settingsFor(host);
  const before = contextForDocument(host, filename, settings);
  const data = before.data;
  let next: DocumentWorkflow;

  if (profileId === '__inherit__') {
    const { profileId: _profileId, ...inherited } = data;
    next = inherited;
  } else if (profileId === '__none__') {
    next = { ...data, profileId: '__none__' };
  } else {
    if (!profileById(settings, profileId)) throw new Error('Workflow profile not found');
    next = { ...data, profileId };
  }

  host.documents.writePluginData(filename, Object.keys(next).length ? next : null);
  reconcileWorkflowStates(host, [{ filename, profile: before.profile, stateId: data.state }], settings);
  host.notify.documentsChanged();
  return host.documents.readPluginData<DocumentWorkflow>(filename) || {};
}

function setWorkspaceProfile(host: Host, workspaceFile: string, profileId: string): WorkspaceWorkflow {
  const settings = settingsFor(host);
  if (!host.workspaces.list().some((workspace) => workspace.filename === workspaceFile)) throw new Error('Workspace not found');
  if (profileId !== '__none__' && !profileById(settings, profileId)) throw new Error('Workflow profile not found');
  const snapshots = workflowSnapshots(host, settings);
  const next = { profileId };
  host.workspaces.writePluginData<WorkspaceWorkflow>(workspaceFile, next);
  reconcileWorkflowStates(host, snapshots, settings);
  host.notify.workspacesChanged();
  host.notify.documentsChanged();
  return next;
}

function setFolderProfile(host: Host, workspaceFile: string, folderId: string, profileId: string): ContainerWorkflow {
  const settings = settingsFor(host);
  if (!host.workspaces.listContainers(workspaceFile).some((folder) => folder.id === folderId)) throw new Error('Workspace folder not found');
  if (profileId !== '__inherit__' && profileId !== '__none__' && !profileById(settings, profileId)) throw new Error('Workflow profile not found');
  const snapshots = workflowSnapshots(host, settings);
  const next = profileId === '__inherit__' ? null : { profileId };
  host.workspaces.writeContainerPluginData<ContainerWorkflow>(workspaceFile, folderId, next);
  reconcileWorkflowStates(host, snapshots, settings);
  host.notify.workspacesChanged();
  host.notify.documentsChanged();
  return next || {};
}

function updateSettings(host: Host, action: string, value: string | undefined, filename: string): void {
  const settings = settingsFor(host);
  const selectedId = settings.settingsProfileId && settings.profiles.some((profile) => profile.id === settings.settingsProfileId)
    ? settings.settingsProfileId
    : settings.profiles[0].id;
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
    // Retained as the compact programmatic/API representation. The human UI
    // uses the structured ordered stage controls above.
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
  } else if (action === 'settings-stage-add') {
    const existing = new Set(selected.states.map((state) => state.id));
    const id = uniqueId('new-stage', existing);
    const insertAt = Math.max(selected.states.length - 1, 0);
    selected.states.splice(insertAt, 0, {
      id,
      label: 'New stage',
      color: COLORS[insertAt % COLORS.length],
    });
    refreshTerminalState(selected);
  } else if (action === 'settings-stage-rename') {
    const payload = actionValue(value, 'stage rename');
    const stateId = typeof payload.id === 'string' ? payload.id : '';
    const label = typeof payload.label === 'string' ? payload.label.trim() : '';
    const state = selected.states.find((item) => item.id === stateId);
    if (!state || !label) throw new Error('A stage needs a name');
    if (selected.states.some((item) => item.id !== stateId && item.label.localeCompare(label, undefined, { sensitivity: 'accent' }) === 0)) {
      throw new Error('Stage names must be distinct within a workflow');
    }
    state.label = label;
  } else if (action === 'settings-stage-color') {
    const payload = actionValue(value, 'stage color');
    const stateId = typeof payload.id === 'string' ? payload.id : '';
    const color = typeof payload.color === 'string' ? payload.color : '';
    const state = selected.states.find((item) => item.id === stateId);
    if (!state) throw new Error('Workflow stage not found');
    if (!/^#[0-9a-f]{6}$/i.test(color)) throw new Error('Choose a valid stage color');
    state.color = color.toLowerCase();
  } else if (action === 'settings-stage-move') {
    const payload = actionValue(value, 'stage movement');
    const stateId = typeof payload.id === 'string' ? payload.id : '';
    const direction = payload.direction;
    const index = selected.states.findIndex((item) => item.id === stateId);
    const target = direction === 'up' ? index - 1 : direction === 'down' ? index + 1 : -1;
    if (index < 0 || target < 0 || target >= selected.states.length) throw new Error('That stage cannot be moved further');
    [selected.states[index], selected.states[target]] = [selected.states[target], selected.states[index]];
    refreshTerminalState(selected);
  } else if (action === 'settings-stage-remove') {
    const index = selected.states.findIndex((item) => item.id === value);
    if (selected.states.length <= 2) throw new Error('A workflow needs at least two stages');
    if (index < 0) throw new Error('Workflow stage not found');
    const [removed] = selected.states.splice(index, 1);
    const replacement = selected.states[index] || selected.states[index - 1];
    for (const document of documentsUsingProfile(host, settings, selected.id)) {
      const documentData = host.documents.readPluginData<DocumentWorkflow>(document.filename);
      if (documentData?.state === removed.id) {
        host.documents.writePluginData(document.filename, { ...documentData, state: replacement.id, updatedAt: new Date().toISOString() });
      }
    }
    refreshTerminalState(selected);
    host.notify.documentsChanged();
  } else if (action === 'settings-add-profile') {
    const payload = actionValue(value, 'workflow creation');
    const name = typeof payload.name === 'string' ? payload.name.trim() : '';
    if (!name) throw new Error('A workflow needs a name');
    if (settings.profiles.some((profile) => profile.name.localeCompare(name, undefined, { sensitivity: 'accent' }) === 0)) {
      throw new Error('Workflow names must be distinct');
    }
    const existing = new Set(settings.profiles.map((profile) => profile.id));
    const id = uniqueId(slug(name), existing);
    settings.profiles.push({
      id,
      name,
      states: [
        { id: 'draft', label: 'Draft', color: COLORS[0] },
        { id: 'review', label: 'Review', color: COLORS[1] },
        { id: 'complete', label: 'Complete', color: COLORS[5], terminal: true },
      ],
    });
    settings.settingsProfileId = id;
  } else if (action === 'settings-delete-profile') {
    if (settings.profiles.length <= 1) throw new Error('Keep at least one workflow profile');
    const removed = selected;
    const remaining = settings.profiles.filter((profile) => profile.id !== removed.id);
    const replacement = replacementForDeletedProfile(settings, removed.id)!;
    const snapshots = workflowSnapshots(host, settings);
    for (const workspace of host.workspaces.list()) {
      const assignment = host.workspaces.readPluginData<WorkspaceWorkflow>(workspace.filename);
      if (assignment?.profileId === removed.id) host.workspaces.writePluginData(workspace.filename, { ...assignment, profileId: replacement.id });
      for (const folder of host.workspaces.listContainers(workspace.filename)) {
        const folderAssignment = host.workspaces.readContainerPluginData<ContainerWorkflow>(workspace.filename, folder.id);
        if (folderAssignment?.profileId === removed.id) {
          host.workspaces.writeContainerPluginData(workspace.filename, folder.id, { ...folderAssignment, profileId: replacement.id });
        }
      }
    }
    for (const document of host.documents.list()) {
      const documentData = host.documents.readPluginData<DocumentWorkflow>(document.filename);
      if (documentData?.profileId === removed.id) host.documents.writePluginData(document.filename, { ...documentData, profileId: replacement.id });
    }
    settings.profiles = remaining;
    settings.settingsProfileId = replacement.id;
    reconcileWorkflowStates(host, snapshots, settings);
    host.notify.workspacesChanged();
    host.notify.documentsChanged();
  } else if (action === 'settings-workspace-profile') {
    const workspace = workspaceFor(host, filename);
    if (!workspace) throw new Error('Open a document inside a workspace first');
    setWorkspaceProfile(host, workspace.filename, value || '');
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
        const { workspace, profile, data, state, resolution } = contextForDocument(host, target);
        return { filename: target, workspace, profile: profile?.name || null, profileId: profile?.id || null, profileSource: resolution.source, profileSourceLabel: resolution.sourceLabel, state: state || null, updatedAt: data.updatedAt || null };
      },
    },
    {
      name: 'workflow_set_state',
      description: 'Set a document’s workflow state after validating it against its effective workflow profile.',
      inputSchema: { type: 'object', properties: { filename: { type: 'string' }, state: { type: 'string' } }, required: ['filename', 'state'] },
      handler: async (params: Record<string, unknown>) => ({ filename: String(params.filename), ...setDocumentState(host, String(params.filename), String(params.state)) }),
    },
    {
      name: 'workflow_advance_state',
      description: 'Move a document to the next state in its effective workflow profile.',
      inputSchema: { type: 'object', properties: { filename: { type: 'string' } }, required: ['filename'] },
      handler: async (params: Record<string, unknown>) => {
        const target = String(params.filename);
        const { profile, state } = contextForDocument(host, target);
        if (!profile || !state) throw new Error('Assign a workflow before advancing a state');
        const index = profile.states.findIndex((item) => item.id === state.id);
        const next = profile.states[index + 1];
        if (!next) throw new Error(`${state.label} is already the final workflow state`);
        return { filename: target, ...setDocumentState(host, target, next.id) };
      },
    },
    {
      name: 'workflow_list_documents_by_state',
      description: 'List documents in a workflow state, optionally limited to one workspace or workflow profile.',
      inputSchema: { type: 'object', properties: { state: { type: 'string' }, workspaceFile: { type: 'string' }, profileId: { type: 'string' } }, required: ['state'] },
      handler: async (params: Record<string, unknown>) => {
        const requested = String(params.state);
        const workspace = params.workspaceFile ? String(params.workspaceFile) : undefined;
        const requestedProfile = params.profileId ? String(params.profileId) : undefined;
        const settings = settingsFor(host);
        const documents = host.documents.list().filter((document) => {
          const memberships = host.workspaces.findForDocument(document.filename);
          const matchingWorkspace = workspace ? memberships.find((item) => item.filename === workspace) : memberships[0];
          if (workspace && !matchingWorkspace) return false;
          const context = contextForDocument(host, document.filename, settings, matchingWorkspace);
          const profile = context.profile;
          const state = context.state;
          if (!profile || !state) return false;
          return (!requestedProfile || profile.id === requestedProfile) && state.id === requested;
        });
        return { state: requested, workspaceFile: workspace || null, profileId: requestedProfile || null, documents };
      },
    },
    {
      name: 'workflow_set_workspace_profile',
      description: 'Set a workspace workflow default. Folders and documents can explicitly use another workflow when needed.',
      inputSchema: { type: 'object', properties: { workspaceFile: { type: 'string' }, profileId: { type: 'string' } }, required: ['workspaceFile', 'profileId'] },
      handler: async (params: Record<string, unknown>) => {
        const workspaceFile = String(params.workspaceFile);
        const profileId = String(params.profileId);
        return { workspaceFile, ...setWorkspaceProfile(host, workspaceFile, profileId) };
      },
    },
    {
      name: 'workflow_set_folder_profile',
      description: 'Set a workflow for one folder. Its documents use it unless they have their own workflow. Use "__inherit__" to return the folder to its workspace workflow.',
      inputSchema: { type: 'object', properties: { workspaceFile: { type: 'string' }, folderId: { type: 'string' }, profileId: { type: 'string' } }, required: ['workspaceFile', 'folderId', 'profileId'] },
      handler: async (params: Record<string, unknown>) => {
        const workspaceFile = String(params.workspaceFile);
        const folderId = String(params.folderId);
        const profileId = String(params.profileId);
        return { workspaceFile, folderId, ...setFolderProfile(host, workspaceFile, folderId, profileId) };
      },
    },
    {
      name: 'workflow_set_document_profile',
      description: 'Set an explicit workflow profile for one document. Use "__inherit__" to follow its folder or workspace workflow again.',
      inputSchema: { type: 'object', properties: { filename: { type: 'string' }, profileId: { type: 'string' } }, required: ['filename', 'profileId'] },
      handler: async (params: Record<string, unknown>) => {
        const filename = String(params.filename);
        const profileId = String(params.profileId);
        return { filename, ...setDocumentProfile(host, filename, profileId) };
      },
    },
  ];
}

function workflowSidebarMenu(host: Host, target: SidebarTarget): SidebarMenuItem[] {
  const settings = settingsFor(host);
  const profiles = settings.profiles;
  const profileItems = (actionPrefix: string): SidebarMenuItem[] => profiles.map((profile) => ({ label: profile.name, action: `workflows:${actionPrefix}:${profile.id}`, target: target.type, menuGroup: 'Workflow' }));
  if (target.type === 'document' && target.filename) {
    const context = contextForDocument(host, target.filename, settings);
    return [
      { label: `Current: ${context.profile?.name || 'No workflow'}`, detail: context.resolution.sourceLabel, action: 'workflows:status', disabled: true, target: 'document', menuGroup: 'Workflow' },
      { label: 'No workflow', action: 'workflows:document-none', target: 'document', menuGroup: 'Workflow' },
      { label: 'Follow folder or workspace', action: 'workflows:document-inherit', target: 'document', menuGroup: 'Workflow' },
      ...profileItems('document-profile'),
    ];
  }
  if (target.type === 'folder' && target.workspaceFile && target.containerId) {
    const assignment = host.workspaces.readContainerPluginData<ContainerWorkflow>(target.workspaceFile, target.containerId);
    const profile = profileById(settings, assignment?.profileId);
    const label = profile?.name || (assignment?.profileId === '__none__' ? 'No workflow' : 'Inherited');
    return [
      { label: `Current: ${label}`, detail: profile ? 'assigned to this folder' : assignment?.profileId === '__none__' ? 'folder explicitly excluded' : 'no folder assignment', action: 'workflows:status', disabled: true, target: 'folder', menuGroup: 'Workflow' },
      { label: 'No workflow', action: 'workflows:folder-none', target: 'folder', menuGroup: 'Workflow' },
      { label: 'Follow parent or workspace', action: 'workflows:folder-inherit', target: 'folder', menuGroup: 'Workflow' },
      ...profileItems('folder-profile'),
    ];
  }
  if (target.type === 'workspace' && target.workspaceFile) {
    const assignment = host.workspaces.readPluginData<WorkspaceWorkflow>(target.workspaceFile);
    const profile = profileById(settings, assignment?.profileId);
    return [
      { label: `Current: ${profile?.name || 'No workflow'}`, detail: profile ? 'assigned to this workspace' : 'folders can opt into a workflow instead', action: 'workflows:status', disabled: true, target: 'workspace', menuGroup: 'Workflow' },
      { label: 'No workflow', action: 'workflows:workspace-none', target: 'workspace', menuGroup: 'Workflow' },
      ...profiles.map((item) => ({ label: item.name, action: `workflows:workspace-profile:${item.id}`, target: 'workspace' as const, menuGroup: 'Workflow' })),
    ];
  }
  return [];
}

const plugin: Plugin = {
  name: PLUGIN_NAME,
  version: '0.1.0',
  description: 'Reusable editorial and publishing workflow states, separate from document lifecycle status.',
  category: 'writing',
  sidebarMenuItems: (host) => [
    { label: 'No workflow', action: 'workflows:document-none', target: 'document', menuGroup: 'Workflow' },
    { label: 'Follow folder or workspace', action: 'workflows:document-inherit', target: 'document', menuGroup: 'Workflow' },
    ...settingsFor(host).profiles.map((profile) => ({ label: profile.name, action: `workflows:document-profile:${profile.id}`, target: 'document' as const, menuGroup: 'Workflow' })),
  ],
  sidebarMenuItemsForTarget: workflowSidebarMenu,
  uiContributions: () => [
    { id: 'overview', label: 'Workflow', scope: 'document', endpoint: '/api/workflows/panel', icon: 'pipeline', order: 5, surface: 'rail' },
    { id: 'pipeline-layout', label: 'Workflow', scope: 'workspace', endpoint: '/api/workflows/board', icon: 'pipeline', order: 5, surface: 'sidebar-layout' },
    { id: 'settings', label: 'Workflow settings', scope: 'settings', endpoint: '/api/workflows/settings', icon: 'settings', order: 7, surface: 'plugins' },
  ],
  // Workflow state is deliberately shown in the Workflow panel, not as a
  // sidebar badge. Resolving a badge for every document would repeatedly walk
  // workspace trees during sidebar refreshes, which makes a large manuscript
  // feel slower and crowds the document list with operational metadata.
  registerRoutes({ app, host }) {
    app.post('/api/workflows/sidebar-action', (req: Request, res: Response) => {
      try {
        const action = String(req.body?.action || '');
        const target = req.body?.target as { type?: string; workspaceFile?: string; containerId?: string } | undefined;
        if (action === 'document-inherit') {
          if (target?.type !== 'document' || !req.body?.filename) throw new Error('Choose a document workflow target');
          res.json({ success: true, filename: req.body.filename, ...setDocumentProfile(host, String(req.body.filename), '__inherit__') });
          return;
        }
        if (action === 'document-none') {
          if (target?.type !== 'document' || !req.body?.filename) throw new Error('Choose a document workflow target');
          res.json({ success: true, filename: req.body.filename, ...setDocumentProfile(host, String(req.body.filename), '__none__') });
          return;
        }
        if (action.startsWith('document-profile:')) {
          if (target?.type !== 'document' || !req.body?.filename) throw new Error('Choose a document workflow target');
          const profileId = action.slice('document-profile:'.length);
          res.json({ success: true, filename: req.body.filename, ...setDocumentProfile(host, String(req.body.filename), profileId) });
          return;
        }
        if (action === 'folder-inherit') {
          if (target?.type !== 'folder' || !target.workspaceFile || !target.containerId) throw new Error('Choose a folder workflow target');
          res.json({ success: true, workspaceFile: target.workspaceFile, folderId: target.containerId, ...setFolderProfile(host, target.workspaceFile, target.containerId, '__inherit__') });
          return;
        }
        if (action === 'folder-none') {
          if (target?.type !== 'folder' || !target.workspaceFile || !target.containerId) throw new Error('Choose a folder workflow target');
          res.json({ success: true, workspaceFile: target.workspaceFile, folderId: target.containerId, ...setFolderProfile(host, target.workspaceFile, target.containerId, '__none__') });
          return;
        }
        if (action.startsWith('folder-profile:')) {
          if (target?.type !== 'folder' || !target.workspaceFile || !target.containerId) throw new Error('Choose a folder workflow target');
          const profileId = action.slice('folder-profile:'.length);
          res.json({ success: true, workspaceFile: target.workspaceFile, folderId: target.containerId, ...setFolderProfile(host, target.workspaceFile, target.containerId, profileId) });
          return;
        }
        if (action === 'workspace-none') {
          if (target?.type !== 'workspace' || !target.workspaceFile) throw new Error('Choose a workspace workflow target');
          res.json({ success: true, workspaceFile: target.workspaceFile, ...setWorkspaceProfile(host, target.workspaceFile, '__none__') });
          return;
        }
        if (action.startsWith('workspace-profile:')) {
          if (target?.type !== 'workspace' || !target.workspaceFile) throw new Error('Choose a workspace workflow target');
          const profileId = action.slice('workspace-profile:'.length);
          res.json({ success: true, workspaceFile: target.workspaceFile, ...setWorkspaceProfile(host, target.workspaceFile, profileId) });
          return;
        }
        throw new Error('Unknown workflow sidebar action');
      } catch (err: any) {
        res.status(400).json({ error: err?.message || 'Unable to update workflow' });
      }
    });
    app.get('/api/workflows/overview', (req: Request, res: Response) => {
      try { res.json(workflowOverview(host, String(req.query.filename || ''))); }
      catch (err: any) { res.status(400).json({ error: err?.message || 'Unable to load workflow' }); }
    });
    app.post('/api/workflows/overview', (req: Request, res: Response) => {
      try {
        const filename = String(req.body.filename || '');
        if (req.body?.action === 'set-state') setDocumentState(host, filename, String(req.body.value || ''));
        else if (req.body?.action === 'set-document-profile') setDocumentProfile(host, filename, String(req.body.value || ''));
        else throw new Error('Unknown workflow action');
        res.json({ success: true });
      } catch (err: any) { res.status(400).json({ error: err?.message || 'Unable to update workflow state' }); }
    });
    app.get('/api/workflows/panel', (req: Request, res: Response) => {
      try { res.json(workflowPanel(host, String(req.query.filename || ''))); }
      catch (err: any) { res.status(400).json({ error: err?.message || 'Unable to load workflow state' }); }
    });
    app.post('/api/workflows/panel', (req: Request, res: Response) => {
      try {
        const filename = String(req.body.filename || '');
        if (req.body?.action === 'set-state') setDocumentState(host, filename, String(req.body.value || ''));
        else if (req.body?.action === 'set-document-profile') setDocumentProfile(host, filename, String(req.body.value || ''));
        else throw new Error('Unknown workflow action');
        res.json({ success: true });
      } catch (err: any) { res.status(400).json({ error: err?.message || 'Unable to update workflow state' }); }
    });
    app.get('/api/workflows/board', (req: Request, res: Response) => {
      try { res.json(workflowBoard(host, String(req.query.filename || ''))); }
      catch (err: any) { res.status(400).json({ error: err?.message || 'Unable to load workflow board' }); }
    });
    app.post('/api/workflows/board', (req: Request, res: Response) => {
      try {
        if (req.body?.action !== 'move-to-state') throw new Error('Unknown workflow action');
        const value = actionValue(typeof req.body?.value === 'string' ? req.body.value : undefined, 'workflow movement');
        const documentFilename = typeof value.itemId === 'string' ? value.itemId : '';
        const encodedColumnId = typeof value.columnId === 'string' ? value.columnId : '';
        const stateId = encodedColumnId.includes('::') ? encodedColumnId.split('::').pop()! : encodedColumnId;
        if (!documentFilename || !stateId) throw new Error('Choose a document and destination state');
        setDocumentState(host, documentFilename, stateId);
        res.json({ success: true });
      } catch (err: any) { res.status(400).json({ error: err?.message || 'Unable to move the document' }); }
    });
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
