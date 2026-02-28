/**
 * TweetEditor — lightweight single-tweet editor instance.
 * Wraps useEditor + EditorContent with per-tweet placeholder text.
 * Used by TweetComposeView to render each tweet in a thread.
 */

import { useEffect } from 'react';
import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import Placeholder from '@tiptap/extension-placeholder';
import { tweetExtensionsBase } from '../editor/extensions';
import { createPendingDecorationPlugin } from '../decorations/plugin';

interface TweetEditorProps {
  initialContent?: string;
  placeholder?: string;
  onUpdate?: (editor: Editor) => void;
  onReady?: (editor: Editor) => void;
  onFocus?: () => void;
}

export default function TweetEditor({ initialContent, placeholder = 'What is happening?!', onUpdate, onReady, onFocus }: TweetEditorProps) {
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

  useEffect(() => {
    if (editor) onReady?.(editor);
  }, [editor, onReady]);

  if (!editor) return null;

  return <EditorContent editor={editor} />;
}
