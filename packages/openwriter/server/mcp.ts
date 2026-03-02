/**
 * MCP stdio server: tool registry + stdio transport.
 * Uses compact wire format for token efficiency.
 * Exports TOOL_REGISTRY for HTTP proxy (multi-session support).
 */

import { join } from 'path';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { randomUUID } from 'crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { DATA_DIR, ensureDataDir, resolveDocPath } from './helpers.js';
import {
  getDocument,
  getWordCount,
  getPendingChangeCount,
  getTitle,
  getStatus,
  getNodesByIds,
  getMetadata,
  setMetadata,
  applyChanges,
  applyTextEdits,
  updateDocument,
  save,
  markAllNodesAsPending,
  setAgentLock,
  updatePendingCacheForActiveDoc,
  populateDocumentFile,
  applyChangesToFile,
  applyTextEditsToFile,
  getDocId,
  getFilePath,
  type NodeChange,
} from './state.js';
import { listDocuments, switchDocument, createDocument, deleteDocument, openFile, getActiveFilename, updateDocumentTitle, promoteTempFile, archiveDocument, unarchiveDocument, resolveDocId } from './documents.js';
import { broadcastDocumentSwitched, broadcastDocumentsChanged, broadcastWorkspacesChanged, broadcastTitleChanged, broadcastMetadataChanged, broadcastPendingDocsChanged, broadcastWritingStarted, broadcastWritingFinished } from './ws.js';
import { listWorkspaces, getWorkspace, getDocTitle, getItemContext, addDoc, updateWorkspaceContext, createWorkspace, deleteWorkspace, addContainerToWorkspace, findOrCreateWorkspace, findOrCreateContainer, moveDoc, renameWorkspace, renameContainer } from './workspaces.js';
import { addDocTag, removeDocTag, getDocTagsByFilename, getCachedDocument } from './state.js';
import type { WorkspaceNode } from './workspace-types.js';
import { importGoogleDoc } from './gdoc-import.js';
import { toCompactFormat, compactNodes, parseMarkdownContent, mergeParagraphsToHardBreaks } from './compact.js';
import matter from 'gray-matter';
import { getUpdateInfo } from './update-check.js';
import { listVersions, forceSnapshot, restoreVersion } from './versions.js';
import { markdownToTiptap } from './markdown.js';
import { getMarks, getMarkCount, getGlobalMarkSummary, resolveMarks } from './marks.js';
import { broadcastMarksChanged } from './ws.js';


/** Check if a document is in tweet compose mode (has tweetContext metadata). */
function isTweetDoc(filename: string | undefined): boolean {
  if (!filename || filename === getActiveFilename()) {
    return !!getMetadata()?.tweetContext;
  }
  const targetPath = resolveDocPath(filename);
  const cached = getCachedDocument(targetPath);
  if (cached) return !!cached.metadata?.tweetContext;
  try {
    const raw = readFileSync(targetPath, 'utf-8');
    const { data } = matter(raw);
    return !!data?.tweetContext;
  } catch { return false; }
}

export type ToolResult = { content: { type: 'text'; text: string }[] };

export interface ToolDef {
  name: string;
  description: string;
  schema: Record<string, z.ZodTypeAny>;
  handler: (args: any) => Promise<ToolResult>;
}

