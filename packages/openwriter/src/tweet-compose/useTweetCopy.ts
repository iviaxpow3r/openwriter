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

/**
 * Hook for copying the active tweet's plain text to clipboard.
 * X's web composer accepts plain text — no HTML needed.
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
    if (!text) return;

    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Legacy fallback
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
    }

    setCopyState('copied');
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopyState('idle'), 2000);
  }, [editorsRef, activeIndex]);

  return { copyText, copyState };
}
