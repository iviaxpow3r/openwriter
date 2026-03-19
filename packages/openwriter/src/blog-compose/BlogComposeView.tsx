/**
 * Blog Compose View — structured blog post editing experience.
 *
 * Layout: cover image → title → description → metadata bar → body.
 * Adjustable canvas via style presets (font, width, spacing).
 * Frontmatter fields stored in blogContext metadata — transformed
 * to clean YAML on publish (no OpenWriter metadata in output).
 */

import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import SchedulePostModal from '../sidebar/SchedulePostModal';
import BlogPublishModal, { type PublishResult } from './BlogPublishModal';
import './BlogComposeView.css';

// ─── Types ──────────────────────────────────────────────────────

type FontPreset = 'serif' | 'sans' | 'mono';
type WidthPreset = 'narrow' | 'standard' | 'wide';
type SpacingPreset = 'compact' | 'comfortable';

interface BlogStyle {
  font: FontPreset;
  width: WidthPreset;
  spacing: SpacingPreset;
}

export interface BlogContext {
  active?: boolean;
  description?: string;
  date?: string;
  tags?: string[];
  author?: string;
  slug?: string;
  draft?: boolean;
  coverImage?: string;
  coverImages?: string[];
  style?: Partial<BlogStyle>;
  lastPublish?: { publishedAt: string; url?: string; repo?: string };
}

const DEFAULT_STYLE: BlogStyle = { font: 'sans', width: 'standard', spacing: 'comfortable' };
const DEFAULT_TITLES = new Set(['Untitled', 'New Document', 'Blog']);

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function todayISO(): string {
  return new Date().toISOString().split('T')[0];
}

// ─── Metadata persistence ───────────────────────────────────────

function saveBlogMeta(partial: Partial<BlogContext>) {
  fetch('/api/metadata', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ blogContext: partial }),
  }).catch(() => {});
}

// ─── Cover Image ────────────────────────────────────────────────
// Reuses the same pattern as ArticleComposeView's CoverImage

type CoverState = 'empty' | 'prompt' | 'loading' | 'display';

