/**
 * TweetEditor — lightweight single-tweet editor instance.
 * Wraps useEditor + EditorContent with per-tweet placeholder text.
 * Used by TweetComposeView to render each tweet in a thread.
 */

import { useEffect } from 'react';
import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import Placeholder from '@tiptap/extension-placeholder';
import { tweetExtensionsBase } from '../editor/extensions';

interface TweetEditorProps {
  initialContent?: string;
  placeholder?: string;
  onUpdate?: (editor: Editor) => void;
  onReady?: (editor: Editor) => void;
}

export default function TweetEditor({ initialContent, placeholder = 'What is happening?!', onUpdate, onReady }: TweetEditorProps) {
  const editor = useEditor({
    extensions: [
      ...tweetExtensionsBase,
      Placeholder.configure({ placeholder }),
    ],
    content: initialContent || '<p></p>',
    onUpdate: ({ editor }) => {
      onUpdate?.(editor);
    },
  }, [initialContent]);

  useEffect(() => {
    if (editor) onReady?.(editor);
  }, [editor, onReady]);

  if (!editor) return null;

  return <EditorContent editor={editor} />;
}
