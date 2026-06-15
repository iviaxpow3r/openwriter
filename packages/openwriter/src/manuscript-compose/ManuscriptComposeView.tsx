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
import { type ReactNode, useEffect, useRef, useState } from 'react';
import './ManuscriptComposeView.css';
import ChapterTickRail from './ChapterTickRail';

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

function readAppMode(): 'light' | 'dark' {
  return document.documentElement.getAttribute('data-mode') === 'dark' ? 'dark' : 'light';
}

export default function ManuscriptComposeView({ children, docId, filename, title }: ManuscriptComposeViewProps) {
  const [mode, setMode] = useState<'manifest' | 'preview'>('manifest');
  const [previewKey, setPreviewKey] = useState(0);
  // The preview's screen light/dark follows the app's Appearance setting
  // (data-mode on <html>), so the book preview sits in the app's theme rather
  // than an OS-driven palette. Re-render the iframe when the user toggles it.
  const [appMode, setAppMode] = useState<'light' | 'dark'>(readAppMode);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    const obs = new MutationObserver(() => {
      setAppMode((prev) => {
        const next = readAppMode();
        if (next !== prev) setPreviewKey((k) => k + 1);
        return next;
      });
    });
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-mode'] });
    return () => obs.disconnect();
  }, []);

  // Back to the manifest editor whenever the active doc changes.
  useEffect(() => { setMode('manifest'); }, [filename]);

  // The rail drives the view. Preview also bumps previewKey so a re-click of
  // Preview re-renders the compiled book (acts as a refresh).
  const modeRef = useRef(mode);
  useEffect(() => { modeRef.current = mode; }, [mode]);
  useEffect(() => {
    const showPreview = () => { setMode('preview'); setPreviewKey((k) => k + 1); };
    const showManifest = () => setMode('manifest');
    // A style/setting change: reload the iframe ONLY if we're already showing
    // the preview. The compose view owns its mode, so this never desyncs with
    // the rail's local toggle state. adr: adr/manuscript-engine.md
    const restyle = () => { if (modeRef.current === 'preview') setPreviewKey((k) => k + 1); };
    window.addEventListener('ow-manuscript-preview', showPreview);
    window.addEventListener('ow-manuscript-manifest', showManifest);
    window.addEventListener('ow-manuscript-restyle', restyle);
    return () => {
      window.removeEventListener('ow-manuscript-preview', showPreview);
      window.removeEventListener('ow-manuscript-manifest', showManifest);
      window.removeEventListener('ow-manuscript-restyle', restyle);
    };
  }, []);

  const previewSrc = docId
    ? `/api/manuscript/preview?docId=${encodeURIComponent(docId)}&mode=${appMode}&v=${previewKey}`
    : 'about:blank';

  return (
    <div className="ms-compose">
      {/* Editor stays mounted (display:none) so toggling never destroys it. */}
      <div className="ms-compose-body" style={{ display: mode === 'manifest' ? 'block' : 'none' }}>
        {children}
      </div>
      {mode === 'preview' && (
        <>
          <iframe
            key={previewKey}
            ref={iframeRef}
            className="ms-preview-frame"
            src={previewSrc}
            title={title ? `${title} — preview` : 'Manuscript preview'}
          />
          <ChapterTickRail iframeRef={iframeRef} previewKey={previewKey} />
        </>
      )}
    </div>
  );
}
