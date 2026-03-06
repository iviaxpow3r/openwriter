/**
 * Newsletter Compose View — rich newsletter editing with header image.
 *
 * Layout: cover image → subject → preview text → body.
 * Only rendered for rich newsletters (format: 'rich').
 * Text newsletters use the default editor.
 */

import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import './NewsletterComposeView.css';

// ─── Types ──────────────────────────────────────────────────────

export interface NewsletterContext {
  active?: boolean;
  format?: 'text' | 'rich';
  subject?: string;
  previewText?: string;
  coverImage?: string;
  coverImages?: string[];
}

// ─── Metadata persistence ───────────────────────────────────────

function saveNewsletterMeta(partial: Partial<NewsletterContext>) {
  fetch('/api/metadata', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ newsletterContext: partial }),
  }).catch(() => {});
}

// ─── Cover Image ────────────────────────────────────────────────

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
    saveNewsletterMeta({ coverImage: newSrc, coverImages: images });
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
      const data = await res.json();
      if (data.success && data.src) {
        const newImages = [...images, data.src];
        setImages(newImages);
        setImageSrc(data.src);
        setState('display');
        setPrompt('');
        saveNewsletterMeta({ coverImage: data.src, coverImages: newImages });
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
      saveNewsletterMeta({ coverImage: nextSrc, coverImages: newImages });
    } else {
      setImageSrc('');
      setState('empty');
      saveNewsletterMeta({ coverImage: undefined, coverImages: undefined });
    }
  };

  const regenerate = () => { setState('prompt'); setTimeout(() => inputRef.current?.focus(), 0); };

  if (state === 'display' && imageSrc) {
    return (
      <div className="nl-cover nl-cover--display">
        <img className="nl-cover-img" src={imageSrc} alt="Header" />
        <div className="nl-cover-overlay">
          {hasMultiple && (
            <button className="nl-cover-arrow nl-cover-arrow--left" onClick={goPrev} disabled={currentIndex <= 0}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6" /></svg>
            </button>
          )}
          <div className="nl-cover-overlay-center">
            <button className="nl-cover-btn" onClick={regenerate}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="23 4 23 10 17 10" /><polyline points="1 20 1 14 7 14" /><path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15" /></svg>
              Regenerate
            </button>
            <button className="nl-cover-btn nl-cover-btn--danger" onClick={remove}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
              Remove
            </button>
          </div>
          {hasMultiple && (
            <button className="nl-cover-arrow nl-cover-arrow--right" onClick={goNext} disabled={currentIndex >= totalImages - 1}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6" /></svg>
            </button>
          )}
          {hasMultiple && <div className="nl-cover-counter">{currentIndex + 1} / {totalImages}</div>}
        </div>
      </div>
    );
  }

  if (state === 'loading') {
    return (
      <div className="nl-cover nl-cover--loading">
        <div className="nl-cover-spinner" />
        <span className="nl-cover-loading-text">Generating header image...</span>
      </div>
    );
  }

  if (state === 'prompt') {
    return (
      <div className="nl-cover nl-cover--prompt">
        <div className="nl-cover-prompt-row">
          <input
            ref={inputRef}
            className="nl-cover-prompt-input"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Describe your header image..."
            spellCheck={false}
          />
          <button className="nl-cover-prompt-btn" onClick={generate} disabled={!prompt.trim()}>Generate</button>
          <button className="nl-cover-prompt-cancel" onClick={() => { setState(imageSrc ? 'display' : 'empty'); setPrompt(''); setError(''); }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
          </button>
        </div>
        {error && <div className="nl-cover-error">{error}</div>}
      </div>
    );
  }

  return (
    <div className="nl-cover nl-cover--empty" onClick={openPrompt}>
      <svg className="nl-cover-icon" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
        <circle cx="8.5" cy="8.5" r="1.5" />
        <polyline points="21 15 16 10 5 21" />
      </svg>
      <span className="nl-cover-hint">Add a header image</span>
    </div>
  );
}

// ─── Text Newsletter View (subject + preview only, no card/cover) ───

interface TextNewsletterViewProps {
  children: ReactNode;
  newsletterContext?: NewsletterContext;
  onFormatChange?: (format: 'text' | 'rich') => void;
}

