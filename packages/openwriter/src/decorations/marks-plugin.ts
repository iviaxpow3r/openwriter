/**
 * ProseMirror plugin: renders dotted underline decorations for agent marks.
 * Marks are fetched from the server and matched by text + nodeId.
 */

import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

export interface MarkData {
  id: string;
  text: string;
  note: string;
  nodeId: string;
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

function tryDecorate(mark: MarkData, node: any, pos: number): Decoration | null {
  const nodeText = node.textContent;
  const idx = nodeText.indexOf(mark.text);
  if (idx === -1) return null;

  const from = mapTextOffset(node, pos, idx);
  const to = mapTextOffset(node, pos, idx + mark.text.length);
  if (from === null || to === null || from >= to) return null;

  return Decoration.inline(from, to, {
    class: 'agent-mark',
    title: mark.note ? `Agent Mark: ${mark.note}` : 'Agent Mark',
    'data-mark-id': mark.id,
  });
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

  // Pass 1: match by nodeId (fast path for current-session marks)
  for (const mark of currentMarks) {
    const entry = textblockByNodeId.get(mark.nodeId);
    if (!entry) continue;
    const dec = tryDecorate(mark, entry.node, entry.pos);
    if (dec) {
      matched.add(mark.id);
      decorations.push(dec);
    }
  }

  // Pass 2: text fallback for unmatched marks (stale nodeIds after re-parse,
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
