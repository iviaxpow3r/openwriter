/**
 * TweetImage — Image extension for tweet compose mode.
 * Extends @tiptap/extension-image with a React NodeView that renders
 * X-style media cards (cover crop, remove button overlay).
 */

import Image from '@tiptap/extension-image';
import { ReactNodeViewRenderer } from '@tiptap/react';
import TweetImageView from './TweetImageView';

const TweetImage = Image.extend({
  addNodeView() {
    return ReactNodeViewRenderer(TweetImageView);
  },
});

export default TweetImage;
