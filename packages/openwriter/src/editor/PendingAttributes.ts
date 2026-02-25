/**
 * TipTap extension: registers pendingStatus + pendingOriginalContent as global
 * attributes on all block node types. Without this, TipTap silently drops
 * unknown attrs during insertContentAt(), and decorations never appear.
 */

import { Extension } from '@tiptap/core';

const BLOCK_TYPES = [
  'paragraph',
  'heading',
  'bulletList',
  'orderedList',
  'listItem',
  'blockquote',
  'codeBlock',
  'horizontalRule',
  'table',
  'taskList',
  'taskItem',
  'image',
];

export const PendingAttributes = Extension.create({
  name: 'pendingAttributes',

  addGlobalAttributes() {
    return [
      {
        types: BLOCK_TYPES,
        attributes: {
          pendingStatus: {
            default: null,
            parseHTML: (element: HTMLElement) => element.getAttribute('data-pending-status') || null,
            renderHTML: (attributes: Record<string, any>) => {
              if (!attributes.pendingStatus) return {};
              return { 'data-pending-status': attributes.pendingStatus };
            },
          },
          pendingOriginalContent: {
            default: null,
            rendered: false, // Internal only — never serialized to HTML
          },
          pendingSelectionFrom: {
            default: null,
            rendered: false,
          },
          pendingSelectionTo: {
            default: null,
            rendered: false,
          },
          pendingOriginalFrom: {
            default: null,
            rendered: false,
          },
          pendingOriginalTo: {
            default: null,
            rendered: false,
          },
          pendingGroupId: {
            default: null,
            rendered: false, // Internal only — links nodes in a range rewrite group
          },
        },
      },
    ];
  },
});
