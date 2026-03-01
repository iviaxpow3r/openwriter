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

function buildMarkDecorations(doc: any): DecorationSet {
  if (currentMarks.length === 0) return DecorationSet.empty;

  const decorations: Decoration[] = [];

  // Group marks by nodeId for efficient lookup
  const marksByNode = new Map<string, MarkData[]>();
  for (const mark of currentMarks) {
    const list = marksByNode.get(mark.nodeId) || [];
    list.push(mark);
    marksByNode.set(mark.nodeId, list);
  }

  doc.descendants((node: any, pos: number) => {
    const nodeId = node.attrs?.id;
    if (!nodeId || !marksByNode.has(nodeId)) return true;

    const nodeMarks = marksByNode.get(nodeId)!;
    const nodeText = node.textContent;

    for (const mark of nodeMarks) {
      // Find the marked text within this node
      const idx = nodeText.indexOf(mark.text);
      if (idx === -1) continue;

      // Map text offset to ProseMirror position
      const from = mapTextOffset(node, pos, idx);
      const to = mapTextOffset(node, pos, idx + mark.text.length);
      if (from === null || to === null || from >= to) continue;

      const title = mark.note ? `Agent Mark: ${mark.note}` : 'Agent Mark';
      decorations.push(
        Decoration.inline(from, to, {
          class: 'agent-mark',
          title,
          'data-mark-id': mark.id,
        })
      );
    }

    return true;
  });

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
      // Non-text nodes (hardBreak, etc.)
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
