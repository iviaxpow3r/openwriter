/**
 * MCP stdio server: tool registry + stdio transport.
 * Uses compact wire format for token efficiency.
 * Exports TOOL_REGISTRY for HTTP proxy (multi-session support).
 */

import { join } from 'path';
import { existsSync, mkdirSync, writeFileSync, readFileSync, statSync } from 'fs';
import { randomUUID } from 'crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { getDataDir, ensureDataDir, resolveDocPath, generateNodeId, atomicWriteFileSync } from './helpers.js';
import {
  getDocument,
  getWordCount,
  getPendingChangeCount,
  getTitle,
  getStatus,
  getNodesByIds,
  findNodesByIds,
  getMetadata,
  setMetadata,
  mergeMetadataUpdates,
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
  extractText,
  countPending,
  updateCacheEntry,
  addDocTag,
  removeDocTag,
  getDocTagsByFilename,
  getCachedDocument,
  invalidateDocCache,
  type NodeChange,
  type PadDocument,
} from './state.js';
import { listDocuments, switchDocument, createDocument, createDocumentFile, deleteDocument, openFile, getActiveFilename, updateDocumentTitle, promoteTempFile, archiveDocument, unarchiveDocument, resolveDocId } from './documents.js';
import { broadcastDocumentSwitched, broadcastDocumentsChanged, broadcastWorkspacesChanged, broadcastTitleChanged, broadcastMetadataChanged, broadcastPendingDocsChanged, broadcastWritingStarted, broadcastWritingFinished, broadcastMarksChanged } from './ws.js';
import { listWorkspaces, getWorkspace, getDocTitle, getItemContext, addDoc, updateWorkspaceContext, createWorkspace, deleteWorkspace, addContainerToWorkspace, findOrCreateWorkspace, findOrCreateContainer, moveDoc, moveContainer, reorderWorkspaceAfter, removeContainer, renameWorkspace, renameContainer, removeDocFromAllWorkspaces } from './workspaces.js';
import type { WorkspaceNode } from './workspace-types.js';
import { findDocNode } from './workspace-tree.js';
import { importGoogleDoc } from './gdoc-import.js';
import { toCompactFormat, compactNodes, parseMarkdownContent, mergeParagraphsToHardBreaks } from './compact.js';
import matter from 'gray-matter';
import { getUpdateInfo } from './update-check.js';
import { listVersions, forceSnapshot, restoreVersion } from './versions.js';
import { markdownToTiptap, tiptapToMarkdown } from './markdown.js';
import { getMarks, getMarkCount, getGlobalMarkSummary, resolveMarks } from './marks.js';
import { readTasks, addTask, updateTask, removeTask } from './tasks.js';


/** Map a content type string to its frontmatter metadata object. */
function resolveTypeMeta(type: string, url?: string): Record<string, any> | undefined {
  switch (type) {
    case 'tweet': return { content_type: 'tweet', tweetContext: { mode: 'tweet' } };
    case 'reply': return { content_type: 'reply', tweetContext: { mode: 'reply', ...(url ? { url } : {}) } };
    case 'quote': return { content_type: 'quote', tweetContext: { mode: 'quote', ...(url ? { url } : {}) } };
    case 'article': return { content_type: 'article', articleContext: { active: true } };
    case 'linkedin': return { content_type: 'linkedin', linkedinContext: { active: true } };
    case 'newsletter': return { content_type: 'newsletter', newsletterContext: { active: true } };
    case 'blog': return { content_type: 'blog', blogContext: { active: true } };
    default: return undefined;
  }
}

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

interface DocTarget {
  filename: string;
  filePath: string;
  docId: string;
  isActive: boolean;
  document: PadDocument;
  title: string;
  metadata: Record<string, any>;
  wordCount: number;
  pendingCount: number;
  lastModified: Date;
}

