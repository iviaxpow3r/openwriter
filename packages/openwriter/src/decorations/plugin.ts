/**
 * ProseMirror plugin: scans pendingStatus node attrs → applies CSS classes.
 */

import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

export type PendingStatus = 'insert' | 'rewrite' | 'delete';

export const pendingDecorationKey = new PluginKey('pendingDecoration');

// ============================================================================
// MODULE-LEVEL STATE: focused node + preview
// ============================================================================

let focusedNodeId: string | null = null;
export function setFocusedPendingNode(id: string | null) { focusedNodeId = id; }
export function getFocusedPendingNode() { return focusedNodeId; }

let previewActive = false;
let previewNodeId: string | null = null;
let savedModifiedContent: any = null;

export function isPreviewActive(): boolean { return previewActive; }
export function getPreviewNodeId(): string | null { return previewNodeId; }
export function getSavedModifiedContent() { return savedModifiedContent; }

export function setPreviewState(active: boolean, nodeId?: string | null, modified?: any) {
  previewActive = active;
  previewNodeId = active ? (nodeId ?? null) : null;
  savedModifiedContent = active ? (modified ?? null) : null;
}

// ============================================================================
// HELPERS
// ============================================================================

function getPendingClass(status: PendingStatus): string {
  switch (status) {
    case 'insert': return 'pending-insert';
    case 'rewrite': return 'pending-rewrite';
    case 'delete': return 'pending-delete';
    default: return '';
  }
}

/**
 * Map a text character offset within a node's inline content to a ProseMirror
 * document position. The offset counts only text characters (not node boundaries).
 */
function mapTextOffsetToPos(node: any, nodeStartPos: number, textOffset: number): number | null {
  // nodeStartPos points to the start of the block node in the doc.
  // The first inline position is nodeStartPos + 1 (inside the block).
  let charCount = 0;
  let pos = nodeStartPos + 1; // Start inside the block node

  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child.isText) {
      if (charCount + child.text.length >= textOffset) {
        return pos + (textOffset - charCount);
      }
      charCount += child.text.length;
      pos += child.nodeSize;
    } else {
      pos += child.nodeSize;
    }
  }

  // If offset equals total text length, return end position
  if (textOffset === charCount) return pos;
  return null;
}

function buildDecorations(doc: any): DecorationSet {
  const decorations: Decoration[] = [];

  doc.descendants((node: any, pos: number) => {
    const status = node.attrs?.pendingStatus as PendingStatus | undefined;
    if (!status) return true;

    const textEdits = node.attrs?.pendingTextEdits;
    const nodeId = node.attrs?.id;

    if (textEdits && Array.isArray(textEdits) && textEdits.length > 0) {
      // Fine-grained inline decorations for text edits (no parent border)
      for (const edit of textEdits) {
        const inlineStart = mapTextOffsetToPos(node, pos, edit.from);
        const inlineEnd = mapTextOffsetToPos(node, pos, edit.to);
        if (inlineStart !== null && inlineEnd !== null && inlineStart < inlineEnd) {
          decorations.push(
            Decoration.inline(inlineStart, inlineEnd, {
              class: `pending-inline-${edit.type || 'rewrite'}`,
            })
          );
        }
      }
    } else {
      // Inline decoration wrapping text content (no text shift)
      const canInline = node.isTextblock && (pos + 1) < (pos + node.nodeSize - 1);
      // When previewing original content, show in red (like delete but no strikethrough)
      const isShowingOriginal = previewActive && nodeId === previewNodeId;
      const className = isShowingOriginal ? 'pending-original' : getPendingClass(status);

      if (className) {
        if (canInline) {
          decorations.push(
            Decoration.inline(pos + 1, pos + node.nodeSize - 1, { class: className })
          );
        } else {
          // Fallback for empty textblocks or non-textblock leaves (hr, image)
          decorations.push(
            Decoration.node(pos, pos + node.nodeSize, { class: className })
          );
        }
      }
    }

    // Active gutter line on focused node (always node decoration for ::before)
    if (nodeId && nodeId === focusedNodeId) {
      const isShowingOriginal = previewActive && nodeId === previewNodeId;
      const gutterStatus = isShowingOriginal ? 'original' : status;
      decorations.push(
        Decoration.node(pos, pos + node.nodeSize, {
          class: `pending-active pending-active--${gutterStatus}`,
        })
      );
    }

    return true;
  });

  return DecorationSet.create(doc, decorations);
}

export function createPendingDecorationPlugin(): Plugin {
  return new Plugin({
    key: pendingDecorationKey,

    state: {
      init(_, state) {
        return buildDecorations(state.doc);
      },
      apply(tr, oldSet, _oldState, newState) {
        if (tr.docChanged || tr.getMeta('forceDecorationUpdate')) {
          return buildDecorations(newState.doc);
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

export function forceDecorationRefresh(view: any): void {
  const { state, dispatch } = view;
  const tr = state.tr.setMeta('forceDecorationUpdate', true);
  dispatch(tr);
}
