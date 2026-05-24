/**
 * Tweet Compose View — X/Twitter compose experience with multi-tweet thread support.
 *
 * Owns ALL editor instances. Content is stored as a single document with HR separators
 * between tweets. On mount, content is split at HRs into separate TweetEditor instances.
 * On any editor update, all editors are merged back with HR JSON nodes.
 *
 * Reply mode: parent tweet above, compose tweets below.
 * Quote mode: compose tweets above, quoted tweet card below.
 * Plain mode: compose tweets with avatar.
 * Thread: + button adds tweets, × removes them, vertical thread line connects avatars.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Editor } from '@tiptap/react';
import { useTweetEmbed } from '../hooks/useTweetEmbed';
import { useTweetCopy } from './useTweetCopy';
import TweetEmbed from './TweetEmbed';
import TweetEditor from './TweetEditor';
import CharacterCounter from './CharacterCounter';
import XConnectPrompt from './XConnectPrompt';
import SchedulePostModal from '../sidebar/SchedulePostModal';
import { weightedLength } from './tweetWeight';

const LS_KEY = 'ow-x-handle';

function ComposeAvatar() {
  const [handle, setHandle] = useState(() => localStorage.getItem(LS_KEY) || '');
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);

  const save = () => {
    const clean = draft.replace(/^@/, '').trim();
    if (clean) {
      localStorage.setItem(LS_KEY, clean);
      setHandle(clean);
    }
    setEditing(false);
  };

  const open = () => {
    setDraft(handle);
    setEditing(true);
    setTimeout(() => inputRef.current?.focus(), 0);
  };

  useEffect(() => {
    if (!editing) return;
    const handler = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) save();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [editing, draft]);

  const avatarUrl = handle ? `https://unavatar.io/twitter/${handle}` : '';

  return (
    <div className="tweet-compose-avatar-wrapper" ref={wrapperRef}>
      {handle ? (
        <img
          className="tweet-compose-avatar tweet-compose-avatar-img"
          src={avatarUrl}
          alt={`@${handle}`}
          onClick={open}
          title={`@${handle} — click to change`}
        />
      ) : (
        <div className="tweet-compose-avatar" onClick={open} title="Set your @handle" />
      )}
      {editing && (
        <div className="tweet-handle-popover">
          <input
            ref={inputRef}
            className="tweet-handle-input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') setEditing(false); }}
            placeholder="your_handle"
            spellCheck={false}
          />
        </div>
      )}
    </div>
  );
}

interface TweetContext {
  url?: string;
  mode: 'tweet' | 'reply' | 'quote';
  lastPost?: { postedAt: string; tweetUrl?: string };
}

/**
 * X API capability map. Source of truth for which compose modes can be
 * posted via the X API. When this is `true` for a mode, the API Post
 * button is shown and the manual Mark-as-posted button is hidden. When
 * `false`, it inverts: manual is the only path.
 *
 * Currently `quote` is `false` because the X API does not support
 * creating quote tweets programmatically. When X adds that capability,
 * flip this to `true` — no other code change needed; the manual
 * Mark-as-posted button auto-hides for quote mode.
 */
const X_API_SUPPORTS_MODE: Record<'tweet' | 'reply' | 'quote', boolean> = {
  tweet: true,
  reply: true,
  quote: false,
};

interface TweetComposeViewProps {
  tweetContext?: TweetContext;
  initialContent?: any;
  onUpdate?: (json: any) => void;
  onEditorReady?: (editor: Editor) => void;
  onEditorsChange?: (editors: Editor[]) => void;
  onActiveEditorChange?: (editor: Editor) => void;
  filename?: string;
  title?: string;
}

function TweetSkeleton() {
  return (
    <div className="tweet-skeleton">
      <div className="tweet-author-row">
        <div className="tweet-avatar tweet-avatar-placeholder tweet-pulse" />
        <div className="tweet-author-info">
          <span className="tweet-skeleton-line tweet-pulse" style={{ width: 120 }} />
          <span className="tweet-skeleton-line tweet-pulse" style={{ width: 80 }} />
        </div>
      </div>
      <div className="tweet-skeleton-line tweet-pulse" style={{ width: '100%', height: 16, marginTop: 12 }} />
      <div className="tweet-skeleton-line tweet-pulse" style={{ width: '75%', height: 16, marginTop: 8 }} />
    </div>
  );
}

