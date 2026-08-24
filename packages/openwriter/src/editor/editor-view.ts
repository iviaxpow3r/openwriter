/**
 * Tiptap creates an Editor before EditorContent attaches its ProseMirror view.
 * React effects may run during that short interval on a cold WKWebView load,
 * and touching `editor.view` then throws instead of returning undefined.
 */
import type { Editor } from '@tiptap/react';

export function getMountedEditorView(editor: Editor | null | undefined): any | null {
  if (!editor || editor.isDestroyed) return null;
  try {
    const view = editor.view;
    return view?.dom ? view : null;
  } catch {
    return null;
  }
}

/** Retry a mount-bound setup until ProseMirror is available, then clean up. */
export function whenEditorViewReady(editor: Editor | null | undefined, attach: (view: any) => void | (() => void)): () => void {
  let cancelled = false;
  let cleanup: void | (() => void);
  let timer: number | undefined;
  const attempt = () => {
    if (cancelled) return;
    const view = getMountedEditorView(editor);
    if (!view) {
      timer = window.setTimeout(attempt, 16);
      return;
    }
    cleanup = attach(view);
  };
  attempt();
  return () => {
    cancelled = true;
    if (timer !== undefined) window.clearTimeout(timer);
    cleanup?.();
  };
}
