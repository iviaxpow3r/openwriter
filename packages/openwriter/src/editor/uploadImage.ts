/**
 * Shared image upload helper — used exclusively by TweetEditor.
 * Uploads a File to /api/upload-image and adds to the preview grid.
 * All images route to preview (X API doesn't support inline images in tweets).
 *
 * Preview callbacks are registered per EditorView via setPreviewCallbacks().
 */

interface PreviewCallbacks {
  addToPreview: (src: string) => void;
  getPreviewImages: () => string[];
}

const previewCallbackMap = new WeakMap<any, PreviewCallbacks>();

/** Register preview grid callbacks for a given EditorView */
export function setPreviewCallbacks(view: any, callbacks: PreviewCallbacks) {
  previewCallbackMap.set(view, callbacks);
}

/** Upload a file and add to the preview grid */
export async function uploadAndInsertImageView(file: File, view: any) {
  const form = new FormData();
  form.append('image', file);
  try {
    const res = await fetch('/api/upload-image', { method: 'POST', body: form });
    if (!res.ok) return;
    const { src } = await res.json();

    const callbacks = previewCallbackMap.get(view);
    if (!callbacks) return;

    if (callbacks.getPreviewImages().length >= 4) return; // X limit
    callbacks.addToPreview(src);
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
