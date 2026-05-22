/**
 * Express HTTP server: serves built React app, WebSocket, plugins.
 * MCP stdio transport is started separately in bin/pad.ts for fast startup.
 */

import express from 'express';
import { createServer } from 'http';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync, readFileSync } from 'fs';
import { setupWebSocket, broadcastAgentStatus, broadcastDocumentSwitched, broadcastDocumentsChanged, broadcastWorkspacesChanged, broadcastMetadataChanged, broadcastPendingDocsChanged, broadcastSyncStatus, broadcastWritingStarted, broadcastWritingFinished, broadcastCommentsChanged } from './ws.js';
import { TOOL_REGISTRY } from './mcp.js';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { save, cancelDebouncedSave, load, getDocument, getTitle, getFilePath, getDocId, getMetadata, getStatus, updateDocument, setMetadata, applyTextEdits, isAgentLocked, getPendingDocInfo, getDocTagsByFilename, addDocTag, removeDocTag, markAllNodesAsPending, updatePendingCacheForActiveDoc, removePendingCacheEntry, clearAllCaches, stripPendingAttrs, stripPendingAttrsFromFile, setAutoAcceptOnFile, markAsAgentStub } from './state.js';
import { syncPostHistory } from './post-sync.js';
import { listDocuments, switchDocument, createDocument, deleteDocument, duplicateDocument, reloadDocument, updateDocumentTitle, openFile, reorderDocs, searchDocuments, listArchivedDocuments, archiveDocument, unarchiveDocument, getActiveFilename, batchResolve } from './documents.js';
import { createWorkspaceRouter } from './workspace-routes.js';
import { createLinkRouter } from './link-routes.js';
import { createTweetRouter } from './tweet-routes.js';
import { markdownToTiptap } from './markdown.js';
import { importGoogleDoc } from './gdoc-import.js';
import { createVersionRouter } from './version-routes.js';
import { clearVersionsCache } from './versions.js';
import { createSyncRouter } from './sync-routes.js';
import { removeDocFromAllWorkspaces } from './workspaces.js';
import { resolveDocPath, getActiveProfile, setActiveProfile, listProfiles, createProfile, deleteProfile, listTrashedProfiles, restoreProfile, saveConfig, readConfig } from './helpers.js';
import { createImageRouter } from './image-upload.js';
import { createExportRouter } from './export-routes.js';
import { createConnectionRouter } from './connection-routes.js';
import { createSchedulerRouter } from './scheduler-routes.js';
import { createBillingRouter } from './billing-routes.js';
import { createBlogRouter } from './blog-routes.js';
import { createTaskRouter } from './task-routes.js';
import { platformFetch, isAuthenticated } from './connections.js';
import { PluginManager } from './plugin-manager.js';
import type { PluginActionPayload } from './plugin-types.js';
import { checkForUpdate, getUpdateInfo, getCurrentVersion } from './update-check.js';
import { addComment, getComments, resolveComments, unresolveComments, deleteComments, editComment } from './comments.js';
import { initLogger, logger, generateRequestId, withRequestId } from './logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export async function startHttpServer(options: { port?: number; noOpen?: boolean; plugins?: string[] } = {}): Promise<void> {
  const port = options.port || 5050;

  // Initialize structured logging first — every subsequent module call can
  // emit events from this point. Config file lives at ~/.openwriter/
  // log-config.json (missing = safe public defaults: error-only, no text).
  // adr: adr/logging-system.md
  initLogger();
  logger.info('state', 'server-boot', `OpenWriter starting on port ${port}`, { port });

  const app = express();
  app.use(express.json({ limit: '10mb' }));

  // API routes for direct HTTP access (fallback if WS not available)
  app.get('/api/status', (_req, res) => {
    res.json(getStatus());
  });

  // MCP tool metadata: lets client-mode proxies discover tools without importing mcp.js
  app.get('/api/mcp-tools', (_req, res) => {
    const tools = TOOL_REGISTRY.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: zodToJsonSchema(z.object(t.schema)),
    }));
    res.json({ tools });
  });

  // MCP-over-HTTP: allows client-mode terminals to proxy tool calls
  app.post('/api/mcp-call', async (req, res) => {
    const { tool: toolName, arguments: args } = req.body;
    // Wrap the call in a request ID scope so every event logged during
    // this tool invocation correlates. adr: adr/logging-system.md
    const reqId = generateRequestId(`mcp-http-${toolName || 'unknown'}`);
    await withRequestId(reqId, async () => {
      try {
        const tool = TOOL_REGISTRY.find((t) => t.name === toolName);
        if (!tool) {
          res.status(404).json({ error: `Unknown tool: ${toolName}` });
          return;
        }
        // Validate arguments against the tool's Zod schema (mirrors McpServer.validateToolInput)
        const schema = z.object(tool.schema);
        const parsed = schema.safeParse(args || {});
        if (!parsed.success) {
          res.status(400).json({ content: [{ type: 'text' as const, text: `Validation error: ${parsed.error.message}` }] });
          return;
        }
        logger.debug('mcp', 'tool-call-http', tool.name, { tool: tool.name });
        const result = await tool.handler(parsed.data);
        res.json(result);
      } catch (err: any) {
        logger.error('mcp', 'tool-error-http', `${toolName}: ${err.message}`, { tool: toolName }, err);
        res.status(500).json({ content: [{ type: 'text', text: `Error: ${err.message}` }] });
      }
    });
  });

  app.get('/api/update-info', (_req, res) => {
    const latestVersion = getUpdateInfo();
    res.json({ updateAvailable: latestVersion, currentVersion: getCurrentVersion() });
  });

  app.get('/api/document', (_req, res) => {
    res.json({ document: getDocument(), title: getTitle(), metadata: getMetadata() });
  });

  app.get('/api/pending-docs', (_req, res) => {
    res.json(getPendingDocInfo());
  });

  // Mount image upload + static serving
  app.use(createImageRouter());

  // Mount sync routes
  app.use(createSyncRouter(broadcastSyncStatus));

  // Mount export routes
  app.use(createExportRouter());

  // Mount connection CRUD + profile binding routes
  app.use(createConnectionRouter());

  // Mount scheduler proxy routes
  app.use(createSchedulerRouter());

  // Mount billing proxy routes
  app.use(createBillingRouter());

  // Mount blog publish routes
  app.use(createBlogRouter());

  // Mount task CRUD routes
  app.use(createTaskRouter());

  // Newsletter analytics proxy routes
  app.get('/api/publications', async (req, res) => {
    try {
      if (!isAuthenticated()) { res.status(401).json({ error: 'Not authenticated' }); return; }
      const qs = req.query.documentId ? `?documentId=${encodeURIComponent(req.query.documentId as string)}` : '';
      const resp = await platformFetch(`/publications${qs}`);
      const data = await resp.json();
      res.status(resp.status).json(data);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/publications/:id/stats', async (req, res) => {
    try {
      if (!isAuthenticated()) { res.status(401).json({ error: 'Not authenticated' }); return; }
      const resp = await platformFetch(`/publications/${req.params.id}/stats`);
      const data = await resp.json();
      res.status(resp.status).json(data);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Mount version history routes
  app.use(createVersionRouter({
    getDocId,
    getFilePath,
    updateDocument,
    save,
    broadcastDocumentSwitched,
  }));

  // Update document metadata from browser (e.g. view toggle in Appearance panel)
  app.post('/api/metadata', (req, res) => {
    try {
      setMetadata(req.body);
      save();
      broadcastMetadataChanged(getMetadata());
      broadcastDocumentsChanged();
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Toggle auto-accept on a document. Body: { filename, enabled }.
  // When enabling, any currently-pending changes are accepted in place so the
  // user enters a clean state — agent writes from this point commit directly.
  app.post('/api/auto-accept', (req, res) => {
    try {
      const filename = req.body?.filename as string | undefined;
      const enabled = req.body?.enabled === true;
      if (!filename) return res.status(400).json({ error: 'filename required' });

      const isActiveDoc = filename === getActiveFilename();
      if (isActiveDoc) {
        if (enabled) {
          stripPendingAttrs(); // accept any pending changes
        }
        // Explicit boolean (not delete) — false overrides workspace inheritance.
        setMetadata({ autoAccept: enabled });
        save();
        updatePendingCacheForActiveDoc();
        broadcastMetadataChanged(getMetadata());
        broadcastDocumentSwitched(getDocument(), getTitle(), getActiveFilename(), getMetadata());
      } else {
        if (enabled) stripPendingAttrsFromFile(filename, true);
        setAutoAcceptOnFile(filename, enabled);
      }
      broadcastDocumentsChanged();
      broadcastPendingDocsChanged();
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Toggle auto-accept on a workspace or container. Inherits to every doc inside.
  // Body: { wsFile, containerId?, enabled }. Omit containerId to target the
  // whole workspace; pass it to target a specific container.
  app.post('/api/auto-accept/inherit', async (req, res) => {
    try {
      const wsFile = req.body?.wsFile as string | undefined;
      const containerId = req.body?.containerId as string | undefined;
      const enabled = req.body?.enabled === true;
      if (!wsFile) return res.status(400).json({ error: 'wsFile required' });

      const { setWorkspaceAutoAccept, setContainerAutoAccept, collectFilesInWorkspace, collectFilesInContainer } = await import('./workspaces.js');

      if (containerId) {
        setContainerAutoAccept(wsFile, containerId, enabled);
      } else {
        setWorkspaceAutoAccept(wsFile, enabled);
      }

      // If enabling, sweep any in-flight pending changes on every affected doc.
      // (Pure inheritance leaves doc flags alone, but existing pending decorations
      //  should clear so the user enters a clean draft state.)
      const affected = containerId ? collectFilesInContainer(wsFile, containerId) : collectFilesInWorkspace(wsFile);
      if (enabled) {
        const activeFn = getActiveFilename();
        for (const file of affected) {
          if (file === activeFn) {
            stripPendingAttrs();
          } else {
            stripPendingAttrsFromFile(file, true);
          }
        }
        if (affected.includes(activeFn)) {
          save();
          updatePendingCacheForActiveDoc();
        }
      }

      broadcastWorkspacesChanged();
      broadcastDocumentsChanged();
      broadcastPendingDocsChanged();
      // Surface metadata change for the active doc so the editor banner updates.
      if (affected.includes(getActiveFilename())) {
        broadcastMetadataChanged(getMetadata());
      }
      res.json({ success: true, affected: affected.length });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/save', (_req, res) => {
    save();
    res.json({ success: true });
  });

  // Beacon-based flush: browser sends this on beforeunload/visibilitychange
  // Client sends as application/json Blob (non-CORS-safelisted, so cross-origin sendBeacon is blocked)
  app.post('/api/flush', (req, res) => {
    try {
      if (isAgentLocked(getActiveFilename())) {
        console.log('[Flush] Blocked (agent write lock active)');
        res.status(204).end();
        return;
      }
      const msg = req.body;
      if (msg.document) {
        updateDocument(msg.document);
        save();
      } else if (msg.markdown) {
        const parsed = markdownToTiptap(msg.markdown);
        updateDocument(parsed.document);
        if (parsed.title !== 'Untitled') setMetadata({ title: parsed.title });
        save();
      }
      res.status(204).end();
    } catch {
      res.status(400).end();
    }
  });

  // Document CRUD routes
  app.get('/api/documents', (_req, res) => {
    res.json(listDocuments());
  });

  // References: get the live computed inverse for a target docId. Returns
  // every source doc that lists this docId in its `references:` frontmatter.
  // Cached server-side; cache invalidated on any save that touches references.
  app.get('/api/backlinks/:docId', async (req, res) => {
    try {
      const { computeBacklinksFor } = await import('./backlinks.js');
      res.json(computeBacklinksFor(req.params.docId));
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // References: full rebuild across all docs (idempotent rescue path).
  // Walks every .md, extracts legacy prose `doc:` links from body, merges
  // their targets into `references:`, strips any legacy `backlinks:` field.
  // Idempotent — safe to re-run.
  app.post('/api/rebuild-references', async (_req, res) => {
    try {
      const { rebuildAllReferences } = await import('./backlinks.js');
      const result = rebuildAllReferences();
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Legacy alias: kept for one release cycle so existing scripts/agents
  // pointing at the old path still work. Forwards to the new endpoint.
  app.post('/api/rebuild-backlinks', async (_req, res) => {
    try {
      const { rebuildAllReferences } = await import('./backlinks.js');
      const result = rebuildAllReferences();
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // List a doc's block-level paragraphs/headings for the manual paragraph-target
  // picker in the right-click "Link to doc" UI. Returns nodeId + type + level +
  // a short text preview per block. Active doc reads from in-memory state; other
  // docs are parsed from disk.
  app.get('/api/documents/by-doc-id/:docId/paragraphs', async (req, res) => {
    try {
      const { resolveDocId } = await import('./documents.js');
      const filename = resolveDocId(req.params.docId);
      const activeFilename = getActiveFilename();
      let doc: any;
      if (filename === activeFilename) {
        doc = getDocument();
      } else {
        const filePath = resolveDocPath(filename);
        const raw = readFileSync(filePath, 'utf-8');
        const parsed = markdownToTiptap(raw);
        doc = parsed.document;
      }

      type ParaEntry = { nodeId: string; type: string; level?: number; preview: string };
      const out: ParaEntry[] = [];
      function walk(nodes: any[]): void {
        for (const node of nodes) {
          if (node.type === 'heading' || node.type === 'paragraph') {
            const text = (node.content || [])
              .map((c: any) => (c.type === 'text' ? (c.text || '') : ''))
              .join('')
              .trim();
            if (!text) continue; // skip empty paragraphs
            const preview = text.length > 80 ? text.slice(0, 79) + '…' : text;
            const entry: ParaEntry = { nodeId: node.attrs?.id || '', type: node.type, preview };
            if (node.type === 'heading') entry.level = node.attrs?.level || 1;
            if (entry.nodeId) out.push(entry);
          } else if (Array.isArray(node.content)) {
            walk(node.content);
          }
        }
      }
      walk(doc.content || []);
      res.json({ paragraphs: out });
    } catch (err: any) {
      res.status(404).json({ error: err.message });
    }
  });

  app.get('/api/documents/:filename/text', (req, res) => {
    try {
      const filepath = resolveDocPath(req.params.filename);
      const raw = readFileSync(filepath, 'utf-8');
      // Parse YAML frontmatter
      const fmMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
      const text = fmMatch ? fmMatch[2].trim() : raw.trim();
      let meta: Record<string, any> = {};
      if (fmMatch) {
        try { meta = JSON.parse(fmMatch[1]); } catch {}
      }
      res.json({ text, meta });
    } catch (err: any) {
      res.status(404).json({ error: 'Document not found' });
    }
  });

  app.put('/api/documents/reorder', (req, res) => {
    try {
      const { order } = req.body;
      if (!Array.isArray(order)) return res.status(400).json({ error: 'order must be an array' });
      reorderDocs(order);
      broadcastDocumentsChanged();
      res.json({ success: true });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post('/api/documents', (req, res) => {
    try {
      const result = createDocument(req.body.title, req.body.content, req.body.path);

      // Apply metadata if provided (e.g. tweetContext for threadified docs)
      if (req.body.metadata) {
        setMetadata(req.body.metadata);
        save();
      }

      // Variant relationship — set masterDocId and variantType in frontmatter
      if (req.body.masterDocId || req.body.variantType) {
        const variantMeta: Record<string, any> = {};
        if (req.body.masterDocId) variantMeta.masterDocId = req.body.masterDocId;
        if (req.body.variantType) variantMeta.variantType = req.body.variantType;
        setMetadata(variantMeta);
        save();
      }

      // Plugin flags: mark all content as pending + tag as agent-created
      if (req.body.markPending) {
        markAllNodesAsPending(getDocument(), 'insert');
        updatePendingCacheForActiveDoc();
        save();
      }
      if (req.body.agentCreated) {
        // In-memory stub registry — not persisted to disk frontmatter.
        // adr: adr/agent-stub-model.md
        markAsAgentStub(result.filename);
      }

      broadcastDocumentSwitched(result.document, result.title, result.filename);
      if (req.body.markPending || req.body.agentCreated) {
        broadcastDocumentsChanged();
        broadcastPendingDocsChanged();
      }
      res.json(result);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post('/api/documents/duplicate', (req, res) => {
    try {
      const { filename } = req.body;
      if (!filename) { res.status(400).json({ error: 'filename is required' }); return; }
      const result = duplicateDocument(filename);
      broadcastDocumentSwitched(result.document, result.title, result.filename);
      broadcastDocumentsChanged();
      res.json(result);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post('/api/documents/batch-resolve', (req, res) => {
    try {
      const { filenames, action } = req.body;
      if (!Array.isArray(filenames) || !filenames.length) { res.status(400).json({ error: 'filenames array is required' }); return; }
      if (action !== 'accept' && action !== 'reject') { res.status(400).json({ error: 'action must be "accept" or "reject"' }); return; }
      const result = batchResolve(filenames, action);
      if (result.docsResolved > 0) {
        // Clear pending cache for resolved docs + broadcast
        for (const fn of filenames) removePendingCacheEntry(fn);
        updatePendingCacheForActiveDoc();
        broadcastPendingDocsChanged();
        broadcastDocumentsChanged();
      }
      res.json(result);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post('/api/documents/open', (req, res) => {
    try {
      const { path } = req.body;
      if (!path) {
        res.status(400).json({ error: 'path is required' });
        return;
      }
      const result = openFile(path);
      broadcastDocumentSwitched(result.document, result.title, result.filename);
      res.json(result);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // Sync browser editor content to server state — guarantees server has latest before MCP calls.
  // Used by compose modals that need to read server state via MCP tools.
  app.post('/api/documents/sync-content', (req, res) => {
    try {
      const { document: doc, filename } = req.body;
      if (!doc || !filename) {
        res.status(400).json({ error: 'document and filename required' });
        return;
      }
      if (filename === getActiveFilename()) {
        updateDocument(doc);
        save();
      }
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/documents/switch', (req, res) => {
    try {
      const alreadyActive = req.body.filename === getActiveFilename();
      const result = switchDocument(req.body.filename);
      if (!alreadyActive) {
        broadcastDocumentSwitched(result.document, result.title, result.filename);
      }
      res.json(result);
    } catch (err: any) {
      res.status(404).json({ error: err.message });
    }
  });

  app.post('/api/documents/reload', (_req, res) => {
    try {
      const result = reloadDocument();
      broadcastDocumentSwitched(result.document, result.title, result.filename);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/documents/archived', (_req, res) => {
    res.json(listArchivedDocuments());
  });

  app.get('/api/documents/search', (req, res) => {
    const q = (req.query.q as string) || '';
    const includeArchived = req.query.archived === 'true';
    res.json(searchDocuments(q, includeArchived));
  });

  app.post('/api/documents/:filename/archive', (req, res) => {
    try {
      removeDocFromAllWorkspaces(req.params.filename);
      const result = archiveDocument(req.params.filename);
      if (result.switched && result.newDoc) {
        broadcastDocumentSwitched(result.newDoc.document, result.newDoc.title, result.newDoc.filename);
      }
      broadcastDocumentsChanged();
      broadcastWorkspacesChanged();
      res.json(result);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post('/api/documents/:filename/unarchive', (req, res) => {
    try {
      const result = unarchiveDocument(req.params.filename);
      broadcastDocumentsChanged();
      res.json(result);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  app.get('/api/documents/:filename/content', (req, res) => {
    try {
      const targetPath = resolveDocPath(req.params.filename);
      if (!existsSync(targetPath)) {
        res.status(404).json({ error: 'Document not found' });
        return;
      }
      const raw = readFileSync(targetPath, 'utf-8');
      const parsed = markdownToTiptap(raw);
      res.json({
        title: parsed.title,
        document: parsed.document,
        metadata: parsed.metadata,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete('/api/documents/:filename', async (req, res) => {
    try {
      removeDocFromAllWorkspaces(req.params.filename);
      const result = await deleteDocument(req.params.filename);
      if (result.switched && result.newDoc) {
        broadcastDocumentSwitched(result.newDoc.document, result.newDoc.title, result.newDoc.filename);
      }
      broadcastDocumentsChanged();
      broadcastWorkspacesChanged();
      res.json(result);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  app.put('/api/documents/:filename', (req, res) => {
    try {
      // Title change = metadata only. Filename stays stable.
      updateDocumentTitle(req.params.filename, req.body.title);
      broadcastDocumentsChanged();
      res.json({ filename: req.params.filename });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // Document-level tag routes
  app.get('/api/doc-tags/:filename', (req, res) => {
    res.json({ tags: getDocTagsByFilename(req.params.filename) });
  });

  app.post('/api/doc-tags/:filename', (req, res) => {
    try {
      const { tag } = req.body;
      if (!tag?.trim()) { res.status(400).json({ error: 'tag is required' }); return; }
      addDocTag(req.params.filename, tag.trim());
      broadcastDocumentsChanged();
      res.json({ success: true });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  app.delete('/api/doc-tags/:filename/:tag', (req, res) => {
    try {
      removeDocTag(req.params.filename, req.params.tag);
      broadcastDocumentsChanged();
      res.json({ success: true });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // Comments (formerly "agent marks")
  app.post('/api/comments', (req, res) => {
    try {
      const { filename, text, note, nodeId, nodeIds } = req.body;
      if (!filename || !text || !nodeId) {
        res.status(400).json({ error: 'filename, text, and nodeId are required' });
        return;
      }
      const comment = addComment(filename, text, note || '', nodeId, nodeIds);
      broadcastCommentsChanged(filename);
      res.json({ success: true, comment });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/comments/:filename', (req, res) => {
    try {
      const byFile = getComments(req.params.filename);
      res.json({ comments: byFile[req.params.filename] || [] });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.patch('/api/comments', (req, res) => {
    try {
      const { filename, id, note } = req.body;
      if (!filename || !id || typeof note !== 'string') {
        res.status(400).json({ error: 'filename, id, and note are required' });
        return;
      }
      const comment = editComment(filename, id, note);
      if (!comment) {
        res.status(404).json({ error: 'comment not found' });
        return;
      }
      broadcastCommentsChanged(filename);
      res.json({ success: true, comment });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Permanently delete comments. Different from /resolve — this is the
  // "remove this record" path; resolve is the "addressed, archive it" path.
  app.delete('/api/comments', (req, res) => {
    try {
      const { ids } = req.body;
      if (!Array.isArray(ids)) {
        res.status(400).json({ error: 'ids must be an array' });
        return;
      }
      const deleted = deleteComments(ids);
      const activeFilename = getActiveFilename();
      broadcastCommentsChanged(activeFilename);
      res.json({ success: true, deleted });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Mark comments as resolved (state change, not deletion). The records
  // stay on disk; only the decoration disappears.
  app.post('/api/comments/resolve', (req, res) => {
    try {
      const { ids } = req.body;
      if (!Array.isArray(ids)) {
        res.status(400).json({ error: 'ids must be an array' });
        return;
      }
      const resolved = resolveComments(ids);
      const activeFilename = getActiveFilename();
      broadcastCommentsChanged(activeFilename);
      res.json({ success: true, resolved });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Clear the resolved flag — the comment surfaces again and re-decorates.
  app.post('/api/comments/unresolve', (req, res) => {
    try {
      const { ids } = req.body;
      if (!Array.isArray(ids)) {
        res.status(400).json({ error: 'ids must be an array' });
        return;
      }
      const cleared = unresolveComments(ids);
      const activeFilename = getActiveFilename();
      broadcastCommentsChanged(activeFilename);
      res.json({ success: true, cleared });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Mount workspace CRUD + doc/container routes
  app.use(createWorkspaceRouter({ broadcastWorkspacesChanged }));

  // Mount link-doc routes (create-link-doc, auto-tag-link)
  app.use(createLinkRouter({ broadcastDocumentsChanged, broadcastWorkspacesChanged }));

  // Mount tweet embed proxy
  app.use(createTweetRouter());

  // Text edit (fine-grained find/replace + mark changes within a node)
  app.post('/api/edit-text', (req, res) => {
    try {
      const { nodeId, edits } = req.body;
      if (!nodeId || !edits) {
        res.status(400).json({ error: 'nodeId and edits are required' });
        return;
      }
      const result = applyTextEdits(nodeId, edits);
      if (!result.success) {
        res.status(400).json({ error: result.error });
        return;
      }
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });


  // ---- Profile management ----
  app.get('/api/profiles', (_req, res) => {
    res.json({ profiles: listProfiles(), active: getActiveProfile() });
  });

  app.post('/api/profiles', (req, res) => {
    try {
      const { name } = req.body;
      if (!name?.trim()) { res.status(400).json({ error: 'name is required' }); return; }
      createProfile(name.trim());
      res.json({ success: true });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post('/api/profiles/switch', async (req, res) => {
    try {
      const { name } = req.body;
      if (!name?.trim()) { res.status(400).json({ error: 'name is required' }); return; }
      const profiles = listProfiles();
      if (!profiles.includes(name)) { res.status(404).json({ error: `Profile "${name}" not found` }); return; }

      // Flush current doc
      cancelDebouncedSave();
      save();

      // Switch profile
      setActiveProfile(name);
      saveConfig({ activeProfile: name });

      // Clear caches and reload
      clearAllCaches();
      clearVersionsCache();
      load();

      // Broadcast fresh state
      broadcastDocumentSwitched(getDocument(), getTitle(), getFilePath().split(/[/\\]/).pop() || '', getMetadata());
      broadcastDocumentsChanged();
      broadcastWorkspacesChanged();
      broadcastPendingDocsChanged();

      res.json({ success: true, active: name });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  app.delete('/api/profiles/:name', (req, res) => {
    try {
      deleteProfile(req.params.name);
      res.json({ success: true });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  app.get('/api/profiles/trash', (_req, res) => {
    res.json({ profiles: listTrashedProfiles() });
  });

  app.post('/api/profiles/restore', (req, res) => {
    try {
      const { name } = req.body;
      if (!name?.trim()) { res.status(400).json({ error: 'name is required' }); return; }
      restoreProfile(name.trim());
      res.json({ success: true });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // Google Doc import
  app.post('/api/import/gdoc', (req, res) => {
    try {
      const result = importGoogleDoc(req.body.document, req.body.title);
      broadcastDocumentsChanged();
      broadcastWorkspacesChanged();
      res.json(result);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // Plugin Manager — discover, enable/disable, config persistence
  const pluginManager = new PluginManager(app);
  await pluginManager.discover();

  // Auto-enable from --plugins CLI flag
  for (const name of (options.plugins || [])) {
    const result = await pluginManager.enable(name);
    if (!result.success) console.error(`[Plugin] ${result.error}`);
  }

  // Auto-enable from saved config.json
  const savedConfig = readConfig();
  for (const [name, state] of Object.entries(savedConfig.plugins || {})) {
    if (state.enabled && !((options.plugins || []).includes(name))) {
      const result = await pluginManager.enable(name);
      if (!result.success) console.error(`[Plugin] ${result.error}`);
    }
  }

  // Enabled plugins' context menu items (backward-compatible)
  app.get('/api/plugins', (_req, res) => {
    res.json({ plugins: pluginManager.getEnabledPluginDescriptors() });
  });

  // All discovered plugins with enabled status, configSchema, current config
  app.get('/api/available-plugins', (_req, res) => {
    res.json({ plugins: pluginManager.getAvailablePlugins() });
  });

  // Enable a plugin
  app.post('/api/plugins/enable', async (req, res) => {
    const { name } = req.body;
    if (!name) { res.status(400).json({ error: 'name is required' }); return; }
    const result = await pluginManager.enable(name);
    res.json(result);
  });

  // Disable a plugin
  app.post('/api/plugins/disable', async (req, res) => {
    const { name } = req.body;
    if (!name) { res.status(400).json({ error: 'name is required' }); return; }
    const result = await pluginManager.disable(name);
    res.json(result);
  });

  // Update plugin config
  app.post('/api/plugins/config', (req, res) => {
    const { name, config } = req.body;
    if (!name || !config) { res.status(400).json({ error: 'name and config are required' }); return; }
    const result = pluginManager.updateConfig(name, config);
    res.json(result);
  });

  // Check if a specific plugin is enabled
  app.get('/api/plugins/:name/status', (req, res) => {
    const fullName = `@openwriter/plugin-${req.params.name}`;
    const all = pluginManager.getAvailablePlugins();
    const match = all.find((p) => p.name === fullName || p.name === req.params.name);
    res.json({ enabled: match?.enabled ?? false });
  });

  // Plugin action dispatch — client sends action payload, routed to correct plugin
  app.post('/api/plugin-action', async (req, res) => {
    try {
      const payload = req.body as PluginActionPayload;
      res.status(404).json({ error: 'Use plugin-registered routes directly' });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Sidebar context menu action dispatch — routes to plugin's registered HTTP routes
  app.post('/api/plugins/sidebar-action', async (req, res) => {
    try {
      const { action, filename, title, instructions, label } = req.body;
      if (!action || !filename) {
        res.status(400).json({ error: 'action and filename are required' });
        return;
      }
      // Action format: "pluginPrefix:actionName" — forward to plugin's route
      const colonIdx = action.indexOf(':');
      if (colonIdx === -1) {
        res.status(400).json({ error: 'action must be namespaced (e.g. "scheduler:schedule-post")' });
        return;
      }
      const prefix = action.slice(0, colonIdx);
      const actionName = action.slice(colonIdx + 1);

      // Read document content so plugins don't need to call back
      let docContent = '';
      try {
        const targetPath = resolveDocPath(filename);
        if (existsSync(targetPath)) {
          docContent = readFileSync(targetPath, 'utf-8');
        }
      } catch { /* content stays empty */ }

      // Extract source doc's docId for variant spinner positioning
      let sourceDocId: string | undefined;
      const docIdMatch = docContent.match(/"docId"\s*:\s*"([^"]+)"/);
      if (docIdMatch) sourceDocId = docIdMatch[1];

      // Show sidebar spinner while plugin processes. Unique key so concurrent
      // writes (e.g. declare_writes in flight) aren't cleared alongside this one.
      const spinnerTitle = label ? `${label}: ${title}` : title;
      const spinnerKey = `sidebar-action:${action}:${filename}:${Date.now()}`;
      broadcastWritingStarted(
        spinnerTitle,
        sourceDocId ? { wsFilename: '', containerId: null, parentDocId: sourceDocId } : undefined,
        spinnerKey,
      );

      // Intercept res.json to clear spinner when plugin handler responds
      const origJson = res.json.bind(res);
      res.json = (body: any) => {
        broadcastWritingFinished(spinnerKey);
        return origJson(body);
      };

      // Forward to plugin route: POST /api/{prefix}/sidebar-action
      // Re-route the request through Express's internal router
      req.url = `/api/${prefix}/sidebar-action`;
      req.body = { action: actionName, filename, title, instructions, content: docContent };
      (app as any).handle(req, res, () => {
        broadcastWritingFinished(spinnerKey);
        res.status(404).json({ error: `No handler registered for action "${action}"` });
      });
    } catch (err: any) {
      // spinnerKey is out of scope here (try body may have thrown before it
      // was declared). The 60s timeout on the server entry cleans it up.
      res.status(500).json({ error: err.message });
    }
  });

  // Serve built React app
  const clientDir = join(__dirname, '..', 'client');
  if (existsSync(clientDir)) {
    app.use(express.static(clientDir));
    app.get('*', (_req, res) => {
      res.sendFile(join(clientDir, 'index.html'));
    });
  }

  const server = createServer(app);

  // Setup WebSocket on same server
  setupWebSocket(server);

  // Broadcast agent status now that WS is ready
  broadcastAgentStatus(true);

  await new Promise<void>((resolve, reject) => {
    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        console.error(`[HTTP] Port ${port} in use — retrying in 2s...`);
        setTimeout(() => {
          server.listen(port, '127.0.0.1', () => {
            console.log(`OpenWriter running at http://localhost:${port}`);
            resolve();
          });
        }, 2000);
      } else {
        console.error(`[HTTP] Server error:`, err);
        reject(err);
      }
    });
    server.listen(port, '127.0.0.1', () => {
      console.log(`OpenWriter running at http://localhost:${port}`);
      resolve();
    });
  });

  // Sync post history from platform (catch posts made while app was closed)
  syncPostHistory().catch(() => {});

  // Open browser unless --no-open or running as MCP stdio pipe
  const isMcpStdio = !process.stdout.isTTY;
  if (!options.noOpen && !isMcpStdio) {
    const open = await import('open');
    const url = existsSync(clientDir)
      ? `http://localhost:${port}`
      : 'http://localhost:5173';
    open.default(url).catch(() => {});
  }

  // Fire-and-forget update check (primary server only — client mode returns early above)
  checkForUpdate().catch(() => {});
}
