import { useEffect, useRef } from 'react';
import { EditorContent, useEditor, type Editor } from '@tiptap/react';

import { padExtensions } from './extensions';
import type { Extensions } from '@tiptap/react';
import FloatingToolbar from './FloatingToolbar';
import { createPendingDecorationPlugin, isPreviewActive } from '../decorations/plugin';
import { createMarkDecorationPlugin } from '../decorations/marks-plugin';
import { createBacklinkDecorationPlugin } from '../decorations/backlinks-plugin';
import { handleImagePaste, handleImageDrop } from './uploadImage';
import { parseLinkHref, type ParsedLinkHref } from './link-href';

interface PadEditorProps {
  initialContent?: any;
  extensions?: Extensions;
  onUpdate?: (json: any) => void;
  onReady?: (editor: Editor) => void;
  onLinkClick?: (target: ParsedLinkHref) => void;
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

  // Intercept link clicks directly on the DOM (bypasses ProseMirror event chain).
  // Internal doc: links route to onLinkClick; external http/https/mailto open in
  // a new tab. PadLink is configured with openOnClick:false so TipTap won't do it.
  useEffect(() => {
    if (!editor) return;
    const el = editor.view.dom;
    const handleClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      // Internal doc: link
      const docLink = target.closest('span.doc-link[data-doc]');
      if (docLink) {
        const dataDoc = docLink.getAttribute('data-doc')!;
        // data-doc is everything after `doc:` — re-parse via the canonical helper.
        const parsed = parseLinkHref(`doc:${dataDoc}`);
        if (!parsed) return;
        onLinkClickRef.current?.(parsed);
        return;
      }
      // External link — open in new tab. Skip Cmd/Ctrl/middle clicks; the
      // browser handles those itself (and cmd-click already opens in new tab).
      const anchor = target.closest('a[href]') as HTMLAnchorElement | null;
      if (!anchor) return;
      const href = anchor.getAttribute('href') || '';
      // Only open links whose protocol the browser can navigate to
      if (!/^(https?:|mailto:|tel:)/i.test(href)) return;
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
      e.preventDefault();
      window.open(href, '_blank', 'noopener,noreferrer');
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

  // Register the backlink decoration plugin (dotted underline on linked paragraphs)
  useEffect(() => {
    if (!editor) return;
    const { state } = editor.view;
    if (state.plugins.some((p: any) => p.key === 'backlinkDecoration$')) return;
    const plugin = createBacklinkDecorationPlugin();
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
