import { useCallback, useEffect, useRef, useState } from 'react';

export interface NodeChange {
  operation: 'rewrite' | 'insert' | 'delete';
  nodeId?: string;
  afterNodeId?: string;
  content?: any;
}

interface WebSocketMessage {
  type: string;
  changes?: NodeChange[];
  agentConnected?: boolean;
  [key: string]: any;
}

export interface DocumentSwitchedPayload {
  document: any;
  title: string;
  filename: string;
  docId?: string;
  metadata?: Record<string, any>;
}

export interface PendingDocsPayload {
  filenames: string[];
  counts: Record<string, number>;
}

export interface SyncStatus {
  state: 'unconfigured' | 'synced' | 'pending' | 'syncing' | 'error';
  lastSyncTime?: string;
  pendingFiles?: number;
  error?: string;
}

interface UseWebSocketOptions {
  onNodeChanges?: (changes: NodeChange[]) => void;
  onAgentStatus?: (connected: boolean) => void;
  onDocumentSwitched?: (payload: DocumentSwitchedPayload) => void;
  onDocumentsChanged?: () => void;
  onWorkspacesChanged?: () => void;
  onTitleChanged?: (title: string) => void;
  onPendingDocsChanged?: (data: PendingDocsPayload) => void;
  onSyncStatus?: (status: SyncStatus) => void;
  onWritingStarted?: (title: string, target: { wsFilename: string; containerId: string | null } | null) => void;
  onMetadataChanged?: (metadata: Record<string, any>) => void;
  onWritingFinished?: () => void;
  /** Called on reconnect so the app can re-sync editor state to server */
  getEditorState?: () => { document: any } | null;
}

export function useWebSocket({ onNodeChanges, onAgentStatus, onDocumentSwitched, onDocumentsChanged, onWorkspacesChanged, onTitleChanged, onPendingDocsChanged, onMetadataChanged, onSyncStatus, onWritingStarted, onWritingFinished, getEditorState }: UseWebSocketOptions) {
  const wsRef = useRef<WebSocket | null>(null);
  const [connected, setConnected] = useState(false);
  // Document version counter — tracks last version seen from agent writes
  const docVersionRef = useRef<number>(0);

  // Store callbacks in refs to avoid reconnection on every render
  const onNodeChangesRef = useRef(onNodeChanges);
  const onAgentStatusRef = useRef(onAgentStatus);
  const onDocumentSwitchedRef = useRef(onDocumentSwitched);
  const onDocumentsChangedRef = useRef(onDocumentsChanged);
  const onWorkspacesChangedRef = useRef(onWorkspacesChanged);
  const onTitleChangedRef = useRef(onTitleChanged);
  const onPendingDocsChangedRef = useRef(onPendingDocsChanged);
  const onSyncStatusRef = useRef(onSyncStatus);
  const onMetadataChangedRef = useRef(onMetadataChanged);
  const onWritingStartedRef = useRef(onWritingStarted);
  const onWritingFinishedRef = useRef(onWritingFinished);
  const getEditorStateRef = useRef(getEditorState);
  onNodeChangesRef.current = onNodeChanges;
  onAgentStatusRef.current = onAgentStatus;
  onDocumentSwitchedRef.current = onDocumentSwitched;
  onDocumentsChangedRef.current = onDocumentsChanged;
  onWorkspacesChangedRef.current = onWorkspacesChanged;
  onTitleChangedRef.current = onTitleChanged;
  onPendingDocsChangedRef.current = onPendingDocsChanged;
  onMetadataChangedRef.current = onMetadataChanged;
  onSyncStatusRef.current = onSyncStatus;
  onWritingStartedRef.current = onWritingStarted;
  onWritingFinishedRef.current = onWritingFinished;
  getEditorStateRef.current = getEditorState;

  useEffect(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws`;
    let reconnectTimer: ReturnType<typeof setTimeout>;
    let hasConnectedBefore = false;
    let backoff = 1000; // Start at 1s, cap at 8s

    function connect() {
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        setConnected(true);
        backoff = 1000; // Reset backoff on successful connect

        // On reconnect (not first connect), pull fresh state from server
        // (server is authoritative — never push stale browser state)
        if (hasConnectedBefore) {
          ws.send(JSON.stringify({ type: 'request-document' }));
        }
        hasConnectedBefore = true;
      };

      ws.onmessage = (event) => {
        try {
          const msg: WebSocketMessage = JSON.parse(event.data);

          if (msg.type === 'node-changes' && msg.changes) {
            if (typeof msg.version === 'number') {
              docVersionRef.current = msg.version;
            }
            onNodeChangesRef.current?.(msg.changes);
          }

          if (msg.type === 'agent-status') {
            onAgentStatusRef.current?.(!!msg.agentConnected);
          }

          if (msg.type === 'document-switched') {
            docVersionRef.current = 0; // New document = fresh version lineage
            onDocumentSwitchedRef.current?.({
              document: msg.document,
              title: msg.title,
              filename: msg.filename,
              docId: msg.docId,
              metadata: msg.metadata,
            });
          }

          if (msg.type === 'metadata-changed' && msg.metadata) {
            onMetadataChangedRef.current?.(msg.metadata);
          }

          if (msg.type === 'documents-changed') {
            onDocumentsChangedRef.current?.();
          }

          if (msg.type === 'workspaces-changed') {
            onWorkspacesChangedRef.current?.();
          }

          if (msg.type === 'title-changed' && msg.title) {
            onTitleChangedRef.current?.(msg.title);
          }

          if (msg.type === 'pending-docs-changed' && msg.pendingDocs) {
            onPendingDocsChangedRef.current?.(msg.pendingDocs);
          }

          if (msg.type === 'sync-status') {
            onSyncStatusRef.current?.({ state: msg.state, lastSyncTime: msg.lastSyncTime, pendingFiles: msg.pendingFiles, error: msg.error });
          }

          if (msg.type === 'writing-started' && msg.title) {
            onWritingStartedRef.current?.(msg.title, msg.target || null);
          }

          if (msg.type === 'writing-finished') {
            onWritingFinishedRef.current?.();
          }

          if (msg.type === 'plugins-changed') {
            window.dispatchEvent(new CustomEvent('ow-plugins-changed'));
          }

          if (msg.type === 'marks-changed' && msg.filename) {
            window.dispatchEvent(new CustomEvent('ow-marks-changed', { detail: { filename: msg.filename } }));
          }
        } catch {
          // Ignore malformed messages
        }
      };

      ws.onclose = () => {
        setConnected(false);
        reconnectTimer = setTimeout(connect, backoff);
        backoff = Math.min(backoff * 1.5, 8000); // Exponential backoff, cap at 8s
      };

      ws.onerror = () => {
        ws.close();
      };
    }

    connect();

    // Immediately reconnect when tab becomes visible (user switched back)
    function handleVisibility() {
      if (document.visibilityState === 'visible' && wsRef.current?.readyState !== WebSocket.OPEN) {
        clearTimeout(reconnectTimer);
        backoff = 1000;
        connect();
      }
    }
    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      clearTimeout(reconnectTimer);
      document.removeEventListener('visibilitychange', handleVisibility);
      // Detach onclose before closing to prevent the handler from setting
      // a new reconnect timer that the cleanup can't clear (StrictMode fix).
      if (wsRef.current) {
        wsRef.current.onclose = null;
        wsRef.current.close();
      }
    };
  }, []); // Stable — no deps, callbacks via refs

  const sendMessage = useCallback((msg: Record<string, any>) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg));
    }
  }, []);

  return { connected, sendMessage, docVersionRef };
}