function extractTweetId(url?: string): string | undefined {
  if (!url) return undefined;
  return url.match(/\/status\/(\d+)/)?.[1];
}

/** Split TipTap JSON document at horizontalRule nodes into per-tweet content (JSON objects or HTML strings) */
function splitContentAtHr(content: any): any[] {
  if (!content) return [null];

  // If it's a string (HTML), split on <hr> tags
  if (typeof content === 'string') {
    const parts = content.split(/<hr\s*\/?>/i).map(s => s.trim()).filter(Boolean);
    return parts.length ? parts : [null];
  }

  // JSON document: split at horizontalRule nodes
  if (content?.type === 'doc' && Array.isArray(content.content)) {
    const tweets: any[][] = [[]];
    for (const node of content.content) {
      if (node.type === 'horizontalRule') {
        tweets.push([]);
      } else {
        tweets[tweets.length - 1].push(node);
      }
    }
    // Return each group as a mini doc JSON object (not stringified)
    const result = tweets
      .map(nodes => nodes.length ? { type: 'doc', content: nodes } : null)
      .filter(Boolean);
    return result.length ? result : [null];
  }

  // Fallback: pass through as-is
  return [content];
}

/**
 * Extract block-level image nodes from a tweet part's content.
 * Returns the image srcs found. Block-level images are top-level nodes
 * with type 'image' (promoted from solo ![](src) in markdown).
 * Only extracts trailing images — images before text content are left inline.
 */
function extractPreviewImagesFromPart(part: any): string[] {
  if (!part || typeof part === 'string' || !part.content) return [];
  const srcs: string[] = [];
  // Walk backwards from the end collecting block-level image nodes
  for (let i = part.content.length - 1; i >= 0; i--) {
    if (part.content[i].type === 'image' && part.content[i].attrs?.src) {
      srcs.unshift(part.content[i].attrs.src);
    } else {
      break;
    }
  }
  return srcs;
}

/**
 * Return a copy of the part with trailing block-level image nodes removed.
 * These images will be shown in the preview grid instead of inline.
 */
function stripPreviewImagesFromPart(part: any, imageCount: number): any {
  if (!part || typeof part === 'string' || !part.content || imageCount === 0) return part;
  const trimmed = part.content.slice(0, part.content.length - imageCount);
  if (trimmed.length === 0) {
    // All content was images — return empty paragraph so editor has somewhere to type
    return { type: 'doc', content: [{ type: 'paragraph', content: [] }] };
  }
  return { ...part, content: trimmed };
}

/** Merge multiple editor JSONs back into a single document with horizontalRule separators.
 *  If previewImages is provided, appends block-level image nodes after each editor's content
 *  so they persist through the markdown save/load cycle.
 */
function mergeEditorContents(editors: (Editor | null)[], previewImages?: string[][]): any {
  const content: any[] = [];
  let outputCount = 0;
  editors.forEach((editor, originalIndex) => {
    if (!editor) return;
    if (outputCount > 0) content.push({ type: 'horizontalRule' });
    const json = editor.getJSON();
    if (json.content) content.push(...json.content);
    // Append preview images as block-level image nodes (serialized as ![](src) in markdown)
    const editorPreview = previewImages?.[originalIndex];
    if (editorPreview) {
      for (const src of editorPreview) {
        const id = crypto.randomUUID().replace(/-/g, '').slice(0, 8);
        content.push({ type: 'image', attrs: { src, id } });
      }
    }
    outputCount++;
  });
  return { type: 'doc', content };
}

/** Walk editor JSON tree and collect image src attributes, plus preview grid images (capped at 4 per X limit) */
function extractImageSrcs(editor: Editor, previewSrcs?: string[]): string[] {
  const srcs: string[] = [];
  const walk = (node: any) => {
    if (node.type === 'image' && node.attrs?.src) srcs.push(node.attrs.src);
    if (node.content) node.content.forEach(walk);
  };
  walk(editor.getJSON());
  if (previewSrcs) srcs.push(...previewSrcs);
  return srcs.slice(0, 4);
}

function saveTweetMeta(partial: Partial<TweetContext>) {
  fetch('/api/metadata', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tweetContext: partial }),
    keepalive: true,
  }).catch(() => {});
}

type PostState = 'idle' | 'uploading' | 'posting' | 'success' | 'error';

