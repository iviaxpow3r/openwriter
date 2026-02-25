/**
 * Selection marker utilities for sub-paragraph context menu actions.
 * Injects [[START_SELECTION]]/[[END_SELECTION]] markers into TipTap JSON
 * so the AI backend only modifies the selected text.
 * Ported from BreeWriter's SelectionMarkers.ts.
 */

import type { JSONContent } from '@tiptap/core';

const START_MARKER = '[[START_SELECTION]]';
const END_MARKER = '[[END_SELECTION]]';

/** Compute linear text length of a node's inline content (text + hardBreak). */
function computeLinearLength(node: JSONContent): number {
  if (!node?.content || !Array.isArray(node.content)) return 0;
  let length = 0;
  for (const child of node.content) {
    if (child.type === 'text' && typeof child.text === 'string') {
      length += child.text.length;
    } else if (child.type === 'hardBreak') {
      length += 1;
    }
  }
  return length;
}

/** Insert a marker string at a linear text offset within a node's inline content. */
function insertMarkerIntoNode(node: JSONContent, offset: number, marker: string): void {
  if (!node?.content || !Array.isArray(node.content)) return;

  const total = computeLinearLength(node);
  let remaining = Math.max(0, Math.min(offset, total));

  for (let i = 0; i < node.content.length; i++) {
    const child = node.content[i];

    if (child.type === 'text' && typeof child.text === 'string') {
      if (remaining <= child.text.length) {
        const idx = Math.max(0, Math.min(child.text.length, remaining));
        child.text = child.text.slice(0, idx) + marker + child.text.slice(idx);
        return;
      }
      remaining -= child.text.length;
      continue;
    }

    if (child.type === 'hardBreak') {
      if (remaining === 0) {
        node.content.splice(i + 1, 0, { type: 'text', text: marker });
        return;
      }
      remaining -= 1;
      continue;
    }

    if (remaining === 0) {
      node.content.splice(i, 0, { type: 'text', text: marker });
      return;
    }
  }

  node.content.push({ type: 'text', text: marker });
}

/**
 * Inject selection markers into node JSON at the given text offsets.
 * Deep-clones nodes to avoid side effects.
 * Single-node: both markers in that node.
 * Multi-node: START in first, END in last.
 */
export function injectSelectionMarkers(
  nodes: JSONContent[],
  startOffset: number,
  endOffset: number
): JSONContent[] {
  const annotated: JSONContent[] = JSON.parse(JSON.stringify(nodes));
  if (annotated.length === 0) return annotated;

  if (annotated.length === 1) {
    // Insert END first (higher offset) so START offset stays valid
    insertMarkerIntoNode(annotated[0], endOffset, END_MARKER);
    insertMarkerIntoNode(annotated[0], startOffset, START_MARKER);
    return annotated;
  }

  insertMarkerIntoNode(annotated[0], startOffset, START_MARKER);
  insertMarkerIntoNode(annotated[annotated.length - 1], endOffset, END_MARKER);
  return annotated;
}

/** Strip selection markers from node text content (mutates in place). */
export function stripSelectionMarkers(jsonData: JSONContent | JSONContent[]): void {
  const strip = (text: string): string =>
    text.replace(/\[\[(START|END)_SELECTION]]/g, '');

  const traverse = (node: JSONContent): void => {
    if (node.type === 'text' && typeof node.text === 'string') {
      node.text = strip(node.text);
    }
    if (node.content && Array.isArray(node.content)) {
      node.content.forEach(traverse);
    }
  };

  if (Array.isArray(jsonData)) jsonData.forEach(traverse);
  else traverse(jsonData);
}
