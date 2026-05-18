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
  onIdRewrites,
  isAgentLocked,
  setAgentLockActive,
  getDocVersion,
  isVersionCurrent,
  getPendingDocInfo,
  updatePendingCacheForActiveDoc,
  stripPendingAttrs,
  saveDocToFile,
  stripPendingAttrsFromFile,
  hasAcceptedContent,
  onExternalWriteConflict,
  onDocumentReloaded,
  isAgentStub,
  unmarkAgentStub,
  type NodeChange,
  type IdRewrite,
  type ExternalWriteConflict,
  type DocumentReloaded,
} from './state.js';
import { switchDocument, createDocument, deleteDocument, getActiveFilename, promoteTempFile } from './documents.js';
import { removeDocFromAllWorkspaces } from './workspaces.js';
import { canonicalizeIdentifier } from './helpers.js';
import { nodeTextPreview, diagLog } from './pending-overlay.js';
import { generateRequestId, withRequestId } from './logger.js';

/** Walk a doc and return a per-pending-node summary for diagnostic logging.
 *  Produces lines like "nodeId/status text=\"...\" orig=\"...\"" — empty
 *  if the doc has no pending nodes. adr: adr/pending-overlay-model.md */
function pendingSummary(doc: any): string {
  if (!doc?.content) return '<none>';
  const lines: string[] = [];
  function walk(nodes: any[]): void {
    if (!Array.isArray(nodes)) return;
    for (const node of nodes) {
      const status = node?.attrs?.pendingStatus;
      if (status && node?.attrs?.id) {
        const text = nodeTextPreview(node);
        const orig = node.attrs.pendingOriginalContent ? nodeTextPreview(node.attrs.pendingOriginalContent) : '<none>';
        const identity = (status === 'rewrite' && text === orig) ? ' IDENTITY!' : '';
        lines.push(`${node.attrs.id}/${status} text="${text}" orig="${orig}"${identity}`);
      }
      if (node.content) walk(node.content);
    }
  }
  walk(doc.content);
  return lines.length === 0 ? '<none>' : lines.join(' | ');
}

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
      setAgentLockActive();
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

  // Push matcher-driven ID rewrites to clients so their in-memory TipTap state
  // tracks the server's authoritative ID assignment. Without this, the browser
  // can hold stale IDs after a save-time matcher reassignment, subsequent
  // server→browser messages targeting the new IDs silently fail to resolve at
  // the bridge anchor lookup, and the browser's debounced autosave eventually
  // overwrites fresh server state with the stale view (the v0.14.0 bug pattern).
  // adr: adr/node-identity-matcher.md
  onIdRewrites((rewrites: IdRewrite[]) => {
    if (rewrites.length === 0) return;
    const msg = JSON.stringify({ type: 'id-rewrites', rewrites });
    for (const ws of clients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(msg);
    }
    console.log(`[WS] Broadcast id-rewrites (${rewrites.length} block(s))`);
  });

  // Push-based: the fs.watch on the active doc fires this listener when an
  // external writer (Edit tool, VSCode, a script) modifies the file. The
  // server has already reloaded its in-memory state from disk and bumped
  // docVersion — we just need to swap the browser's TipTap view so it
  // matches and surface a toast. Stale autosaves from before the external
  // write are rejected by the existing version check in the doc-update
  // handler.
  //
  // Version sync: we include the freshly-bumped docVersion in the message.
  // The browser adopts it as its new baseline so subsequent autosaves (from
  // the user typing on top of the reloaded content) pass the isVersionCurrent
  // check. Without this, browser sits at version 0 while the server is at
  // N+1, and every browser edit gets BLOCKED — typing silently fails to save.
  // adr: adr/active-doc-watcher.md
  onDocumentReloaded((event: DocumentReloaded) => {
    const msg = JSON.stringify({
      type: 'document-reloaded',
      filename: event.filename,
      document: event.document,
      title: event.title,
      docId: event.docId,
      metadata: event.metadata,
      version: getDocVersion(),
      orphanCount: event.orphans.length,
      staleBaselineCount: event.staleBaseline.length,
    });
    for (const ws of clients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(msg);
    }
    // Pending count may have shifted (orphan rewrites convert to inserts).
    broadcastPendingDocsChanged();
  });

  // Legacy: surface external-write conflicts when writeToDisk's mtime
  // guard fires. With the active-doc watcher in place, the watcher should
  // reload before any save races, but the guard remains as a backstop —
  // if it fires, we still want to tell the user.
  // adr: adr/external-write-guard.md
  onExternalWriteConflict((conflict: ExternalWriteConflict) => {
    const filename = conflict.filePath.split(/[/\\]/).pop() || conflict.filePath;
    const msg = JSON.stringify({
      type: 'external-write-conflict',
      filePath: conflict.filePath,
      filename,
      diskMtime: conflict.diskMtime,
      loadedMtime: conflict.loadedMtime,
    });
    for (const ws of clients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(msg);
    }
    console.warn(`[WS] Broadcast external-write-conflict for ${filename}`);
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
    const docOnConnect = getDocument();
    const pendingOnConnect = pendingSummary(docOnConnect);
    diagLog(`[WS] document-switched SEND on-connect docId=${getDocId()} v=${getDocVersion()} pending=[${pendingOnConnect}]`);
    ws.send(JSON.stringify({
      type: 'document-switched',
      document: docOnConnect,
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
        // Every WS message gets a request ID — every downstream log emitted
        // while handling this message inherits it. Trace one request through
        // the whole system with: jq 'select(.requestId=="ws-xxxxxx")'.
        // adr: adr/logging-system.md
        const reqId = generateRequestId(`ws-${msg.type || 'unknown'}`);
        return await withRequestId(reqId, async () => { return await handleMessage(msg); });
      } catch (err: any) {
        console.error('[WS] Message error:', err.message);
      }
    });

    /** Inner handler — body extracted so it runs inside the withRequestId
     *  scope above. Returns void. */
    async function handleMessage(msg: any): Promise<void> {
      try {

        if (msg.type === 'doc-update' && msg.document) {
          const docContent = msg.document?.content || [];
          const nodeCount = docContent.length;
          const currentNodeCount = getDocument()?.content?.length || 0;
          const browserVersion = typeof msg.version === 'number' ? msg.version : -1;
          const serverVersion = getDocVersion();
          // Canonicalize the browser-sent filename so comparison against
          // getActiveFilename() doesn't trip on separator/case differences
          // for the same file. Without this, a browser that cached the
          // pre-canonicalization spelling sends doc-updates that look like
          // they're for a different doc, triggering saveDocToFile() to
          // write to the old non-canonical path — re-creating the
          // duplicate-document bug we just fixed.
          // adr: adr/path-canonicalization.md
          const browserFilename = msg.filename ? canonicalizeIdentifier(msg.filename) : msg.filename;
          if (isAgentLocked(browserFilename || getActiveFilename())) {
            diagLog(`[WS] doc-update BLOCKED by agent lock (browser: ${nodeCount} nodes, server: ${currentNodeCount} nodes) filename=${browserFilename || '<active>'} browserPending=[${pendingSummary(msg.document)}]`);
          } else if (browserVersion >= 0 && !isVersionCurrent(browserVersion)) {
            diagLog(`[WS] doc-update BLOCKED by stale version (browser: v${browserVersion}, server: v${serverVersion}) browserPending=[${pendingSummary(msg.document)}]`);
          } else if (browserFilename && browserFilename !== getActiveFilename()) {
            // Browser sent a doc-update for a different document (race: server switched away).
            // Save directly to that file on disk instead of corrupting the active doc.
            diagLog(`[WS] doc-update ROUTED-TO-NON-ACTIVE filename=${browserFilename} browserPending=[${pendingSummary(msg.document)}]`);
            saveDocToFile(browserFilename, msg.document);
          } else {
            // Strip ephemeral imageLoading nodes — they're transient placeholders that should
            // never persist. The browser's doc-update can re-add them after a failed rewrite.
            if (msg.document.content) {
              msg.document.content = msg.document.content.filter((n: any) => n.type !== 'imageLoading');
            }
            const cleanedCount = msg.document.content?.length || 0;
            // Capture server's BEFORE state so we can diff against the incoming.
            // adr: adr/pending-overlay-model.md
            const serverBefore = pendingSummary(getDocument());
            const browserAfter = pendingSummary(msg.document);
            if (serverBefore !== browserAfter) {
              diagLog(`[WS] doc-update PENDING-DIFF v${browserVersion}→v${serverVersion}`);
              diagLog(`  BEFORE(server): ${serverBefore}`);
              diagLog(`  AFTER (browser): ${browserAfter}`);
            }
            diagLog(`[WS] doc-update ACCEPTED (browser: ${nodeCount} nodes, cleaned: ${cleanedCount}, server: ${currentNodeCount} nodes)`);
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

          // Stub-cleanup: when the user rejects all pending decorations on a
          // doc that's still a fresh agent stub, delete the file. The stub
          // had no real content; the user said no to the populated content;
          // there's nothing left to keep.
          //
          // Stub status is consulted from the in-memory registry — NEVER
          // from disk frontmatter. The previous on-disk `agentCreated: true`
          // model was a silent-data-loss landmine: the flag survived across
          // sessions, restarts, and the doc's entire useful lifetime, so a
          // reject-all years later would destroy real work. The in-memory
          // model can only mark a doc as a stub during the brief window
          // between create_document and the first accepted save.
          // adr: adr/agent-stub-model.md
          if (action === 'reject' && isAgentStub(resolvedFilename)) {
            if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
            try {
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
              console.error('[WS] Failed to delete rejected agent stub:', err.message);
              // Fall through to normal strip+save (e.g. only doc remaining)
            }
          }

          if (isActiveDoc) {
            // Normal path: resolved doc is the active one. Accept-all
            // graduates the doc out of stub status (it now has accepted
            // content); the writeToDisk graduation does the same for
            // saves with mixed pending+accepted content.
            if (action === 'accept') unmarkAgentStub(resolvedFilename);
            stripPendingAttrs();
            save();
            updatePendingCacheForActiveDoc(); // Sync cache after strip (prevents stale "has changes" indicator)
          } else {
            // Race path: resolved doc is NOT the active one (server switched away).
            // Strip pending attrs directly from the file on disk.
            if (action === 'accept') unmarkAgentStub(resolvedFilename);
            stripPendingAttrsFromFile(resolvedFilename, action === 'accept');
          }
          broadcastPendingDocsChanged();
        }

      } catch {
        // Ignore malformed messages
      }
    }

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

export function broadcastCommentsChanged(filename: string): void {
  const msg = JSON.stringify({ type: 'comments-changed', filename });
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
