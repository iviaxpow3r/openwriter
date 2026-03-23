import { useCallback, useEffect, useRef, useState } from 'react';
import type { Editor } from '@tiptap/react';

import PadEditor from './editor/PadEditor';
import FormatToolbar from './editor/FormatToolbar';
import Titlebar from './titlebar/Titlebar';
import ContextMenu from './context-menu/ContextMenu';
import ReviewPanel from './review/ReviewPanel';
import Sidebar from './sidebar/Sidebar';
import SyncSetupModal from './sync/SyncSetupModal';
import { useWebSocket, type PendingDocsPayload, type SyncStatus } from './ws/client';
import { applyNodeChangesToEditor } from './decorations/bridge';
import { setMarksData, forceMarkRefresh } from './decorations/marks-plugin';
import { getSidebarMode } from './themes/appearance-store';

import TweetComposeView from './tweet-compose/TweetComposeView';
import ArticleComposeView from './article-compose/ArticleComposeView';
import BlogComposeView from './blog-compose/BlogComposeView';
import { TextNewsletterView } from './newsletter-compose/NewsletterComposeView';
import { articleExtensions } from './editor/extensions';
import './decorations/styles.css';

/** articleContext: {} is truthy but meaningless — require at least one real key */
function hasArticleContext(meta: Record<string, any> | undefined): boolean {
  const ctx = meta?.articleContext;
  return ctx != null && typeof ctx === 'object' && Object.keys(ctx).length > 0;
}

function hasBlogContext(meta: Record<string, any> | undefined): boolean {
  const ctx = meta?.blogContext;
  return ctx != null && typeof ctx === 'object' && Object.keys(ctx).length > 0;
}

function hasNewsletterContext(meta: Record<string, any> | undefined): boolean {
  const ctx = meta?.newsletterContext;
  return ctx != null && typeof ctx === 'object' && (ctx.active === true || Object.keys(ctx).length > 0);
}

