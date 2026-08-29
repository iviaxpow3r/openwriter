import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Editor } from '@tiptap/react';

import './format-toolbar.css';

function Btn({
  onClick,
  active,
  disabled,
  title,
  children,
}: {
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      className={`format-toolbar__btn${active ? ' active' : ''}${disabled ? ' disabled' : ''}`}
      onMouseDown={(e) => {
        e.preventDefault();
        onClick();
      }}
      disabled={disabled}
      title={title}
    >
      {children}
    </button>
  );
}

function Divider() {
  return <div className="format-toolbar__divider" />;
}

function OverflowBtn({
  onClick,
  active,
  children,
}: {
  onClick: () => void;
  active?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      className={`format-toolbar__overflow-action${active ? ' active' : ''}`}
      role="menuitem"
      onMouseDown={(event) => {
        event.preventDefault();
        onClick();
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        onClick();
      }}
    >
      {children}
    </button>
  );
}

async function uploadAndInsertImage(file: File, editor: Editor) {
  const form = new FormData();
  form.append('image', file);
  try {
    const res = await fetch('/api/upload-image', { method: 'POST', body: form });
    if (!res.ok) return;
    const { src } = await res.json();
    editor.chain().focus().setImage({ src, alt: file.name }).run();
  } catch {
    // upload failed silently
  }
}

