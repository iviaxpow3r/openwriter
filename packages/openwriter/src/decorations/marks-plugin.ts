/**
 * ProseMirror plugin: renders dotted underline decorations for agent marks.
 * Marks are fetched from the server and matched by text + nodeId.
 * Supports multi-paragraph marks via nodeIds array.
 */

import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

export interface MarkData {
  id: string;
  text: string;
  note: string;
  nodeId: string;
  nodeIds?: string[];
}

export const markDecorationKey = new PluginKey('markDecoration');

// Module-level marks state
let currentMarks: MarkData[] = [];

export function setMarksData(marks: MarkData[]): void {
  currentMarks = marks;
}

export function getMarksData(): MarkData[] {
  return currentMarks;
}

function makeDecoAttrs(mark: MarkData): Record<string, string> {
  return {
    class: 'agent-mark',
    title: mark.note ? `Agent Mark: ${mark.note}` : 'Agent Mark',
    'data-mark-id': mark.id,
  };
}

function tryDecorate(mark: MarkData, node: any, pos: number): Decoration | null {
  const nodeText = node.textContent;
  const idx = nodeText.indexOf(mark.text);
  if (idx === -1) return null;

  const from = mapTextOffset(node, pos, idx);
  const to = mapTextOffset(node, pos, idx + mark.text.length);
  if (from === null || to === null || from >= to) return null;

  return Decoration.inline(from, to, makeDecoAttrs(mark));
}

/**
 * Try to decorate a multi-paragraph mark by splitting its text across the
 * ordered nodeIds and decorating each paragraph's portion independently.
 * Returns an array of decorations (one per matched paragraph), or empty if
 * the mark cannot be matched.
 */
function tryDecorateMultiNode(
  mark: MarkData,
  textblockByNodeId: Map<string, { node: any; pos: number }>,
): Decoration[] {
  const ids = mark.nodeIds!;
  const segments = mark.text.split('\n');
  const attrs = makeDecoAttrs(mark);
  const decorations: Decoration[] = [];

  // The mark text was captured with textBetween(from, to, '\n'), which inserts
  // '\n' between block nodes. The segments should map 1:1 to nodeIds. However,
  // if they don't align (e.g. a segment is empty due to an empty paragraph),
  // we use a greedy walk: advance through segments, matching each non-empty
  // segment to the next nodeId whose text contains it.

  if (segments.length === ids.length) {
    // Fast path: 1:1 mapping
    for (let i = 0; i < ids.length; i++) {
      const seg = segments[i];
      if (!seg) continue; // skip empty paragraph segments
      const entry = textblockByNodeId.get(ids[i]);
      if (!entry) continue;
      const nodeText = entry.node.textContent;
      const idx = nodeText.indexOf(seg);
      if (idx === -1) continue;
      const from = mapTextOffset(entry.node, entry.pos, idx);
      const to = mapTextOffset(entry.node, entry.pos, idx + seg.length);
      if (from !== null && to !== null && from < to) {
        decorations.push(Decoration.inline(from, to, attrs));
      }
    }
  } else {
    // Fallback: greedy matching — walk nodeIds in order, try each remaining segment
    let segIdx = 0;
    for (const id of ids) {
      if (segIdx >= segments.length) break;
      const entry = textblockByNodeId.get(id);
      if (!entry) continue;
      const seg = segments[segIdx];
      if (!seg) { segIdx++; continue; }
      const nodeText = entry.node.textContent;
      const idx = nodeText.indexOf(seg);
      if (idx === -1) continue;
      const from = mapTextOffset(entry.node, entry.pos, idx);
      const to = mapTextOffset(entry.node, entry.pos, idx + seg.length);
      if (from !== null && to !== null && from < to) {
        decorations.push(Decoration.inline(from, to, attrs));
        segIdx++;
      }
    }
  }

  return decorations;
}

function buildMarkDecorations(doc: any): DecorationSet {
  if (currentMarks.length === 0) return DecorationSet.empty;

  const decorations: Decoration[] = [];
  const matched = new Set<string>();

  // Build nodeId → textblock lookup (only leaf text blocks can host inline decorations)
  const textblockByNodeId = new Map<string, { node: any; pos: number }>();
  doc.descendants((node: any, pos: number) => {
    if (node.isTextblock && node.attrs?.id) {
      textblockByNodeId.set(node.attrs.id, { node, pos });
    }
    return true;
  });

  // Pass 1: match multi-node marks by nodeIds array
  for (const mark of currentMarks) {
    if (mark.nodeIds && mark.nodeIds.length > 1) {
      const decs = tryDecorateMultiNode(mark, textblockByNodeId);
      if (decs.length > 0) {
        matched.add(mark.id);
        decorations.push(...decs);
      }
    }
  }

  // Pass 2: match single-node marks by nodeId (fast path for current-session marks)
  for (const mark of currentMarks) {
    if (matched.has(mark.id)) continue;
    const entry = textblockByNodeId.get(mark.nodeId);
    if (!entry) continue;
    const dec = tryDecorate(mark, entry.node, entry.pos);
    if (dec) {
      matched.add(mark.id);
      decorations.push(dec);
    }
  }

  // Pass 3: text fallback for unmatched marks (stale nodeIds after re-parse,
  // or nodeId pointed to a wrapper block like bulletList/blockquote)
  const unmatched = currentMarks.filter((m) => !matched.has(m.id));
  if (unmatched.length > 0) {
    doc.descendants((node: any, pos: number) => {
      if (!node.isTextblock) return true;
      for (const mark of unmatched) {
        if (matched.has(mark.id)) continue;
        const dec = tryDecorate(mark, node, pos);
        if (dec) {
          matched.add(mark.id);
          decorations.push(dec);
        }
      }
      return true;
    });
  }

  return DecorationSet.create(doc, decorations);
}

/**
 * Map a text character offset to a ProseMirror document position.
 */
function mapTextOffset(node: any, nodeStartPos: number, textOffset: number): number | null {
  let charCount = 0;
  let pos = nodeStartPos + 1; // Inside the block node

  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child.isText) {
      if (charCount + child.text.length >= textOffset) {
        return pos + (textOffset - charCount);
      }
      charCount += child.text.length;
      pos += child.nodeSize;
    } else {
      // Leaf nodes like hardBreak contribute to textContent via leafText spec
      const leafLen = child.type.spec.leafText ? child.type.spec.leafText(child).length : 0;
      if (leafLen > 0 && charCount + leafLen >= textOffset) {
        return pos; // Position of the leaf node itself
      }
      charCount += leafLen;
      pos += child.nodeSize;
    }
  }

  if (textOffset === charCount) return pos;
  return null;
}

export function createMarkDecorationPlugin(): Plugin {
  return new Plugin({
    key: markDecorationKey,

    state: {
      init(_, state) {
        return buildMarkDecorations(state.doc);
      },
      apply(tr, oldSet, _oldState, newState) {
        if (tr.docChanged || tr.getMeta('forceMarkUpdate')) {
          return buildMarkDecorations(newState.doc);
        }
        return oldSet.map(tr.mapping, tr.doc);
      },
    },

    props: {
      decorations(state) {
        return this.getState(state);
      },
    },
  });
}

export function forceMarkRefresh(view: any): void {
  const { state, dispatch } = view;
  const tr = state.tr.setMeta('forceMarkUpdate', true);
  dispatch(tr);
}
