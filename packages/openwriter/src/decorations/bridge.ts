/**
 * Bridge: maps NodeChange objects from server/MCP to apply operations.
 */

import type { Editor } from '@tiptap/core';
import { Fragment } from '@tiptap/pm/model';
import type { NodeChange } from '../ws/client';
import { applyInsert, applyRewrite, applyDelete, applyRangeRewrite, type InsertAnchor } from './apply';

export function applyNodeChangeToEditor(
  editor: Editor,
  change: NodeChange
): { success: boolean; error?: string } {
  if (change.operation === 'rewrite' && change.nodeId && change.content) {
    const result = applyRewrite(editor, change.nodeId, change.content);
    return { success: result.success, error: result.error };
  }

  if (change.operation === 'insert' && change.content) {
    let anchor: InsertAnchor | null = null;

    if (change.nodeId && !change.afterNodeId) {
      // INSERT replacing empty node
      anchor = { nodeId: change.nodeId };
    } else if (change.afterNodeId) {
      anchor = { afterNodeId: change.afterNodeId };
    }

    if (!anchor) {
      return { success: false, error: 'Insert requires afterNodeId or nodeId' };
    }

    const result = applyInsert(editor, anchor, change.content);
    return { success: result.success, error: result.error };
  }

  if (change.operation === 'delete' && change.nodeId) {
    const result = applyDelete(editor, change.nodeId);
    return { success: result.success, error: result.error };
  }

  return { success: false, error: `Invalid operation: ${change.operation}` };
}

/**
 * Apply multiple node changes in a single ProseMirror transaction.
 * One transaction = one decoration rebuild = one DOM render.
 * Falls back to individual applies for single changes.
 */
export function applyNodeChangesToEditor(
  editor: Editor,
  changes: NodeChange[]
): void {
  if (changes.length === 0) return;
  if (changes.length === 1) {
    applyNodeChangeToEditor(editor, changes[0]);
    return;
  }

  const schema = editor.state.schema;

  editor.chain().command(({ tr }) => {
    for (const change of changes) {
      try {
        if (change.operation === 'rewrite' && change.nodeId && change.content) {
          const found = findNodeByIdInDoc(tr.doc, change.nodeId);
          if (!found) continue;

          const contentArray = Array.isArray(change.content) ? change.content : [change.content];
          const pmNodes = contentArray.map((n: any) => schema.nodeFromJSON(n));
          tr.replaceWith(found.pos, found.pos + found.node.nodeSize, pmNodes);
        }

        else if (change.operation === 'insert' && change.content) {
          const contentArray = Array.isArray(change.content) ? change.content : [change.content];
          const pmNodes = contentArray.map((n: any) => schema.nodeFromJSON(n));

          // Dedup: skip if a pending insert with same text already exists nearby
          const incomingText = pmNodes.map((n: any) => n.textContent || '').join('');
          if (incomingText && change.afterNodeId) {
            const anchor = findNodeByIdInDoc(tr.doc, change.afterNodeId);
            if (anchor) {
              const searchFrom = anchor.pos + anchor.node.nodeSize;
              const searchTo = Math.min(searchFrom + 5000, tr.doc.content.size);
              let isDuplicate = false;
              tr.doc.nodesBetween(searchFrom, searchTo, (node: any) => {
                if (isDuplicate) return false;
                if (node.attrs?.pendingStatus === 'insert' && (node.textContent || '') === incomingText) {
                  isDuplicate = true;
                  return false;
                }
                return true;
              });
              if (isDuplicate) continue;
            }
          }

          if (change.nodeId && !change.afterNodeId) {
            // Replace empty node
            const found = findNodeByIdInDoc(tr.doc, change.nodeId);
            if (!found) continue;
            tr.replaceWith(found.pos, found.pos + found.node.nodeSize, pmNodes);
          } else if (change.afterNodeId) {
            const found = findNodeByIdInDoc(tr.doc, change.afterNodeId);
            if (!found) continue;
            const insertPos = found.pos + found.node.nodeSize;
            tr.insert(insertPos, Fragment.fromArray(pmNodes));
          }
        }

        else if (change.operation === 'delete' && change.nodeId) {
          const found = findNodeByIdInDoc(tr.doc, change.nodeId);
          if (!found) continue;
          if (found.node.attrs?.pendingStatus === 'delete') continue;
          tr.setNodeMarkup(found.pos, undefined, {
            ...found.node.attrs,
            pendingStatus: 'delete',
          });
        }
      } catch {
        // Skip individual changes that fail — don't block the batch
        continue;
      }
    }
    return true;
  }).run();
}

/** Find a node by ID in a ProseMirror document (works with tr.doc for batched operations). */
function findNodeByIdInDoc(doc: any, id: string): { node: any; pos: number } | null {
  let result: { node: any; pos: number } | null = null;
  doc.descendants((node: any, pos: number) => {
    if (node.attrs?.id === id) {
      result = { node, pos };
      return false;
    }
    return true;
  });
  return result;
}

/**
 * Apply node changes from context menu API response.
 * Maps API response nodes back to pending decorations.
 */
export function applyNodeChangesFromBridge(
  editor: Editor,
  responseNodes: any[],
  originalNodeIds: string[],
  action: string
): any[] {
  const results: any[] = [];

  if (action === 'delete') {
    for (const nodeId of originalNodeIds) {
      results.push(applyDelete(editor, nodeId));
    }
    return results;
  }

  if (action === 'insert') {
    // Replace the empty node the cursor is on (not insert after)
    const anchorId = originalNodeIds[originalNodeIds.length - 1];
    if (anchorId && responseNodes.length > 0) {
      results.push(applyInsert(editor, { nodeId: anchorId }, responseNodes));
    }
    return results;
  }

  // Multi-node selection: atomic range replacement
  if (originalNodeIds.length > 1) {
    const result = applyRangeRewrite(editor, originalNodeIds, responseNodes);
    results.push(result);
    return results;
  }

  // Single-node rewrite: replace in place
  const result = applyRewrite(editor, originalNodeIds[0], responseNodes[0]);
  results.push(result);

  // If API returned more nodes than the single original, insert extras after
  if (responseNodes.length > 1) {
    const extraNodes = responseNodes.slice(1);
    results.push(applyInsert(editor, { afterNodeId: originalNodeIds[0] }, extraNodes));
  }

  return results;
}
