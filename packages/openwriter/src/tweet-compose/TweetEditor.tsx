/**
 * TweetEditor — lightweight single-tweet editor instance.
 * Wraps useEditor + EditorContent with per-tweet placeholder text.
 * Used by TweetComposeView to render each tweet in a thread.
 */

import { useEffect, useRef } from 'react';
import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import Placeholder from '@tiptap/extension-placeholder';
import { tweetExtensionsBase } from '../editor/extensions';
import { createPendingDecorationPlugin } from '../decorations/plugin';
import { createMarkDecorationPlugin } from '../decorations/marks-plugin';
import { handleImagePaste, handleImageDrop } from '../editor/uploadImage';

interface TweetEditorProps {
  initialContent?: string;
  placeholder?: string;
  onUpdate?: (editor: Editor) => void;
  onReady?: (editor: Editor) => void;
  onFocus?: () => void;
}

export default function TweetEditor({ initialContent, placeholder = 'What is happening?!', onUpdate, onReady, onFocus }: TweetEditorProps) {
  // Use refs for callbacks to avoid re-triggering effects when parent re-renders.
  // Parent passes inline arrow functions that change every render — refs break the loop.
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;

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

  if (!editor) return null;

  return <EditorContent editor={editor} />;
}