export default function FormatToolbar({ editor }: { editor: Editor }) {
  const [, setTick] = useState(0);
  const [density, setDensity] = useState<'wide' | 'compact' | 'tight'>('wide');
  const [showOverflow, setShowOverflow] = useState(false);
  const [overflowPosition, setOverflowPosition] = useState<{ left: number; top: number } | null>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const overflowButtonRef = useRef<HTMLButtonElement>(null);
  const overflowMenuRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Re-render on editor transactions so active states update
  useEffect(() => {
    const onTransaction = () => setTick((n) => n + 1);
    editor.on('transaction', onTransaction);
    return () => { editor.off('transaction', onTransaction); };
  }, [editor]);

  // The toolbar responds to its actual column width, rather than the whole
  // app window. Opening either rail therefore never leaves controls clipped.
  useEffect(() => {
    const element = toolbarRef.current;
    if (!element) return;

    const updateDensity = (width: number) => {
      setDensity(width < 470 ? 'tight' : width < 760 ? 'compact' : 'wide');
    };
    const observer = new ResizeObserver((entries) => {
      updateDensity(entries[0]?.contentRect.width ?? element.clientWidth);
    });
    observer.observe(element);
    updateDensity(element.clientWidth);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!showOverflow) return;
    const closeWhenOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!overflowMenuRef.current?.contains(target) && !overflowButtonRef.current?.contains(target)) {
        setShowOverflow(false);
      }
    };
    const closeWithEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setShowOverflow(false);
      overflowButtonRef.current?.focus();
    };
    document.addEventListener('mousedown', closeWhenOutside);
    document.addEventListener('keydown', closeWithEscape);
    return () => {
      document.removeEventListener('mousedown', closeWhenOutside);
      document.removeEventListener('keydown', closeWithEscape);
    };
  }, [showOverflow]);

  const handleImageSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) uploadAndInsertImage(file, editor);
    e.target.value = '';
  };

  const hiddenGroups = density === 'wide'
    ? []
    : density === 'compact'
      ? ['marks', 'blocks', 'insert']
      : ['marks', 'lists', 'blocks', 'insert'];
  const hasHiddenActive = (
    (hiddenGroups.includes('marks') && (editor.isActive('highlight') || editor.isActive('subscript') || editor.isActive('superscript')))
    || (hiddenGroups.includes('lists') && (editor.isActive('bulletList') || editor.isActive('orderedList') || editor.isActive('taskList')))
    || (hiddenGroups.includes('blocks') && (editor.isActive('blockquote') || editor.isActive('codeBlock')))
  );

  const openOverflow = () => {
    const rect = overflowButtonRef.current?.getBoundingClientRect();
    if (!rect) return;
    const menuWidth = 236;
    setOverflowPosition({
      left: Math.max(8, Math.min(rect.right - menuWidth, window.innerWidth - menuWidth - 8)),
      top: Math.min(rect.bottom + 6, window.innerHeight - 300),
    });
    setShowOverflow((open) => !open);
  };

  const closeOverflowAfter = (action: () => void) => {
    action();
    setShowOverflow(false);
  };

  return (
    <div className="format-toolbar" ref={toolbarRef}>
      {/* Text Style */}
      <div className="format-toolbar__group">
        <Btn onClick={() => editor.chain().focus().toggleBold().run()} active={editor.isActive('bold')} title="Bold (Ctrl+B)">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M6 12h9a4 4 0 0 1 0 8H7a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h7a4 4 0 0 1 0 8" />
          </svg>
        </Btn>
        <Btn onClick={() => editor.chain().focus().toggleItalic().run()} active={editor.isActive('italic')} title="Italic (Ctrl+I)">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="19" x2="10" y1="4" y2="4" />
            <line x1="14" x2="5" y1="20" y2="20" />
            <line x1="15" x2="9" y1="4" y2="20" />
          </svg>
        </Btn>
        <Btn onClick={() => editor.chain().focus().toggleUnderline().run()} active={editor.isActive('underline')} title="Underline (Ctrl+U)">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M6 4v6a6 6 0 0 0 12 0V4" />
            <line x1="4" x2="20" y1="20" y2="20" />
          </svg>
        </Btn>
        <Btn onClick={() => editor.chain().focus().toggleStrike().run()} active={editor.isActive('strike')} title="Strikethrough">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M16 4H9a3 3 0 0 0-2.83 4" />
            <path d="M14 12a4 4 0 0 1 0 8H6" />
            <line x1="4" x2="20" y1="12" y2="12" />
          </svg>
        </Btn>
        <Btn onClick={() => editor.chain().focus().toggleCode().run()} active={editor.isActive('code')} title="Inline Code">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="m16 18 6-6-6-6" />
            <path d="m8 6-6 6 6 6" />
          </svg>
        </Btn>
      </div>

      {density === 'wide' && <Divider />}

      {/* Marks: highlight, sub, sup */}
      {density === 'wide' && <div className="format-toolbar__group">
        <Btn onClick={() => editor.chain().focus().toggleHighlight().run()} active={editor.isActive('highlight')} title="Highlight">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="m9 11-6 6v3h9l3-3" />
            <path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4" />
          </svg>
        </Btn>
        <Btn onClick={() => editor.chain().focus().toggleSubscript().run()} active={editor.isActive('subscript')} title="Subscript">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="m4 5 8 8" />
            <path d="m12 5-8 8" />
            <path d="M20 19h-4c0-1.5.44-2 1.5-2.5S20 15.33 20 14c0-.47-.17-.93-.48-1.29a2.11 2.11 0 0 0-2.62-.44c-.42.24-.74.62-.9 1.07" />
          </svg>
        </Btn>
        <Btn onClick={() => editor.chain().focus().toggleSuperscript().run()} active={editor.isActive('superscript')} title="Superscript">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="m4 19 8-8" />
            <path d="m12 19-8-8" />
            <path d="M20 12h-4c0-1.5.44-2 1.5-2.5S20 8.33 20 7c0-.47-.17-.93-.48-1.29a2.11 2.11 0 0 0-2.62-.44c-.42.24-.74.62-.9 1.07" />
          </svg>
        </Btn>
      </div>}

      <Divider />

      {/* Headings */}
      <div className="format-toolbar__group">
        <Btn onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()} active={editor.isActive('heading', { level: 1 })} title="Heading 1">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 12h8" />
            <path d="M4 18V6" />
            <path d="M12 18V6" />
            <path d="m17 12 3-2v8" />
          </svg>
        </Btn>
        <Btn onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()} active={editor.isActive('heading', { level: 2 })} title="Heading 2">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 12h8" />
            <path d="M4 18V6" />
            <path d="M12 18V6" />
            <path d="M21 18h-4c0-4 4-3 4-6 0-1.5-2-2.5-4-1" />
          </svg>
        </Btn>
        <Btn onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()} active={editor.isActive('heading', { level: 3 })} title="Heading 3">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 12h8" />
            <path d="M4 18V6" />
            <path d="M12 18V6" />
            <path d="M17.5 10.5c1.7-1 3.5 0 3.5 1.5a2 2 0 0 1-2 2" />
            <path d="M17 17.5c2 1.5 4 .3 4-1.5a2 2 0 0 0-2-2" />
          </svg>
        </Btn>
        <Btn onClick={() => editor.chain().focus().setParagraph().run()} active={editor.isActive('paragraph') && !editor.isActive('heading')} title="Paragraph">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M13 4v16" />
            <path d="M17 4v16" />
            <path d="M19 4H9.5a4.5 4.5 0 0 0 0 9H13" />
          </svg>
        </Btn>
      </div>

      {density !== 'tight' && <Divider />}

      {/* Lists */}
      {density !== 'tight' && <div className="format-toolbar__group">
        <Btn onClick={() => editor.chain().focus().toggleBulletList().run()} active={editor.isActive('bulletList')} title="Bullet List">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 12h.01" />
            <path d="M3 18h.01" />
            <path d="M3 6h.01" />
            <path d="M8 12h13" />
            <path d="M8 18h13" />
            <path d="M8 6h13" />
          </svg>
        </Btn>
        <Btn onClick={() => editor.chain().focus().toggleOrderedList().run()} active={editor.isActive('orderedList')} title="Ordered List">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M11 12h9" />
            <path d="M11 18h9" />
            <path d="M11 6h9" />
            <path d="M4 10V4h1" />
            <path d="M4 10h2" />
            <path d="M6 18H4c0-1 2-2 2-3s-1-1.5-2-1" />
          </svg>
        </Btn>
        <Btn onClick={() => editor.chain().focus().toggleTaskList().run()} active={editor.isActive('taskList')} title="Task List">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="m3 17 2 2 4-4" />
            <path d="m3 7 2 2 4-4" />
            <path d="M13 6h8" />
            <path d="M13 12h8" />
            <path d="M13 18h8" />
          </svg>
        </Btn>
      </div>}

      {density === 'wide' && <Divider />}

      {/* Link */}
      <div className="format-toolbar__group">
        <Btn
          onClick={() => {
            const existing = editor.getAttributes('link').href || '';
            const url = window.prompt('Link URL:', existing);
            if (url === null) return;
            if (url === '') {
              editor.chain().focus().unsetLink().run();
            } else {
              editor.chain().focus().setLink({ href: url }).run();
            }
          }}
          active={editor.isActive('link')}
          title="Link (Ctrl+K)"
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
            <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
          </svg>
        </Btn>
      </div>

      {density === 'wide' && <Divider />}

      {/* Blocks */}
      {density === 'wide' && <div className="format-toolbar__group">
        <Btn onClick={() => editor.chain().focus().toggleBlockquote().run()} active={editor.isActive('blockquote')} title="Blockquote">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M17 6H3" />
            <path d="M21 12H8" />
            <path d="M21 18H8" />
            <path d="M3 12v6" />
          </svg>
        </Btn>
        <Btn onClick={() => editor.chain().focus().toggleCodeBlock().run()} active={editor.isActive('codeBlock')} title="Code Block">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect width="18" height="18" x="3" y="3" rx="2" />
            <path d="m10 9-3 3 3 3" />
            <path d="m14 15 3-3-3-3" />
          </svg>
        </Btn>
        <Btn onClick={() => editor.chain().focus().setHorizontalRule().run()} title="Horizontal Rule">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M5 12h14" />
          </svg>
        </Btn>
      </div>}

      {density === 'wide' && <Divider />}

      {/* Insert */}
      {density === 'wide' && <div className="format-toolbar__group">
        <Btn onClick={() => fileInputRef.current?.click()} title="Insert Image">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect width="18" height="18" x="3" y="3" rx="2" ry="2" />
            <circle cx="9" cy="9" r="2" />
            <path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" />
          </svg>
        </Btn>
        <Btn onClick={() => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()} title="Insert Table">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect width="18" height="18" x="3" y="3" rx="2" />
            <path d="M12 3v18" />
            <path d="M3 9h18" />
            <path d="M3 15h18" />
          </svg>
        </Btn>
      </div>}

      {hiddenGroups.length > 0 && <>
        <Divider />
        <button
          ref={overflowButtonRef}
          className={`format-toolbar__more${hasHiddenActive ? ' active' : ''}`}
          type="button"
          aria-label="More formatting"
          aria-expanded={showOverflow}
          aria-haspopup="menu"
          title="More formatting"
          onClick={openOverflow}
        >
          <span aria-hidden="true">•••</span>
        </button>
      </>}

      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        className="format-toolbar__file-input"
        onChange={handleImageSelect}
      />

      {showOverflow && overflowPosition && createPortal(
        <div
          ref={overflowMenuRef}
          className="format-toolbar__overflow-menu"
          style={overflowPosition}
          role="menu"
          aria-label="More formatting"
        >
          <span className="format-toolbar__overflow-title">More formatting</span>

          {hiddenGroups.includes('marks') && <section className="format-toolbar__overflow-group">
            <span>Text marks</span>
            <OverflowBtn onClick={() => closeOverflowAfter(() => editor.chain().focus().toggleHighlight().run())} active={editor.isActive('highlight')}>Highlight</OverflowBtn>
            <OverflowBtn onClick={() => closeOverflowAfter(() => editor.chain().focus().toggleSubscript().run())} active={editor.isActive('subscript')}>Subscript</OverflowBtn>
            <OverflowBtn onClick={() => closeOverflowAfter(() => editor.chain().focus().toggleSuperscript().run())} active={editor.isActive('superscript')}>Superscript</OverflowBtn>
          </section>}

          {hiddenGroups.includes('lists') && <section className="format-toolbar__overflow-group">
            <span>Lists</span>
            <OverflowBtn onClick={() => closeOverflowAfter(() => editor.chain().focus().toggleBulletList().run())} active={editor.isActive('bulletList')}>Bullet list</OverflowBtn>
            <OverflowBtn onClick={() => closeOverflowAfter(() => editor.chain().focus().toggleOrderedList().run())} active={editor.isActive('orderedList')}>Numbered list</OverflowBtn>
            <OverflowBtn onClick={() => closeOverflowAfter(() => editor.chain().focus().toggleTaskList().run())} active={editor.isActive('taskList')}>Task list</OverflowBtn>
          </section>}

          {hiddenGroups.includes('blocks') && <section className="format-toolbar__overflow-group">
            <span>Blocks</span>
            <OverflowBtn onClick={() => closeOverflowAfter(() => editor.chain().focus().toggleBlockquote().run())} active={editor.isActive('blockquote')}>Blockquote</OverflowBtn>
            <OverflowBtn onClick={() => closeOverflowAfter(() => editor.chain().focus().toggleCodeBlock().run())} active={editor.isActive('codeBlock')}>Code block</OverflowBtn>
            <OverflowBtn onClick={() => closeOverflowAfter(() => editor.chain().focus().setHorizontalRule().run())}>Horizontal rule</OverflowBtn>
          </section>}

          {hiddenGroups.includes('insert') && <section className="format-toolbar__overflow-group">
            <span>Insert</span>
            <OverflowBtn onClick={() => closeOverflowAfter(() => fileInputRef.current?.click())}>Image</OverflowBtn>
            <OverflowBtn onClick={() => closeOverflowAfter(() => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run())}>Table</OverflowBtn>
          </section>}
        </div>,
        document.body,
      )}
    </div>
  );
}