export const TOOL_REGISTRY: ToolDef[] = [
  {
    name: 'read_pad',
    description: 'Read the current document. Returns compact tagged-line format with [type:id] per node, inline markdown formatting. Much more token-efficient than JSON.',
    schema: {},
    handler: async () => {
      const doc = getDocument();
      const compact = toCompactFormat(doc, getTitle(), getWordCount(), getPendingChangeCount(), getDocId());
      const activeFile = getActiveFilename();
      const localCount = getMarkCount(activeFile);
      const { totalMarks: otherMarks, docCount: otherDocs } = getGlobalMarkSummary(activeFile);
      let hint = '';
      if (localCount > 0) hint += `\n[${localCount} agent mark${localCount !== 1 ? 's' : ''} on this document]`;
      if (otherMarks > 0) hint += `\n[${otherMarks} agent mark${otherMarks !== 1 ? 's' : ''} on ${otherDocs} other document${otherDocs !== 1 ? 's' : ''}]`;
      if (hint) hint += '\n[call get_agent_marks to review]';
      return { content: [{ type: 'text', text: compact + hint }] };
    },
  },
  {
    name: 'write_to_pad',
    description: 'Preferred tool for all document edits. Send 3-8 changes per call for responsive feel. Multiple rapid calls better than one monolithic call. Content can be a markdown string (preferred) or TipTap JSON. Markdown strings are auto-converted. Changes appear as pending decorations the user accepts or rejects. Use afterNodeId: "end" to append to the document without knowing node IDs. Response includes lastNodeId for chaining subsequent inserts. Target document by docId (8-char hex from list_documents or read_pad).',
    schema: {
      changes: z.array(z.object({
        operation: z.enum(['rewrite', 'insert', 'delete']),
        nodeId: z.string().optional(),
        afterNodeId: z.string().optional(),
        content: z.any().optional(),
      })).describe('Array of node changes. Content accepts markdown strings or TipTap JSON.'),
      docId: z.string().describe('Target document by docId (8-char hex from list_documents or read_pad).'),
    },
    handler: async ({ changes, docId }: { changes: any[]; docId: string }) => {
      const filename = resolveDocId(docId);
      const tweetMode = isTweetDoc(filename);
      const processed = changes.map((change) => {
        const resolved = { ...change };
        if (typeof resolved.content === 'string') {
          let nodes = parseMarkdownContent(resolved.content);
          if (tweetMode) nodes = mergeParagraphsToHardBreaks(nodes);
          resolved.content = nodes;
        }
        return resolved;
      });

      const targetIsNonActive = filename && filename !== getActiveFilename();
      if (targetIsNonActive) {
        const { count: appliedCount, lastNodeId } = applyChangesToFile(filename, processed as NodeChange[]);
        broadcastPendingDocsChanged();
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              success: appliedCount > 0,
              appliedCount,
              ...(lastNodeId ? { lastNodeId } : {}),
              ...(appliedCount < processed.length ? { skipped: processed.length - appliedCount } : {}),
            }),
          }],
        };
      }

      const { count: appliedCount, lastNodeId } = applyChanges(processed as NodeChange[]);
      // broadcastPendingDocsChanged() already fires via onChanges listener in ws.ts
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: appliedCount > 0,
            appliedCount,
            ...(lastNodeId ? { lastNodeId } : {}),
            ...(appliedCount < processed.length ? { skipped: processed.length - appliedCount } : {}),
          }),
        }],
      };
    },
  },
  {
    name: 'get_pad_status',
    description: 'Get the current status of the pad: word count, pending changes. Cheap call for polling.',
    schema: {},
    handler: async () => {
      const status = getStatus();
      const latestVersion = getUpdateInfo();
      const payload = latestVersion ? { ...status, updateAvailable: latestVersion } : status;
      return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
    },
  },
  {
    name: 'get_nodes',
    description: 'Get specific nodes by ID. Returns compact tagged-line format per node.',
    schema: {
      nodeIds: z.array(z.string()).describe('Array of node IDs to retrieve'),
    },
    handler: async ({ nodeIds }: { nodeIds: string[] }) => {
      return { content: [{ type: 'text', text: compactNodes(getNodesByIds(nodeIds)) }] };
    },
  },
  {
    name: 'list_documents',
    description: 'List all documents. Shows title, docId (8-char hex), word count, last modified date, and which document is active. Use the docId to target documents in other tools.',
    schema: {},
    handler: async () => {
      const docs = listDocuments();
      const lines = docs.map((d) => {
        const active = d.isActive ? ' (active)' : '';
        const id = d.docId ? ` [${d.docId}]` : '';
        const date = d.lastModified.split('T')[0];
        return `  "${d.title}"${id}${active} — ${d.wordCount.toLocaleString()} words — ${date}`;
      });
      return { content: [{ type: 'text', text: `documents:\n${lines.join('\n') || '  (none)'}` }] };
    },
  },
  {
    name: 'switch_document',
    description: 'Switch to a different document. Saves the current document first. Returns a compact read of the newly active document. Target document by docId (8-char hex from list_documents or read_pad).',
    schema: {
      docId: z.string().describe('Target document by docId (8-char hex from list_documents or read_pad).'),
    },
    handler: async ({ docId }: { docId: string }) => {
      const filename = resolveDocId(docId);
      broadcastWritingFinished(); // Clear any in-progress creation spinner
      const result = switchDocument(filename);
      broadcastDocumentSwitched(result.document, result.title, result.filename);
      const compact = toCompactFormat(result.document, result.title, getWordCount(), getPendingChangeCount(), getDocId());
      return { content: [{ type: 'text', text: `Switched to "${result.title}" [${docId}]\n\n${compact}` }] };
    },
  },
  {
    name: 'create_document',
    description: 'Create a new empty document and switch to it. Always provide a title. Saves the current document first. By default shows a sidebar spinner that persists until populate_document is called — set empty=true to skip the spinner and switch immediately (use for template docs like tweets/articles that don\'t need agent content). If workspace is provided, the doc is automatically added to it (workspace is created if it doesn\'t exist). If container is also provided, the doc is placed inside that container (created if it doesn\'t exist).',
    schema: {
      title: z.string().optional().describe('Title for the new document. Defaults to "Untitled".'),
      path: z.string().optional().describe('Absolute file path to create the document at (e.g. "C:/projects/doc.md"). If omitted, creates in ~/.openwriter/.'),
      workspace: z.string().optional().describe('Workspace title to add this doc to. Creates the workspace if it doesn\'t exist.'),
      container: z.string().optional().describe('Container name within the workspace (e.g. "Chapters", "Notes", "References"). Creates the container if it doesn\'t exist. Requires workspace.'),
      empty: z.boolean().optional().describe('If true, skip the writing spinner and switch to the doc immediately. No need to call populate_document. Use for template docs (tweets, articles) that start empty.'),
    },
    handler: async ({ title, path, workspace, container, empty }: { title?: string; path?: string; workspace?: string; container?: string; empty?: boolean }) => {
      // Resolve workspace/container up front so spinner renders in the right place
      let wsTarget: { wsFilename: string; containerId: string | null } | undefined;
      if (workspace) {
        const ws = findOrCreateWorkspace(workspace);
        let containerId: string | null = null;
        if (container) {
          const c = findOrCreateContainer(ws.filename, container);
          containerId = c.containerId;
        }
        wsTarget = { wsFilename: ws.filename, containerId };
        broadcastWorkspacesChanged(); // Browser sees container structure before spinner
      }

      if (!empty) {
        broadcastWritingStarted(title || 'Untitled', wsTarget);
        // Yield so the browser receives and renders the spinner before heavy work
        await new Promise((resolve) => setTimeout(resolve, 200));
      }

      try {
        // Lock browser doc-updates: prevents race where browser sends a doc-update
        // for the previous document but server has already switched active doc.
        setAgentLock();
        const result = createDocument(title, undefined, path);

        // Auto-add to workspace if specified
        let wsInfo = '';
        if (wsTarget) {
          addDoc(wsTarget.wsFilename, wsTarget.containerId, result.filename, result.title);
          wsInfo = ` → workspace "${workspace}"${container ? ` / ${container}` : ''}`;
        }

        const newDocId = getDocId();

        if (empty) {
          // Immediate switch — no spinner, no populate_document needed
          save();
          broadcastDocumentsChanged();
          broadcastWorkspacesChanged();
          broadcastDocumentSwitched(getDocument(), getTitle(), getActiveFilename());
          return {
            content: [{
              type: 'text',
              text: `Created "${result.title}" [${newDocId}]${wsInfo} — ready.`,
            }],
          };
        }

        // Two-step flow: spinner persists until populate_document is called
        setMetadata({ agentCreated: true });
        save(); // Persist agentCreated flag to frontmatter
        broadcastDocumentsChanged();
        broadcastDocumentSwitched(getDocument(), getTitle(), getActiveFilename());
        return {
          content: [{
            type: 'text',
            text: `Created "${result.title}" [${newDocId}]${wsInfo} — empty. Call populate_document with docId "${newDocId}" to add content.`,
          }],
        };
      } catch (err) {
        if (!empty) broadcastWritingFinished();
        throw err;
      }
    },
  },
  {
    name: 'populate_document',
    description: 'Populate a document with content. Use after create_document (without content) to complete the two-step creation flow. Content appears as pending decorations for user review. Clears the sidebar creation spinner and shows the document. Pass the docId from create_document\'s response to ensure content goes to the right doc even if the user switched away.',
    schema: {
      content: z.any().describe('Document content: markdown string (preferred) or TipTap JSON doc object.'),
      docId: z.string().optional().describe('Target document by docId (8-char hex from create_document or list_documents). If provided and differs from the active doc, writes directly to disk without switching the user\'s view. Recommended — prevents race conditions when the user navigates during content generation.'),
    },
    handler: async ({ content, docId }: { content: any; docId?: string }) => {
      const filename = docId ? resolveDocId(docId) : undefined;
      try {
        let doc: any;

        if (typeof content === 'string') {
          let nodes = parseMarkdownContent(content);
          if (isTweetDoc(filename)) nodes = mergeParagraphsToHardBreaks(nodes);
          doc = { type: 'doc', content: nodes };
        } else if (content?.type === 'doc' && Array.isArray(content.content)) {
          doc = content;
        } else {
          broadcastWritingFinished();
          return {
            content: [{ type: 'text', text: 'Error: content must be a markdown string or TipTap JSON { type: "doc", content: [...] }' }],
          };
        }

        // Non-active target: write directly to disk without disrupting the user's view
        const targetIsNonActive = filename && filename !== getActiveFilename();
        if (targetIsNonActive) {
          const result = populateDocumentFile(filename, doc);

          broadcastDocumentsChanged();
          broadcastWorkspacesChanged();
          broadcastPendingDocsChanged();
          broadcastWritingFinished();

          return {
            content: [{
              type: 'text',
              text: `Populated "${result.title}" — ${result.wordCount.toLocaleString()} words`,
            }],
          };
        }

        // Active target (or no filename): existing flow
        setAgentLock(); // Block browser doc-updates during population
        markAllNodesAsPending(doc, 'insert');
        updateDocument(doc);
        updatePendingCacheForActiveDoc();
        save();

        // Broadcast sidebar updates first (deferred from create_document) so the doc
        // entry and spinner removal arrive in the same render cycle
        broadcastDocumentsChanged();
        broadcastWorkspacesChanged();
        broadcastDocumentSwitched(doc, getTitle(), getActiveFilename());
        broadcastPendingDocsChanged();
        broadcastWritingFinished();

        const wordCount = getWordCount();
        return {
          content: [{
            type: 'text',
            text: `Populated "${getTitle()}" — ${wordCount.toLocaleString()} words`,
          }],
        };
      } catch (err) {
        broadcastWritingFinished();
        throw err;
      }
    },
  },
  {
    name: 'open_file',
    description: 'Open an existing .md file from any location on disk. Saves the current document first, then loads the file and sets it as active. The file appears in the sidebar and edits save back to the original path.',
    schema: {
      path: z.string().describe('Absolute path to the .md file to open (e.g. "C:/projects/blog/post.md")'),
    },
    handler: async ({ path }: { path: string }) => {
      const result = openFile(path);
      broadcastDocumentSwitched(result.document, result.title, result.filename);
      const openedDocId = getDocId();
      const compact = toCompactFormat(result.document, result.title, getWordCount(), getPendingChangeCount(), openedDocId);
      return { content: [{ type: 'text', text: `Opened "${result.title}" [${openedDocId}] from ${path}\n\n${compact}` }] };
    },
  },
  {
    name: 'delete_document',
    description: 'Delete a document file. Moves to OS trash (Recycle Bin / macOS Trash). If deleting the active document, automatically switches to the most recent remaining doc. Cannot delete the last document. IMPORTANT: Always confirm with the user before calling this tool. Target document by docId (8-char hex from list_documents or read_pad).',
    schema: {
      docId: z.string().describe('Target document by docId (8-char hex from list_documents or read_pad).'),
    },
    handler: async ({ docId }: { docId: string }) => {
      const filename = resolveDocId(docId);
      const result = await deleteDocument(filename);
      if (result.switched && result.newDoc) {
        broadcastDocumentSwitched(result.newDoc.document, result.newDoc.title, result.newDoc.filename);
      }
      broadcastDocumentsChanged();
      let text = `Deleted "${filename}" (moved to trash)`;
      if (result.switched && result.newDoc) {
        text += `. Switched to "${result.newDoc.title}"`;
      }
      return { content: [{ type: 'text', text }] };
    },
  },
  {
    name: 'archive_document',
    description: 'Archive a document. Removes it from the active document list without deleting the file. Archived docs can be restored later with unarchive_document. If archiving the active document, automatically switches to the most recent remaining doc. Target document by docId (8-char hex from list_documents).',
    schema: {
      docId: z.string().describe('Target document by docId (8-char hex from list_documents).'),
    },
    handler: async ({ docId }: { docId: string }) => {
      const filename = resolveDocId(docId);
      const result = archiveDocument(filename);
      if (result.switched && result.newDoc) {
        broadcastDocumentSwitched(result.newDoc.document, result.newDoc.title, result.newDoc.filename);
      }
      broadcastDocumentsChanged();
      let text = `Archived "${filename}"`;
      if (result.switched && result.newDoc) {
        text += `. Switched to "${result.newDoc.title}"`;
      }
      return { content: [{ type: 'text', text }] };
    },
  },
  {
    name: 'unarchive_document',
    description: 'Restore an archived document back to the active document list. Target document by docId (8-char hex from list_documents with includeArchived).',
    schema: {
      docId: z.string().describe('Target document by docId (8-char hex).'),
    },
    handler: async ({ docId }: { docId: string }) => {
      const filename = resolveDocId(docId);
      const result = unarchiveDocument(filename);
      broadcastDocumentsChanged();
      return { content: [{ type: 'text', text: `Restored "${result.title}" [${docId}] from archive` }] };
    },
  },
  {
    name: 'get_metadata',
    description: 'Get the JSON frontmatter metadata for the active document. Returns all key-value pairs stored in frontmatter (title, summary, characters, tags, etc.). Useful for understanding document context without reading full content.',
    schema: {},
    handler: async () => {
      const metadata = getMetadata();
      return { content: [{ type: 'text', text: Object.keys(metadata).length > 0 ? JSON.stringify(metadata) : '{}' }] };
    },
  },
  {
    name: 'set_metadata',
    description: 'Update frontmatter metadata on the active document. Merges with existing metadata — only provided keys are changed. Use for summaries, character lists, tags, arc notes, or any organizational data. Saves to disk immediately.',
    schema: {
      metadata: z.record(z.any()).describe('Key-value pairs to merge into frontmatter. Set a key to null to remove it.'),
    },
    handler: async ({ metadata: updates }: { metadata: Record<string, any> }) => {
      const setKeys: string[] = [];
      const removed: string[] = [];

      for (const [key, value] of Object.entries(updates)) {
        if (value === null || value === undefined) {
          removed.push(key);
        } else {
          setKeys.push(key);
        }
      }

      const cleaned: Record<string, any> = {};
      for (const key of setKeys) cleaned[key] = updates[key];
      if (Object.keys(cleaned).length > 0) setMetadata(cleaned);

      const meta = getMetadata();
      for (const key of removed) delete meta[key];
      save();

      broadcastMetadataChanged(getMetadata());

      if (cleaned.title) {
        // Promote temp file → named file when title is set
        const promoted = promoteTempFile(cleaned.title);
        broadcastTitleChanged(cleaned.title);
        broadcastDocumentsChanged();
        if (promoted) {
          broadcastDocumentSwitched(getDocument(), getTitle(), promoted, getMetadata());
        }
      }

      const keys = Object.keys(cleaned);
      const parts: string[] = [];
      if (keys.length > 0) parts.push(`set: ${keys.join(', ')}`);
      if (removed.length > 0) parts.push(`removed: ${removed.join(', ')}`);
      return { content: [{ type: 'text', text: `Metadata updated (${parts.join('; ')})` }] };
    },
  },
  {
    name: 'list_workspaces',
    description: 'List all workspaces. Returns filename, title, and doc count.',
    schema: {},
    handler: async () => {
      const workspaces = listWorkspaces();
      const lines = workspaces.map((w) => `  ${w.filename} — "${w.title}" — ${w.docCount} docs`);
      return { content: [{ type: 'text', text: `workspaces:\n${lines.join('\n') || '  (none)'}` }] };
    },
  },
  {
    name: 'create_workspace',
    description: 'Create a new workspace. Workspaces are flexible containers for documents — add containers and tags after creation.',
    schema: {
      title: z.string().describe('Workspace title'),
      voiceProfileId: z.string().optional().describe('Author\'s Voice profile ID (future use)'),
    },
    handler: async ({ title, voiceProfileId }: { title: string; voiceProfileId?: string }) => {
      const info = createWorkspace({ title, voiceProfileId });
      broadcastWorkspacesChanged();
      return { content: [{ type: 'text', text: `Created workspace "${info.title}" (${info.filename})` }] };
    },
  },
  {
    name: 'delete_workspace',
    description: 'Delete a workspace and all its document files. Files go to OS trash (Recycle Bin / macOS Trash). IMPORTANT: Always confirm with the user before calling this tool.',
    schema: {
      filename: z.string().describe('Workspace manifest filename (e.g. "my-novel-a1b2c3d4.json")'),
    },
    handler: async ({ filename }: { filename: string }) => {
      const result = await deleteWorkspace(filename);
      broadcastWorkspacesChanged();
      broadcastDocumentsChanged();
      let text = `Deleted workspace "${filename}" and ${result.deletedFiles.length} files: ${result.deletedFiles.join(', ')}`;
      if (result.skippedExternal.length > 0) {
        text += `\nSkipped ${result.skippedExternal.length} external files (not owned by OpenWriter): ${result.skippedExternal.join(', ')}`;
      }
      return { content: [{ type: 'text', text }] };
    },
  },
  {
    name: 'get_workspace_structure',
    description: 'Get the full structure of a workspace: tree of containers and docs, per-doc tags, plus context (characters, settings, rules). Use to understand workspace organization before writing.',
    schema: {
      filename: z.string().describe('Workspace manifest filename (e.g. "my-novel-a1b2c3d4.json")'),
    },
    handler: async ({ filename }: { filename: string }) => {
      const ws = getWorkspace(filename);

      function renderTree(nodes: WorkspaceNode[], indent: string): string[] {
        const lines: string[] = [];
        for (const node of nodes) {
          if (node.type === 'doc') {
            const tags = getDocTagsByFilename(node.file);
            const tagStr = tags.length > 0 ? `  [${tags.join(', ')}]` : '';
            lines.push(`${indent}${getDocTitle(node.file)}  (${node.file})${tagStr}`);
          } else {
            lines.push(`${indent}[container] ${node.name}  (id:${node.id})`);
            lines.push(...renderTree(node.items, indent + '  '));
          }
        }
        return lines;
      }

      const treeLines = renderTree(ws.root, '  ');
      let text = `workspace: "${ws.title}"\nstructure:\n${treeLines.join('\n') || '  (empty)'}`;

      if (ws.context && Object.keys(ws.context).length > 0) {
        text += `\ncontext:\n${JSON.stringify(ws.context, null, 2)}`;
      }
      return { content: [{ type: 'text', text }] };
    },
  },
  {
    name: 'get_item_context',
    description: 'Get progressive disclosure context for a document in a workspace: workspace-level context (characters, settings, rules) and tags. Use before writing to understand context.',
    schema: {
      workspaceFile: z.string().describe('Workspace manifest filename'),
      docFile: z.string().describe('Document filename within the workspace'),
    },
    handler: async ({ workspaceFile, docFile }: { workspaceFile: string; docFile: string }) => {
      return { content: [{ type: 'text', text: JSON.stringify(getItemContext(workspaceFile, docFile), null, 2) }] };
    },
  },
  {
    name: 'add_doc',
    description: 'Add a document to a workspace. Optionally place it inside a container.',
    schema: {
      workspaceFile: z.string().describe('Workspace manifest filename'),
      docFile: z.string().describe('Document filename to add (e.g. "Chapter 1.md")'),
      containerId: z.string().optional().describe('Container ID to add into (null = root level)'),
      title: z.string().optional().describe('Display title for the doc'),
    },
    handler: async ({ workspaceFile, docFile, containerId, title }: any) => {
      addDoc(workspaceFile, containerId ?? null, docFile, title || docFile.replace(/\.md$/, ''));
      broadcastWorkspacesChanged();
      return {
        content: [{ type: 'text', text: `Added "${docFile}" to workspace${containerId ? ` in container ${containerId}` : ''}` }],
      };
    },
  },
  {
    name: 'update_workspace_context',
    description: 'Update a workspace\'s context section (characters, settings, rules). Merges with existing context — only provided keys are changed.',
    schema: {
      workspaceFile: z.string().describe('Workspace manifest filename'),
      context: z.object({
        characters: z.record(z.string()).optional().describe('Character name → description'),
        settings: z.record(z.string()).optional().describe('Setting name → description'),
        rules: z.array(z.string()).optional().describe('Writing rules for this workspace'),
      }).describe('Context fields to merge'),
    },
    handler: async ({ workspaceFile, context }: any) => {
      updateWorkspaceContext(workspaceFile, context);
      const keys = Object.keys(context).filter((k: string) => context[k] !== undefined);
      return { content: [{ type: 'text', text: `Workspace context updated (${keys.join(', ')})` }] };
    },
  },
  {
    name: 'create_container',
    description: 'Create a container (folder) inside a workspace. Max nesting depth: 3.',
    schema: {
      workspaceFile: z.string().describe('Workspace manifest filename'),
      name: z.string().describe('Container name (e.g. "Chapters", "Research")'),
      parentContainerId: z.string().optional().describe('Parent container ID for nesting (null = root level)'),
    },
    handler: async ({ workspaceFile, name, parentContainerId }: any) => {
      const result = addContainerToWorkspace(workspaceFile, parentContainerId ?? null, name);
      broadcastWorkspacesChanged();
      return { content: [{ type: 'text', text: `Created container "${name}" (id:${result.containerId})` }] };
    },
  },
  {
    name: 'tag_doc',
    description: 'Add a tag to a document. Tags are stored in the document\'s frontmatter — they travel with the file. A doc can have multiple tags.',
    schema: {
      docFile: z.string().describe('Document filename (e.g. "Chapter 1.md")'),
      tag: z.string().describe('Tag name to add'),
    },
    handler: async ({ docFile, tag }: any) => {
      addDocTag(docFile, tag);
      broadcastDocumentsChanged();
      return { content: [{ type: 'text', text: `Tagged "${docFile}" with [${tag}]` }] };
    },
  },
  {
    name: 'untag_doc',
    description: 'Remove a tag from a document.',
    schema: {
      docFile: z.string().describe('Document filename'),
      tag: z.string().describe('Tag name to remove'),
    },
    handler: async ({ docFile, tag }: any) => {
      removeDocTag(docFile, tag);
      broadcastDocumentsChanged();
      return { content: [{ type: 'text', text: `Removed tag [${tag}] from "${docFile}"` }] };
    },
  },
  {
    name: 'move_doc',
    description: 'Move a document to a different container within the same workspace, or to root level.',
    schema: {
      workspaceFile: z.string().describe('Workspace manifest filename'),
      docFile: z.string().describe('Document filename to move'),
      targetContainerId: z.string().optional().describe('Target container ID (omit for root level)'),
      afterFile: z.string().optional().describe('Place after this file (omit for beginning)'),
    },
    handler: async ({ workspaceFile, docFile, targetContainerId, afterFile }: any) => {
      moveDoc(workspaceFile, docFile, targetContainerId ?? null, afterFile ?? null);
      broadcastWorkspacesChanged();
      return { content: [{ type: 'text', text: `Moved "${docFile}"${targetContainerId ? ` to container ${targetContainerId}` : ' to root'}` }] };
    },
  },
  {
    name: 'rename_item',
    description: 'Rename a workspace, container, or document. For workspaces: updates the manifest title. For containers: updates the container name in the workspace tree. For documents: updates the title in frontmatter — use docId to identify the document.',
    schema: {
      type: z.enum(['workspace', 'container', 'document']).describe('What to rename'),
      filename: z.string().optional().describe('Workspace manifest filename (required for workspace/container renames). Not used for document renames.'),
      docId: z.string().optional().describe('Document docId (required for document renames, 8-char hex from list_documents).'),
      newName: z.string().describe('The new name/title'),
      containerId: z.string().optional().describe('Container ID (required for container renames)'),
      workspaceFile: z.string().optional().describe('Parent workspace filename (required for container renames)'),
    },
    handler: async ({ type, filename, docId, newName, containerId, workspaceFile }: { type: string; filename?: string; docId?: string; newName: string; containerId?: string; workspaceFile?: string }) => {
      if (type === 'workspace') {
        if (!filename) return { content: [{ type: 'text', text: 'Error: filename is required for workspace renames' }] };
        renameWorkspace(filename, newName);
        broadcastWorkspacesChanged();
        return { content: [{ type: 'text', text: `Renamed workspace to "${newName}"` }] };
      }
      if (type === 'container') {
        const wsFile = workspaceFile || filename;
        if (!wsFile) return { content: [{ type: 'text', text: 'Error: workspaceFile or filename is required for container renames' }] };
        if (!containerId) return { content: [{ type: 'text', text: 'Error: containerId is required for container renames' }] };
        renameContainer(wsFile, containerId, newName);
        broadcastWorkspacesChanged();
        return { content: [{ type: 'text', text: `Renamed container ${containerId} to "${newName}"` }] };
      }
      if (type === 'document') {
        if (!docId) return { content: [{ type: 'text', text: 'Error: docId is required for document renames' }] };
        const resolvedFilename = resolveDocId(docId);
        updateDocumentTitle(resolvedFilename, newName);
        broadcastDocumentsChanged();
        if (resolvedFilename === getActiveFilename()) {
          broadcastTitleChanged(newName);
        }
        return { content: [{ type: 'text', text: `Renamed document [${docId}] to "${newName}"` }] };
      }
      return { content: [{ type: 'text', text: `Error: unknown type "${type}"` }] };
    },
  },
  {
    name: 'edit_text',
    description: 'Apply fine-grained text edits within a node. Find text by exact match and replace it, or add/remove marks on matched text. More precise than rewriting the whole node. Target document by docId (8-char hex from list_documents or read_pad).',
    schema: {
      nodeId: z.string().describe('ID of the node to edit'),
      edits: z.array(z.object({
        find: z.string().describe('Exact text to find within the node'),
        replace: z.string().optional().describe('Replacement text (omit to keep text, just change marks)'),
        addMark: z.object({
          type: z.string(),
          attrs: z.record(z.any()).optional(),
        }).optional().describe('Mark to add to the matched text (e.g. link, bold)'),
        removeMark: z.string().optional().describe('Mark type to remove from matched text'),
      })).describe('Array of text edits to apply'),
      docId: z.string().describe('Target document by docId (8-char hex from list_documents or read_pad).'),
    },
    handler: async ({ nodeId, edits, docId }: { nodeId: string; edits: any[]; docId: string }) => {
      const filename = resolveDocId(docId);
      const targetIsNonActive = filename && filename !== getActiveFilename();
      if (targetIsNonActive) {
        const result = applyTextEditsToFile(filename, nodeId, edits);
        if (result.success) broadcastPendingDocsChanged();
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      }
      return { content: [{ type: 'text', text: JSON.stringify(applyTextEdits(nodeId, edits)) }] };
    },
  },
  {
    name: 'import_gdoc',
    description: 'Import a structured Google Doc into OpenWriter. Pass the raw JSON from the Google Docs API (the object with body.content). Converts headings, bold/italic, links, lists, and tables to markdown. Docs with 2+ HEADING_1 sections auto-split into chapter files with a workspace and "Chapters" container. Single-section docs become one file.',
    schema: {
      document: z.any().describe('Raw Google Doc JSON object from the Docs API (must have body.content)'),
      title: z.string().optional().describe('Book/document title. Defaults to the Google Doc title.'),
    },
    handler: async ({ document, title }: { document: any; title?: string }) => {
      const result = importGoogleDoc(document, title);
      broadcastDocumentsChanged();
      broadcastWorkspacesChanged();
      const lines = result.files.map((f: any, i: number) =>
        `  ${i + 1}. ${f.filename} (${f.wordCount.toLocaleString()} words)`
      );
      let text = `Imported "${result.title}" — ${result.files.length} file(s), mode: ${result.mode}`;
      if (result.workspaceFilename) text += `\nWorkspace manifest: ${result.workspaceFilename}`;
      text += `\n\n${lines.join('\n')}`;
      return { content: [{ type: 'text', text }] };
    },
  },
  {
    name: 'generate_image',
    description: 'Generate an image using Gemini Nano Banana 2. Saves to ~/.openwriter/_images/. Optionally sets it as the active article\'s cover image atomically. Requires GEMINI_API_KEY env var.',
    schema: {
      prompt: z.string().max(1000).describe('Image generation prompt (max 1000 chars)'),
      aspect_ratio: z.string().optional().describe('Aspect ratio (default "16:9"). Supported: 1:1, 9:16, 16:9, 4:3, 3:4.'),
      set_cover: z.boolean().optional().describe('If true, atomically set the generated image as the article cover (articleContext.coverImage in metadata).'),
    },
    handler: async ({ prompt, aspect_ratio, set_cover }: { prompt: string; aspect_ratio?: string; set_cover?: boolean }) => {
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) {
        return { content: [{ type: 'text', text: 'Error: GEMINI_API_KEY environment variable is not set.' }] };
      }

      const { GoogleGenAI } = await import('@google/genai');
      const ai = new GoogleGenAI({ apiKey });

      const response = await ai.models.generateContent({
        model: 'gemini-3.1-flash-image-preview',
        contents: `Generate a ${aspect_ratio || '16:9'} aspect ratio image: ${prompt}`,
        config: {
          responseModalities: ['IMAGE'],
        },
      });

      const parts = response.candidates?.[0]?.content?.parts;
      const imagePart = parts?.find((p: any) => p.inlineData);
      if (!imagePart?.inlineData?.data) {
        return { content: [{ type: 'text', text: 'Error: Gemini returned no image data.' }] };
      }

      // Save to ~/.openwriter/_images/
      ensureDataDir();
      const imagesDir = join(DATA_DIR, '_images');
      if (!existsSync(imagesDir)) mkdirSync(imagesDir, { recursive: true });

      const filename = `${randomUUID().slice(0, 8)}.png`;
      const filePath = join(imagesDir, filename);
      writeFileSync(filePath, Buffer.from(imagePart.inlineData.data, 'base64'));

      const src = `/_images/${filename}`;

      // Optionally set as article cover + append to carousel history
      if (set_cover) {
        const meta = getMetadata();
        const articleContext = (meta.articleContext as Record<string, any>) || {};
        let existing: string[] = Array.isArray(articleContext.coverImages) ? articleContext.coverImages : [];
        // Seed with current coverImage if array is empty (first carousel entry)
        if (existing.length === 0 && articleContext.coverImage) {
          existing = [articleContext.coverImage];
        }
        existing.push(src);
        articleContext.coverImage = src;
        articleContext.coverImages = existing;
        setMetadata({ articleContext });
        save();
        broadcastMetadataChanged(getMetadata());
      }

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ success: true, src, ...(set_cover ? { coverSet: true } : {}) }),
        }],
      };
    },
  },
  {
    name: 'list_versions',
    description: 'List version history for the active document. Returns timestamps, word counts, and sizes. Use to find a timestamp for restore_version.',
    schema: {},
    handler: async () => {
      const docId = getDocId();
      if (!docId) return { content: [{ type: 'text', text: 'Error: No active document.' }] };
      const versions = listVersions(docId);
      if (versions.length === 0) return { content: [{ type: 'text', text: 'No versions found for this document.' }] };
      const lines = versions.map((v, i) =>
        `  ${i + 1}. ${v.date}  ts:${v.timestamp}  ${v.wordCount.toLocaleString()} words  ${(v.size / 1024).toFixed(1)}KB`
      );
      return { content: [{ type: 'text', text: `versions (${versions.length}):\n${lines.join('\n')}` }] };
    },
  },
  {
    name: 'create_checkpoint',
    description: 'Force a version snapshot of the active document right now. Use before risky operations as a safety net.',
    schema: {},
    handler: async () => {
      const docId = getDocId();
      const filePath = getFilePath();
      if (!docId || !filePath) return { content: [{ type: 'text', text: 'Error: No active document.' }] };
      forceSnapshot(docId, filePath);
      return { content: [{ type: 'text', text: `Checkpoint created at ${new Date().toISOString()}` }] };
    },
  },
  {
    name: 'restore_version',
    description: 'Restore the active document to a previous version by timestamp. Automatically creates a safety checkpoint of the current state first. Get timestamps from list_versions.',
    schema: {
      timestamp: z.number().describe('Version timestamp to restore (from list_versions)'),
    },
    handler: async ({ timestamp }: { timestamp: number }) => {
      const docId = getDocId();
      const filePath = getFilePath();
      if (!docId || !filePath) return { content: [{ type: 'text', text: 'Error: No active document.' }] };

      // Safety net: snapshot current state before restoring
      try { forceSnapshot(docId, filePath); } catch { /* best effort */ }

      const parsed = restoreVersion(docId, timestamp);
      if (!parsed) return { content: [{ type: 'text', text: `Error: Version ${timestamp} not found.` }] };

      updateDocument(parsed.document);
      save();

      const filename = filePath.split(/[/\\]/).pop() || '';
      broadcastDocumentSwitched(parsed.document, parsed.title, filename);

      return { content: [{ type: 'text', text: `Restored version from ${new Date(timestamp).toISOString()} — "${parsed.title}"` }] };
    },
  },
  {
    name: 'reload_from_disk',
    description: 'Re-read the active document from its file on disk. Use when the file was modified externally and the editor needs to pick up changes. Does NOT rescan the full document list.',
    schema: {},
    handler: async () => {
      const filePath = getFilePath();
      if (!filePath) return { content: [{ type: 'text', text: 'Error: No active document.' }] };
      if (!existsSync(filePath)) return { content: [{ type: 'text', text: `Error: File not found: ${filePath}` }] };

      const markdown = readFileSync(filePath, 'utf-8');
      const parsed = markdownToTiptap(markdown);
      updateDocument(parsed.document);
      save();

      const filename = filePath.split(/[/\\]/).pop() || '';
      broadcastDocumentSwitched(parsed.document, parsed.title, filename);

      return { content: [{ type: 'text', text: `Reloaded "${parsed.title}" from disk` }] };
    },
  },
  {
    name: 'get_agent_marks',
    description: 'Get inline feedback marks left by the user. Users select text in the editor, right-click → Agent Mark, and leave notes for the agent. Returns marks grouped by document with text, note, and nodeId. Call resolve_agent_marks after addressing each mark.',
    schema: {
      docId: z.string().optional().describe('Target document by docId (8-char hex). Omit to get marks across all documents.'),
    },
    handler: async ({ docId }: { docId?: string }) => {
      const filename = docId ? resolveDocId(docId) : undefined;
      const marks = getMarks(filename);
      const entries = Object.entries(marks);
      if (entries.length === 0) {
        return { content: [{ type: 'text', text: 'No agent marks found.' }] };
      }
      const lines: string[] = [];
      for (const [file, fileMarks] of entries) {
        lines.push(`${file}:`);
        for (const m of fileMarks) {
          const notePart = m.note ? ` — "${m.note}"` : '';
          lines.push(`  [${m.id}] "${m.text}"${notePart}  (node:${m.nodeId})`);
        }
      }
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
  },
  {
    name: 'resolve_agent_marks',
    description: 'Remove agent marks after addressing the user\'s feedback. Pass the mark IDs from get_agent_marks. Decorations clear in the browser immediately.',
    schema: {
      mark_ids: z.array(z.string()).describe('Array of mark IDs to resolve'),
    },
    handler: async ({ mark_ids }: { mark_ids: string[] }) => {
      const resolved = resolveMarks(mark_ids);
      // Broadcast to browser so decorations update
      const activeFile = getActiveFilename();
      broadcastMarksChanged(activeFile);
      return {
        content: [{
          type: 'text',
          text: resolved.length > 0
            ? `Resolved ${resolved.length} mark${resolved.length !== 1 ? 's' : ''}: ${resolved.join(', ')}`
            : 'No matching marks found.',
        }],
      };
    },
  },
];

/** Register MCP tools from plugins. Tools added after startMcpServer() won't be visible to existing MCP sessions. */
export function registerPluginTools(tools: import('./plugin-types.js').PluginMcpTool[]): void {
  for (const tool of tools) {
    TOOL_REGISTRY.push({
      name: tool.name,
      description: tool.description,
      schema: {},
      handler: async (args: any) => {
        const result = await tool.handler(args);
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      },
    });
  }
}

/** Remove MCP tools by name. Existing MCP stdio sessions won't see removal until reconnect. */
export function removePluginTools(names: string[]): void {
  const nameSet = new Set(names);
  for (let i = TOOL_REGISTRY.length - 1; i >= 0; i--) {
    if (nameSet.has(TOOL_REGISTRY[i].name)) {
      TOOL_REGISTRY.splice(i, 1);
    }
  }
}

export async function startMcpServer(): Promise<void> {
  const server = new McpServer({
    name: 'openwriter',
    version: '0.2.0',
  });

  for (const tool of TOOL_REGISTRY) {
    server.tool(tool.name, tool.description, tool.schema, tool.handler);
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