function CoverImage({ src, coverImages }: { src?: string; coverImages?: string[] }) {
  const [state, setState] = useState<CoverState>(src ? 'display' : 'empty');
  const [imageSrc, setImageSrc] = useState(src || '');
  const [images, setImages] = useState<string[]>(coverImages || (src ? [src] : []));
  const [prompt, setPrompt] = useState('');
  const [error, setError] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (src) { setImageSrc(src); setState('display'); }
    else { setImageSrc(''); setState('empty'); setPrompt(''); setError(''); }
  }, [src]);

  useEffect(() => {
    if (coverImages && coverImages.length > 0) setImages(coverImages);
    else setImages(src ? [src] : []);
  }, [coverImages]);

  const currentIndex = imageSrc ? images.indexOf(imageSrc) : -1;
  const totalImages = images.length;
  const hasMultiple = totalImages > 1;

  const navigateTo = useCallback((index: number) => {
    const newSrc = images[index];
    if (!newSrc) return;
    setImageSrc(newSrc);
    saveBlogMeta({ coverImage: newSrc, coverImages: images });
  }, [images]);

  const goPrev = useCallback(() => { if (currentIndex > 0) navigateTo(currentIndex - 1); }, [currentIndex, navigateTo]);
  const goNext = useCallback(() => { if (currentIndex < totalImages - 1) navigateTo(currentIndex + 1); }, [currentIndex, totalImages, navigateTo]);

  const generate = useCallback(async () => {
    if (!prompt.trim()) return;
    setState('loading');
    setError('');
    try {
      const res = await fetch('/api/image-gen/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: prompt.trim() }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        setError(data?.error || `Generation failed (${res.status})`);
        setState('prompt');
        return;
      }
      const data = await res.json();
      if (data.success && data.src) {
        const newImages = [...images, data.src];
        setImages(newImages);
        setImageSrc(data.src);
        setState('display');
        setPrompt('');
        saveBlogMeta({ coverImage: data.src, coverImages: newImages });
      } else {
        setError(data.error || 'Generation failed');
        setState('prompt');
      }
    } catch (err: any) {
      setError(err.message || 'Network error');
      setState('prompt');
    }
  }, [prompt, images]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') generate();
    if (e.key === 'Escape') { setState('empty'); setPrompt(''); setError(''); }
  };

  const openPrompt = () => { setState('prompt'); setTimeout(() => inputRef.current?.focus(), 0); };

  const remove = () => {
    const newImages = images.filter((img) => img !== imageSrc);
    setImages(newImages);
    if (newImages.length > 0) {
      const nextIndex = Math.min(currentIndex, newImages.length - 1);
      const nextSrc = newImages[nextIndex];
      setImageSrc(nextSrc);
      saveBlogMeta({ coverImage: nextSrc, coverImages: newImages });
    } else {
      setImageSrc('');
      setState('empty');
      saveBlogMeta({ coverImage: undefined, coverImages: undefined });
    }
  };

  const regenerate = () => { setState('prompt'); setTimeout(() => inputRef.current?.focus(), 0); };

  const download = () => {
    const a = document.createElement('a');
    a.href = imageSrc;
    a.download = `cover-${currentIndex + 1}.png`;
    a.click();
  };

  if (state === 'display' && imageSrc) {
    return (
      <div className="blog-cover blog-cover--display">
        <img className="blog-cover-img" src={imageSrc} alt="Cover" />
        <div className="blog-cover-overlay">
          {hasMultiple && (
            <button className="blog-cover-arrow blog-cover-arrow--left" onClick={goPrev} disabled={currentIndex <= 0}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6" /></svg>
            </button>
          )}
          <div className="blog-cover-overlay-center">
            <button className="blog-cover-btn" onClick={regenerate}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="23 4 23 10 17 10" /><polyline points="1 20 1 14 7 14" /><path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15" /></svg>
              Regenerate
            </button>
            <button className="blog-cover-btn" onClick={download}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" /></svg>
              Save
            </button>
            <button className="blog-cover-btn blog-cover-btn--danger" onClick={remove}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
              Remove
            </button>
          </div>
          {hasMultiple && (
            <button className="blog-cover-arrow blog-cover-arrow--right" onClick={goNext} disabled={currentIndex >= totalImages - 1}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6" /></svg>
            </button>
          )}
          {hasMultiple && <div className="blog-cover-counter">{currentIndex + 1} / {totalImages}</div>}
        </div>
      </div>
    );
  }

  if (state === 'loading') {
    return (
      <div className="blog-cover blog-cover--loading">
        <div className="blog-cover-spinner" />
        <span className="blog-cover-loading-text">Generating cover image...</span>
      </div>
    );
  }

  if (state === 'prompt') {
    return (
      <div className="blog-cover blog-cover--prompt">
        <div className="blog-cover-prompt-row">
          <input
            ref={inputRef}
            className="blog-cover-prompt-input"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Describe your cover image..."
            spellCheck={false}
          />
          <button className="blog-cover-prompt-btn" onClick={generate} disabled={!prompt.trim()}>Generate</button>
          <button className="blog-cover-prompt-cancel" onClick={() => { setState(imageSrc ? 'display' : 'empty'); setPrompt(''); setError(''); }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
          </button>
        </div>
        {error && <div className="blog-cover-error">{error}</div>}
      </div>
    );
  }

  return (
    <div className="blog-cover blog-cover--empty" onClick={openPrompt}>
      <svg className="blog-cover-icon" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
        <circle cx="8.5" cy="8.5" r="1.5" />
        <polyline points="21 15 16 10 5 21" />
      </svg>
      <span className="blog-cover-hint">Add a featured image</span>
    </div>
  );
}

// ─── Tag Input ──────────────────────────────────────────────────

