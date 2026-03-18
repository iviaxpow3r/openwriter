/**
 * Shared image upload helper — used exclusively by TweetEditor.
 * Uploads a File to /api/upload-image and routes the result:
 * - If preview grid exists or cursor is adjacent to an inline image → preview grid
 * - Otherwise → inline ProseMirror node
 *
 * Preview callbacks are registered per EditorView via setPreviewCallbacks().
 */

import { TextSelection } from '@tiptap/pm/state';

interface PreviewCallbacks {
  addToPreview: (src: string) => void;
  getPreviewImages: () => string[];
  moveInlineToPreview: () => void;
}

const previewCallbackMap = new WeakMap<any, PreviewCallbacks>();

/** Register preview grid callbacks for a given EditorView */
export function setPreviewCallbacks(view: any, callbacks: PreviewCallbacks) {
  previewCallbackMap.set(view, callbacks);
}

/** Count inline image nodes in the editor state */
function countInlineImages(state: any): number {
  let count = 0;
  state.doc.descendants((node: any) => {
    if (node.type.name === 'image') count++;
  });
  return count;
}

/** Check if cursor is adjacent to an image (only empty paragraphs between) */
function isAdjacentToImage(state: any): boolean {
  const { doc, selection } = state;
  const { $from } = selection;
  const cursorIndex = $from.index(0);

  // Walk backward through top-level nodes
  for (let i = cursorIndex - 1; i >= 0; i--) {
    const node = doc.child(i);
    if (node.type.name === 'image') return true;
    if (node.type.name === 'paragraph' && node.textContent === '') continue;
    break;
  }

  // Walk forward through top-level nodes
  for (let i = cursorIndex + 1; i < doc.childCount; i++) {
    const node = doc.child(i);
    if (node.type.name === 'image') return true;
    if (node.type.name === 'paragraph' && node.textContent === '') continue;
    break;
  }

  return false;
}

/** Upload a file and insert via ProseMirror view (for paste/drop handlers) */
export async function uploadAndInsertImageView(file: File, view: any) {
  const form = new FormData();
  form.append('image', file);
  try {
    const res = await fetch('/api/upload-image', { method: 'POST', body: form });
    if (!res.ok) return;
    const { src } = await res.json();

    const callbacks = previewCallbackMap.get(view);
    if (callbacks) {
      const previewImages = callbacks.getPreviewImages();
      const inlineCount = countInlineImages(view.state);
      const totalImages = inlineCount + previewImages.length;

      // Route to preview if: preview already has images, or cursor is adjacent to an inline image
      if (previewImages.length > 0 || (inlineCount > 0 && isAdjacentToImage(view.state))) {
        if (totalImages >= 4) return; // X limit
        if (inlineCount > 0) callbacks.moveInlineToPreview();
        callbacks.addToPreview(src);
        return;
      }
    }

    // Default: insert inline
    const { state } = view;
    const imageNode = state.schema.nodes.image.create({ src, alt: file.name });

    let lastImageEnd = -1;
    state.doc.descendants((node: any, pos: number) => {
      if (node.type.name === 'image') lastImageEnd = pos + node.nodeSize;
    });

    let tr;
    if (lastImageEnd >= 0) {
      tr = state.tr.insert(lastImageEnd, imageNode);
    } else {
      tr = state.tr.replaceSelectionWith(imageNode);
    }

    // Move cursor after the last image so next paste appends
    try {
      let endPos = 0;
      tr.doc.descendants((node: any, pos: number) => {
        if (node.type.name === 'image') endPos = pos + node.nodeSize;
      });
      if (endPos > 0) {
        const $after = tr.doc.resolve(endPos);
        tr.setSelection(TextSelection.near($after, 1));
      }
    } catch { /* leave selection as-is */ }

    view.dispatch(tr);
  } catch {
    // upload failed silently
  }
}

/** Paste handler — intercepts image clipboard data */
export function handleImagePaste(view: any, event: ClipboardEvent): boolean {
  const items = event.clipboardData?.items;
  if (!items) return false;
  for (const item of items) {
    if (item.type.startsWith('image/')) {
      event.preventDefault();
      const file = item.getAsFile();
      if (file) uploadAndInsertImageView(file, view);
      return true;
    }
  }
  return false;
}

/** Drop handler — intercepts image file drops */
export function handleImageDrop(view: any, event: DragEvent): boolean {
  const files = event.dataTransfer?.files;
  if (!files?.length) return false;
  for (const file of files) {
    if (file.type.startsWith('image/')) {
      event.preventDefault();
      uploadAndInsertImageView(file, view);
      return true;
    }
  }
  return false;
}
