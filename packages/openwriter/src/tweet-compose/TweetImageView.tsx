/**
 * TweetImageView — Custom NodeView for images in tweet compose mode.
 * Renders each image as an X-style media card:
 * - object-fit: cover with center crop
 * - Remove (×) button overlay top-right
 * - No edit/crop button for now (v1)
 *
 * Used exclusively in tweetExtensionsBase via TweetImage extension.
 */

import { NodeViewWrapper } from '@tiptap/react';

export default function TweetImageView({ node, deleteNode }: any) {
  return (
    <NodeViewWrapper as="div" className="tweet-image-card" draggable data-drag-handle>
      <img
        className="tweet-image-card-img"
        src={node.attrs.src}
        alt={node.attrs.alt || ''}
        draggable={false}
      />
      <button
        className="tweet-image-card-remove"
        onClick={deleteNode}
        title="Remove image"
        contentEditable={false}
      >
        ×
      </button>
    </NodeViewWrapper>
  );
}
