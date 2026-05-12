/**
 * WebSocket handler: pushes NodeChanges to browser, receives doc updates + signals.
 */

import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'http';
import {
  updateDocument,
  getDocument,
  getTitle,
  getFilePath,
  getDocId,
  getMetadata,
  setMetadata,
  save,
  onChanges,
  isAgentLocked,
  setAgentLock,
  getDocVersion,
  isVersionCurrent,
  getPendingDocInfo,
  updatePendingCacheForActiveDoc,
  stripPendingAttrs,
  saveDocToFile,
  stripPendingAttrsFromFile,
  type NodeChange,
} from './state.js';
import { switchDocument, createDocument, deleteDocument, getActiveFilename, promoteTempFile } from './documents.js';
import { removeDocFromAllWorkspaces } from './workspaces.js';

const clients = new Set<WebSocket>();
let currentAgentConnected = false;

// Debounced auto-save: persist to disk 2s after last doc-update
let saveTimer: ReturnType<typeof setTimeout> | null = null;
function debouncedSave(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    save();
    console.log('[WS] Auto-saved to disk');
  }, 2000);
}

// Debounced sidebar refresh: notify clients after title changes settle
let docsChangedTimer: ReturnType<typeof setTimeout> | null = null;
function debouncedBroadcastDocumentsChanged(): void {
  if (docsChangedTimer) clearTimeout(docsChangedTimer);
  docsChangedTimer = setTimeout(() => {
    broadcastDocumentsChanged();
  }, 2100);
}

