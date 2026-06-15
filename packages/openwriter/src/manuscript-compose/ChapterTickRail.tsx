/**
 * Chapter tick-rail — a Substack-style vertical navigator on the left edge of
 * the manuscript preview. One tick per chapter (top-level h1 in the compiled
 * book), the current chapter highlighted as you scroll, hover reveals the title,
 * click jumps the preview to that chapter.
 *
 * The preview iframe is SAME-ORIGIN, so this parent component reads the book's
 * headings straight from `iframe.contentDocument` and drives `contentWindow`
 * scroll — no postMessage bridge, no anchors required (the {{toc}} anchors are a
 * separate, in-page concern). Re-binds whenever the iframe reloads (previewKey).
 *
 * adr: adr/manuscript-engine.md
 */
import { useEffect, useRef, useState } from 'react';
import './ChapterTickRail.css';

interface Props {
  iframeRef: React.RefObject<HTMLIFrameElement | null>;
  /** Bumps when the iframe reloads (style/theme/refresh) — re-read the book. */
  previewKey: number;
}

export default function ChapterTickRail({ iframeRef, previewKey }: Props) {
  const [titles, setTitles] = useState<string[]>([]);
  const [active, setActive] = useState(0);
  // Live heading ELEMENTS from the iframe — never cache pixel offsets (they
  // shift as the book's web fonts load). Read positions on demand instead.
  const headingsRef = useRef<HTMLElement[]>([]);

  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;
    let win: Window | null = null;
    let onScroll: (() => void) | null = null;

    const wire = (): boolean => {
      try {
        const doc = iframe.contentDocument;
        win = iframe.contentWindow;
        if (!doc || !win) return false;
        const hs = Array.from(
          doc.querySelectorAll<HTMLElement>('.book-page > h1:not(.book-title)'),
        );
        if (hs.length === 0) return false;
        headingsRef.current = hs;
        setTitles(hs.map((h) => (h.textContent || '').trim()));
        onScroll = () => {
          // Re-query live each tick — the captured nodes can detach across a
          // reload, and live rects track font reflow / theme changes.
          const live = win?.document.querySelectorAll<HTMLElement>('.book-page > h1:not(.book-title)');
          if (!live || live.length === 0) return;
          let idx = 0;
          for (let i = 0; i < live.length; i++) {
            if (live[i].getBoundingClientRect().top <= 80) idx = i;
            else break;
          }
          setActive(idx);
        };
        win.addEventListener('scroll', onScroll, { passive: true });
        onScroll();
        return true;
      } catch {
        return false; // cross-origin (shouldn't happen) or not ready yet
      }
    };

    // The iframe may not have loaded yet — bind on load and poll briefly in case
    // load already fired (style toggles reuse a warm frame).
    const onLoad = () => wire();
    iframe.addEventListener('load', onLoad);
    let tries = 0;
    const poll = window.setInterval(() => {
      if (wire() || ++tries > 25) window.clearInterval(poll);
    }, 150);

    return () => {
      iframe.removeEventListener('load', onLoad);
      window.clearInterval(poll);
      if (win && onScroll) win.removeEventListener('scroll', onScroll);
    };
  }, [iframeRef, previewKey]);

  const jump = (i: number) => {
    // Re-query the LIVE iframe at click time — never trust a cached element ref,
    // which can be detached if the frame reloaded since it was read.
    const doc = iframeRef.current?.contentDocument;
    const win = iframeRef.current?.contentWindow;
    if (!doc || !win) return;
    const hs = doc.querySelectorAll<HTMLElement>('.book-page > h1:not(.book-title)');
    const el = hs[i];
    if (!el) return;
    // NB: behavior:'smooth' silently no-ops for a programmatic cross-frame
    // scroll in Chrome — use an instant jump (positional form is the reliable one).
    win.scrollTo(0, Math.max(0, el.getBoundingClientRect().top + win.scrollY - 8));
    // A programmatic scroll doesn't reliably fire the 'scroll' event, so set the
    // active tick directly. Manual scrolling still updates it via the listener.
    setActive(i);
  };

  // A single-chapter book doesn't need a navigator.
  if (titles.length < 2) return null;

  return (
    <nav className="ch-tickrail" aria-label="Chapters">
      {titles.map((t, i) => (
        <button
          key={i}
          type="button"
          className={`ch-tick${i === active ? ' ch-tick--active' : ''}`}
          onClick={() => jump(i)}
          title={t}
          aria-current={i === active ? 'true' : undefined}
        >
          <span className="ch-tick__line" />
          <span className="ch-tick__label">{t}</span>
        </button>
      ))}
    </nav>
  );
}