export function TextNewsletterView({ children, newsletterContext, onFormatChange }: TextNewsletterViewProps) {
  const ctx = newsletterContext || {};
  const [subject, setSubject] = useState(ctx.subject || '');
  const [previewText, setPreviewText] = useState(ctx.previewText || '');

  useEffect(() => {
    setSubject(ctx.subject || '');
    setPreviewText(ctx.previewText || '');
  }, [newsletterContext]);

  const canSave = !!newsletterContext?.active;
  const format = ctx.format || 'text';

  const saveFields = useCallback(() => {
    if (canSave) saveNewsletterMeta({ subject, previewText });
  }, [canSave, subject, previewText]);

  const toggleFormat = useCallback(() => {
    const newFormat = format === 'rich' ? 'text' : 'rich';
    saveNewsletterMeta({ format: newFormat });
    onFormatChange?.(newFormat);
  }, [format, onFormatChange]);

  const previewCharCount = previewText.length;
  const previewOverLimit = previewCharCount > 150;

  return (
    <div className="nl-text-wrapper">
      <div className="nl-subject-row">
        <input
          className="nl-subject-input"
          type="text"
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          onBlur={saveFields}
          placeholder="Email subject line (defaults to title if empty)"
          spellCheck={false}
        />
        <button
          className={`nl-format-badge nl-format-badge--${format}`}
          onClick={toggleFormat}
          title={`Switch to ${format === 'rich' ? 'plain text' : 'HTML'}`}
        >
          {format === 'rich' ? 'HTML' : 'Plain text'}
        </button>
      </div>
      <div className="nl-preview-wrap">
        <textarea
          className={`nl-preview-input${previewOverLimit ? ' over-limit' : ''}`}
          value={previewText}
          onChange={(e) => setPreviewText(e.target.value)}
          onBlur={saveFields}
          placeholder="Preview text shown in inbox before opening..."
          rows={2}
          spellCheck={false}
        />
        <span className={`nl-preview-count${previewOverLimit ? ' over-limit' : ''}`}>
          {previewCharCount}/150
        </span>
      </div>
      {children}
    </div>
  );
}

// ─── Rich Newsletter View ───────────────────────────────────────

interface NewsletterComposeViewProps {
  children: ReactNode;
  title?: string;
  onTitleChange?: (title: string) => void;
  newsletterContext?: NewsletterContext;
}

const DEFAULT_TITLES = new Set(['Untitled', 'New Document', 'Newsletter', 'Rich Newsletter']);

export default function NewsletterComposeView({ children, title, onTitleChange, newsletterContext }: NewsletterComposeViewProps) {
  const ctx = newsletterContext || {};
  const [subject, setSubject] = useState(ctx.subject || '');
  const [previewText, setPreviewText] = useState(ctx.previewText || '');

  // Sync from props when doc switches
  useEffect(() => {
    setSubject(ctx.subject || '');
    setPreviewText(ctx.previewText || '');
  }, [newsletterContext]);

  const canSave = !!newsletterContext?.active;

  const saveFields = useCallback(() => {
    if (canSave) saveNewsletterMeta({ subject, previewText });
  }, [canSave, subject, previewText]);

  const previewCharCount = previewText.length;
  const previewOverLimit = previewCharCount > 150;

  return (
    <div className="nl-compose-wrapper">
      <CoverImage src={ctx.coverImage} coverImages={ctx.coverImages} />

      <div className="nl-compose-content">
        <input
          className="nl-title-input"
          type="text"
          value={DEFAULT_TITLES.has(title || '') ? '' : title || ''}
          onChange={(e) => onTitleChange?.(e.target.value || 'Untitled')}
          placeholder="Newsletter title"
          spellCheck={false}
        />

        <input
          className="nl-subject-input"
          type="text"
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          onBlur={saveFields}
          placeholder="Email subject line (defaults to title if empty)"
          spellCheck={false}
        />

        <div className="nl-preview-wrap">
          <textarea
            className={`nl-preview-input${previewOverLimit ? ' over-limit' : ''}`}
            value={previewText}
            onChange={(e) => setPreviewText(e.target.value)}
            onBlur={saveFields}
            placeholder="Preview text shown in inbox before opening..."
            rows={2}
            spellCheck={false}
          />
          <span className={`nl-preview-count${previewOverLimit ? ' over-limit' : ''}`}>
            {previewCharCount}/150
          </span>
        </div>

        <div className="nl-compose-body">{children}</div>
      </div>
    </div>
  );
}