export function setupWebSocket(server: Server): void {
  const wss = new WebSocketServer({
    server,
    verifyClient: ({ req }: { req: import('http').IncomingMessage }) => {
      const origin = req.headers.origin;
      // Allow connections with no origin (non-browser clients like MCP)
      // and localhost origins only (blocks cross-site WebSocket hijacking)
      if (!origin) return true;
      try {
        const url = new URL(origin);
        return url.hostname === 'localhost' || url.hostname === '127.0.0.1';
      } catch {
        return false;
      }
    },
  });

  // Push agent changes to all browser clients
  onChanges((changes: NodeChange[], version: number) => {
    // Check if changes include HR nodes in a tweet thread document.
    // Tweet editors don't support horizontalRule in their schema, so individual
    // node-changes with HRs silently fail. Send a full document resync instead,
    // which triggers splitContentAtHr in TweetComposeView to create new editors.
    const metadata = getMetadata();
    const isTweetThread = metadata?.tweetContext != null;

    const hasHrChange = isTweetThread && changes.some((c) => {
      if (!c.content) return false;
      const contentArr = Array.isArray(c.content) ? c.content : [c.content];
      return contentArr.some((n: any) => n.type === 'horizontalRule');
    });

    if (hasHrChange) {
      const doc = getDocument();
      console.log(`[WS] HR detected in tweet thread → sending document-switched (${doc?.content?.length || 0} nodes)`);
      // Re-set agent lock so the 3s window starts NOW, not from the original insert.
      // Tweet thread resyncs recreate all editors which fire onUpdate → stale doc-updates.
      // Without this reset, the lock expires before the browser finishes recreating editors.
      setAgentLock();
      const filePath = getFilePath();
      const filename = filePath ? filePath.split(/[/\\]/).pop() || '' : '';
      const msg = JSON.stringify({
        type: 'document-switched',
        document: getDocument(),
        title: getTitle(),
        filename,
        docId: getDocId(),
        metadata,
      });
      for (const ws of clients) {
        if (ws.readyState === WebSocket.OPEN) ws.send(msg);
      }
    } else {
      const msg = JSON.stringify({ type: 'node-changes', changes, version });
      for (const ws of clients) {
        if (ws.readyState === WebSocket.OPEN) ws.send(msg);
      }
    }
    // Notify browser of updated pending docs list (debounced)
    broadcastPendingDocsChanged();
  });

  wss.on('connection', (ws) => {
    clients.add(ws);
    console.log(`[WS] Client connected (total: ${clients.size})`);

    // Send current agent status to newly connected client
    ws.send(JSON.stringify({ type: 'agent-status', agentConnected: currentAgentConnected }));

    // Send current sync status if available
    if (lastSyncStatus) {
      ws.send(JSON.stringify({ type: 'sync-status', ...lastSyncStatus }));
    }

    // Always send authoritative document state on connect — forces browser to adopt server state
    // (prevents stale browser tabs from displaying old content)
    const filePath = getFilePath();
    const filename = filePath ? filePath.split(/[/\\]/).pop() || '' : '';
    ws.send(JSON.stringify({
      type: 'document-switched',
      document: getDocument(),
      title: getTitle(),
      filename,
      docId: getDocId(),
      metadata: getMetadata(),
    }));

    // Send pending docs info on connect
    ws.send(JSON.stringify({
      type: 'pending-docs-changed',
      pendingDocs: getPendingDocInfo(),
    }));

    // Rehydrate in-flight writing spinners across app refreshes
    const pendingWritesSnapshot = getPendingWritesSnapshot();
    if (pendingWritesSnapshot.length > 0) {
      ws.send(JSON.stringify({ type: 'pending-writes-sync', writes: pendingWritesSnapshot }));
    }

    ws.on('message', async (data) => {
      try {
        const msg = JSON.parse(data.toString());

        if (msg.type === 'doc-update' && msg.document) {
          const docContent = msg.document?.content || [];
          const nodeCount = docContent.length;
          const currentNodeCount = getDocument()?.content?.length || 0;
          const browserVersion = typeof msg.version === 'number' ? msg.version : -1;
          const serverVersion = getDocVersion();
          if (isAgentLocked()) {
            console.log(`[WS] doc-update BLOCKED by agent lock (browser: ${nodeCount} nodes, server: ${currentNodeCount} nodes)`);
          } else if (browserVersion >= 0 && !isVersionCurrent(browserVersion)) {
            console.log(`[WS] doc-update BLOCKED by stale version (browser: v${browserVersion}, server: v${serverVersion})`);
          } else if (msg.filename && msg.filename !== getActiveFilename()) {
            // Browser sent a doc-update for a different document (race: server switched away).
            // Save directly to that file on disk instead of corrupting the active doc.
            saveDocToFile(msg.filename, msg.document);
          } else {
            // Strip ephemeral imageLoading nodes — they're transient placeholders that should
            // never persist. The browser's doc-update can re-add them after a failed rewrite.
            if (msg.document.content) {
              msg.document.content = msg.document.content.filter((n: any) => n.type !== 'imageLoading');
            }
            const cleanedCount = msg.document.content?.length || 0;
            console.log(`[WS] doc-update ACCEPTED (browser: ${nodeCount} nodes, cleaned: ${cleanedCount}, server: ${currentNodeCount} nodes)`);
            updateDocument(msg.document);
            updatePendingCacheForActiveDoc(); // Keep cache in sync after browser edits/reject-all
            debouncedSave();
          }
        }

        // Browser requests fresh state on reconnect (instead of pushing stale state)
        if (msg.type === 'request-document') {
          const filePath = getFilePath();
          const filename = filePath ? filePath.split(/[/\\]/).pop() || '' : '';
          ws.send(JSON.stringify({
            type: 'document-switched',
            document: getDocument(),
            title: getTitle(),
            filename,
            docId: getDocId(),
            metadata: getMetadata(),
          }));
        }

        if (msg.type === 'title-update' && msg.title) {
          setMetadata({ title: msg.title });
          const promoted = promoteTempFile(msg.title as string);
          if (promoted) {
            save();
            broadcastDocumentSwitched(getDocument(), getTitle(), promoted, getMetadata());
            broadcastDocumentsChanged();
          } else {
            debouncedSave();
            debouncedBroadcastDocumentsChanged();
          }
        }

        if (msg.type === 'save') {
          save();
        }

        if (msg.type === 'switch-document' && msg.filename) {
          try {
            const result = switchDocument(msg.filename);
            broadcastDocumentSwitched(result.document, result.title, result.filename);
          } catch (err: any) {
            console.error('[WS] Switch document failed:', err.message);
          }
        }

        if (msg.type === 'create-document') {
          try {
            const result = createDocument(msg.title);
            broadcastDocumentSwitched(result.document, result.title, result.filename);
          } catch (err: any) {
            console.error('[WS] Create document failed:', err.message);
          }
        }

        if (msg.type === 'create-template' && msg.template) {
          try {
            const tmpl = msg.template as string;
            const url = msg.url as string | undefined;

            // Create named document (dedup handles collisions)
            let title = 'Untitled';
            if (tmpl === 'tweet') title = 'Tweet';
            else if (tmpl === 'reply') title = 'Reply';
            else if (tmpl === 'quote') title = 'Quote Tweet';
            else if (tmpl === 'article') title = 'Article';
            else if (tmpl === 'linkedin') title = 'LinkedIn Post';
            else if (tmpl === 'newsletter') title = 'Newsletter';
            else if (tmpl === 'blog') title = 'Blog Post';

            const result = createDocument(title);

            // Set template-specific metadata
            if (tmpl === 'tweet') {
              setMetadata({ tweetContext: { mode: 'tweet' } });
            } else if (tmpl === 'reply') {
              setMetadata({ tweetContext: { url, mode: 'reply' } });
            } else if (tmpl === 'quote') {
              setMetadata({ tweetContext: { url, mode: 'quote' } });
            } else if (tmpl === 'article') {
              setMetadata({ articleContext: { active: true } });
            } else if (tmpl === 'linkedin') {
              setMetadata({ linkedinContext: { active: true } });
            } else if (tmpl === 'newsletter') {
              setMetadata({ newsletterContext: { active: true } });
            } else if (tmpl === 'blog') {
              setMetadata({ blogContext: { active: true } });
            }

            save();
            broadcastDocumentSwitched(result.document, getTitle(), result.filename, getMetadata());
            broadcastDocumentsChanged();
          } catch (err: any) {
            console.error('[WS] Create template failed:', err.message);
          }
        }

        if (msg.type === 'pending-resolved' && msg.filename) {
          const action = msg.action as string; // 'accept' or 'reject'
          const resolvedFilename = msg.filename as string;
          const isActiveDoc = resolvedFilename === getActiveFilename();

          // Get metadata from the correct source (active state or disk file)
          const metadata = isActiveDoc ? getMetadata() : null;

          if (action === 'reject' && metadata?.agentCreated) {
            // Agent-created doc with all content rejected → delete the file
            // Cancel debounced save (doc-update may have queued one for the now-empty doc)
            if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
            try {
              // Remove from any workspace manifests before deleting the file
              removeDocFromAllWorkspaces(resolvedFilename);
              const result = await deleteDocument(resolvedFilename);
              if (result.switched && result.newDoc) {
                broadcastDocumentSwitched(result.newDoc.document, result.newDoc.title, result.newDoc.filename);
              }
              broadcastDocumentsChanged();
              broadcastWorkspacesChanged();
              broadcastPendingDocsChanged();
              return; // File deleted — no strip/save needed
            } catch (err: any) {
              console.error('[WS] Failed to delete rejected agent doc:', err.message);
              // Fall through to normal strip+save (e.g. only doc remaining)
            }
          }

          if (isActiveDoc) {
            // Normal path: resolved doc is the active one
            if (action === 'accept' && metadata?.agentCreated) {
              delete metadata.agentCreated;
            }
            stripPendingAttrs();
            save();
            updatePendingCacheForActiveDoc(); // Sync cache after strip (prevents stale "has changes" indicator)
          } else {
            // Race path: resolved doc is NOT the active one (server switched away).
            // Strip pending attrs directly from the file on disk.
            stripPendingAttrsFromFile(resolvedFilename, action === 'accept');
          }
          broadcastPendingDocsChanged();
        }

      } catch {
        // Ignore malformed messages
      }
    });

    ws.on('close', () => {
      clients.delete(ws);
      console.log(`[WS] Client disconnected (total: ${clients.size})`);
    });
  });
}