export default function App() {
  const editorRef = useRef<Editor | null>(null);
  const allEditorsRef = useRef<Editor[]>([]);
  const [editorInstance, setEditorInstance] = useState<Editor | null>(null);
  const [allEditors, setAllEditors] = useState<Editor[]>([]);
  const [title, setTitle] = useState('Untitled');
  const [initialContent, setInitialContent] = useState<any>(undefined);
  const [activeDocKey, setActiveDocKey] = useState(0);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sidebarRefreshKey, setSidebarRefreshKey] = useState(0);
  const [workspacesRefreshKey, setWorkspacesRefreshKey] = useState(0);
  const [pendingDocs, setPendingDocs] = useState<PendingDocsPayload>({ filenames: [], counts: {} });
  const [syncStatus, setSyncStatus] = useState<SyncStatus>({ state: 'unconfigured' });
  const [showSyncSetup, setShowSyncSetup] = useState(false);
  const [metadata, setMetadata] = useState<Record<string, any>>({});
  const [showToolbar, setShowToolbar] = useState(() => localStorage.getItem('ow-toolbar') !== 'hidden');
  const [writingTitle, setWritingTitle] = useState<string | null>(null);
  const [writingTarget, setWritingTarget] = useState<{ wsFilename: string; containerId: string | null } | null>(null);
  const writingStartedAt = useRef<number>(0);
  const writingClearTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const MIN_WRITING_DISPLAY_MS = 1500;

  const showWritingTitle = useCallback((title: string, target: { wsFilename: string; containerId: string | null } | null) => {
    if (writingClearTimer.current) { clearTimeout(writingClearTimer.current); writingClearTimer.current = null; }
    writingStartedAt.current = Date.now();
    setWritingTitle(title);
    setWritingTarget(target);
  }, []);

  const clearWritingTitle = useCallback(() => {
    if (writingClearTimer.current) return; // already scheduled
    const elapsed = Date.now() - writingStartedAt.current;
    const remaining = MIN_WRITING_DISPLAY_MS - elapsed;
    if (remaining <= 0) {
      setWritingTitle(null);
      setWritingTarget(null);
    } else {
      writingClearTimer.current = setTimeout(() => {
        writingClearTimer.current = null;
        setWritingTitle(null);
        setWritingTarget(null);
      }, remaining);
    }
  }, []);

  const [, setSidebarModeKey] = useState(0);
  const docUpdateTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastDocJson = useRef<any>(null); // Latest merged doc JSON (covers tweet compose where editorRef is only first tweet)

  // Navigation history
  interface NavEntry { filename: string; scrollTop: number; }
  const navStack = useRef<NavEntry[]>([]);
  const navIndex = useRef(-1);
  const isNavAction = useRef(false);
  const currentFilename = useRef<string>('');
  const [activeFilename, setActiveFilename] = useState('');
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);

  // Fetch saved document from server on mount
  // Set/remove data-view attribute on <html> for CSS targeting
  const isArticle = hasArticleContext(metadata);
  const isBlog = hasBlogContext(metadata);
  const isNewsletter = hasNewsletterContext(metadata);
  useEffect(() => {
    if (isArticle) {
      document.documentElement.setAttribute('data-view', 'article');
    } else if (isBlog) {
      document.documentElement.setAttribute('data-view', 'blog');
    } else if (isNewsletter) {
      document.documentElement.setAttribute('data-view', 'newsletter');
    } else if (metadata?.tweetContext) {
      document.documentElement.setAttribute('data-view', 'tweet');
    } else {
      document.documentElement.removeAttribute('data-view');
    }
    return () => document.documentElement.removeAttribute('data-view');
  }, [metadata?.tweetContext, isArticle, isBlog, isNewsletter]);

  // Re-render when sidebar mode changes (board mode needs different layout)
  useEffect(() => {
    const handler = () => setSidebarModeKey(k => k + 1);
    window.addEventListener('ow-sidebar-mode-change', handler);
    return () => window.removeEventListener('ow-sidebar-mode-change', handler);
  }, []);

  useEffect(() => {
    fetch('/api/document', { cache: 'no-store' })
      .then((res) => res.json())
      .then((data) => {
        if (data.document) {
          setInitialContent(data.document);
          lastDocJson.current = data.document;
        }
        if (data.title) setTitle(data.title);
        if (data.metadata) setMetadata(data.metadata);
      })
      .catch(() => {
        setInitialContent(undefined);
      });

    // Fetch pending docs state
    fetch('/api/pending-docs')
      .then((res) => res.json())
      .then((data) => setPendingDocs(data))
      .catch(() => {});

    // Fetch initial sync status
    fetch('/api/sync/status')
      .then((res) => res.json())
      .then((data) => setSyncStatus(data))
      .catch(() => {});
  }, []);

  const handleEditorReady = useCallback((editor: Editor) => {
    editorRef.current = editor;
    setEditorInstance(editor);
    allEditorsRef.current = [editor];
    setAllEditors([editor]);
  }, []);

  // Buffer for node-changes that arrive while tweet editors are being recreated (resync).
  // During document-switched → re-split, old editors are destroyed and new ones mount.
  // node-changes arriving in this window would apply to destroyed editors and be lost.
  const nodeChangesBuffer = useRef<import('./ws/client').NodeChange[]>([]);

  const handleEditorsChange = useCallback((editors: Editor[]) => {
    allEditorsRef.current = editors;
    setAllEditors(editors);
    // Replay any buffered node-changes that arrived during resync
    if (nodeChangesBuffer.current.length > 0 && editors.length > 0) {
      const buffered = nodeChangesBuffer.current;
      nodeChangesBuffer.current = [];
      for (const editor of editors) {
        if (!(editor as any).isDestroyed) {
          applyNodeChangesToEditor(editor, buffered);
        }
      }
    }
  }, []);

  const handleDocumentSwitched = useCallback((payload: { document: any; title: string; filename: string; docId?: string; metadata?: Record<string, any> }) => {
    // Cancel any pending debounced doc-update — the server just sent authoritative state,
    // so a stale closure from a prior edit must not overwrite it.
    if (docUpdateTimer.current) {
      clearTimeout(docUpdateTimer.current);
      docUpdateTimer.current = null;
    }
    const wasEmpty = currentFilename.current === '';
    const isSameDoc = payload.filename === currentFilename.current;
    currentFilename.current = payload.filename;
    lastDocJson.current = payload.document;
    setActiveFilename(payload.filename);
    setInitialContent(payload.document);
    setTitle(payload.title);
    setMetadata(payload.metadata || {});
    // Don't clear writingTitle here — only writing-finished clears the spinner.
    // This lets the two-step create flow (create_document → populate_document) keep the spinner alive.
    // Skip remount when it's the same document (e.g. WS initial connect echoing the HTTP-fetched doc)
    // Also skip on initial connect (wasEmpty) — the HTTP fetch already set the content, no remount needed.
    if (!isSameDoc && !wasEmpty) setActiveDocKey((k) => k + 1);
    setSidebarRefreshKey((k) => k + 1);

    // Restore scroll position if this was a back/forward navigation
    if (isNavAction.current) {
      const entry = navStack.current[navIndex.current];
      if (entry) {
        setTimeout(() => {
          const editorContainer = document.querySelector('.editor-container');
          if (editorContainer) editorContainer.scrollTop = entry.scrollTop;
        }, 50);
      }
      isNavAction.current = false;
    }

    // Update nav button states
    setCanGoBack(navIndex.current > 0);
    setCanGoForward(navIndex.current < navStack.current.length - 1);
  }, []);

  const handleDocumentsChanged = useCallback(() => {
    setSidebarRefreshKey((k) => k + 1);
  }, []);

  const handleWorkspacesChanged = useCallback(() => {
    setWorkspacesRefreshKey((k) => k + 1);
  }, []);

  const handlePendingDocsChanged = useCallback((data: PendingDocsPayload) => {
    setPendingDocs(data);
  }, []);

  const { connected, sendMessage, docVersionRef } = useWebSocket({
    onNodeChanges: (changes) => {
      const editors = allEditorsRef.current;
      if (editors.length <= 1) {
        // Single editor mode (normal doc or single tweet) — apply to primary
        const editor = editorRef.current;
        if (!editor) return;
        applyNodeChangesToEditor(editor, changes);
      } else {
        // Multi-editor mode (tweet thread) — apply to each editor
        // Each editor only contains a subset of nodes, so changes that
        // don't match will be silently skipped by applyNodeChangesToEditor
        const hasDestroyed = editors.some((e: any) => e.isDestroyed);
        if (hasDestroyed) {
          // Editors are being recreated (resync in progress) — buffer for replay
          nodeChangesBuffer.current.push(...changes);
          return;
        }
        for (const editor of editors) {
          applyNodeChangesToEditor(editor, changes);
        }
      }
    },
    onDocumentSwitched: handleDocumentSwitched,
    onDocumentsChanged: handleDocumentsChanged,
    onWorkspacesChanged: handleWorkspacesChanged,
    onPendingDocsChanged: handlePendingDocsChanged,
    onMetadataChanged: (m) => setMetadata(m),
    onWritingStarted: (title, target) => showWritingTitle(title, target),
    onWritingFinished: () => clearWritingTitle(),
    onSyncStatus: (status) => setSyncStatus(status),
    onTitleChanged: (newTitle) => setTitle(newTitle),
    getEditorState: () => {
      const doc = lastDocJson.current || editorRef.current?.getJSON();
      if (!doc) return null;
      return { document: doc };
    },
  });

  // Flush current editor content to server synchronously before switching/creating docs.
  // Only sends doc-update (no explicit save) — switchDocument/createDocument call save() internally.
  // Sending save here would bump the old doc's mtime before switchDocument can preserve it.
  const flushCurrentDoc = useCallback(() => {
    if (docUpdateTimer.current) {
      clearTimeout(docUpdateTimer.current);
      docUpdateTimer.current = null;
    }
    // Use lastDocJson (covers tweet compose where editorRef is only the first tweet's editor)
    const doc = lastDocJson.current || editorRef.current?.getJSON();
    if (!doc) return;
    sendMessage({ type: 'doc-update', document: doc, filename: currentFilename.current, version: docVersionRef.current });
  }, [sendMessage, docVersionRef]);

  // Sync editor content to server via HTTP — guarantees server state is current before MCP calls.
  // Unlike flushCurrentDoc (WebSocket, fire-and-forget), this awaits confirmation.
  const syncContentToServer = useCallback(async () => {
    const doc = lastDocJson.current || editorRef.current?.getJSON();
    if (!doc) return;
    await fetch('/api/documents/sync-content', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ document: doc, filename: currentFilename.current }),
    });
  }, []);

  // Flush on browser close / tab switch to prevent data loss
  useEffect(() => {
    const flush = () => {
      if (docUpdateTimer.current) {
        clearTimeout(docUpdateTimer.current);
        docUpdateTimer.current = null;
      }
      // Use lastDocJson (covers tweet compose where editorRef is only the first tweet's editor)
      const doc = lastDocJson.current || editorRef.current?.getJSON();
      if (!doc) return;
      // Use sendBeacon with JSON Blob — application/json is not CORS-safelisted,
      // so cross-origin sendBeacon is blocked by the browser automatically
      const payload = JSON.stringify({ type: 'flush', document: doc });
      navigator.sendBeacon('/api/flush', new Blob([payload], { type: 'application/json' }));
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') flush();
    };

    window.addEventListener('beforeunload', flush);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      window.removeEventListener('beforeunload', flush);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, []);

  // Use WS (not HTTP) for switch/create so messages are ordered after the flush
  const handleCreateDocument = useCallback(() => {
    flushCurrentDoc();
    sendMessage({ type: 'create-document' });
  }, [flushCurrentDoc, sendMessage]);

  const handleSwitchDocument = useCallback((filename: string) => {
    // Save current scroll position and push to nav stack
    const editorContainer = document.querySelector('.editor-container');
    const scrollTop = editorContainer?.scrollTop || 0;

    if (!isNavAction.current && currentFilename.current) {
      // Truncate forward history
      navStack.current = navStack.current.slice(0, navIndex.current + 1);
      navStack.current.push({ filename: currentFilename.current, scrollTop });
      navIndex.current = navStack.current.length - 1;
    }

    flushCurrentDoc();
    sendMessage({ type: 'switch-document', filename });
  }, [flushCurrentDoc, sendMessage]);

  const goBack = useCallback(() => {
    if (navIndex.current <= 0) return;
    // Save current position before going back
    const editorContainer = document.querySelector('.editor-container');
    const scrollTop = editorContainer?.scrollTop || 0;

    // If we're at the end of the stack going back for the first time,
    // push the current doc so we can go forward to it
    if (navIndex.current === navStack.current.length - 1 && currentFilename.current) {
      navStack.current = navStack.current.slice(0, navIndex.current + 1);
      navStack.current.push({ filename: currentFilename.current, scrollTop });
    } else if (currentFilename.current) {
      // Update current entry's scroll position
      navStack.current[navIndex.current + 1] = { filename: currentFilename.current, scrollTop };
    }

    const entry = navStack.current[navIndex.current];
    navIndex.current--;
    isNavAction.current = true;
    setCanGoBack(navIndex.current > 0);
    setCanGoForward(true);
    flushCurrentDoc();
    sendMessage({ type: 'switch-document', filename: entry.filename });
  }, [flushCurrentDoc, sendMessage]);

  const goForward = useCallback(() => {
    if (navIndex.current >= navStack.current.length - 2) return;
    // Save current scroll
    const editorContainer = document.querySelector('.editor-container');
    const scrollTop = editorContainer?.scrollTop || 0;
    if (currentFilename.current) {
      navStack.current[navIndex.current + 1] = { filename: currentFilename.current, scrollTop };
    }

    navIndex.current++;
    const entry = navStack.current[navIndex.current + 1];
    isNavAction.current = true;
    setCanGoBack(true);
    setCanGoForward(navIndex.current < navStack.current.length - 2);
    flushCurrentDoc();
    sendMessage({ type: 'switch-document', filename: entry.filename });
  }, [flushCurrentDoc, sendMessage]);

  // Fetch agent marks for current document + refresh decorations
  const fetchMarks = useCallback(() => {
    const filename = currentFilename.current;
    const editor = editorRef.current;
    if (!filename || !editor) return;
    fetch(`/api/marks/${encodeURIComponent(filename)}`)
      .then((res) => res.json())
      .then((data) => {
        setMarksData(data.marks || []);
        forceMarkRefresh(editor.view);
      })
      .catch(() => {
        setMarksData([]);
        if (editor?.view) forceMarkRefresh(editor.view);
      });
  }, []);

  // Re-fetch marks when document switches
  useEffect(() => {
    fetchMarks();
  }, [activeFilename, fetchMarks]);

  // Listen for marks-changed WS events (agent resolved marks, or new mark created)
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.filename === currentFilename.current) {
        fetchMarks();
      }
    };
    window.addEventListener('ow-marks-changed', handler);
    return () => window.removeEventListener('ow-marks-changed', handler);
  }, [fetchMarks]);

  // Keyboard shortcuts for navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.altKey && e.key === 'ArrowLeft') { e.preventDefault(); goBack(); }
      if (e.altKey && e.key === 'ArrowRight') { e.preventDefault(); goForward(); }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [goBack, goForward]);

  // Debounce doc updates — send at most every 1s instead of every keystroke
  const handleDocUpdate = useCallback((json: any) => {
    lastDocJson.current = json;
    if (docUpdateTimer.current) clearTimeout(docUpdateTimer.current);
    docUpdateTimer.current = setTimeout(() => {
      sendMessage({ type: 'doc-update', document: json, filename: currentFilename.current, version: docVersionRef.current });
    }, 1000);
  }, [sendMessage, docVersionRef]);

  // Send title changes to server explicitly (not bundled with doc-update)
  const handleTitleChange = useCallback((newTitle: string) => {
    setTitle(newTitle);
    sendMessage({ type: 'title-update', title: newTitle });
  }, [sendMessage]);

  const toggleToolbar = useCallback(() => {
    setShowToolbar(v => {
      localStorage.setItem('ow-toolbar', v ? 'hidden' : 'visible');
      return !v;
    });
  }, []);

  const handleSync = useCallback(() => {
    if (syncStatus.state === 'unconfigured') {
      setShowSyncSetup(true);
      return;
    }
    // Flush current doc + save to disk, then push
    flushCurrentDoc();
    sendMessage({ type: 'save' });
    fetch('/api/sync/push', { method: 'POST' }).catch(() => {});
  }, [syncStatus.state, flushCurrentDoc, sendMessage]);

  const isBoardMode = getSidebarMode() === 'board';

  return (
    <div className="app">
      {!isBoardMode && (
        <Sidebar
          open={sidebarOpen}
          onSwitchDocument={handleSwitchDocument}
          onCreateDocument={handleCreateDocument}
          refreshKey={sidebarRefreshKey}
          workspacesRefreshKey={workspacesRefreshKey}
          pendingDocs={pendingDocs}
          writingTitle={writingTitle}
          writingTarget={writingTarget}
          onClose={() => setSidebarOpen(false)}
        />
      )}
      <div className="app-main">
        <Titlebar
          title={title}
          onTitleChange={handleTitleChange}
          syncStatus={syncStatus}
          onSync={handleSync}
          onToggleSidebar={!isBoardMode && !sidebarOpen ? () => setSidebarOpen(true) : undefined}
          canGoBack={canGoBack}
          canGoForward={canGoForward}
          onGoBack={goBack}
          onGoForward={goForward}
          editor={editorInstance}
          onToggleToolbar={toggleToolbar}
          toolbarOpen={showToolbar}
        />
        {showToolbar && editorInstance && <FormatToolbar editor={editorInstance} />}
        {isBoardMode && (
          <Sidebar
            open={true}
            onSwitchDocument={handleSwitchDocument}
            onCreateDocument={handleCreateDocument}
            refreshKey={sidebarRefreshKey}
            workspacesRefreshKey={workspacesRefreshKey}
            pendingDocs={pendingDocs}
            writingTitle={writingTitle}
          writingTarget={writingTarget}
          />
        )}
        {!connected && (
          <div className="connection-banner">
            <div className="connection-banner-spinner" />
            <span>Reconnecting to server...</span>
          </div>
        )}
        <div className="editor-container">
          {isArticle ? (
            <ArticleComposeView
              title={title}
              onTitleChange={handleTitleChange}
              coverImage={metadata?.articleContext?.coverImage}
              coverImages={metadata?.articleContext?.coverImages}
              lastPost={metadata?.articleContext?.lastPost}
            >
              <PadEditor
                key={activeDocKey}
                initialContent={initialContent}
                extensions={articleExtensions}
                onUpdate={handleDocUpdate}
                onReady={handleEditorReady}
                onLinkClick={handleSwitchDocument}
              />
            </ArticleComposeView>
          ) : isBlog ? (
            <BlogComposeView
              title={title}
              onTitleChange={handleTitleChange}
              blogContext={metadata?.blogContext}
              filename={activeFilename}
            >
              <PadEditor
                key={activeDocKey}
                initialContent={initialContent}
                onUpdate={handleDocUpdate}
                onReady={handleEditorReady}
                onLinkClick={handleSwitchDocument}
              />
            </BlogComposeView>
          ) : isNewsletter ? (
            <TextNewsletterView
              newsletterContext={metadata?.newsletterContext}
              filename={activeFilename}
              title={title}
              onTitleChange={handleTitleChange}
              onBeforeSend={syncContentToServer}
            >
              <PadEditor
                key={activeDocKey}
                initialContent={initialContent}
                onUpdate={handleDocUpdate}
                onReady={handleEditorReady}
                onLinkClick={handleSwitchDocument}
              />
            </TextNewsletterView>
          ) : metadata?.tweetContext ? (
            <TweetComposeView
              key={activeDocKey}
              tweetContext={metadata.tweetContext}
              initialContent={initialContent}
              onUpdate={handleDocUpdate}
              onEditorReady={handleEditorReady}
              onEditorsChange={handleEditorsChange}
              filename={activeFilename}
              title={title}
            />
          ) : (
            <PadEditor
              key={activeDocKey}
              initialContent={initialContent}
              onUpdate={handleDocUpdate}
              onReady={handleEditorReady}
              onLinkClick={handleSwitchDocument}
            />
          )}
        </div>
        <ReviewPanel
          editors={allEditors}
          pendingDocs={pendingDocs}
          currentFilename={activeFilename}
          onSwitchDocument={handleSwitchDocument}
          sendMessage={sendMessage}
          getDocument={() => lastDocJson.current}
          docVersionRef={docVersionRef}
        />
      </div>
      <ContextMenu editorRef={editorRef} allEditors={allEditors} documentId={activeFilename} />
      {showSyncSetup && (
        <SyncSetupModal
          onClose={() => setShowSyncSetup(false)}
          onSetupComplete={() => {
            fetch('/api/sync/status').then((r) => r.json()).then(setSyncStatus).catch(() => {});
          }}
        />
      )}
    </div>
  );
}
