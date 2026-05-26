import { useCallback, useEffect, useRef, useState } from 'react';
import type { Editor } from '@tiptap/react';

import PadEditor from './editor/PadEditor';
import FormatToolbar from './editor/FormatToolbar';
import Titlebar from './titlebar/Titlebar';
import ContextMenu from './context-menu/ContextMenu';
import CommentPopover from './comment-popover/CommentPopover';
import Sidebar from './sidebar/Sidebar';
import { RightRailProvider } from './right-rail/RightRailContext';
import RightRail from './right-rail/RightRail';
import SyncSetupModal from './sync/SyncSetupModal';
import { useWebSocket, type PendingDocsPayload, type SyncStatus } from './ws/client';
import { applyNodeChangesToEditor, applyIdRewritesToEditor } from './decorations/bridge';
import { setCommentsData, forceCommentRefresh } from './decorations/comments-plugin';
import { setBacklinksData, forceBacklinkRefresh } from './decorations/backlinks-plugin';
import { getSidebarMode } from './themes/appearance-store';

import TweetComposeView from './tweet-compose/TweetComposeView';
import ArticleComposeView from './article-compose/ArticleComposeView';
import BlogComposeView from './blog-compose/BlogComposeView';
import { TextNewsletterView } from './newsletter-compose/NewsletterComposeView';
import { articleExtensions } from './editor/extensions';
import type { ParsedLinkHref } from './editor/link-href';
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
  const [activeEditor, setActiveEditor] = useState<Editor | null>(null);
  const [allEditors, setAllEditors] = useState<Editor[]>([]);
  const [title, setTitle] = useState('Untitled');
  const [initialContent, setInitialContent] = useState<any>(undefined);
  const [activeDocKey, setActiveDocKey] = useState(0);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sidebarRefreshKey, setSidebarRefreshKey] = useState(0);
  // Separate from sidebarRefreshKey: doc tags only change when the doc set
  // changes (create/delete) or when a tag is mutated. They do NOT change on
  // doc switch. Coupling the two keys made every switch fan out one HTTP
  // fetch per doc (N+1 across the library) — the dominant nav-lag cause once
  // a workspace grows past ~50 docs.
  const [docTagsRefreshKey, setDocTagsRefreshKey] = useState(0);
  const [workspacesRefreshKey, setWorkspacesRefreshKey] = useState(0);
  const [pendingDocs, setPendingDocs] = useState<PendingDocsPayload>({ filenames: [], counts: {} });
  const [syncStatus, setSyncStatus] = useState<SyncStatus>({ state: 'unconfigured' });
  const [showSyncSetup, setShowSyncSetup] = useState(false);
  const [metadata, setMetadata] = useState<Record<string, any>>({});
  const [showToolbar, setShowToolbar] = useState(() => localStorage.getItem('ow-toolbar') !== 'hidden');
  // Focus mode: collapses left sidebar + right rail + format bar to a clean
  // editor canvas. The toggle button lives in the rail topbar (when rail
  // open) and in the titlebar (when rail closed) so it's always reachable.
  // Prior state is snapshotted on entry and restored on exit.
  const [focusMode, setFocusMode] = useState(false);
  const focusSnapshotRef = useRef<{ sidebarOpen: boolean; showToolbar: boolean } | null>(null);
  const [writingTitle, setWritingTitle] = useState<string | null>(null);
  const [writingTarget, setWritingTarget] = useState<{ wsFilename: string; containerId: string | null; parentDocId?: string } | null>(null);
  // All filenames the server currently has a pending-write spinner registered for.
  // Sidebar uses this to hide the real doc entries that sit behind those spinners.
  const [pendingWriteFilenames, setPendingWriteFilenames] = useState<Set<string>>(new Set());
  const writingStartedAt = useRef<number>(0);
  const writingClearTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const MIN_WRITING_DISPLAY_MS = 1500;

  const showWritingTitle = useCallback((title: string, target: { wsFilename: string; containerId: string | null; parentDocId?: string } | null) => {
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
  // Banner shown when the server's fs.watch reloaded the active doc from
  // disk (external write). Persists until user dismisses — auto-dismiss
  // would be the system guessing whether the user has perceived the
  // notification, and the system has no way to know. Manual dismiss is
  // the only correct model.
  //
  // Coalesces: if a second external write arrives while a banner is
  // already showing, reloadCount increments and orphan/stale counts
  // accumulate. Otherwise rapid back-to-back reloads would silently
  // swap the displayed metadata under the user.
  //
  // TODO(deferred): banner state is lost on hard refresh / tab close. If
  // a user closes the tab between reload and acknowledgment, the signal
  // is gone. Moving acknowledgment state to a server-side per-docId
  // record (or localStorage) is the next layer of robustness.
  // adr: adr/active-doc-watcher.md
  const [reloadNotice, setReloadNotice] = useState<{
    filename: string;
    orphanCount: number;
    staleBaselineCount: number;
    reloadCount: number;
  } | null>(null);
  const docUpdateTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastDocJson = useRef<any>(null); // Latest merged doc JSON (covers tweet compose where editorRef is only first tweet)
  // Diff-gate: stringified JSON of what we last successfully synced with the server.
  // The autosave timer compares the current editor state to this and SKIPS the send
  // when they're equal. Without this, any TipTap onUpdate (server broadcasts, reconnect
  // rehydration, decoration refreshes, React re-renders that pass new initialContent)
  // round-trips back to the server as if it were a real edit — which can resurrect
  // stale overlay entries the server already cleared, and burns a save cycle on
  // every metadata change.
  // adr: adr/pending-overlay-model.md
  const lastSentDocJson = useRef<string | null>(null);

  // Navigation history (browser-like: stack includes current; index points at current).
  // navIntent records why the next document-switched message is arriving so we can
  // mutate the stack correctly: 'push' truncates forward and appends; 'back'/'forward'
  // just move the index; null is treated as 'push' (covers agent-driven switches).
  interface NavEntry { filename: string; scrollTop: number; }
  const navStack = useRef<NavEntry[]>([]);
  const navIndex = useRef(-1);
  const navIntent = useRef<'push' | 'back' | 'forward' | null>(null);
  const skipBrowserPush = useRef(false); // true when a switch came from popstate; don't re-push
  const currentFilename = useRef<string>('');
  const [activeFilename, setActiveFilename] = useState('');
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);

  function getEditorScrollTop(): number {
    const c = document.querySelector('.editor-container');
    return c?.scrollTop || 0;
  }

  function saveCurrentScroll(): void {
    if (navIndex.current < 0) return;
    const entry = navStack.current[navIndex.current];
    if (entry) entry.scrollTop = getEditorScrollTop();
  }

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
    setActiveEditor(null);
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
    const tReceive = performance.now();
    const ls = (window as any).__lastSwitch;
    if (ls && ls.filename === payload.filename) {
      ls.tReceive = tReceive;
      console.log(`[Switch] RECEIVE filename=${payload.filename} sendToReceive=${(tReceive - ls.tSend).toFixed(1)}ms (server round-trip)`);
    } else {
      console.log(`[Switch] RECEIVE filename=${payload.filename} (no matching CLICK — agent or initial-load switch)`);
    }
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
    // Authoritative state from the server — diff-gate baseline resets to this.
    lastSentDocJson.current = JSON.stringify(payload.document);
    setActiveFilename(payload.filename);
    setInitialContent(payload.document);
    setTitle(payload.title);
    setMetadata(payload.metadata || {});
    // Don't clear writingTitle here — only writing-finished clears the spinner.
    // This lets the two-step create flow (create_document → populate_document) keep the spinner alive.
    // Skip remount when it's the same document (e.g. WS initial connect echoing the HTTP-fetched doc)
    // Also skip on initial connect (wasEmpty) — the HTTP fetch already set the content, no remount needed.
    // Editor stays mounted across doc-switches; content swaps via PadEditor's
    // content-prop watcher (editor.commands.setContent). activeDocKey is now
    // only used to remount TweetComposeView, where multi-editor lifecycle
    // makes a stable-instance model more complex than it's worth.
    if (!isSameDoc && !wasEmpty && payload.metadata?.tweetContext) {
      setActiveDocKey((k) => k + 1);
    }
    setSidebarRefreshKey((k) => k + 1);
    // Schedule a post-commit timestamp on the next paint frame so we can
    // see how long React's commit phase takes (state set → DOM updated).
    if (ls && ls.filename === payload.filename) {
      requestAnimationFrame(() => {
        const tCommit = performance.now();
        ls.tCommit = tCommit;
        console.log(`[Switch] COMMIT filename=${payload.filename} receiveToCommit=${(tCommit - tReceive).toFixed(1)}ms totalClickToPaint=${(tCommit - ls.tClick).toFixed(1)}ms`);
      });
    }

    // Update nav stack based on intent. Default (null) = push, which also covers
    // agent-driven switch_document calls and the initial doc load.
    const intent = navIntent.current ?? 'push';
    navIntent.current = null;
    if (navStack.current.length === 0) {
      navStack.current = [{ filename: payload.filename, scrollTop: 0 }];
      navIndex.current = 0;
    } else if (intent === 'back') {
      navIndex.current = Math.max(0, navIndex.current - 1);
    } else if (intent === 'forward') {
      navIndex.current = Math.min(navStack.current.length - 1, navIndex.current + 1);
    } else if (!isSameDoc) {
      navStack.current = navStack.current.slice(0, navIndex.current + 1);
      navStack.current.push({ filename: payload.filename, scrollTop: 0 });
      navIndex.current = navStack.current.length - 1;
    }

    // Mirror to browser history so the browser back button stays in OpenWriter.
    // skipBrowserPush is set when this switch was itself triggered by popstate.
    if (!skipBrowserPush.current) {
      const url = `#${encodeURIComponent(payload.filename)}`;
      const state = { ow: { filename: payload.filename, navIndex: navIndex.current } };
      if (navStack.current.length === 1 || isSameDoc) {
        window.history.replaceState(state, '', url);
      } else {
        window.history.pushState(state, '', url);
      }
    }
    skipBrowserPush.current = false;

    // Restore scroll position for back/forward
    if (intent === 'back' || intent === 'forward') {
      const entry = navStack.current[navIndex.current];
      if (entry) {
        setTimeout(() => {
          const editorContainer = document.querySelector('.editor-container');
          if (editorContainer) editorContainer.scrollTop = entry.scrollTop;
        }, 50);
      }
    }

    setCanGoBack(navIndex.current > 0);
    setCanGoForward(navIndex.current < navStack.current.length - 1);
  }, []);

  /**
   * External writer (Edit, VSCode, a script) modified the active doc on
   * disk. Server reloaded canonical + re-applied the pending overlay by
   * nodeId; we adopt the new state and surface a transient banner.
   *
   * Important: this is NOT a navigation event. We DON'T touch the nav
   * stack, browser history, or doc key (remount key). The doc identity
   * is unchanged — only its content shifted. Forcing a remount would
   * destroy editor focus mid-edit, which is the bug we're trying to fix.
   *
   * The doc's internal content updates via setInitialContent + editor
   * setContent (handled by PadEditor's content-prop watcher). docVersion
   * was already reset to 0 in ws/client.ts so the next browser autosave
   * carries a fresh baseline.
   *
   * adr: adr/active-doc-watcher.md
   */
  const handleDocumentReloaded = useCallback((payload: {
    document: any;
    title: string;
    filename: string;
    docId?: string;
    metadata?: Record<string, any>;
    orphanCount: number;
    staleBaselineCount: number;
  }) => {
    // Cancel any in-flight debounced doc-update — its baseline is now stale.
    if (docUpdateTimer.current) {
      clearTimeout(docUpdateTimer.current);
      docUpdateTimer.current = null;
    }
    lastDocJson.current = payload.document;
    // Authoritative state from disk — diff-gate baseline resets to this.
    lastSentDocJson.current = JSON.stringify(payload.document);
    setInitialContent(payload.document);
    setTitle(payload.title);
    setMetadata(payload.metadata || {});

    // Surface a persistent banner so the user knows their content
    // changed without their action. If a prior reload's banner is still
    // up (user hasn't dismissed yet), accumulate counts rather than
    // overwrite — the user gets a single banner that tracks how many
    // external writes landed since they last looked.
    setReloadNotice((prev) => prev ? {
      filename: payload.filename,
      orphanCount: prev.orphanCount + payload.orphanCount,
      staleBaselineCount: prev.staleBaselineCount + payload.staleBaselineCount,
      reloadCount: prev.reloadCount + 1,
    } : {
      filename: payload.filename,
      orphanCount: payload.orphanCount,
      staleBaselineCount: payload.staleBaselineCount,
      reloadCount: 1,
    });
  }, []);

  const handleDocumentsChanged = useCallback(() => {
    setSidebarRefreshKey((k) => k + 1);
    // Doc set changed — refresh the per-doc tag cache. (Switching docs alone
    // does not need to refresh tags.)
    setDocTagsRefreshKey((k) => k + 1);
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
    onDocumentReloaded: handleDocumentReloaded,
    onDocumentsChanged: handleDocumentsChanged,
    onWorkspacesChanged: handleWorkspacesChanged,
    onPendingDocsChanged: handlePendingDocsChanged,
    onMetadataChanged: (m) => setMetadata(m),
    onWritingStarted: (title, target) => showWritingTitle(title, target),
    onWritingFinished: () => clearWritingTitle(),
    onIdRewrites: (rewrites) => {
      // Server's save-time matcher reassigned block IDs. Apply to every editor
      // so subsequent server→browser updates can resolve their anchors. In
      // multi-editor (tweet-thread) mode each editor holds a subset of nodes;
      // applyIdRewritesToEditor only touches matching nodes so applying to all
      // is safe.
      //
      // CRITICAL: also rewrite `lastDocJson.current` in lockstep. The debounced
      // doc-update timer reads the doc from `lastDocJson` at fire time — if we
      // only mutate the editor and leave lastDocJson alone, the timer sends
      // stale-ID json back to the server, the matcher rewrites those same IDs
      // AGAIN, and the system loops indefinitely (the 222-rewrites-per-save
      // pathology observed on the Beat Sheet doc).
      // adr: adr/node-identity-matcher.md
      const editors = allEditorsRef.current;
      const targets = editors.length > 0 ? editors : (editorRef.current ? [editorRef.current] : []);
      for (const editor of targets) {
        if (!(editor as any).isDestroyed) applyIdRewritesToEditor(editor, rewrites);
      }
      // Mirror the rewrites onto the cached JSON doc so the next debounced
      // send sees the post-rewrite IDs even if the editor's onUpdate doesn't
      // refresh lastDocJson in time.
      const cached = lastDocJson.current;
      if (cached && Array.isArray(rewrites) && rewrites.length > 0) {
        const map = new Map(rewrites.map((r) => [r.oldId, r.newId]));
        const walk = (nodes: any[]) => {
          if (!Array.isArray(nodes)) return;
          for (const n of nodes) {
            const oldId = n?.attrs?.id;
            if (oldId && map.has(oldId)) {
              n.attrs = { ...n.attrs, id: map.get(oldId) };
            }
            if (n?.content) walk(n.content);
          }
        };
        walk(cached.content || []);
      }
    },
    onPendingFilenamesChanged: (filenames) => setPendingWriteFilenames(filenames),
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
    // Diff-gate applies to flush too — no point shipping a duplicate state right
    // before switch_document does its own save.
    const docStr = JSON.stringify(doc);
    if (docStr === lastSentDocJson.current) return;
    sendMessage({ type: 'doc-update', document: doc, filename: currentFilename.current, version: docVersionRef.current });
    lastSentDocJson.current = docStr;
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
    if (filename === currentFilename.current) return;
    const tClick = performance.now();
    // adr-perf: per-switch timings exposed on window.__lastSwitch so the
    // RECEIVE/COMMIT/EDITOR-MOUNT phases below can compute deltas. Console
    // logs surface to DevTools and (via Claude in Chrome MCP) to the test
    // harness. Cleanup once the doc-switch latency model is stable.
    (window as any).__lastSwitch = { filename, tClick, tSend: 0, tReceive: 0, tCommit: 0 };
    console.log(`[Switch] CLICK filename=${filename} t=${tClick.toFixed(0)}`);
    saveCurrentScroll();
    navIntent.current = 'push';
    flushCurrentDoc();
    sendMessage({ type: 'switch-document', filename });
    const tSend = performance.now();
    (window as any).__lastSwitch.tSend = tSend;
    console.log(`[Switch] SEND filename=${filename} clickToSend=${(tSend - tClick).toFixed(1)}ms`);
  }, [flushCurrentDoc, sendMessage]);

  // Pending scroll target — consumed by handleEditorReady after the new doc mounts.
  // Set by handleLinkClick on every doc-link navigation. `toTop` is the default
  // for `doc:DOCID` links (no #nodeId, no ?q=quote) — without an explicit signal
  // the editor container would keep whatever scrollTop the previous doc had,
  // landing the user mid-doc or at the bottom. Setting toTop forces a clean
  // scroll-to-top after the new doc mounts.
  const pendingScroll = useRef<{ nodeId?: string; quote?: string; toTop?: boolean } | null>(null);

  /**
   * Resolve a parsed doc: link href to a filename, then switch.
   * Layered resolver:
   *   1. docId → filename via /api/documents lookup
   *   2. filename → direct switch (legacy fallback)
   *   3. nodeId / quote scroll: stashed in pendingScroll, consumed on editor ready
   */
  const handleLinkClick = useCallback(async (target: ParsedLinkHref) => {
    let filename: string | null = null;
    if (target.docId) {
      try {
        const docs = await fetch('/api/documents').then((r) => r.json());
        if (Array.isArray(docs)) {
          const match = docs.find((d: any) => d.docId === target.docId);
          if (match) filename = match.filename;
        }
      } catch { /* fall through to filename */ }
    }
    if (!filename && target.filename) {
      filename = target.filename;
    }
    if (!filename) {
      console.warn('[link] could not resolve doc: target', target);
      return;
    }
    // Stash scroll target — consumed when the new doc finishes loading.
    // A doc-level link (`doc:DOCID` with no #nodeId and no ?q=quote) defaults
    // to scroll-to-top. Without this the editor would keep whatever scrollTop
    // the prior doc left behind, which lands the user mid-doc or at the bottom.
    if (target.nodeId || target.quote) {
      pendingScroll.current = {
        nodeId: target.nodeId || undefined,
        quote: target.quote || undefined,
      };
    } else {
      pendingScroll.current = { toTop: true };
    }
    handleSwitchDocument(filename);
  }, [handleSwitchDocument]);

  // Listen for backlinks-panel "navigate to source" events from ContextMenu.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as ParsedLinkHref;
      if (detail) handleLinkClick(detail);
    };
    window.addEventListener('ow-navigate-to-link', handler);
    return () => window.removeEventListener('ow-navigate-to-link', handler);
  }, [handleLinkClick]);

  // Deep-link boot: /d/{docId} or /d/{docId}#node={nodeId}.
  // Fires once on mount, hands off to the existing handleLinkClick path which
  // resolves docId → filename, switches the doc, and consumes pendingScroll
  // to scroll + flash the target node (if any). The URL bar then flips to the
  // canonical `#{filename}` form on successful load — the /d/{docId} URL is
  // an entry point, not a persistent state.
  const deepLinkBootRef = useRef(false);
  useEffect(() => {
    if (deepLinkBootRef.current) return;
    deepLinkBootRef.current = true;
    const pathMatch = window.location.pathname.match(/^\/d\/([a-f0-9]{8})\/?$/);
    if (!pathMatch) return;
    const docId = pathMatch[1];
    const nodeMatch = window.location.hash.match(/^#node=([a-f0-9]{8})$/);
    const nodeId = nodeMatch ? nodeMatch[1] : null;
    handleLinkClick({ docId, filename: null, nodeId, quote: null });
  }, [handleLinkClick]);

  // Consume pendingScroll after a doc loads. Tries nodeId first, then quote
  // fallback, then scroll-to-top (the default for doc-level links).
  useEffect(() => {
    if (!editorInstance || !pendingScroll.current) return;
    const scroll = pendingScroll.current;
    pendingScroll.current = null;
    // Defer a tick so the editor's DOM is fully laid out
    setTimeout(() => {
      // toTop wins on doc-level links — no nodeId, no quote, just "show me
      // the top of this doc." Without this branch the editor container keeps
      // the prior doc's scrollTop and the user lands mid-doc / at the bottom.
      if (scroll.toTop) {
        const container = document.querySelector('.editor-container') as HTMLElement | null;
        if (container) container.scrollTop = 0;
        return;
      }
      let targetPos: number | null = null;
      // 1. Try nodeId — walk doc, find node with matching attrs.id
      if (scroll.nodeId) {
        editorInstance.state.doc.descendants((node: any, pos: number) => {
          if (targetPos !== null) return false;
          if (node.attrs?.id === scroll.nodeId) {
            targetPos = pos + 1; // inside the block
            return false;
          }
          return true;
        });
      }
      // 2. Quote fallback — find first text match
      if (targetPos === null && scroll.quote) {
        const needle = scroll.quote;
        editorInstance.state.doc.descendants((node: any, pos: number) => {
          if (targetPos !== null) return false;
          if (node.isTextblock) {
            const idx = node.textContent.indexOf(needle);
            if (idx >= 0) {
              targetPos = pos + 1 + idx;
              return false;
            }
          }
          return true;
        });
      }
      if (targetPos === null) return;
      editorInstance.chain().focus().setTextSelection({ from: targetPos, to: targetPos }).scrollIntoView().run();
      // Briefly flash the target so the eye finds it
      const dom = editorInstance.view.nodeDOM(targetPos - 1) as HTMLElement | null;
      if (dom?.classList) {
        dom.classList.add('scroll-target-flash');
        setTimeout(() => dom.classList.remove('scroll-target-flash'), 1200);
      }
    }, 100);
    // activeFilename, not activeDocKey: with the stable-editor refactor the
    // doc-key only bumps for tweet compose. Scroll-after-switch should fire
    // on every filename change.
  }, [editorInstance, activeFilename]);

  // Top-bar back/forward delegate to the browser. The browser fires popstate,
  // which triggers our internal switch — so browser back, top-bar back, and
  // Alt+ArrowLeft all walk through the exact same code path.
  const goBack = useCallback(() => {
    if (navIndex.current <= 0) return;
    window.history.back();
  }, []);

  const goForward = useCallback(() => {
    if (navIndex.current >= navStack.current.length - 1) return;
    window.history.forward();
  }, []);

  // popstate handler — fires on browser back/forward (and on goBack/goForward,
  // which delegate via window.history.back/forward). State carries the filename
  // and the navIndex it corresponds to; we move our pointer to match.
  useEffect(() => {
    const handler = (e: PopStateEvent) => {
      const ow = (e.state && (e.state as any).ow) as { filename: string; navIndex: number } | undefined;
      if (!ow?.filename) return;
      if (ow.filename === currentFilename.current) return;
      saveCurrentScroll();
      // Direction tells handleDocumentSwitched whether to move the pointer back or forward.
      navIntent.current = ow.navIndex < navIndex.current ? 'back' : 'forward';
      // Don't push a new browser entry — the browser already moved us.
      skipBrowserPush.current = true;
      flushCurrentDoc();
      sendMessage({ type: 'switch-document', filename: ow.filename });
    };
    window.addEventListener('popstate', handler);
    return () => window.removeEventListener('popstate', handler);
  }, [flushCurrentDoc, sendMessage]);

  // Fetch comments for current document + refresh decorations on ALL editors
  const fetchComments = useCallback(() => {
    const filename = currentFilename.current;
    const editor = editorRef.current;
    if (!filename || !editor) return;
    const refreshAll = () => {
      const editors = allEditorsRef.current;
      if (editors.length > 1) {
        for (const e of editors) {
          if (e?.view) forceCommentRefresh(e.view);
        }
      } else if (editor?.view) {
        forceCommentRefresh(editor.view);
      }
    };
    fetch(`/api/comments/${encodeURIComponent(filename)}`)
      .then((res) => res.json())
      .then((data) => {
        setCommentsData(data.comments || []);
        refreshAll();
      })
      .catch(() => {
        setCommentsData([]);
        refreshAll();
      });
  }, []);

  // Re-fetch comments when document switches OR when the editor finishes
  // mounting. On hard refresh, activeFilename can resolve before the editor
  // is ready — without the editorInstance dep the fetch would bail and never
  // re-fire, so newly-created comments would appear "lost" until next switch.
  useEffect(() => {
    fetchComments();
  }, [activeFilename, editorInstance, fetchComments]);

  // Listen for comments-changed WS events (agent resolved a comment, or a new one created)
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.filename === currentFilename.current) {
        fetchComments();
      }
    };
    window.addEventListener('ow-comments-changed', handler);
    return () => window.removeEventListener('ow-comments-changed', handler);
  }, [fetchComments]);

  // Sync backlinks decoration data from /api/backlinks/:docId. v0.20 computes
  // backlinks live (inverse of every doc's references) — there is no stored
  // derived field. Fires whenever the doc switches (docId changes) or its
  // metadata changes (a write may have touched references and invalidated the
  // server-side cache).
  useEffect(() => {
    const docId = metadata?.docId;
    if (!docId) {
      setBacklinksData([]);
      return;
    }
    let cancelled = false;
    fetch(`/api/backlinks/${docId}`)
      .then((r) => (r.ok ? r.json() : []))
      .then((entries) => {
        if (cancelled) return;
        setBacklinksData(Array.isArray(entries) ? entries : []);
        const editors = allEditorsRef.current.length > 0 ? allEditorsRef.current : (editorInstance ? [editorInstance] : []);
        for (const e of editors) {
          if (e?.view) forceBacklinkRefresh(e.view);
        }
      })
      .catch(() => { /* best-effort; leave decorations as-is on transient failure */ });
    return () => { cancelled = true; };
  }, [metadata, editorInstance]);

  // Keyboard shortcuts for navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.altKey && e.key === 'ArrowLeft') { e.preventDefault(); goBack(); }
      if (e.altKey && e.key === 'ArrowRight') { e.preventDefault(); goForward(); }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [goBack, goForward]);

  // Debounce doc updates — send at most every 1s instead of every keystroke.
  // CRITICAL: read the doc from `lastDocJson.current` at fire time, NOT from
  // the captured `json` argument. Between handleDocUpdate firing and the timer
  // resolving, `onIdRewrites` may mutate lastDocJson in place (after the
  // server's matcher reassigns block IDs). Sending the captured json would
  // ship stale-ID state back to the server, which would re-rewrite those same
  // IDs and broadcast the same rewrites again — an infinite non-converging
  // loop. Reading lastDocJson at fire time picks up any rewrites that landed
  // during the debounce window.
  // adr: adr/node-identity-matcher.md
  const handleDocUpdate = useCallback((json: any) => {
    lastDocJson.current = json;
    if (docUpdateTimer.current) clearTimeout(docUpdateTimer.current);
    docUpdateTimer.current = setTimeout(() => {
      const fresh = lastDocJson.current || json;
      // Diff-gate: skip the send if content matches what we last synced. This
      // suppresses no-op autosaves triggered by server broadcasts, reconnect
      // rehydration, decoration plugin transactions, and React re-renders that
      // pass new initialContent. Without this gate, those events round-trip
      // back to the server and can resurrect overlay entries the server
      // already resolved, or burn save cycles on docs that haven't changed.
      const freshStr = JSON.stringify(fresh);
      if (freshStr === lastSentDocJson.current) return;
      sendMessage({ type: 'doc-update', document: fresh, filename: currentFilename.current, version: docVersionRef.current });
      lastSentDocJson.current = freshStr;
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

  const toggleFocusMode = useCallback(() => {
    setFocusMode((cur) => {
      if (!cur) {
        // Entering focus mode — snapshot sidebar + toolbar, close both.
        focusSnapshotRef.current = { sidebarOpen, showToolbar };
        setSidebarOpen(false);
        setShowToolbar(false);
        return true;
      }
      // Exiting — restore snapshot if we have one.
      const snap = focusSnapshotRef.current;
      if (snap) {
        setSidebarOpen(snap.sidebarOpen);
        setShowToolbar(snap.showToolbar);
        focusSnapshotRef.current = null;
      }
      return false;
    });
  }, [sidebarOpen, showToolbar]);

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
    <RightRailProvider>
    <div className="app">
      {!isBoardMode && (
        <Sidebar
          open={sidebarOpen}
          onSwitchDocument={handleSwitchDocument}
          onCreateDocument={handleCreateDocument}
          refreshKey={sidebarRefreshKey}
          docTagsRefreshKey={docTagsRefreshKey}
          workspacesRefreshKey={workspacesRefreshKey}
          pendingDocs={pendingDocs}
          writingTitle={writingTitle}
          writingTarget={writingTarget}
          pendingWriteFilenames={pendingWriteFilenames}
          onClose={() => setSidebarOpen(false)}
        />
      )}
      <div className="app-main">
        <Titlebar
          title={title}
          onTitleChange={handleTitleChange}
          onToggleSidebar={!isBoardMode && !sidebarOpen ? () => setSidebarOpen(true) : undefined}
          canGoBack={canGoBack}
          canGoForward={canGoForward}
          onGoBack={goBack}
          onGoForward={goForward}
          editor={editorInstance}
          onToggleToolbar={toggleToolbar}
          toolbarOpen={showToolbar}
          focusMode={focusMode}
          onToggleFocusMode={toggleFocusMode}
        />
        {showToolbar && editorInstance && (
          <FormatToolbar editor={activeEditor || editorInstance} />
        )}
        {isBoardMode && (
          <Sidebar
            open={true}
            onSwitchDocument={handleSwitchDocument}
            onCreateDocument={handleCreateDocument}
            refreshKey={sidebarRefreshKey}
            docTagsRefreshKey={docTagsRefreshKey}
            workspacesRefreshKey={workspacesRefreshKey}
            pendingDocs={pendingDocs}
            writingTitle={writingTitle}
          writingTarget={writingTarget}
          pendingWriteFilenames={pendingWriteFilenames}
          />
        )}
        {!connected && (
          <div className="connection-banner">
            <div className="connection-banner-spinner" />
            <span>Reconnecting to server...</span>
          </div>
        )}
        {metadata?.autoAccept === true && (
          <div className="editor-auto-accept-banner" title="Agent edits skip the review step. Right-click the doc in the sidebar to turn off.">
            <span className="editor-auto-accept-dot" />
            Auto-accept on — agent edits skip review
          </div>
        )}
        {reloadNotice && (
          <div
            className="editor-reload-banner"
            role="status"
            aria-live="polite"
          >
              <span className="editor-reload-dot" aria-hidden="true" />
              <span>
                {reloadNotice.reloadCount > 1
                  ? `Document reloaded from disk ${reloadNotice.reloadCount}× since you last looked`
                  : 'Document reloaded from disk (external write detected)'}
              </span>
              {(reloadNotice.orphanCount > 0 || reloadNotice.staleBaselineCount > 0) && (
                <span className="editor-reload-detail">
                  {reloadNotice.orphanCount > 0 && (
                    <span className="editor-reload-tag editor-reload-tag--orphan">
                      {reloadNotice.orphanCount} orphan{reloadNotice.orphanCount === 1 ? '' : 's'}
                    </span>
                  )}
                  {reloadNotice.staleBaselineCount > 0 && (
                    <span className="editor-reload-tag editor-reload-tag--stale">
                      {reloadNotice.staleBaselineCount} stale-baseline
                    </span>
                  )}
                </span>
              )}
            <button
              type="button"
              className="editor-reload-dismiss"
              onClick={() => setReloadNotice(null)}
              aria-label="Dismiss reload notification"
            >
              ×
            </button>
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
                initialContent={initialContent}
                extensions={articleExtensions}
                onUpdate={handleDocUpdate}
                onReady={handleEditorReady}
                onLinkClick={handleLinkClick}
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
                initialContent={initialContent}
                onUpdate={handleDocUpdate}
                onReady={handleEditorReady}
                onLinkClick={handleLinkClick}
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
                initialContent={initialContent}
                onUpdate={handleDocUpdate}
                onReady={handleEditorReady}
                onLinkClick={handleLinkClick}
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
              onActiveEditorChange={setActiveEditor}
              filename={activeFilename}
              title={title}
            />
          ) : (
            <PadEditor
              initialContent={initialContent}
              onUpdate={handleDocUpdate}
              onReady={handleEditorReady}
              onLinkClick={handleLinkClick}
            />
          )}
        </div>
      </div>
      <RightRail
        editors={allEditors}
        pendingDocs={pendingDocs}
        currentFilename={activeFilename}
        docId={(metadata?.docId as string) || null}
        onSwitchDocument={handleSwitchDocument}
        sendMessage={sendMessage}
        getDocument={() => lastDocJson.current}
        docVersionRef={docVersionRef}
        syncStatus={syncStatus}
        onSync={handleSync}
        onToggleToolbar={toggleToolbar}
        toolbarOpen={showToolbar}
        focusMode={focusMode}
        onToggleFocusMode={toggleFocusMode}
      />
      <ContextMenu editorRef={editorRef} allEditors={allEditors} documentId={activeFilename} />
      <CommentPopover documentId={activeFilename} />
      {showSyncSetup && (
        <SyncSetupModal
          onClose={() => setShowSyncSetup(false)}
          onSetupComplete={() => {
            fetch('/api/sync/status').then((r) => r.json()).then(setSyncStatus).catch(() => {});
          }}
        />
      )}
    </div>
    </RightRailProvider>
  );
}
