import { useEffect, useState } from 'react';
import './PostToBlogModal.css';

interface BlogSite {
  id: string;
  label: string;
  owner: string;
  repo: string;
  branch: string;
  content_dir: string;
  image_dir: string;
  image_public_prefix: string;
  framework: string;
}

interface PostToBlogModalProps {
  filename: string;
  title: string;
  isActive: boolean;
  onSwitchDocument: (fn: string) => void;
  onClose: () => void;
}

type Stage = 'loading' | 'pick' | 'confirm' | 'posting' | 'done' | 'error';

async function mcpCall<T = any>(tool: string, args: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch('/api/mcp-call', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tool, arguments: args }),
  });
  const data = await res.json();
  if (data?.content?.[0]?.text) {
    try { return JSON.parse(data.content[0].text) as T; }
    catch { return data.content[0].text as unknown as T; }
  }
  return data as T;
}

export default function PostToBlogModal({ filename, title, isActive, onSwitchDocument, onClose }: PostToBlogModalProps) {
  const [stage, setStage] = useState<Stage>('loading');
  const [sites, setSites] = useState<BlogSite[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ url?: string; file?: string; commit?: string; images_committed?: number; message?: string } | null>(null);

  useEffect(() => {
    mcpCall<{ sites?: BlogSite[]; error?: string }>('list_blog_sites')
      .then((r) => {
        if (r.error) {
          setError(r.error);
          setStage('error');
          return;
        }
        const list = r.sites || [];
        setSites(list);
        if (list.length === 0) {
          setStage('pick');
        } else if (list.length === 1) {
          setSelectedId(list[0].id);
          setStage('confirm');
        } else {
          setStage('pick');
        }
      })
      .catch((err) => {
        setError(err?.message || 'Failed to load blog sites');
        setStage('error');
      });
  }, []);

  const selectedSite = sites.find((s) => s.id === selectedId) || null;

  const handlePost = async () => {
    if (!selectedSite) return;
    setStage('posting');
    setError(null);

    // Switch active document if needed, then wait briefly so the server-side
    // state catches up before post_to_blog reads it.
    if (!isActive) {
      onSwitchDocument(filename);
      await new Promise((r) => setTimeout(r, 350));
    }

    try {
      const r = await mcpCall<{ success?: boolean; error?: string; file?: string; commit?: string; images_committed?: number; message?: string }>('post_to_blog', {
        site_id: selectedSite.id,
      });
      if (r?.error) {
        setError(r.error);
        setStage('error');
        return;
      }
      const githubUrl = r.commit
        ? `https://github.com/${selectedSite.owner}/${selectedSite.repo}/commit/${r.commit}`
        : undefined;
      setResult({ ...r, url: githubUrl });
      setStage('done');
    } catch (err: any) {
      setError(err?.message || 'Publish failed');
      setStage('error');
    }
  };

  return (
    <div className="post-blog-overlay" onClick={() => { if (stage !== 'posting') onClose(); }}>
      <div className="post-blog-modal" onClick={(e) => e.stopPropagation()}>
        <div className="post-blog-modal-header">
          <h3>Post to Blog</h3>
          <button className="post-blog-modal-close" onClick={onClose} disabled={stage === 'posting'}>&times;</button>
        </div>

        <div className="post-blog-modal-doc">{title}</div>

        {stage === 'loading' && (
          <div className="post-blog-modal-loading">Loading blog sites…</div>
        )}

        {stage === 'pick' && sites.length === 0 && (
          <div className="post-blog-modal-empty">
            No blog sites registered. Add one in <strong>Settings → Plugins → GitHub</strong> first.
            <button className="post-blog-modal-done" onClick={onClose}>Close</button>
          </div>
        )}

        {stage === 'pick' && sites.length > 0 && (
          <>
            <div className="post-blog-modal-label">Choose a destination</div>
            <div className="post-blog-modal-sites">
              {sites.map((s) => (
                <button
                  key={s.id}
                  className={`post-blog-modal-site${selectedId === s.id ? ' post-blog-modal-site--selected' : ''}`}
                  onClick={() => { setSelectedId(s.id); setStage('confirm'); }}
                >
                  <div className="post-blog-modal-site-label">{s.label}</div>
                  <div className="post-blog-modal-site-repo">{s.owner}/{s.repo}@{s.branch}</div>
                </button>
              ))}
            </div>
          </>
        )}

        {stage === 'confirm' && selectedSite && (
          <>
            <div className="post-blog-modal-confirm">
              Publish to <strong>{selectedSite.owner}/{selectedSite.repo}@{selectedSite.branch}</strong>?
              <div className="post-blog-modal-target-dir">→ {selectedSite.content_dir}</div>
            </div>
            <div className="post-blog-modal-actions">
              <button className="post-blog-modal-btn post-blog-modal-btn--primary" onClick={handlePost}>
                Publish now
              </button>
              {sites.length > 1 && (
                <button className="post-blog-modal-btn" onClick={() => setStage('pick')}>
                  Back
                </button>
              )}
              <button className="post-blog-modal-btn" onClick={onClose}>Cancel</button>
            </div>
          </>
        )}

        {stage === 'posting' && (
          <div className="post-blog-modal-loading">Publishing…</div>
        )}

        {stage === 'done' && result && (
          <div className="post-blog-modal-result post-blog-modal-result--success">
            <div>{result.message || 'Published'}</div>
            {result.file && <div className="post-blog-modal-meta">{result.file}</div>}
            {typeof result.images_committed === 'number' && result.images_committed > 0 && (
              <div className="post-blog-modal-meta">{result.images_committed} image{result.images_committed === 1 ? '' : 's'} committed</div>
            )}
            <div className="post-blog-modal-actions">
              {result.url && (
                <button className="post-blog-modal-btn post-blog-modal-btn--primary" onClick={() => window.open(result.url, '_blank')}>
                  View commit
                </button>
              )}
              <button className="post-blog-modal-btn" onClick={onClose}>Done</button>
            </div>
          </div>
        )}

        {stage === 'error' && (
          <div className="post-blog-modal-result post-blog-modal-result--error">
            <div>{error || 'Publish failed'}</div>
            <div className="post-blog-modal-actions">
              <button className="post-blog-modal-btn" onClick={onClose}>Close</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
