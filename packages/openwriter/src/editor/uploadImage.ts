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

/** Download an external image URL through the server and add to preview */
async function downloadAndInsertImage(url: string, view: any) {
  try {
    const res = await fetch('/api/download-image', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    if (!res.ok) return;
    const { src } = await res.json();

    const callbacks = previewCallbackMap.get(view);
    if (!callbacks) return;
    if (callbacks.getPreviewImages().length >= 4) return;
    callbacks.addToPreview(src);
  } catch {
    // download failed silently
  }
}

/** Extract image URLs from an HTML string */
function extractImageUrls(html: string): string[] {
  const urls: string[] = [];
  const regex = /<img[^>]+src=["']([^"']+)["']/gi;
  let match;
  while ((match = regex.exec(html)) !== null) {
    const url = match[1];
    if (url.startsWith('http://') || url.startsWith('https://')) {
      urls.push(url);
    }
  }
  return urls;
}

/** Paste handler — intercepts image clipboard data */
export function handleImagePaste(view: any, event: ClipboardEvent): boolean {
  const items = event.clipboardData?.items;
  if (!items) return false;

  // Check for image file blobs first
  for (const item of items) {
    if (item.type.startsWith('image/')) {
      event.preventDefault();
      const file = item.getAsFile();
      if (file) uploadAndInsertImageView(file, view);
      return true;
    }
  }

  // Check for HTML with image URLs (e.g. copy-paste from Google)
  const html = event.clipboardData?.getData('text/html');
  if (html) {
    const urls = extractImageUrls(html);
    if (urls.length > 0) {
      event.preventDefault();
      for (const url of urls) {
        downloadAndInsertImage(url, view);
      }
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
