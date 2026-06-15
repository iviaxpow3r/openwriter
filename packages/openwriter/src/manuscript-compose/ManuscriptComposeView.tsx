/**
 * Manuscript compose view — the main-canvas surface for a manuscript doc.
 *
 * The body is the manifest itself (ordered `doc:` pointers + headings), edited
 * in the normal PadEditor. The canvas has NO chrome of its own: it shows either
 * the manifest editor or the compiled Preview iframe, driven entirely by the
 * right rail's "This Manuscript" section (rail = controls, canvas = surface).
 * The preview is the real compile() → render() output (GET /api/manuscript/
 * preview) — the same path EPUB export uses — so it never disagrees with the
 * shipped book.
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

  // The rail drives the view. Preview also bumps previewKey so a re-click of
  // Preview re-renders the compiled book (acts as a refresh).
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
