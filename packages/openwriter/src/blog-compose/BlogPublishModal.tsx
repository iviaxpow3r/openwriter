import { useState, useEffect, useRef } from 'react';
import './BlogPublishModal.css';

export interface PublishResult {
  publishedAt: string;
  url?: string;
  repo?: string;
}

interface BlogPublishModalProps {
  connectionId: string;
  repoName: string;
  title: string;
  slug: string;
  onClose: (result?: PublishResult) => void;
}

type Stage = 'confirm' | 'publishing' | 'published' | 'error';

export default function BlogPublishModal({ connectionId, repoName, title, slug, onClose }: BlogPublishModalProps) {
  const [stage, setStage] = useState<Stage>('confirm');
  const [error, setError] = useState<string | null>(null);
  const [publishUrl, setPublishUrl] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  const getDismissResult = (): PublishResult | undefined =>
    stage === 'published' ? { publishedAt: new Date().toISOString(), url: publishUrl || undefined, repo: repoName } : undefined;

  // Close on click outside (not while publishing)
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (stage !== 'publishing' && ref.current && !ref.current.contains(e.target as Node)) onClose(getDismissResult());
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose, stage, publishUrl]);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && stage !== 'publishing') onClose(getDismissResult());
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose, stage, publishUrl]);

  async function publish() {
    setStage('publishing');
    setError(null);
    try {
      const res = await fetch('/api/blog/publish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ connectionId }),
      });
      const data = await res.json();

      if (!res.ok || data.error) {
        setError(data.error || `Publish failed (${res.status})`);
        setStage('error');
        return;
      }

      if (data.url) setPublishUrl(data.url);
      setStage('published');

      // Persist lastPublish to metadata
      fetch('/api/metadata', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          blogContext: {
            lastPublish: {
              publishedAt: new Date().toISOString(),
              url: data.url || undefined,
              repo: repoName,
            },
          },
        }),
      }).catch(() => {});
    } catch (err: any) {
      setError(err.message);
      setStage('error');
    }
  }

  return (
    <div className="blog-publish-overlay">
      <div className="blog-publish-modal" ref={ref}>
        <div className="blog-publish__header">
          <h3>Publish to GitHub</h3>
          <button className="blog-publish__close" onClick={() => onClose(getDismissResult())}>&times;</button>
        </div>

        <div className="blog-publish__body">
          {stage === 'confirm' && (
            <>
              <div className="blog-publish__summary">
                <div className="blog-publish__row">
                  <span className="blog-publish__label">Repository</span>
                  <span className="blog-publish__value">{repoName}</span>
                </div>
                <div className="blog-publish__row">
                  <span className="blog-publish__label">Title</span>
                  <span className="blog-publish__value">{title}</span>
                </div>
                {slug && (
                  <div className="blog-publish__row">
                    <span className="blog-publish__label">Slug</span>
                    <span className="blog-publish__value blog-publish__value--mono">{slug}</span>
                  </div>
                )}
              </div>
              <div className="blog-publish__actions">
                <button className="blog-publish__btn" onClick={() => onClose()}>Cancel</button>
                <button className="blog-publish__btn blog-publish__btn--primary" onClick={publish}>
                  Publish
                </button>
              </div>
            </>
          )}

          {stage === 'publishing' && (
            <div className="blog-publish__status">
              <div className="blog-publish__spinner" />
              <span>Publishing to {repoName}...</span>
            </div>
          )}

          {stage === 'published' && (
            <>
              <div className="blog-publish__status blog-publish__status--success">
                Published to {repoName}!
              </div>
              {publishUrl && (
                <a className="blog-publish__link" href={publishUrl} target="_blank" rel="noopener noreferrer">
                  View on GitHub
                </a>
              )}
              <div className="blog-publish__actions">
                <button
                  className="blog-publish__btn blog-publish__btn--primary"
                  onClick={() => onClose({ publishedAt: new Date().toISOString(), url: publishUrl || undefined, repo: repoName })}
                >
                  Done
                </button>
              </div>
            </>
          )}

          {stage === 'error' && (
            <>
              <div className="blog-publish__error">{error}</div>
              <div className="blog-publish__actions">
                <button className="blog-publish__btn" onClick={() => onClose()}>Cancel</button>
                <button className="blog-publish__btn blog-publish__btn--primary" onClick={publish}>
                  Retry
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
