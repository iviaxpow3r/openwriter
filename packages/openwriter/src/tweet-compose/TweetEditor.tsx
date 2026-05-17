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
import { createCommentDecorationPlugin } from '../decorations/comments-plugin';
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
  // Guard flag: prevents infinite loop when removing images triggers onUpdate
  const isExtractingImagesRef = useRef(false);

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

  /**
   * Extract image nodes from editor content and move them to the preview grid.
   * In tweet mode, images are always displayed in the preview grid below the
   * editor, never inline. This handles images inserted via MCP (write_to_pad,
   * insert_image) which arrive as inline ProseMirror nodes.
   */
  const extractInlineImages = useCallback((editor: Editor) => {
    if (isExtractingImagesRef.current) return;
    const imageSrcs: string[] = [];
    const removePositions: { from: number; to: number }[] = [];
    editor.state.doc.descendants((node, pos) => {
      if (node.type.name === 'image' && node.attrs?.src) {
        imageSrcs.push(node.attrs.src);
        removePositions.push({ from: pos, to: pos + node.nodeSize });
      }
    });
    if (imageSrcs.length === 0) return;
    isExtractingImagesRef.current = true;
    // Remove image nodes from editor (iterate in reverse to preserve positions)
    const { tr } = editor.state;
    for (let i = removePositions.length - 1; i >= 0; i--) {
      tr.delete(removePositions[i].from, removePositions[i].to);
    }
    editor.view.dispatch(tr);
    // Add extracted images to preview grid (respecting 4-image X limit)
    const current = previewImagesRef.current;
    const available = 4 - current.length;
    if (available > 0) {
      updatePreviewImages([...current, ...imageSrcs.slice(0, available)]);
    }
    isExtractingImagesRef.current = false;
  }, [updatePreviewImages]);

  const editor = useEditor({
    extensions: [
      ...tweetExtensionsBase,
      Placeholder.configure({ placeholder }),
    ],
    content: initialContent || '<p></p>',
    onCreate: ({ editor }) => {
      // On editor creation, extract any inline image nodes that were part of the
      // initial content (e.g. MCP-inserted images inside paragraphs that
      // extractPreviewImagesFromPart didn't catch because it only handles
      // trailing block-level images).
      extractInlineImages(editor);
    },
    onUpdate: ({ editor }) => {
      // Detect image nodes inserted into editor content (e.g. via MCP write_to_pad)
      // and move them to the preview grid. In tweet mode, images are always in the
      // preview grid, never inline in the editor.
      extractInlineImages(editor);
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

  // Register the comment decoration plugin (dotted underlines)
  useEffect(() => {
    if (!editor) return;
    const { state } = editor.view;
    if (state.plugins.some((p: any) => p.key === 'commentDecoration$')) return;
    const plugin = createCommentDecorationPlugin();
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