function TagInput({ tags, onChange }: { tags: string[]; onChange: (tags: string[]) => void }) {
  const [input, setInput] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const addTag = (value: string) => {
    const tag = value.trim().toLowerCase();
    if (tag && !tags.includes(tag)) onChange([...tags, tag]);
    setInput('');
  };

  const removeTag = (tag: string) => onChange(tags.filter(t => t !== tag));

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addTag(input); }
    if (e.key === 'Backspace' && !input && tags.length > 0) removeTag(tags[tags.length - 1]);
  };

  return (
    <div className="blog-tags" onClick={() => inputRef.current?.focus()}>
      {tags.map(tag => (
        <span key={tag} className="blog-tag">
          {tag}
          <button className="blog-tag-remove" onClick={(e) => { e.stopPropagation(); removeTag(tag); }}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
          </button>
        </span>
      ))}
      <input
        ref={inputRef}
        className="blog-tag-input"
        value={input}
        onChange={e => setInput(e.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={() => { if (input.trim()) addTag(input); }}
        placeholder={tags.length === 0 ? 'Add tags...' : ''}
        spellCheck={false}
      />
    </div>
  );
}

// ─── Style Controls ─────────────────────────────────────────────

function StyleControls({ style, onChange }: { style: BlogStyle; onChange: (s: BlogStyle) => void }) {
  const btn = (active: boolean) => `blog-style-btn${active ? ' active' : ''}`;

  return (
    <div className="blog-style-controls">
      <div className="blog-style-group">
        <span className="blog-style-label">Font</span>
        <button className={btn(style.font === 'sans')} onClick={() => onChange({ ...style, font: 'sans' })} title="Sans-serif">Aa</button>
        <button className={`${btn(style.font === 'serif')} serif-btn`} onClick={() => onChange({ ...style, font: 'serif' })} title="Serif">Aa</button>
        <button className={`${btn(style.font === 'mono')} mono-btn`} onClick={() => onChange({ ...style, font: 'mono' })} title="Monospace">Aa</button>
      </div>
      <div className="blog-style-group">
        <span className="blog-style-label">Width</span>
        <button className={btn(style.width === 'narrow')} onClick={() => onChange({ ...style, width: 'narrow' })} title="Narrow (600px)">
          <svg width="16" height="14" viewBox="0 0 16 14"><rect x="4" y="1" width="8" height="12" rx="1" fill="none" stroke="currentColor" strokeWidth="1.5" /></svg>
        </button>
        <button className={btn(style.width === 'standard')} onClick={() => onChange({ ...style, width: 'standard' })} title="Standard (720px)">
          <svg width="16" height="14" viewBox="0 0 16 14"><rect x="2" y="1" width="12" height="12" rx="1" fill="none" stroke="currentColor" strokeWidth="1.5" /></svg>
        </button>
        <button className={btn(style.width === 'wide')} onClick={() => onChange({ ...style, width: 'wide' })} title="Wide (900px)">
          <svg width="16" height="14" viewBox="0 0 16 14"><rect x="0.5" y="1" width="15" height="12" rx="1" fill="none" stroke="currentColor" strokeWidth="1.5" /></svg>
        </button>
      </div>
      <div className="blog-style-group">
        <span className="blog-style-label">Spacing</span>
        <button className={btn(style.spacing === 'compact')} onClick={() => onChange({ ...style, spacing: 'compact' })} title="Compact">
          <svg width="16" height="14" viewBox="0 0 16 14" fill="none" stroke="currentColor" strokeWidth="1.5"><line x1="1" y1="3" x2="15" y2="3" /><line x1="1" y1="7" x2="15" y2="7" /><line x1="1" y1="11" x2="15" y2="11" /></svg>
        </button>
        <button className={btn(style.spacing === 'comfortable')} onClick={() => onChange({ ...style, spacing: 'comfortable' })} title="Comfortable">
          <svg width="16" height="14" viewBox="0 0 16 14" fill="none" stroke="currentColor" strokeWidth="1.5"><line x1="1" y1="2" x2="15" y2="2" /><line x1="1" y1="7" x2="15" y2="7" /><line x1="1" y1="12" x2="15" y2="12" /></svg>
        </button>
      </div>
    </div>
  );
}

// ─── Main View ──────────────────────────────────────────────────

interface BlogComposeViewProps {
  children: ReactNode;
  title?: string;
  onTitleChange?: (title: string) => void;
  blogContext?: BlogContext;
  filename?: string;
}

export default function BlogComposeView({ children, title, onTitleChange, blogContext, filename }: BlogComposeViewProps) {
  const ctx = blogContext || {};
  const [description, setDescription] = useState(ctx.description || '');
  const [showScheduleModal, setShowScheduleModal] = useState(false);
  const [date, setDate] = useState(ctx.date || todayISO());
  const [tags, setTags] = useState<string[]>(ctx.tags || []);
  const [author, setAuthor] = useState(ctx.author || '');
  const [slug, setSlug] = useState(ctx.slug || '');
  const [draft, setDraft] = useState(ctx.draft ?? false);
  const [style, setStyle] = useState<BlogStyle>({ ...DEFAULT_STYLE, ...ctx.style });
  const [metaOpen, setMetaOpen] = useState(false);
  const [slugManual, setSlugManual] = useState(!!ctx.slug);
  const [ghConnection, setGhConnection] = useState<{ id: string; display_name: string } | null>(null);
  const [showPublishModal, setShowPublishModal] = useState(false);

  // Fetch GitHub connection on mount
  useEffect(() => {
    fetch('/api/blog/connection')
      .then(r => r.json())
      .then(data => { if (data.connection) setGhConnection(data.connection); })
      .catch(() => {});
  }, []);

  // Auto-derive slug from title unless manually edited
  useEffect(() => {
    if (!slugManual && title && !DEFAULT_TITLES.has(title)) {
      setSlug(slugify(title));
    }
  }, [title, slugManual]);

  // Sync from props when doc switches
  useEffect(() => {
    setDescription(ctx.description || '');
    setDate(ctx.date || todayISO());
    setTags(ctx.tags || []);
    setAuthor(ctx.author || '');
    setSlug(ctx.slug || '');
    setDraft(ctx.draft ?? false);
    setStyle({ ...DEFAULT_STYLE, ...ctx.style });
    setSlugManual(!!ctx.slug);
  }, [blogContext]);

  // Only save when this is genuinely a blog doc (active blogContext from props).
  // Prevents contaminating other docs during unmount/switch transitions.
  const canSave = !!blogContext?.active;

  // Persist changes on blur / explicit action (not every keystroke)
  const saveFields = useCallback(() => {
    if (canSave) saveBlogMeta({ description, date, tags, author, slug, draft, style });
  }, [canSave, description, date, tags, author, slug, draft, style]);

  // Save tags immediately since they change via discrete actions
  useEffect(() => { if (canSave) saveBlogMeta({ tags }); }, [canSave, tags]);

  // Save style immediately since it changes via button clicks
  useEffect(() => { if (canSave) saveBlogMeta({ style }); }, [canSave, style]);

  // Save draft toggle immediately
  useEffect(() => { if (canSave) saveBlogMeta({ draft }); }, [canSave, draft]);

  const descCharCount = description.length;
  const descOverLimit = descCharCount > 160;

  const wrapperClass = [
    'blog-compose-wrapper',
    `blog--font-${style.font}`,
    `blog--width-${style.width}`,
    `blog--spacing-${style.spacing}`,
  ].join(' ');

  return (
    <div className={wrapperClass}>
      <CoverImage src={ctx.coverImage} coverImages={ctx.coverImages} />

      <div className="blog-compose-content">
        {ctx.lastPublish?.publishedAt && (
          <a
            className="blog-published-status"
            href={ctx.lastPublish.url}
            target="_blank"
            rel="noopener noreferrer"
            title={ctx.lastPublish.url || `Published to ${ctx.lastPublish.repo || 'GitHub'}`}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="20 6 9 17 4 12" />
            </svg>
            Published {new Date(ctx.lastPublish.publishedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}{ctx.lastPublish.repo ? ` to ${ctx.lastPublish.repo.split('/').pop()}` : ''}
          </a>
        )}
        <input
          className="blog-title-input"
          type="text"
          value={DEFAULT_TITLES.has(title || '') ? '' : title || ''}
          onChange={(e) => onTitleChange?.(e.target.value || 'Untitled')}
          placeholder="Post title"
          spellCheck={false}
        />

        <div className="blog-description-wrap">
          <textarea
            className={`blog-description-input${descOverLimit ? ' over-limit' : ''}`}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            onBlur={saveFields}
            placeholder="Write a short description for SEO and social previews..."
            rows={2}
            spellCheck={false}
          />
          <span className={`blog-description-count${descOverLimit ? ' over-limit' : ''}`}>
            {descCharCount}/160
          </span>
        </div>

        <div className="blog-meta-toggle" onClick={() => setMetaOpen(o => !o)}>
          <svg className={`blog-meta-chevron${metaOpen ? ' open' : ''}`} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="9 18 15 12 9 6" />
          </svg>
          <span>Metadata</span>
          {draft && <span className="blog-draft-badge">Draft</span>}
        </div>

        {metaOpen && (
          <div className="blog-meta-fields">
            <div className="blog-meta-row">
              <label className="blog-meta-label">Date</label>
              <input type="date" className="blog-meta-input" value={date} onChange={(e) => setDate(e.target.value)} onBlur={saveFields} />
            </div>
            <div className="blog-meta-row">
              <label className="blog-meta-label">Author</label>
              <input type="text" className="blog-meta-input" value={author} onChange={(e) => setAuthor(e.target.value)} onBlur={saveFields} placeholder="Author name" spellCheck={false} />
            </div>
            <div className="blog-meta-row">
              <label className="blog-meta-label">Slug</label>
              <input
                type="text"
                className="blog-meta-input"
                value={slug}
                onChange={(e) => { setSlugManual(true); setSlug(e.target.value); }}
                onBlur={saveFields}
                placeholder="auto-generated-from-title"
                spellCheck={false}
              />
            </div>
            <div className="blog-meta-row">
              <label className="blog-meta-label">Tags</label>
              <TagInput tags={tags} onChange={setTags} />
            </div>
            <div className="blog-meta-row">
              <label className="blog-meta-label">Draft</label>
              <button className={`blog-draft-toggle${draft ? ' active' : ''}`} onClick={() => setDraft(d => !d)}>
                <div className="blog-draft-toggle-knob" />
              </button>
            </div>
          </div>
        )}

        <div className="blog-compose-body">{children}</div>
      </div>

      <div className="blog-compose-footer">
        <StyleControls style={style} onChange={setStyle} />
        {filename && (
          <div className="blog-footer-actions">
            {ghConnection && (
              <button className="blog-footer-btn blog-footer-btn--primary" onClick={() => setShowPublishModal(true)}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22" />
                </svg>
                Publish
              </button>
            )}
            <button className="blog-footer-btn" onClick={() => setShowScheduleModal(true)}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" />
              </svg>
              Schedule
            </button>
          </div>
        )}
      </div>

      {showScheduleModal && filename && (
        <SchedulePostModal
          filename={filename}
          title={title || 'Untitled'}
          onClose={() => setShowScheduleModal(false)}
        />
      )}

      {showPublishModal && ghConnection && (
        <BlogPublishModal
          connectionId={ghConnection.id}
          repoName={ghConnection.display_name}
          title={title || 'Untitled'}
          slug={slug}
          onClose={(result) => {
            setShowPublishModal(false);
            if (result) saveBlogMeta({ lastPublish: result } as any);
          }}
        />
      )}
    </div>
  );
}
