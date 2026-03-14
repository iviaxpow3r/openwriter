import { useCallback, useRef, useState } from 'react';
import type { Editor } from '@tiptap/react';

type CopyState = 'idle' | 'copied';

/**
 * Extract clean plain text from a TipTap editor's DOM.
 * Walks paragraph children, preserves hardBreaks as \n within paragraphs,
 * joins paragraphs with \n\n. Avoids TipTap's getText() which adds
 * extra newlines at paragraph boundaries.
 */
function extractCleanText(editor: Editor): string {
  const el = editor.view.dom as HTMLElement;
  const blocks: string[] = [];
  for (const child of el.children) {
    const text = (child as HTMLElement).innerText?.trim();
    if (text) blocks.push(text);
  }
  return blocks.join('\n\n');
}

/** Walk editor JSON and return the first image src (if any) */
function extractFirstImageSrc(editor: Editor): string | null {
  const walk = (node: any): string | null => {
    if (node.type === 'image' && node.attrs?.src) return node.attrs.src;
    if (node.content) {
      for (const child of node.content) {
        const found = walk(child);
        if (found) return found;
      }
    }
    return null;
  };
  return walk(editor.getJSON());
}

/** Fetch an image URL and return it as a PNG blob (Clipboard API requires PNG) */
async function fetchAsPngBlob(src: string): Promise<Blob | null> {
  try {
    const res = await fetch(src);
    if (!res.ok) return null;
    const blob = await res.blob();
    if (blob.type === 'image/png') return blob;
    // Convert non-PNG to PNG via canvas
    return new Promise((resolve) => {
      const img = new Image();
      const url = URL.createObjectURL(blob);
      img.onload = () => {
        const c = document.createElement('canvas');
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        c.getContext('2d')!.drawImage(img, 0, 0);
        c.toBlob((b) => { URL.revokeObjectURL(url); resolve(b); }, 'image/png');
      };
      img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
      img.src = url;
    });
  } catch {
    return null;
  }
}

/**
 * Hook for copying the active tweet's content (text + image) to clipboard.
 * Uses Clipboard API write() for text+image, falls back to writeText() for text-only.
 */
export function useTweetCopy(
  editorsRef: React.MutableRefObject<(Editor | null)[]>,
  activeIndex: number,
) {
  const [copyState, setCopyState] = useState<CopyState>('idle');
  const timer = useRef<ReturnType<typeof setTimeout>>();

  const copyText = useCallback(async () => {
    const editor = editorsRef.current[activeIndex];
    if (!editor) return;

    const text = extractCleanText(editor);
    const imageSrc = extractFirstImageSrc(editor);

    if (!text && !imageSrc) return;

    try {
      const items: Record<string, Blob> = {};
      if (text) items['text/plain'] = new Blob([text], { type: 'text/plain' });
      if (imageSrc) {
        const imageBlob = await fetchAsPngBlob(imageSrc);
        if (imageBlob) items['image/png'] = imageBlob;
      }
      if (Object.keys(items).length > 0) {
        await navigator.clipboard.write([new ClipboardItem(items)]);
      }
    } catch {
      // Fallback: text-only copy
      if (text) {
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
      }
    }

    setCopyState('copied');
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopyState('idle'), 2000);
  }, [editorsRef, activeIndex]);

  return { copyText, copyState };
}
