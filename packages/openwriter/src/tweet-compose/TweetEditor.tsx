/**
 * TweetEditor — lightweight single-tweet editor instance.
 * Wraps useEditor + EditorContent with per-tweet placeholder text.
 * Used by TweetComposeView to render each tweet in a thread.
 *
 * Images go to a preview grid below the editor (X API doesn't support
 * inline images in tweets). Preview grid shows 1-4 images with X-style
 * card layout.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import Placeholder from '@tiptap/extension-placeholder';
import { tweetExtensionsBase } from '../editor/extensions';
import { createPendingDecorationPlugin } from '../decorations/plugin';
import { createMarkDecorationPlugin } from '../decorations/marks-plugin';
import { handleImagePaste, handleImageDrop, setPreviewCallbacks } from '../editor/uploadImage';

interface TweetEditorProps {
  initialContent?: string;
  initialPreviewImages?: string[];
  placeholder?: string;
  onUpdate?: (editor: Editor) => void;
  onReady?: (editor: Editor) => void;
  onFocus?: () => void;
  onPreviewImagesChange?: (srcs: string[]) => void;
}

export default function TweetEditor({ initialContent, initialPreviewImages, placeholder = 'What is happening?!', onUpdate, onReady, onFocus, onPreviewImagesChange }: TweetEditorProps) {
  const [previewImages, setPreviewImages] = useState<string[]>(initialPreviewImages || []);
  const previewImagesRef = useRef<string[]>(initialPreviewImages || []);

  // Use refs for callbacks to avoid re-triggering effects when parent re-renders.
  // Parent passes inline arrow functions that change every render — refs break the loop.
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  const onPreviewChangeRef = useRef(onPreviewImagesChange);
  onPreviewChangeRef.current = onPreviewImagesChange;

  const updatePreviewImages = useCallback((newImages: string[]) => {
    const capped = newImages.slice(0, 4);
    previewImagesRef.current = capped;
    setPreviewImages(capped);
    onPreviewChangeRef.current?.(capped);
  }, []);

  const editor = useEditor({
    extensions: [
      ...tweetExtensionsBase,
      Placeholder.configure({ placeholder }),
    ],
    content: initialContent || '<p></p>',
    onUpdate: ({ editor }) => {
      onUpdate?.(editor);
    },
    onFocus: () => {
      onFocus?.();
    },
    editorProps: {
      handlePaste: handleImagePaste,
      handleDrop: handleImageDrop,
    },
  }, [initialContent]);

  // Register preview callbacks on the editor view so uploadImage.ts can add images
  useEffect(() => {
    if (!editor) return;
    setPreviewCallbacks(editor.view, {
      addToPreview: (src: string) => {
        const current = previewImagesRef.current;
        if (current.length >= 4) return;
        updatePreviewImages([...current, src]);
      },
      getPreviewImages: () => previewImagesRef.current,
    });
  }, [editor, updatePreviewImages]);

  // Register the pending decoration plugin (guard against double-add in React strict mode)
  useEffect(() => {
    if (!editor) return;
    const { state } = editor.view;
    if (state.plugins.some((p: any) => p.key === 'pendingDecoration$')) return;
    const plugin = createPendingDecorationPlugin();
    const newState = state.reconfigure({ plugins: [...state.plugins, plugin] });
    editor.view.updateState(newState);
  }, [editor]);

  // Register the mark decoration plugin (agent marks — dotted underlines)
  useEffect(() => {
    if (!editor) return;
    const { state } = editor.view;
    if (state.plugins.some((p: any) => p.key === 'markDecoration$')) return;
    const plugin = createMarkDecorationPlugin();
    const newState = state.reconfigure({ plugins: [...state.plugins, plugin] });
    editor.view.updateState(newState);
  }, [editor]);

  // Notify parent when editor is ready — use ref to avoid re-firing on every render
  useEffect(() => {
    if (editor) onReadyRef.current?.(editor);
  }, [editor]);

  const removePreviewImage = useCallback((index: number) => {
    updatePreviewImages(previewImagesRef.current.filter((_, i) => i !== index));
  }, [updatePreviewImages]);

  if (!editor) return null;

  return (
    <>
      <EditorContent editor={editor} />
      {previewImages.length > 0 && (
        <div className="tweet-preview-grid" data-count={previewImages.length}>
          {previewImages.map((src, i) => (
            <div key={src} className="tweet-image-card">
              <img className="tweet-image-card-img" src={src} alt="" draggable={false} />
              <button
                className="tweet-image-card-remove"
                onClick={() => removePreviewImage(i)}
                title="Remove image"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
