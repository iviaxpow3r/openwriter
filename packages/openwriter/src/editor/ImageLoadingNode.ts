/**
 * Placeholder node shown while an image is being generated.
 * Renders a full-width shimmer rectangle; not editable or selectable.
 * Automatically replaced (or deleted) once the image arrives (or fails).
 */

import { Node } from '@tiptap/core';

export const ImageLoadingNode = Node.create({
  name: 'imageLoading',
  group: 'block',
  atom: true,

  addAttributes() {
    return {
      id: { default: null },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-type="image-loading"]' }];
  },

  renderHTML() {
    return ['div', {
      'data-type': 'image-loading',
      class: 'image-loading-placeholder',
      contenteditable: 'false',
    }];
  },
});