/** Resolve a docId to a full document target. Fast path for active doc (zero I/O). */
function resolveDocTarget(docId: string): DocTarget {
  const filename = resolveDocId(docId);
  const activeFilename = getActiveFilename();

  // Fast path: active document — use in-memory state
  if (filename === activeFilename) {
    return {
      filename,
      filePath: getFilePath(),
      docId,
      isActive: true,
      document: getDocument(),
      title: getTitle(),
      metadata: getMetadata(),
      wordCount: getWordCount(),
      pendingCount: getPendingChangeCount(),
      lastModified: new Date(getStatus().lastModified),
    };
  }

  // Non-active: try cache, then disk
  const filePath = resolveDocPath(filename);
  const cached = getCachedDocument(filePath);
  if (cached) {
    const text = extractText(cached.document.content);
    return {
      filename,
      filePath,
      docId: cached.docId,
      isActive: false,
      document: cached.document,
      title: cached.title,
      metadata: cached.metadata,
      wordCount: text.trim() ? text.trim().split(/\s+/).length : 0,
      pendingCount: countPending(cached.document.content),
      lastModified: cached.lastModified,
    };
  }

  // Read from disk
  if (!existsSync(filePath)) throw new Error(`Document file not found: ${filename}`);
  const raw = readFileSync(filePath, 'utf-8');
  const parsed = markdownToTiptap(raw);
  const meta = parsed.metadata || {};
  const resolvedDocId = meta.docId || docId;
  const text = extractText(parsed.document.content);
  return {
    filename,
    filePath,
    docId: resolvedDocId,
    isActive: false,
    document: parsed.document,
    title: parsed.title,
    metadata: parsed.metadata || {},
    wordCount: text.trim() ? text.trim().split(/\s+/).length : 0,
    pendingCount: countPending(parsed.document.content),
    lastModified: statSync(filePath).mtime,
  };
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
    description: 'Read a document by docId. Returns compact tagged-line format with [type:id] per node, inline markdown formatting. Much more token-efficient than JSON.',
    schema: {
      docId: z.string().describe('Target document by docId (8-char hex from list_documents).'),
    },
    handler: async ({ docId }: { docId: string }) => {
      const target = resolveDocTarget(docId);
      const compact = toCompactFormat(target.document, target.title, target.wordCount, target.pendingCount, target.docId, target.metadata);
      const localCount = getMarkCount(target.filename);
      const { totalMarks: otherMarks, docCount: otherDocs } = getGlobalMarkSummary(target.filename);
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
        } else if (tweetMode && Array.isArray(resolved.content)) {
          resolved.content = mergeParagraphsToHardBreaks(resolved.content);
        }
        return resolved;
      });

      // Auto-clean: if doc has only a single empty paragraph and first change is
      // an insert, convert to a rewrite so the empty node gets replaced silently
      // (shows as green insert decoration, not a red delete).
      const activeDoc = getDocument();
      if (activeDoc.content?.length === 1) {
        const first = activeDoc.content[0];
        if (first.type === 'paragraph' && (!first.content || first.content.length === 0) && first.attrs?.id) {
          const insertIdx = processed.findIndex((c: any) => c.operation === 'insert');
          if (insertIdx !== -1) {
            processed[insertIdx] = { ...processed[insertIdx], operation: 'rewrite', nodeId: first.attrs.id };
            delete processed[insertIdx].afterNodeId;
          }
        }
      }

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
    description: 'Get the status of a document: word count, pending changes. Cheap call for polling.',
    schema: {
      docId: z.string().describe('Target document by docId (8-char hex from list_documents).'),
    },
    handler: async ({ docId }: { docId: string }) => {
      const target = resolveDocTarget(docId);
      const status = {
        title: target.title,
        wordCount: target.wordCount,
        pendingChanges: target.pendingCount,
        lastModified: target.lastModified.toISOString(),
      };
      const latestVersion = getUpdateInfo();
      const payload = latestVersion ? { ...status, updateAvailable: latestVersion } : status;
      return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
    },
  },
  {
    name: 'get_nodes',
    description: 'Get specific nodes by ID. Returns compact tagged-line format per node.',
    schema: {
      docId: z.string().describe('Target document by docId (8-char hex from list_documents).'),
      nodeIds: z.array(z.string()).describe('Array of node IDs to retrieve'),
    },
    handler: async ({ docId, nodeIds }: { docId: string; nodeIds: string[] }) => {
      const target = resolveDocTarget(docId);
      const nodes = target.isActive ? getNodesByIds(nodeIds) : findNodesByIds(target.document.content, nodeIds);
      return { content: [{ type: 'text', text: compactNodes(nodes) }] };
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
    description: 'Show a document in the user\'s browser. NOT required before reading or editing — all tools target documents by docId directly. Use only when you want to change what the user sees. Saves the current document first. Returns a compact read of the newly active document.',
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
    description: 'Create a new document. content_type is REQUIRED — use "document" for plain docs, or "tweet"/"reply"/"quote"/"article"/"linkedin"/"newsletter"/"blog" for typed docs. Always provide a title. By default shows a sidebar spinner — call populate_document next to deliver content and clear it. This two-step flow is REQUIRED for all content documents: create_document → populate_document. Use empty=true ONLY for typed docs (tweets, articles) that start blank and get written to incrementally via write_to_pad. If workspace is provided, the doc is automatically added to it (workspace is created if it doesn\'t exist). If container is also provided, the doc is placed inside that container (created if it doesn\'t exist).',
    schema: {
      title: z.string().optional().describe('Title for the new document. Defaults to "Untitled".'),
      path: z.string().optional().describe('Absolute file path to create the document at (e.g. "C:/projects/doc.md"). If omitted, creates in ~/.openwriter/.'),
      workspace: z.string().optional().describe('Workspace title to add this doc to. Creates the workspace if it doesn\'t exist.'),
      container: z.string().optional().describe('Container name within the workspace (e.g. "Chapters", "Notes", "References"). Creates the container if it doesn\'t exist. Requires workspace.'),
      empty: z.boolean().optional().describe('ONLY for content_type template docs (tweets, articles) that start blank. Skips the spinner and switches immediately. Do NOT set this for content documents — use the two-step flow (create_document → populate_document) instead.'),
      content_type: z.enum(['document', 'tweet', 'reply', 'quote', 'article', 'linkedin', 'newsletter', 'blog']).describe('Required. Use "document" for plain documents. Tweet/reply/quote/article/linkedin/newsletter/blog set type-specific metadata automatically.'),
      url: z.string().optional().describe('Tweet URL — REQUIRED for content_type "reply" or "quote" (e.g. "https://x.com/user/status/123"). Sets tweetContext.url automatically. Ignored for other content types.'),
    },
    handler: async ({ title, path, workspace, container, empty, content_type, url }: { title?: string; path?: string; workspace?: string; container?: string; empty?: boolean; content_type: string; url?: string }) => {
      // Require url for reply/quote
      if ((content_type === 'reply' || content_type === 'quote') && !url) {
        return { content: [{ type: 'text', text: `Error: content_type "${content_type}" requires a url parameter (e.g. "https://x.com/user/status/123").` }] };
      }

      // Default title from content_type if not provided
      if (!title && content_type && content_type !== 'document') {
        const typeDefaults: Record<string, string> = {
          tweet: 'Tweet', reply: 'Reply', quote: 'Quote Tweet', article: 'Article',
          linkedin: 'LinkedIn Post', newsletter: 'Newsletter', blog: 'Blog Post',
        };
        title = typeDefaults[content_type];
      }

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
        if (empty) {
          // Immediate switch — no spinner, no populate_document needed
          setAgentLock();
          const result = createDocument(title, undefined, path);

          // Apply type-specific metadata
          if (content_type) {
            const typeMeta = resolveTypeMeta(content_type, url);
            if (typeMeta) {
              setMetadata(typeMeta);
            }
          }

          let wsInfo = '';
          if (wsTarget) {
            addDoc(wsTarget.wsFilename, wsTarget.containerId, result.filename, result.title);
            wsInfo = ` → workspace "${workspace}"${container ? ` / ${container}` : ''}`;
          }

          const newDocId = getDocId();
          save();
          broadcastDocumentsChanged();
          broadcastWorkspacesChanged();
          broadcastDocumentSwitched(getDocument(), getTitle(), getActiveFilename(), getMetadata());
          return {
            content: [{
              type: 'text',
              text: `Created "${result.title}" [${newDocId}]${wsInfo}${content_type ? ` (${content_type})` : ''} — ready.`,
            }],
          };
        }

        // Two-step flow: create file on disk WITHOUT switching the user's view.
        // The spinner persists in the sidebar until populate_document is called.
        const typeMeta = content_type ? resolveTypeMeta(content_type, url) : undefined;
        const result = createDocumentFile(title, path, typeMeta);

        let wsInfo = '';
        if (wsTarget) {
          addDoc(wsTarget.wsFilename, wsTarget.containerId, result.filename, result.title);
          wsInfo = ` → workspace "${workspace}"${container ? ` / ${container}` : ''}`;
        }

        broadcastDocumentsChanged();
        return {
          content: [{
            type: 'text',
            text: `Created "${result.title}" [${result.docId}]${wsInfo} — empty. Call populate_document with docId "${result.docId}" to add content.`,
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
          if (isTweetDoc(filename)) content.content = mergeParagraphsToHardBreaks(content.content);
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
      removeDocFromAllWorkspaces(filename);
      if (result.switched && result.newDoc) {
        broadcastDocumentSwitched(result.newDoc.document, result.newDoc.title, result.newDoc.filename);
      }
      broadcastDocumentsChanged();
      broadcastWorkspacesChanged();
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
      removeDocFromAllWorkspaces(filename);
      if (result.switched && result.newDoc) {
        broadcastDocumentSwitched(result.newDoc.document, result.newDoc.title, result.newDoc.filename);
      }
      broadcastDocumentsChanged();
      broadcastWorkspacesChanged();
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
    description: 'Get the JSON frontmatter metadata for a document. Returns all key-value pairs stored in frontmatter (title, summary, characters, tags, etc.). Useful for understanding document context without reading full content.',
    schema: {
      docId: z.string().describe('Target document by docId (8-char hex from list_documents).'),
    },
    handler: async ({ docId }: { docId: string }) => {
      const target = resolveDocTarget(docId);
      return { content: [{ type: 'text', text: Object.keys(target.metadata).length > 0 ? JSON.stringify(target.metadata) : '{}' }] };
    },
  },
  {
    name: 'set_metadata',
    description: 'Update frontmatter metadata on a document. Merges with existing metadata — only provided keys are changed. Use for summaries, character lists, tags, arc notes, or any organizational data. Saves to disk immediately.',
    schema: {
      docId: z.string().describe('Target document by docId (8-char hex from list_documents).'),
      metadata: z.record(z.any()).describe('Key-value pairs to merge into frontmatter. Set a key to null to remove it.'),
    },
    handler: async ({ docId, metadata: updates }: { docId: string; metadata: Record<string, any> }) => {
      const target = resolveDocTarget(docId);
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

      if (target.isActive) {
        // Active doc: use in-memory path
        if (Object.keys(cleaned).length > 0) setMetadata(cleaned);
        const meta = getMetadata();
        for (const key of removed) delete meta[key];
        save();
        broadcastMetadataChanged(getMetadata());

        if (cleaned.title) {
          const promoted = promoteTempFile(cleaned.title);
          broadcastTitleChanged(cleaned.title);
          broadcastDocumentsChanged();
          if (promoted) {
            broadcastDocumentSwitched(getDocument(), getTitle(), promoted, getMetadata());
          }
        }
      } else {
        // Non-active doc: read → merge → write file
        let meta = { ...target.metadata };
        if (Object.keys(cleaned).length > 0) {
          const merged = mergeMetadataUpdates(meta, cleaned);
          if (merged) meta = merged;
        }
        for (const key of removed) delete meta[key];
        const newTitle = cleaned.title || meta.title || target.title;
        const markdown = tiptapToMarkdown(target.document, newTitle, meta);
        atomicWriteFileSync(target.filePath, markdown);
        invalidateDocCache(target.filePath);

        if (cleaned.title) {
          updateDocumentTitle(target.filename, cleaned.title);
          broadcastDocumentsChanged();
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
      docId: z.string().describe('Document docId (8-char hex from list_documents)'),
    },
    handler: async ({ workspaceFile, docId }: { workspaceFile: string; docId: string }) => {
      const filename = resolveDocId(docId);
      return { content: [{ type: 'text', text: JSON.stringify(getItemContext(workspaceFile, filename), null, 2) }] };
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
    name: 'delete_container',
    description: 'Delete a container from a workspace. Any docs inside are removed from the workspace (files are NOT deleted from disk).',
    schema: {
      workspaceFile: z.string().describe('Workspace manifest filename'),
      containerId: z.string().describe('Container ID to delete'),
    },
    handler: async ({ workspaceFile, containerId }: { workspaceFile: string; containerId: string }) => {
      removeContainer(workspaceFile, containerId);
      broadcastWorkspacesChanged();
      return { content: [{ type: 'text', text: `Deleted container ${containerId}` }] };
    },
  },
  {
    name: 'tag_doc',
    description: 'Add a tag to a document. Tags are stored in the document\'s frontmatter — they travel with the file. A doc can have multiple tags.',
    schema: {
      docId: z.string().describe('Document docId (8-char hex from list_documents)'),
      tag: z.string().describe('Tag name to add'),
    },
    handler: async ({ docId, tag }: any) => {
      const filename = resolveDocId(docId);
      addDocTag(filename, tag);
      broadcastDocumentsChanged();
      return { content: [{ type: 'text', text: `Tagged "${filename}" with [${tag}]` }] };
    },
  },
  {
    name: 'untag_doc',
    description: 'Remove a tag from a document.',
    schema: {
      docId: z.string().describe('Document docId (8-char hex from list_documents)'),
      tag: z.string().describe('Tag name to remove'),
    },
    handler: async ({ docId, tag }: any) => {
      const filename = resolveDocId(docId);
      removeDocTag(filename, tag);
      broadcastDocumentsChanged();
      return { content: [{ type: 'text', text: `Removed tag [${tag}] from "${filename}"` }] };
    },
  },
  {
    name: 'move_item',
    description: 'Move or reorder a doc, container, or workspace. For docs: add to workspace or move within it. For containers: move to different parent or reorder within current parent. For workspaces: reorder in sidebar.',
    schema: {
      type: z.enum(['doc', 'container', 'workspace']).describe('What to move'),
      workspaceFile: z.string().optional().describe('Workspace manifest filename (required for doc/container)'),
      itemId: z.string().describe('docId (8-char hex), containerId, or workspace filename'),
      targetContainerId: z.string().optional().describe('Destination container (omit for root or same-parent reorder). Doc/container only.'),
      afterId: z.string().optional().describe('Place after this item (omit for beginning)'),
    },
    handler: async ({ type, workspaceFile, itemId, targetContainerId, afterId }: any) => {
      if (type === 'doc') {
        if (!workspaceFile) return { content: [{ type: 'text', text: 'Error: workspaceFile is required for doc moves' }] };
        const filename = resolveDocId(itemId);
        const ws = getWorkspace(workspaceFile);
        const inTarget = findDocNode(ws.root, filename);
        if (inTarget) {
          // Within same workspace — reorder/move to container
          moveDoc(workspaceFile, filename, targetContainerId ?? null, afterId ?? null);
        } else {
          // Cross-workspace move: remove from old, add to new
          removeDocFromAllWorkspaces(filename);
          addDoc(workspaceFile, targetContainerId ?? null, filename, getDocTitle(filename), afterId ?? null);
        }
        broadcastWorkspacesChanged();
        return { content: [{ type: 'text', text: `Moved "${filename}"${targetContainerId ? ` to container ${targetContainerId}` : ' to root'}` }] };
      }
      if (type === 'container') {
        if (!workspaceFile) return { content: [{ type: 'text', text: 'Error: workspaceFile is required for container moves' }] };
        if (targetContainerId !== undefined) {
          moveContainer(workspaceFile, itemId, targetContainerId, afterId ?? null);
        } else {
          moveContainer(workspaceFile, itemId, null, afterId ?? null);
        }
        broadcastWorkspacesChanged();
        return { content: [{ type: 'text', text: `Moved container "${itemId}"${targetContainerId ? ` to container ${targetContainerId}` : ''}${afterId ? ` after ${afterId}` : ' to beginning'}` }] };
      }
      if (type === 'workspace') {
        reorderWorkspaceAfter(itemId, afterId ?? null);
        broadcastWorkspacesChanged();
        return { content: [{ type: 'text', text: `Reordered workspace "${itemId}"${afterId ? ` after ${afterId}` : ' to beginning'}` }] };
      }
      return { content: [{ type: 'text', text: `Error: unknown type "${type}"` }] };
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
    name: 'insert_image',
    description: 'Generate an image via Gemini and optionally insert it inline or set it as article cover. Three modes: (1) docId + afterNodeId → generate + insert inline with pending decoration. (2) set_cover: true → generate + set as article cover. (3) Neither → generate to disk only, returns path. Uses local GEMINI_API_KEY if set, otherwise falls back to publish platform API.',
    schema: {
      prompt: z.string().max(1000).describe('Gemini image generation prompt (max 1000 chars).'),
      docId: z.string().optional().describe('Target document by docId (8-char hex). Required for inline insert.'),
      afterNodeId: z.string().optional().describe('Insert after this node ID, or "end" to append. Required for inline insert.'),
      aspect_ratio: z.string().optional().describe('Aspect ratio (default "16:9"). Supported: 1:1, 9:16, 16:9, 4:3, 3:4.'),
      alt: z.string().optional().describe('Alt text for the image (defaults to prompt).'),
      set_cover: z.boolean().optional().describe('If true, set the generated image as the article cover (articleContext.coverImage in metadata).'),
    },
    handler: async ({ prompt, docId, afterNodeId, aspect_ratio, alt, set_cover }: { prompt: string; docId?: string; afterNodeId?: string; aspect_ratio?: string; alt?: string; set_cover?: boolean }) => {
      const inlineMode = docId && afterNodeId;
      const filename = inlineMode ? resolveDocId(docId) : undefined;
      const targetIsNonActive = filename && filename !== getActiveFilename();

      // Capture context before async work (for set_cover)
      const preAwaitFilePath = getFilePath();

      // Phase 1: Insert imageLoading placeholder immediately (inline + active doc only)
      const loadingNodeId = generateNodeId();
      if (inlineMode && !targetIsNonActive) {
        const loadingChange: NodeChange = {
          operation: 'insert' as const,
          afterNodeId,
          content: [{ type: 'imageLoading', attrs: { id: loadingNodeId } }],
        };
        applyChanges([loadingChange]);
      }

      try {
        let imgFilename: string;
        const apiKey = process.env.GEMINI_API_KEY;

        if (apiKey) {
          // Generate image via local Gemini
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
            if (inlineMode && !targetIsNonActive) {
              applyChanges([{ operation: 'delete' as const, nodeId: loadingNodeId }]);
            }
            return { content: [{ type: 'text', text: 'Error: Gemini returned no image data.' }] };
          }

          ensureDataDir();
          const imagesDir = join(getDataDir(), '_images');
          if (!existsSync(imagesDir)) mkdirSync(imagesDir, { recursive: true });

          imgFilename = `${randomUUID().slice(0, 8)}.png`;
          writeFileSync(join(imagesDir, imgFilename), Buffer.from(imagePart.inlineData.data, 'base64'));
        } else {
          // Fallback: generate via publish platform API
          const { platformFetch, isAuthenticated } = await import('./connections.js');
          if (!isAuthenticated()) {
            if (inlineMode && !targetIsNonActive) {
              try { applyChanges([{ operation: 'delete' as const, nodeId: loadingNodeId }]); } catch {}
            }
            return { content: [{ type: 'text', text: 'Error: No GEMINI_API_KEY and publish platform not configured. Set GEMINI_API_KEY or log in to the publish plugin.' }] };
          }

          const res = await platformFetch('/images/generate', {
            method: 'POST',
            body: JSON.stringify({ prompt, aspect_ratio: aspect_ratio || '16:9' }),
          });

          if (!res.ok) {
            const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
            if (inlineMode && !targetIsNonActive) {
              try { applyChanges([{ operation: 'delete' as const, nodeId: loadingNodeId }]); } catch {}
            }
            return { content: [{ type: 'text', text: `Error: ${(err as any).error || 'Platform generation failed'}` }] };
          }

          const data = await res.json() as { url: string };
          const imageRes = await fetch(data.url);
          const imageBuffer = Buffer.from(await imageRes.arrayBuffer());

          ensureDataDir();
          const imagesDir = join(getDataDir(), '_images');
          if (!existsSync(imagesDir)) mkdirSync(imagesDir, { recursive: true });

          imgFilename = `${randomUUID().slice(0, 8)}.png`;
          writeFileSync(join(imagesDir, imgFilename), imageBuffer);
        }

        const src = `/_images/${imgFilename}`;

        // Mode 1: Inline insert
        if (inlineMode) {
          const imageNode = { type: 'image', attrs: { src, alt: alt || prompt } };
          if (targetIsNonActive) {
            const change: NodeChange = { operation: 'insert' as const, afterNodeId, content: [imageNode] };
            const { lastNodeId } = applyChangesToFile(filename!, [change]);
            broadcastPendingDocsChanged();
            return { content: [{ type: 'text', text: JSON.stringify({ success: true, src, ...(lastNodeId ? { lastNodeId } : {}) }) }] };
          }
          // Hard-replace: mutate server doc directly, bypass applyChanges.
          // During async generation (5-10s) the agent lock expires and browser doc-updates
          // can change the imageLoading node's ID. Find it by type, not stale ID.
          // Then broadcast document-switched so the browser rebuilds from server truth.
          const doc = getDocument();
          const imgId = generateNodeId();
          const pendingImage = { ...imageNode, attrs: { ...imageNode.attrs, id: imgId, pendingStatus: 'insert' } };
          const idx = doc.content?.findIndex((n: any) => n.type === 'imageLoading') ?? -1;
          if (idx >= 0) {
            doc.content.splice(idx, 1, pendingImage);
          } else {
            doc.content.push(pendingImage);
          }
          updateDocument(doc);
          save();
          setAgentLock();
          broadcastDocumentSwitched(doc, getTitle(), getActiveFilename(), getMetadata());
          return { content: [{ type: 'text', text: JSON.stringify({ success: true, src, lastNodeId: imgId }) }] };
        }

        // Mode 2: Set as article cover
        if (set_cover) {
          const docChanged = getFilePath() !== preAwaitFilePath;
          if (docChanged) {
            return { content: [{ type: 'text', text: JSON.stringify({ success: true, src, coverSet: false, warning: 'Active document changed during generation — cover not set.' }) }] };
          }
          const liveMeta = getMetadata();
          const articleContext = (liveMeta.articleContext as Record<string, any>) || {};
          let existing: string[] = Array.isArray(articleContext.coverImages) ? [...articleContext.coverImages] : [];
          if (existing.length === 0 && articleContext.coverImage) {
            existing = [articleContext.coverImage];
          }
          existing.push(src);
          articleContext.coverImage = src;
          articleContext.coverImages = existing;
          setMetadata({ articleContext });
          save();
          broadcastMetadataChanged(getMetadata());
          return { content: [{ type: 'text', text: JSON.stringify({ success: true, src, coverSet: true }) }] };
        }

        // Mode 3: Generate to disk only
        return { content: [{ type: 'text', text: JSON.stringify({ success: true, src }) }] };
      } catch (err: any) {
        if (inlineMode && !targetIsNonActive) {
          try { applyChanges([{ operation: 'delete' as const, nodeId: loadingNodeId }]); } catch {}
        }
        const msg = err.message || 'Image generation failed.';
        const friendly = /Unexpected token.*<!DOCTYPE/i.test(msg)
          ? 'Image generation failed — your Gemini API key may be invalid or expired. Check your GEMINI_API_KEY.'
          : msg;
        return { content: [{ type: 'text', text: `Error: ${friendly}` }] };
      }
    },
  },
  {
    name: 'list_versions',
    description: 'List version history for a document. Returns timestamps, word counts, and sizes. Use to find a timestamp for restore_version.',
    schema: {
      docId: z.string().describe('Target document by docId (8-char hex from list_documents).'),
    },
    handler: async ({ docId }: { docId: string }) => {
      const target = resolveDocTarget(docId);
      const versions = listVersions(target.docId);
      if (versions.length === 0) return { content: [{ type: 'text', text: 'No versions found for this document.' }] };
      const lines = versions.map((v, i) =>
        `  ${i + 1}. ${v.date}  ts:${v.timestamp}  ${v.wordCount.toLocaleString()} words  ${(v.size / 1024).toFixed(1)}KB`
      );
      return { content: [{ type: 'text', text: `versions (${versions.length}):\n${lines.join('\n')}` }] };
    },
  },
  {
    name: 'create_checkpoint',
    description: 'Force a version snapshot of a document right now. Use before risky operations as a safety net.',
    schema: {
      docId: z.string().describe('Target document by docId (8-char hex from list_documents).'),
    },
    handler: async ({ docId }: { docId: string }) => {
      const target = resolveDocTarget(docId);
      forceSnapshot(target.docId, target.filePath);
      return { content: [{ type: 'text', text: `Checkpoint created at ${new Date().toISOString()}` }] };
    },
  },
  {
    name: 'restore_version',
    description: 'Restore a document to a previous version by timestamp. Automatically creates a safety checkpoint of the current state first. Get timestamps from list_versions.',
    schema: {
      docId: z.string().describe('Target document by docId (8-char hex from list_documents).'),
      timestamp: z.number().describe('Version timestamp to restore (from list_versions)'),
    },
    handler: async ({ docId, timestamp }: { docId: string; timestamp: number }) => {
      const target = resolveDocTarget(docId);

      // Safety net: snapshot current state before restoring
      try { forceSnapshot(target.docId, target.filePath); } catch { /* best effort */ }

      const parsed = restoreVersion(target.docId, timestamp);
      if (!parsed) return { content: [{ type: 'text', text: `Error: Version ${timestamp} not found.` }] };

      if (target.isActive) {
        updateDocument(parsed.document);
        save();
        broadcastDocumentSwitched(parsed.document, parsed.title, target.filename);
      } else {
        // Write restored content to file without switching active doc
        const markdown = tiptapToMarkdown(parsed.document, parsed.title, parsed.metadata);
        atomicWriteFileSync(target.filePath, markdown);
        invalidateDocCache(target.filePath);
        broadcastDocumentsChanged();
      }

      return { content: [{ type: 'text', text: `Restored version from ${new Date(timestamp).toISOString()} — "${parsed.title}"` }] };
    },
  },
  {
    name: 'reload_from_disk',
    description: 'Re-read a document from its file on disk. Use when the file was modified externally and the editor needs to pick up changes. Does NOT rescan the full document list.',
    schema: {
      docId: z.string().describe('Target document by docId (8-char hex from list_documents).'),
    },
    handler: async ({ docId }: { docId: string }) => {
      const target = resolveDocTarget(docId);
      if (!existsSync(target.filePath)) return { content: [{ type: 'text', text: `Error: File not found: ${target.filePath}` }] };

      if (target.isActive) {
        const markdown = readFileSync(target.filePath, 'utf-8');
        const parsed = markdownToTiptap(markdown);
        updateDocument(parsed.document);
        save();
        broadcastDocumentSwitched(parsed.document, parsed.title, target.filename);
        return { content: [{ type: 'text', text: `Reloaded "${parsed.title}" from disk` }] };
      } else {
        // Non-active: just invalidate cache so next access re-reads from disk
        invalidateDocCache(target.filePath);
        return { content: [{ type: 'text', text: `Cache invalidated for "${target.title}" — next access will re-read from disk` }] };
      }
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

  // ---- Task management ----
  {
    name: 'list_tasks',
    description: 'List all tasks for the current profile.',
    schema: {},
    handler: async () => {
      const tasks = readTasks();
      if (tasks.length === 0) return { content: [{ type: 'text', text: 'No tasks.' }] };
      const lines = tasks.map((t) => `[${t.completed ? 'x' : ' '}] ${t.text} (id:${t.id})`);
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
  },
  {
    name: 'add_task',
    description: 'Add a new task to the checklist.',
    schema: {
      text: z.string().describe('The task description.'),
    },
    handler: async ({ text }: { text: string }) => {
      const task = addTask(text);
      return { content: [{ type: 'text', text: `Added task: ${task.text} (id:${task.id})` }] };
    },
  },
  {
    name: 'update_task',
    description: 'Update a task (text or completion status).',
    schema: {
      id: z.string().describe('Task ID to update.'),
      text: z.string().optional().describe('New task text.'),
      completed: z.boolean().optional().describe('Mark completed (true) or incomplete (false).'),
    },
    handler: async ({ id, text, completed }: { id: string; text?: string; completed?: boolean }) => {
      const task = updateTask(id, { text, completed });
      if (!task) return { content: [{ type: 'text', text: `Task ${id} not found.` }] };
      return { content: [{ type: 'text', text: `Updated: [${task.completed ? 'x' : ' '}] ${task.text}` }] };
    },
  },
  {
    name: 'remove_task',
    description: 'Remove a task from the checklist.',
    schema: {
      id: z.string().describe('Task ID to remove.'),
    },
    handler: async ({ id }: { id: string }) => {
      const ok = removeTask(id);
      return { content: [{ type: 'text', text: ok ? `Removed task ${id}.` : `Task ${id} not found.` }] };
    },
  },
];

/** Live MCP server instance — used to register plugin tools dynamically. */
let mcpServerInstance: McpServer | null = null;

/** Convert a JSON Schema properties object to a Zod shape for MCP tool registration. */
function jsonSchemaToZodShape(inputSchema: Record<string, unknown>): Record<string, z.ZodTypeAny> {
  const properties = (inputSchema.properties || {}) as Record<string, { type?: string; description?: string }>;
  const required = new Set((inputSchema.required || []) as string[]);
  const shape: Record<string, z.ZodTypeAny> = {};

  for (const [key, prop] of Object.entries(properties)) {
    let field: z.ZodTypeAny;
    switch (prop.type) {
      case 'number': field = z.number(); break;
      case 'boolean': field = z.boolean(); break;
      default: field = z.string(); break;
    }
    if (prop.description) field = field.describe(prop.description);
    if (!required.has(key)) field = field.optional();
    shape[key] = field;
  }
  return shape;
}

/** Register MCP tools from plugins. Dynamically adds to the live MCP session. */
export function registerPluginTools(tools: import('./plugin-types.js').PluginMcpTool[]): void {
  for (const tool of tools) {
    const zodShape = jsonSchemaToZodShape(tool.inputSchema);
    const toolDef: ToolDef = {
      name: tool.name,
      description: tool.description,
      schema: zodShape,
      handler: async (args: any) => {
        const result = await tool.handler(args);
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      },
    };
    TOOL_REGISTRY.push(toolDef);

    // Register on live MCP server so existing sessions see it immediately
    if (mcpServerInstance) {
      mcpServerInstance.tool(tool.name, tool.description, zodShape, toolDef.handler);
    }
  }

  // Notify connected clients that the tool list changed
  if (mcpServerInstance) {
    mcpServerInstance.server.sendToolListChanged().catch(() => {});
  }
}

/** Remove MCP tools by name. Notifies connected clients of the change. */
export function removePluginTools(names: string[]): void {
  const nameSet = new Set(names);
  for (let i = TOOL_REGISTRY.length - 1; i >= 0; i--) {
    if (nameSet.has(TOOL_REGISTRY[i].name)) {
      TOOL_REGISTRY.splice(i, 1);
    }
  }

  if (mcpServerInstance) {
    mcpServerInstance.server.sendToolListChanged().catch(() => {});
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

  mcpServerInstance = server;

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