export function broadcastDocumentSwitched(document: any, title: string, filename: string, metadata?: Record<string, any>): void {
  const resolvedMeta = metadata ?? getMetadata();
  const msg = JSON.stringify({ type: 'document-switched', document, title, filename, docId: getDocId(), metadata: resolvedMeta });
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(msg);
    }
  }
}

export function broadcastMetadataChanged(metadata: Record<string, any>): void {
  const msg = JSON.stringify({ type: 'metadata-changed', metadata });
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  }
}

export function broadcastDocumentsChanged(): void {
  const msg = JSON.stringify({ type: 'documents-changed' });
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(msg);
    }
  }
}

export function broadcastWorkspacesChanged(): void {
  const msg = JSON.stringify({ type: 'workspaces-changed' });
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  }
}

export function broadcastTitleChanged(title: string): void {
  const msg = JSON.stringify({ type: 'title-changed', title });
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  }
}

// Debounced: coalesces rapid agent writes into a single broadcast.
let pendingDocsTimer: ReturnType<typeof setTimeout> | null = null;
const PENDING_DOCS_DEBOUNCE_MS = 500;

export function broadcastPendingDocsChanged(): void {
  if (pendingDocsTimer) clearTimeout(pendingDocsTimer);
  pendingDocsTimer = setTimeout(() => {
    pendingDocsTimer = null;
    const msg = JSON.stringify({
      type: 'pending-docs-changed',
      pendingDocs: getPendingDocInfo(),
    });
    for (const ws of clients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(msg);
    }
  }, PENDING_DOCS_DEBOUNCE_MS);
}