export default function TweetComposeView({ tweetContext, initialContent, onUpdate, onEditorReady, onEditorsChange, onActiveEditorChange, filename, title }: TweetComposeViewProps) {
  const { tweet, loading, error } = useTweetEmbed(tweetContext?.url);

  // Split initial content into per-tweet parts, extracting preview images from persisted image nodes
  const [tweetParts, setTweetParts] = useState<string[]>(() => {
    const rawParts = splitContentAtHr(initialContent);
    // Strip trailing image nodes — they'll be extracted into previewImagesRef below
    return rawParts.map(part => {
      const imgs = extractPreviewImagesFromPart(part);
      return stripPreviewImagesFromPart(part, imgs.length);
    });
  });
  const [contentVersion, setContentVersion] = useState(0);

  // Editor refs — one per tweet
  const editorsRef = useRef<(Editor | null)[]>([]);
  const lastMergedRef = useRef<string | null>(null);
  const isFirstRender = useRef(true);
  // Resync guard: suppress handleEditorUpdate during editor re-creation
  // to prevent incomplete merges from overwriting server state.
  const isResyncingRef = useRef(false);
  const expectedEditorCount = useRef(tweetParts.length);
  const [charCounts, setCharCounts] = useState<number[]>(() => tweetParts.map(() => 0));
  const [activeIndex, setActiveIndex] = useState(0);
  const [editorReadyCount, setEditorReadyCount] = useState(0);

  // Preview images per editor — initialized from persisted image nodes in document content
  const previewImagesRef = useRef<string[][]>(
    splitContentAtHr(initialContent).map(part => extractPreviewImagesFromPart(part))
  );
  const [previewImageCounts, setPreviewImageCounts] = useState<number[]>(() => {
    const rawParts = splitContentAtHr(initialContent);
    return rawParts.map(part => extractPreviewImagesFromPart(part).length);
  });

  // X connection state
  const [xConnected, setXConnected] = useState<boolean | null>(null);
  const [xUsername, setXUsername] = useState<string | undefined>();
  const [showConnect, setShowConnect] = useState(false);
  const [postState, setPostState] = useState<PostState>('idle');
  const [postError, setPostError] = useState('');
  const successTimer = useRef<ReturnType<typeof setTimeout>>();
  const { copyText, copyState } = useTweetCopy(editorsRef, activeIndex);
  const [showScheduleModal, setShowScheduleModal] = useState(false);

  // Whether the X API can post the current compose mode. When true, the
  // API Post button is the only path. When false, manual Mark-as-posted
  // is the only path. Drives footer button visibility — see X_API_SUPPORTS_MODE.
  const apiCanPost = X_API_SUPPORTS_MODE[tweetContext?.mode ?? 'tweet'];

  // Mark-as-posted URL prompt. Matches the CreateDocDropdown convention:
  // click opens an inline input + chevron submit. Enter or chevron saves
  // { postedAt, tweetUrl }. Empty URL is allowed (mark posted without link).
  // Esc dismisses without saving. Clicking when already posted reopens the
  // prompt with the existing URL pre-filled so it can be added or edited.
  const [markPostedUrlOpen, setMarkPostedUrlOpen] = useState(false);
  const [markPostedUrlValue, setMarkPostedUrlValue] = useState('');
  const markPostedInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (markPostedUrlOpen) setTimeout(() => markPostedInputRef.current?.focus(), 0);
  }, [markPostedUrlOpen]);
  const submitMarkPosted = () => {
    const url = markPostedUrlValue.trim();
    const isValid = !url || url.includes('x.com') || url.includes('twitter.com');
    if (!isValid) return;
    const prevPostedAt = tweetContext?.lastPost?.postedAt;
    saveTweetMeta({
      lastPost: {
        postedAt: prevPostedAt ?? new Date().toISOString(),
        tweetUrl: url || undefined,
      },
    });
    setMarkPostedUrlOpen(false);
    setMarkPostedUrlValue('');
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/x/status');
        if (cancelled) return;
        if (res.ok) {
          const data = await res.json();
          setXConnected(data.connected);
          setXUsername(data.username);
        } else {
          setXConnected(false);
        }
      } catch {
        if (!cancelled) setXConnected(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Sync server-side content changes (e.g. MCP insert_image, agent write_to_pad) into split editors
  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }
    if (!initialContent) return;
    const incoming = JSON.stringify(initialContent);
    // Skip if this is an echo of our own merge
    if (incoming === lastMergedRef.current) return;
    const rawParts = splitContentAtHr(initialContent);
    // Extract persisted preview images from block-level image nodes, strip them from editor content
    const extractedImages = rawParts.map(part => extractPreviewImagesFromPart(part));
    const strippedParts = rawParts.map((part, i) => stripPreviewImagesFromPart(part, extractedImages[i].length));
    // Set resync guard: suppress handleEditorUpdate until all editors are ready.
    // This prevents incomplete merges during editor re-creation from overwriting server state.
    isResyncingRef.current = true;
    expectedEditorCount.current = strippedParts.length;
    editorsRef.current = [];
    previewImagesRef.current = extractedImages;
    setTweetParts(strippedParts);
    setCharCounts(strippedParts.map(() => 0));
    setPreviewImageCounts(extractedImages.map(imgs => imgs.length));
    setContentVersion(v => v + 1);
  }, [initialContent]);

  const handleEditorUpdate = useCallback((index: number, editor: Editor) => {
    editorsRef.current[index] = editor;
    setCharCounts(prev => {
      const next = [...prev];
      next[index] = weightedLength(editor.getText());
      return next;
    });
    // Suppress merge during resync — editors are being re-created and an incomplete
    // merge would overwrite server state with fewer tweets.
    if (isResyncingRef.current) return;
    // Merge all editors and notify parent, track to avoid re-split echo.
    // Include preview images so they persist as block-level image nodes in the document.
    const merged = mergeEditorContents(editorsRef.current, previewImagesRef.current);
    lastMergedRef.current = JSON.stringify(merged);
    onUpdate?.(merged);
  }, [onUpdate]);

  const handleEditorReady = useCallback((index: number, editor: Editor) => {
    editorsRef.current[index] = editor;
    setCharCounts(prev => {
      const next = [...prev];
      next[index] = weightedLength(editor.getText());
      return next;
    });
    setEditorReadyCount(c => c + 1);
    // Clear resync guard once all editors are ready
    if (isResyncingRef.current) {
      const readyCount = editorsRef.current.filter(Boolean).length;
      if (readyCount >= expectedEditorCount.current) {
        isResyncingRef.current = false;
        // Update lastMergedRef so the next user edit doesn't echo
        const merged = mergeEditorContents(editorsRef.current, previewImagesRef.current);
        lastMergedRef.current = JSON.stringify(merged);
      }
    }
    // Give parent the first editor for toolbar/context menu compatibility
    if (index === 0) onEditorReady?.(editor);
    // Notify parent of all editors for review panel navigation
    onEditorsChange?.(editorsRef.current.filter(Boolean) as Editor[]);
  }, [onEditorReady, onEditorsChange]);

  const isThread = tweetParts.length > 1;
  const totalChars = charCounts.reduce((a, b) => a + b, 0);

  const addTweet = useCallback(() => {
    const insertAt = activeIndex + 1;
    setTweetParts(prev => [...prev.slice(0, insertAt), '<p></p>', ...prev.slice(insertAt)]);
    setCharCounts(prev => [...prev.slice(0, insertAt), 0, ...prev.slice(insertAt)]);
    previewImagesRef.current.splice(insertAt, 0, []);
    setPreviewImageCounts(prev => [...prev.slice(0, insertAt), 0, ...prev.slice(insertAt)]);
    setActiveIndex(insertAt);
  }, [activeIndex]);

  const removeTweet = useCallback((index: number) => {
    if (index === 0) return; // Can't remove first tweet
    // Remove the editor ref and preview images
    editorsRef.current.splice(index, 1);
    previewImagesRef.current.splice(index, 1);
    setTweetParts(prev => prev.filter((_, i) => i !== index));
    setCharCounts(prev => prev.filter((_, i) => i !== index));
    setPreviewImageCounts(prev => prev.filter((_, i) => i !== index));
    // Re-merge after removal and notify parent of editor changes
    setTimeout(() => {
      const merged = mergeEditorContents(editorsRef.current, previewImagesRef.current);
      onUpdate?.(merged);
      onEditorsChange?.(editorsRef.current.filter(Boolean) as Editor[]);
    }, 0);
  }, [onUpdate, onEditorsChange]);

  const hasContext = !!tweetContext?.url;
  const isReply = tweetContext?.mode === 'reply';

  // Check if any editor has content (text, inline images, or preview images)
  const hasContent = (() => {
    const editors = editorsRef.current.filter(Boolean) as Editor[];
    const hasEditorContent = editors.some(e => e.getText().trim() || extractImageSrcs(e).length > 0);
    const hasPreviewContent = previewImageCounts.some(c => c > 0);
    return hasEditorContent || hasPreviewContent;
  })();
  const canPost = xConnected && hasContent && postState === 'idle';

  const handlePost = async () => {
    if (!xConnected) { setShowConnect(true); return; }
    if (!canPost) return;

    setPostState('uploading');
    setPostError('');

    try {
      // Phase 1: Extract text + images per tweet (inline + preview), upload images
      const tweetData: { text: string; mediaIds: string[] }[] = [];

      for (let idx = 0; idx < editorsRef.current.length; idx++) {
        const editor = editorsRef.current[idx];
        if (!editor) continue;
        const text = editor.getText().trim();
        const imageSrcs = extractImageSrcs(editor, previewImagesRef.current[idx]);

        // Skip empty tweets (no text AND no images)
        if (!text && imageSrcs.length === 0) continue;

        const mediaIds: string[] = [];
        for (const src of imageSrcs) {
          const uploadRes = await fetch('/api/x/upload-media', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ src }),
          });
          const uploadData = await uploadRes.json();
          if (!uploadData.success) {
            throw new Error(uploadData.error || 'Image upload failed');
          }
          mediaIds.push(uploadData.mediaId);
        }

        tweetData.push({ text, mediaIds });
      }

      if (tweetData.length === 0) return;

      // Phase 2: Post tweet(s)
      setPostState('posting');

      const contextTweetId = extractTweetId(tweetContext?.url);

      if (tweetData.length === 1) {
        // Single tweet
        const body: Record<string, any> = {};
        if (tweetData[0].text) body.text = tweetData[0].text;
        if (tweetData[0].mediaIds.length > 0) body.mediaIds = tweetData[0].mediaIds;
        if (tweetContext?.mode === 'reply' && contextTweetId) body.replyTo = contextTweetId;
        else if (tweetContext?.mode === 'quote' && contextTweetId) body.quoteTweetId = contextTweetId;

        const res = await fetch('/api/x/post', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const data = await res.json();

        if (data.success) {
          saveTweetMeta({ lastPost: { postedAt: new Date().toISOString(), tweetUrl: data.tweetUrl } });
          setPostState('success');
          successTimer.current = setTimeout(() => setPostState('idle'), 2500);
        } else {
          console.error('[TweetCompose] Post error:', data.error);
          setPostError(data.error || 'Post failed');
          setPostState('error');
          setTimeout(() => setPostState('idle'), 3000);
        }
      } else {
        // Thread
        const tweets = tweetData.map(t => ({
          text: t.text,
          ...(t.mediaIds.length > 0 ? { mediaIds: t.mediaIds } : {}),
        }));
        const body: any = { tweets };
        if (tweetContext?.mode === 'reply' && contextTweetId) body.replyTo = contextTweetId;

        const res = await fetch('/api/x/post-thread', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const data = await res.json();

        if (data.success) {
          saveTweetMeta({ lastPost: { postedAt: new Date().toISOString(), tweetUrl: data.threadUrl } });
          setPostState('success');
          successTimer.current = setTimeout(() => setPostState('idle'), 2500);
        } else {
          setPostError(data.error || 'Thread post failed');
          setPostState('error');
          setTimeout(() => setPostState('idle'), 3000);
        }
      }
    } catch (err: any) {
      setPostError(err.message || 'Network error');
      setPostState('error');
      setTimeout(() => setPostState('idle'), 3000);
    }
  };

  useEffect(() => () => { if (successTimer.current) clearTimeout(successTimer.current); }, []);

  const handleConnected = () => {
    setXConnected(true);
    setShowConnect(false);
    fetch('/api/x/status').then(r => r.json()).then(d => {
      if (d.username) setXUsername(d.username);
    }).catch(() => {});
  };

  const postBtnLabel = postState === 'uploading' ? 'Uploading...'
    : postState === 'posting' ? 'Posting...'
    : postState === 'success' ? 'Posted!'
    : postState === 'error' ? 'Failed'
    : isThread ? (activeIndex === 0 ? 'Post Thread' : 'Post All') : 'Post';

  const placeholders = tweetParts.map((_, i) => {
    if (i === 0) {
      if (isReply) return 'Post your reply';
      return 'What is happening?!';
    }
    return 'Add another tweet';
  });

  /** Renders the compose footer (char counter, + button, post button) */
  const renderFooter = (inline?: boolean) => (
    <div className={`tweet-compose-footer${inline ? ' tweet-compose-footer--inline' : ''}`}>
      {activeIndex === 0 && tweetContext?.lastPost?.postedAt && (
        <a
          className="tweet-posted-status"
          href={tweetContext.lastPost.tweetUrl}
          target="_blank"
          rel="noopener noreferrer"
          title={tweetContext.lastPost.tweetUrl || 'Posted to X'}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="20 6 9 17 4 12" />
          </svg>
          Posted {new Date(tweetContext.lastPost.postedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
        </a>
      )}
      {postState === 'error' && postError && (
        <span className="tweet-post-error">{postError}</span>
      )}
      {isThread && (
        <span className="tweet-thread-counter">{activeIndex + 1}/{tweetParts.length}</span>
      )}
      <CharacterCounter count={charCounts[activeIndex] || 0} />
      <button className="tweet-thread-add" onClick={addTweet} title="Add another tweet">
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
          <line x1="10" y1="4" x2="10" y2="16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          <line x1="4" y1="10" x2="16" y2="10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      </button>
      <button
        className={`tweet-copy-btn${copyState === 'copied' ? ' tweet-copy-btn--copied' : ''}`}
        disabled={!hasContent}
        onClick={copyText}
        title="Copy tweet text to clipboard"
      >
        {copyState === 'copied' ? (
          <>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <path d="M3 8.5L6.5 12L13 4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            Copied!
          </>
        ) : (
          <>
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <rect x="5.5" y="2" width="8.5" height="10.5" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
              <path d="M3.5 5H2.5A1.5 1.5 0 001 6.5V13a1.5 1.5 0 001.5 1.5H9A1.5 1.5 0 0010.5 13v-1" stroke="currentColor" strokeWidth="1.5" />
            </svg>
            Copy
          </>
        )}
      </button>
      {activeIndex === 0 && !apiCanPost && (() => {
        const isPosted = !!tweetContext?.lastPost?.postedAt;
        const existingUrl = tweetContext?.lastPost?.tweetUrl ?? '';
        const openPrompt = () => {
          setMarkPostedUrlValue(existingUrl);
          setMarkPostedUrlOpen(true);
        };
        return (
          <div className="tweet-mark-sent-wrap">
            <button
              className={`tweet-mark-sent-btn${isPosted ? ' tweet-mark-sent-btn--done' : ''}`}
              onClick={openPrompt}
              title={isPosted ? (existingUrl ? `Posted — ${existingUrl}` : 'Posted — add URL') : 'Mark as manually posted'}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill={isPosted ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" /><polyline points="8 12 11 15 16 9" stroke={isPosted ? '#fff' : 'currentColor'} />
              </svg>
            </button>
            {markPostedUrlOpen && (() => {
              const url = markPostedUrlValue.trim();
              const isValid = !url || url.includes('x.com') || url.includes('twitter.com');
              return (
                <div className="tweet-mark-sent-url">
                  <input
                    ref={markPostedInputRef}
                    type="text"
                    placeholder="Paste posted tweet URL..."
                    value={markPostedUrlValue}
                    onChange={(e) => setMarkPostedUrlValue(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') { e.preventDefault(); submitMarkPosted(); }
                      if (e.key === 'Escape') { setMarkPostedUrlOpen(false); setMarkPostedUrlValue(''); }
                    }}
                  />
                  <button onClick={submitMarkPosted} disabled={!isValid} title={url ? 'Save URL' : 'Mark posted without URL'}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="9 18 15 12 9 6" />
                    </svg>
                  </button>
                </div>
              );
            })()}
          </div>
        );
      })()}
      {filename && (
        <button className="tweet-schedule-btn" onClick={() => setShowScheduleModal(true)} title="Schedule post">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" />
          </svg>
        </button>
      )}
      {apiCanPost && (
        <button
          className={`tweet-post-btn${canPost || (!xConnected && xConnected !== null) ? ' tweet-post-btn--active' : ''}${postState === 'success' ? ' tweet-post-btn--success' : ''}${postState === 'error' ? ' tweet-post-btn--error' : ''}`}
          disabled={xConnected ? !canPost : false}
          onClick={handlePost}
          title={xConnected ? (xUsername ? `Post as @${xUsername}` : 'Post to X') : 'Connect X to post'}
        >
          {postBtnLabel}
        </button>
      )}
    </div>
  );

  const isQuoteMode = hasContext && !isReply;

  /** Renders the thread compose UI — used in all modes */
  const renderThreadEditors = () => (
    <div className="tweet-thread-editors">
      {tweetParts.map((part, i) => (
        <div key={`${contentVersion}-${i}`} className={`tweet-thread-item${i === activeIndex ? ' tweet-thread-item--active' : ' tweet-thread-item--inactive'}`}>
          <div className="tweet-thread-item-left">
            <ComposeAvatar />
            {(i < tweetParts.length - 1) && <div className="tweet-thread-line" />}
          </div>
          <div className="tweet-thread-item-right">
            {i > 0 && (
              <button
                className="tweet-thread-remove"
                onClick={() => removeTweet(i)}
                title="Remove this tweet"
              >
                &times;
              </button>
            )}
            <div className={`tweet-compose-box${i === 0 && !isThread ? ' tweet-compose-box--standalone' : ''}`}>
              <TweetEditor
                initialContent={part}
                initialPreviewImages={previewImagesRef.current[i]}
                placeholder={placeholders[i]}
                onUpdate={(editor) => handleEditorUpdate(i, editor)}
                onReady={(editor) => handleEditorReady(i, editor)}
                onFocus={() => {
                  setActiveIndex(i);
                  const editor = editorsRef.current[i];
                  if (editor) onActiveEditorChange?.(editor);
                }}
                onPreviewImagesChange={(srcs) => {
                  previewImagesRef.current[i] = srcs;
                  setPreviewImageCounts(prev => {
                    const next = [...prev];
                    next[i] = srcs.length;
                    return next;
                  });
                  // Trigger document save so preview images persist as block-level image nodes
                  if (!isResyncingRef.current) {
                    const merged = mergeEditorContents(editorsRef.current, previewImagesRef.current);
                    lastMergedRef.current = JSON.stringify(merged);
                    onUpdate?.(merged);
                  }
                }}
              />
            </div>
            {i === activeIndex && !isQuoteMode && renderFooter(i < tweetParts.length - 1)}
          </div>
        </div>
      ))}
    </div>
  );

  return (
    <div className="tweet-compose-wrapper">
      {/* === Reply mode: parent tweet above, compose below === */}
      {hasContext && isReply && (
        <>
          {loading && (
            <div className="tweet-context-section">
              <TweetSkeleton />
            </div>
          )}
          {error && (
            <div className="tweet-context-section">
              <div className="tweet-embed-error">
                <span>Could not load tweet</span>
                <a href={tweetContext!.url} target="_blank" rel="noopener noreferrer" className="tweet-fallback-link">
                  {tweetContext!.url}
                </a>
              </div>
            </div>
          )}
          {tweet && (
            <div className="tweet-reply-parent-section">
              <div className="tweet-reply-parent-card">
                <TweetEmbed tweet={tweet} url={tweetContext?.url} />
              </div>
              <div className="tweet-replying-to">
                Replying to <span className="tweet-reply-handle">@{tweet.author.username}</span>
              </div>
            </div>
          )}
          {renderThreadEditors()}
        </>
      )}

      {/* === Quote mode: compose above, quoted tweet below, footer at bottom === */}
      {isQuoteMode && (
        <>
          {renderThreadEditors()}
          <div className="tweet-quote-section" style={{ padding: '0 16px 12px' }}>
            {loading && <TweetSkeleton />}
            {error && (
              <div className="tweet-embed-error">
                <span>Could not load tweet</span>
                <a href={tweetContext!.url} target="_blank" rel="noopener noreferrer" className="tweet-fallback-link">
                  {tweetContext!.url}
                </a>
              </div>
            )}
            {tweet && <TweetEmbed tweet={tweet} url={tweetContext?.url} />}
          </div>
          <div className="tweet-quote-footer">{renderFooter()}</div>
        </>
      )}

      {/* === No context: plain compose === */}
      {!hasContext && renderThreadEditors()}

      {showConnect && (
        <XConnectPrompt
          onConnected={handleConnected}
          onCancel={() => setShowConnect(false)}
        />
      )}

      {showScheduleModal && filename && (
        <SchedulePostModal
          filename={filename}
          title={title || 'Untitled'}
          onClose={() => setShowScheduleModal(false)}
        />
      )}
    </div>
  );
}
