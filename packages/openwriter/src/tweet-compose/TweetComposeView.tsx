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
}

interface TweetComposeViewProps {
  tweetContext?: TweetContext;
  initialContent?: any;
  onUpdate?: (json: any) => void;
  onEditorReady?: (editor: Editor) => void;
  onEditorsChange?: (editors: Editor[]) => void;
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

/** Merge multiple editor JSONs back into a single document with horizontalRule separators */
function mergeEditorContents(editors: (Editor | null)[]): any {
  const content: any[] = [];
  const validEditors = editors.filter(Boolean) as Editor[];
  validEditors.forEach((editor, i) => {
    const json = editor.getJSON();
    if (json.content) content.push(...json.content);
    if (i < validEditors.length - 1) content.push({ type: 'horizontalRule' });
  });
  return { type: 'doc', content };
}

/** Walk editor JSON tree and collect image src attributes (capped at 4 per X limit) */
function extractImageSrcs(editor: Editor): string[] {
  const srcs: string[] = [];
  const walk = (node: any) => {
    if (node.type === 'image' && node.attrs?.src) srcs.push(node.attrs.src);
    if (node.content) node.content.forEach(walk);
  };
  walk(editor.getJSON());
  return srcs.slice(0, 4);
}

type PostState = 'idle' | 'uploading' | 'posting' | 'success' | 'error';

export default function TweetComposeView({ tweetContext, initialContent, onUpdate, onEditorReady, onEditorsChange }: TweetComposeViewProps) {
  const { tweet, loading, error } = useTweetEmbed(tweetContext?.url);

  // Split initial content into per-tweet parts
  const [tweetParts, setTweetParts] = useState<string[]>(() => splitContentAtHr(initialContent));

  // Editor refs — one per tweet
  const editorsRef = useRef<(Editor | null)[]>([]);
  const [charCounts, setCharCounts] = useState<number[]>(() => tweetParts.map(() => 0));
  const [activeIndex, setActiveIndex] = useState(0);
  const [editorReadyCount, setEditorReadyCount] = useState(0);

  // X connection state
  const [xConnected, setXConnected] = useState<boolean | null>(null);
  const [xUsername, setXUsername] = useState<string | undefined>();
  const [showConnect, setShowConnect] = useState(false);
  const [postState, setPostState] = useState<PostState>('idle');
  const [postError, setPostError] = useState('');
  const successTimer = useRef<ReturnType<typeof setTimeout>>();
  const { copyText, copyState } = useTweetCopy(editorsRef, activeIndex);

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

  const handleEditorUpdate = useCallback((index: number, editor: Editor) => {
    editorsRef.current[index] = editor;
    setCharCounts(prev => {
      const next = [...prev];
      next[index] = editor.getText().length;
      return next;
    });
    // Merge all editors and notify parent
    const merged = mergeEditorContents(editorsRef.current);
    onUpdate?.(merged);
  }, [onUpdate]);

  const handleEditorReady = useCallback((index: number, editor: Editor) => {
    editorsRef.current[index] = editor;
    setCharCounts(prev => {
      const next = [...prev];
      next[index] = editor.getText().length;
      return next;
    });
    setEditorReadyCount(c => c + 1);
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
    setActiveIndex(insertAt);
  }, [activeIndex]);

  const removeTweet = useCallback((index: number) => {
    if (index === 0) return; // Can't remove first tweet
    // Remove the editor ref
    editorsRef.current.splice(index, 1);
    setTweetParts(prev => prev.filter((_, i) => i !== index));
    setCharCounts(prev => prev.filter((_, i) => i !== index));
    // Re-merge after removal and notify parent of editor changes
    setTimeout(() => {
      const merged = mergeEditorContents(editorsRef.current);
      onUpdate?.(merged);
      onEditorsChange?.(editorsRef.current.filter(Boolean) as Editor[]);
    }, 0);
  }, [onUpdate, onEditorsChange]);

  const hasContext = !!tweetContext?.url;
  const isReply = tweetContext?.mode === 'reply';

  // Check if any editor has content (text or images)
  const hasContent = (() => {
    const editors = editorsRef.current.filter(Boolean) as Editor[];
    return editors.some(e => e.getText().trim() || extractImageSrcs(e).length > 0);
  })();
  const canPost = xConnected && hasContent && postState === 'idle';

  const handlePost = async () => {
    if (!xConnected) { setShowConnect(true); return; }
    if (!canPost) return;

    setPostState('uploading');
    setPostError('');

    try {
      const validEditors = editorsRef.current.filter(Boolean) as Editor[];

      // Phase 1: Extract text + images per tweet, upload images
      const tweetData: { text: string; mediaIds: string[] }[] = [];

      for (const editor of validEditors) {
        const text = editor.getText().trim();
        const imageSrcs = extractImageSrcs(editor);

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
      {postState === 'error' && postError && (
        <span className="tweet-post-error">{postError}</span>
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
      <button
        className={`tweet-post-btn${canPost || (!xConnected && xConnected !== null) ? ' tweet-post-btn--active' : ''}${postState === 'success' ? ' tweet-post-btn--success' : ''}${postState === 'error' ? ' tweet-post-btn--error' : ''}`}
        disabled={xConnected ? !canPost : false}
        onClick={handlePost}
        title={xConnected ? (xUsername ? `Post as @${xUsername}` : 'Post to X') : 'Connect X to post'}
      >
        {postBtnLabel}
      </button>
    </div>
  );

  const isQuoteMode = hasContext && !isReply;

  /** Renders the thread compose UI — used in all modes */
  const renderThreadEditors = () => (
    <div className="tweet-thread-editors">
      {tweetParts.map((part, i) => (
        <div key={i} className={`tweet-thread-item${i === activeIndex ? ' tweet-thread-item--active' : ' tweet-thread-item--inactive'}`}>
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
                placeholder={placeholders[i]}
                onUpdate={(editor) => handleEditorUpdate(i, editor)}
                onReady={(editor) => handleEditorReady(i, editor)}
                onFocus={() => setActiveIndex(i)}
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
              <div className="tweet-reply-thread">
                <div className="tweet-reply-thread-left">
                  {tweet.author.avatarUrl ? (
                    <img className="tweet-avatar" src={tweet.author.avatarUrl} alt="" />
                  ) : (
                    <div className="tweet-avatar tweet-avatar-placeholder" />
                  )}
                  <div className="tweet-reply-thread-line" />
                </div>
                <div className="tweet-reply-thread-right">
                  <div className="tweet-reply-parent">
                    <div className="tweet-author-info">
                      <span className="tweet-author-name">{tweet.author.name}</span>
                      <span className="tweet-author-handle">@{tweet.author.username}</span>
                    </div>
                    <div className="tweet-text">{tweet.text}</div>
                    {tweet.media && tweet.media.length > 0 && (
                      <div className="tweet-media">
                        {tweet.media.map((m, i) => (
                          m.type === 'photo' ? (
                            <img key={i} className="tweet-media-img" src={m.url} alt="" loading="lazy" />
                          ) : (
                            <div key={i} className="tweet-media-video-placeholder">
                              <span>Video</span>
                            </div>
                          )
                        ))}
                      </div>
                    )}
                  </div>
                  <div className="tweet-replying-to-inline">
                    Replying to <span className="tweet-reply-handle">@{tweet.author.username}</span>
                  </div>
                </div>
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
            {tweet && <TweetEmbed tweet={tweet} />}
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
    </div>
  );
}
