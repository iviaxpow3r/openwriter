/**
 * Footnote node extensions for TipTap.
 *
 * Three nodes:
 *   - footnoteReference: inline atom rendered as a superscript chip with the
 *     author-written label (`[^N]` on disk). CSS counter assigns the visible
 *     display number, so author-written mnemonic labels stay clean.
 *   - footnoteSection: block container holding all footnote definitions for
 *     a doc. Always emitted at end-of-doc by the serializer regardless of
 *     where it appears in the tree.
 *   - footnoteDefinition: block container for one footnote's content
 *     (typically a single paragraph). Carries the label attr that pairs
 *     it with one or more references in the prose.
 *
 * adr: adr/footnote-system.md
 */

import { Node, mergeAttributes, type Editor } from '@tiptap/core';
import { TextSelection } from 'prosemirror-state';

export const FootnoteReference = Node.create({
  name: 'footnoteReference',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  draggable: false,

  addAttributes() {
    return {
      label: {
        default: '',
        parseHTML: (el) => (el as HTMLElement).getAttribute('data-label') || '',
        renderHTML: (attrs) => ({ 'data-label': attrs.label }),
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'sup.footnote-ref',
        getAttrs: (el) => {
          const label = (el as HTMLElement).getAttribute('data-label');
          return label ? { label } : false;
        },
      },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    // Empty content — display number comes from a CSS counter on
    // `.footnote-ref`. The author label rides on `data-label` for round-trip.
    return ['sup', mergeAttributes({ class: 'footnote-ref' }, HTMLAttributes)];
  },

  addKeyboardShortcuts() {
    return {
      'Mod-Shift-f': () => {
        insertFootnoteAt(this.editor);
        return true;
      },
    };
  },
});

export const FootnoteSection = Node.create({
  name: 'footnoteSection',
  group: 'block',
  content: 'footnoteDefinition+',
  defining: true,
  isolating: true,

  addAttributes() {
    return {
      id: { default: null },
    };
  },

  parseHTML() {
    return [{ tag: 'section.footnotes' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['section', mergeAttributes({ class: 'footnotes' }, HTMLAttributes), 0];
  },
});

export const FootnoteDefinition = Node.create({
  name: 'footnoteDefinition',
  group: 'block',
  content: 'paragraph+',
  defining: true,
  isolating: true,

  addAttributes() {
    return {
      id: { default: null },
      label: {
        default: '',
        parseHTML: (el) => (el as HTMLElement).getAttribute('data-label') || '',
        renderHTML: (attrs) => ({ 'data-label': attrs.label }),
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'div.footnote-def',
        getAttrs: (el) => {
          const label = (el as HTMLElement).getAttribute('data-label');
          return label ? { label } : false;
        },
      },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes({ class: 'footnote-def' }, HTMLAttributes), 0];
  },
});

/**
 * Insert a footnote at the current cursor position.
 *
 *   1. Compute the next free label (sequential number; skips any label
 *      already used by an existing reference or definition).
 *   2. Insert a `footnoteReference` inline node at the caret.
 *   3. Append a new `footnoteDefinition` to the end-of-doc `footnoteSection`,
 *      creating the section if none exists.
 *   4. Move the selection into the new definition's empty paragraph so the
 *      author can immediately type the citation text.
 *
 * Atomic — single transaction. Never produces an orphan reference or
 * orphan definition.
 *
 * adr: adr/footnote-system.md
 */
export function insertFootnoteAt(editor: Editor): void {
  const { state } = editor;
  const { schema, doc } = state;

  const referenceType = schema.nodes.footnoteReference;
  const sectionType = schema.nodes.footnoteSection;
  const definitionType = schema.nodes.footnoteDefinition;
  const paragraphType = schema.nodes.paragraph;
  if (!referenceType || !sectionType || !definitionType || !paragraphType) {
    return;
  }

  // 1. Compute next free label
  const labels = new Set<string>();
  doc.descendants((node) => {
    if (node.type.name === 'footnoteReference' || node.type.name === 'footnoteDefinition') {
      if (node.attrs.label) labels.add(String(node.attrs.label));
    }
  });
  let n = 1;
  while (labels.has(String(n))) n++;
  const label = String(n);

  // 2. Find existing section position (top-level only)
  let sectionPos = -1;
  let sectionNode: any = null;
  doc.forEach((child, offset) => {
    if (child.type.name === 'footnoteSection') {
      sectionPos = offset;
      sectionNode = child;
    }
  });

  const newDefinition = definitionType.create({ label }, paragraphType.create());
  const newReference = referenceType.create({ label });
  // Insert at end-of-selection (so highlighting a word and inserting puts the
  // chip after the word). Empty selection (just a cursor) inserts at cursor.
  const insertAt = state.selection.to;

  const tr = state.tr;
  tr.insert(insertAt, newReference);

  // Compute where the new definition will sit so we can move the cursor
  // there after the transaction commits.
  let cursorTarget: number;

  if (sectionPos >= 0 && sectionNode) {
    // Append to existing section. After the reference insertion shifted
    // positions by `newReference.nodeSize`, recompute the section's end.
    const refSize = newReference.nodeSize;
    const sectionEndAfterRefInsert =
      insertAt <= sectionPos
        ? sectionPos + refSize + sectionNode.nodeSize
        : sectionPos + sectionNode.nodeSize;
    // Inside the section, before its closing token.
    const insertDefAt = sectionEndAfterRefInsert - 1;
    tr.insert(insertDefAt, newDefinition);
    // Cursor lands inside the new definition's empty paragraph: insertDefAt
    // points at the definition's opening token; +2 skips the definition open
    // and the paragraph open to land in the empty text position.
    cursorTarget = insertDefAt + 2;
  } else {
    // No section yet — create one with the new definition inside, append at
    // end of doc. doc.content.size is the position of the doc's closing
    // edge after the reference insertion.
    const newSection = sectionType.create(null, newDefinition);
    const endOfDoc = tr.doc.content.size;
    tr.insert(endOfDoc, newSection);
    // Cursor target: +1 (into section) +1 (into definition) +1 (into paragraph)
    cursorTarget = endOfDoc + 3;
  }

  // Move selection into the new definition's empty paragraph and scroll
  // it into view so the author sees where to type.
  const selPos = Math.min(cursorTarget, tr.doc.content.size);
  tr.setSelection(TextSelection.near(tr.doc.resolve(selPos)));
  tr.scrollIntoView();

  editor.view.dispatch(tr);
  editor.view.focus();
}
