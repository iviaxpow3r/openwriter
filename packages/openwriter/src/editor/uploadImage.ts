/**
 * Shared image upload helper.
 * Uploads a File to /api/upload-image and inserts the resulting image node.
 */

/** Upload a file and insert via ProseMirror view (for paste/drop handlers) */
export async function uploadAndInsertImageView(file: File, view: any) {
  const form = new FormData();
  form.append('image', file);
  try {
    const res = await fetch('/api/upload-image', { method: 'POST', body: form });
    if (!res.ok) return;
    const { src } = await res.json();
    const { state } = view;
    const node = state.schema.nodes.image.create({ src, alt: file.name });
    const tr = state.tr.replaceSelectionWith(node);
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