export function broadcastPluginsChanged(): void {
  const msg = JSON.stringify({ type: 'plugins-changed' });
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  }
}

export function broadcastAgentStatus(connected: boolean): void {
  currentAgentConnected = connected;
  const msg = JSON.stringify({ type: 'agent-status', agentConnected: connected });
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(msg);
    }
  }
}

let lastSyncStatus: any = null;

// Registry of in-flight writes. Keyed by filename when available so
// populate_document can resolve its matching spinner; otherwise auto-generated.
// Each entry has its own timeout so one slow write doesn't hold the spinner
// for siblings that finished fast.
interface PendingWrite {
  key: string;
  title: string;
  target: { wsFilename: string; containerId: string | null; parentDocId?: string } | null;
  startedAt: number;
  timer: ReturnType<typeof setTimeout>;
}
const pendingWrites = new Map<string, PendingWrite>();
const WRITING_TIMEOUT_MS = 60_000;

export function broadcastWritingStarted(
  title: string,
  target?: { wsFilename: string; containerId: string | null; parentDocId?: string },
  key?: string,
): string {
  const writeKey = key || target?.wsFilename || `write:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
  const existing = pendingWrites.get(writeKey);
  if (existing) clearTimeout(existing.timer);
  const timer = setTimeout(() => {
    console.log(`[WS] Writing spinner timed out for ${writeKey} — auto-clearing`);
    broadcastWritingFinished(writeKey);
  }, WRITING_TIMEOUT_MS);
  pendingWrites.set(writeKey, {
    key: writeKey,
    title,
    target: target || null,
    startedAt: Date.now(),
    timer,
  });
  const msg = JSON.stringify({ type: 'writing-started', title, target: target || null, key: writeKey });
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  }
  return writeKey;
}

// key omitted → clear all (legacy single-write flows). Pass a key for multi-doc.
export function broadcastWritingFinished(key?: string): void {
  if (key) {
    const entry = pendingWrites.get(key);
    if (entry) {
      clearTimeout(entry.timer);
      pendingWrites.delete(key);
    }
  } else {
    for (const entry of pendingWrites.values()) clearTimeout(entry.timer);
    pendingWrites.clear();
  }
  // Always send writing-finished with the key so the client can drop it from
  // its pending set. Then, if siblings remain, re-surface the latest with a
  // writing-started so the spinner doesn't vanish mid-batch.
  const finishedMsg = JSON.stringify({ type: 'writing-finished', key: key || null });
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(finishedMsg);
  }
  if (key && pendingWrites.size > 0) {
    let next: PendingWrite | null = null;
    for (const e of pendingWrites.values()) {
      if (!next || e.startedAt > next.startedAt) next = e;
    }
    if (next) {
      const startedMsg = JSON.stringify({
        type: 'writing-started',
        title: next.title,
        target: next.target,
        key: next.key,
      });
      for (const ws of clients) {
        if (ws.readyState === WebSocket.OPEN) ws.send(startedMsg);
      }
    }
  }
}

export function getPendingWritesSnapshot(): Array<{
  key: string;
  title: string;
  target: PendingWrite['target'];
  startedAt: number;
}> {
  return Array.from(pendingWrites.values()).map(({ key, title, target, startedAt }) => ({
    key,
    title,
    target,
    startedAt,
  }));
}

export function broadcastMarksChanged(filename: string): void {
  const msg = JSON.stringify({ type: 'marks-changed', filename });
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  }
}

export function broadcastSyncStatus(status: any): void {
  lastSyncStatus = status;
  const msg = JSON.stringify({ type: 'sync-status', ...status });
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(msg);
    }
  }
}
