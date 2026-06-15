/**
 * Manuscript compose view — the main-canvas surface for a manuscript doc.
 *
 * The body is the manifest itself (ordered `doc:` pointers + headings), edited in
 * the normal PadEditor. A segmented toggle flips the canvas between:
 *   - Manifest — edit the executable TOC (PadEditor, kept mounted)
 *   - Preview  — the compiled book in an iframe (GET /api/manuscript/preview)
 *
 * The preview is the real compile() → render() output (same path EPUB export
 * uses), so it never disagrees with the shipped book. Compile/Export controls
 * live in the right rail (Review-slot takeover), not here — a 700-page doc can't
 * carry its actions in a footer. The rail flips this view via window events.
 *
 * adr: adr/manuscript-engine.md
 */
import { type ReactNode, useEffect, useState } from 'react';
import './ManuscriptComposeView.css';

export interface ManuscriptContext {
  active?: boolean;
  // Render config (cover, trim, theme) lands here when the theme layer ships.
}

interface ManuscriptComposeViewProps {
  children: ReactNode;
  docId?: string | null;
  filename?: string;
  title?: string;
}

export default function ManuscriptComposeView({ children, docId, filename, title }: ManuscriptComposeViewProps) {
  const [mode, setMode] = useState<'manifest' | 'preview'>('manifest');
  const [previewKey, setPreviewKey] = useState(0);

  // Back to the manifest editor whenever the active doc changes.
  useEffect(() => { setMode('manifest'); }, [filename]);

  // The rail's Preview button drives this view via events (rail = controls,
  // canvas = surface). Refreshing bumps previewKey to force the iframe to reload.
  useEffect(() => {
    const showPreview = () => { setMode('preview'); setPreviewKey((k) => k + 1); };
    const showManifest = () => setMode('manifest');
    window.addEventListener('ow-manuscript-preview', showPreview);
    window.addEventListener('ow-manuscript-manifest', showManifest);
    return () => {
      window.removeEventListener('ow-manuscript-preview', showPreview);
      window.removeEventListener('ow-manuscript-manifest', showManifest);
    };
  }, []);

  const previewSrc = docId
    ? `/api/manuscript/preview?docId=${encodeURIComponent(docId)}&v=${previewKey}`
    : 'about:blank';

  return (
    <div className="ms-compose">
      <div className="ms-compose-toolbar">
        <div className="ms-seg" role="tablist" aria-label="Manuscript view">
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'manifest'}
            className={mode === 'manifest' ? 'ms-seg-btn ms-seg-btn--active' : 'ms-seg-btn'}
            onClick={() => setMode('manifest')}
          >
            Manifest
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'preview'}
            className={mode === 'preview' ? 'ms-seg-btn ms-seg-btn--active' : 'ms-seg-btn'}
            onClick={() => { setMode('preview'); setPreviewKey((k) => k + 1); }}
          >
            Preview
          </button>
        </div>
        {mode === 'preview' && (
          <button type="button" className="ms-refresh" onClick={() => setPreviewKey((k) => k + 1)} title="Re-render">
            ↻ Refresh
          </button>
        )}
      </div>

      {/* Editor stays mounted (display:none) so toggling never destroys it. */}
      <div className="ms-compose-body" style={{ display: mode === 'manifest' ? 'block' : 'none' }}>
        {children}
      </div>

      {mode === 'preview' && (
        <iframe
          key={previewKey}
          className="ms-preview-frame"
          src={previewSrc}
          title={title ? `${title} — preview` : 'Manuscript preview'}
        />
      )}
    </div>
  );
}
