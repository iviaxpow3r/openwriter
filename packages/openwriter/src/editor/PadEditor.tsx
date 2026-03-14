import { useEffect, useRef } from 'react';
import { EditorContent, useEditor, type Editor } from '@tiptap/react';

import { padExtensions } from './extensions';
import type { Extensions } from '@tiptap/react';
import FloatingToolbar from './FloatingToolbar';
import { createPendingDecorationPlugin, isPreviewActive } from '../decorations/plugin';
import { createMarkDecorationPlugin } from '../decorations/marks-plugin';
import { handleImagePaste, handleImageDrop } from './uploadImage';

interface PadEditorProps {
  initialContent?: any;
  extensions?: Extensions;
  onUpdate?: (json: any) => void;
  onReady?: (editor: Editor) => void;
  onLinkClick?: (filename: string) => void;
}

export default function PadEditor({ initialContent, extensions, onUpdate, onReady, onLinkClick }: PadEditorProps) {
  const onLinkClickRef = useRef(onLinkClick);
  onLinkClickRef.current = onLinkClick;

  const editor = useEditor({
    extensions: extensions || padExtensions,
    content: initialContent || '<p></p>',
    onUpdate: ({ editor }) => {
      if (isPreviewActive()) return; // Skip sync during original/modified preview
      onUpdate?.(editor.getJSON());
    },
    editorProps: {
      attributes: {
        class: 'tiptap',
      },
      handlePaste: handleImagePaste,
      handleDrop: handleImageDrop,
    },
  }, [initialContent]);

  // Intercept doc: link clicks directly on the DOM (bypasses ProseMirror event chain)
  useEffect(() => {
    if (!editor) return;
    const el = editor.view.dom;
    const handleClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      const link = target.closest('span.doc-link[data-doc]');
      if (!link) return;
      const filename = link.getAttribute('data-doc')!;
      onLinkClickRef.current?.(filename);
    };
    el.addEventListener('click', handleClick, true); // capture phase
    return () => el.removeEventListener('click', handleClick, true);
  }, [editor]);

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

  // Notify parent when editor is ready
  useEffect(() => {
    if (editor) onReady?.(editor);
  }, [editor, onReady]);

  if (!editor) return null;

  return (
    <>
      <EditorContent editor={editor} />
      <FloatingToolbar editor={editor} />
    </>
  );
}
