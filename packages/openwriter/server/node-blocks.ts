/**
 * TipTap node tree → walker-style block list.
 *
 * The matcher and fingerprint operate on a flat ordered block list (one entry
 * per block, pre-order traversal, with parentPosition pointing back). This
 * adapter converts the TipTap document tree into that shape so the matcher
 * operates on the SAME structural view as the editor — not on a separately
 * re-parsed markdown body.
 *
 * Avoiding a second parse is the architectural defense against walker-vs-
 * parser drift: one block tree feeds both TipTap rendering and node identity
 * tracking.
 *
 * adr: adr/node-identity-matcher.md
 */

import type { Block, StructureSig } from './node-fingerprint.js';

interface TipTapNode {
  type: string;
  attrs?: Record<string, any>;
  content?: TipTapNode[];
  text?: string;
  marks?: Array<{ type: string }>;
}

/**
 * Flatten a TipTap document tree into a walker-style block list.
 *
 * Container blocks (lists, blockquotes, listItems) get an entry AND their
 * children get separate entries with parentPosition pointing back. Container
 * text is the first direct paragraph's content only (no recursive roll-up).
 */
export function tiptapToBlocks(doc: { content?: TipTapNode[] }): Block[] {
  const blocks: Block[] = [];
  walkNodes(doc.content || [], blocks, null);
  return blocks;
}

const CONTAINER_TYPES = new Set([
  'bulletList',
  'orderedList',
  'taskList',
  'blockquote',
  'table',
  'listItem',
  'taskItem',
  'tableRow',
  'tableCell',
  'tableHeader',
]);

function walkNodes(nodes: TipTapNode[], blocks: Block[], parentPosition: number | null): void {
  let ordinalInParent = 0;

  for (const node of nodes) {
    if (node.type === 'heading') {
      const level = node.attrs?.level || 1;
      const text = extractInlineText(node.content || []);
      blocks.push({
        position: blocks.length,
        type: 'heading',
        level,
        text,
        parentPosition,
        ordinalInParent: ordinalInParent++,
        inlineMarks: countInlineMarks(node.content || []),
        id: node.attrs?.id,
      });
    } else if (node.type === 'paragraph') {
      const text = extractInlineText(node.content || []);
      blocks.push({
        position: blocks.length,
        type: 'paragraph',
        text,
        parentPosition,
        ordinalInParent: ordinalInParent++,
        inlineMarks: countInlineMarks(node.content || []),
        id: node.attrs?.id,
      });
    } else if (node.type === 'bulletList' || node.type === 'orderedList' || node.type === 'taskList') {
      const containerPosition = blocks.length;
      blocks.push({
        position: containerPosition,
        type: node.type,
        text: '',
        parentPosition,
        ordinalInParent: ordinalInParent++,
        id: node.attrs?.id,
      });
      walkNodes(node.content || [], blocks, containerPosition);
    } else if (node.type === 'listItem' || node.type === 'taskItem') {
      const itemPosition = blocks.length;
      // listItem's identity text = first direct paragraph child only.
      // Avoids cascading fingerprint changes when nested children are edited.
      const firstParaText = firstParagraphText(node.content || []);
      blocks.push({
        position: itemPosition,
        type: node.type,
        text: firstParaText,
        parentPosition,
        ordinalInParent: ordinalInParent++,
        id: node.attrs?.id,
      });
      walkNodes(node.content || [], blocks, itemPosition);
    } else if (node.type === 'blockquote') {
      const bqPosition = blocks.length;
      blocks.push({
        position: bqPosition,
        type: 'blockquote',
        text: '',
        parentPosition,
        ordinalInParent: ordinalInParent++,
        id: node.attrs?.id,
      });
      walkNodes(node.content || [], blocks, bqPosition);
    } else if (node.type === 'codeBlock') {
      const text = extractInlineText(node.content || []);
      blocks.push({
        position: blocks.length,
        type: 'codeBlock',
        language: node.attrs?.language || '',
        text,
        parentPosition,
        ordinalInParent: ordinalInParent++,
        id: node.attrs?.id,
      });
    } else if (node.type === 'horizontalRule') {
      blocks.push({
        position: blocks.length,
        type: 'horizontalRule',
        text: '',
        parentPosition,
        ordinalInParent: ordinalInParent++,
        id: node.attrs?.id,
      });
    } else if (node.type === 'table') {
      const tablePosition = blocks.length;
      blocks.push({
        position: tablePosition,
        type: 'table',
        text: extractTableText(node),
        parentPosition,
        ordinalInParent: ordinalInParent++,
        id: node.attrs?.id,
      });
      // Don't descend into table internals — the walker treats tables as opaque.
    } else if (node.type === 'image') {
      blocks.push({
        position: blocks.length,
        type: 'image',
        text: node.attrs?.alt || '',
        parentPosition,
        ordinalInParent: ordinalInParent++,
        id: node.attrs?.id,
      });
    } else if (CONTAINER_TYPES.has(node.type)) {
      // Generic container — emit entry, descend
      const containerPosition = blocks.length;
      blocks.push({
        position: containerPosition,
        type: node.type,
        text: '',
        parentPosition,
        ordinalInParent: ordinalInParent++,
        id: node.attrs?.id,
      });
      walkNodes(node.content || [], blocks, containerPosition);
    } else if (node.content) {
      // Unknown wrapper — descend without emitting
      walkNodes(node.content, blocks, parentPosition);
    }
  }
}

/** Get plain text from a node's inline children. */
function extractInlineText(nodes: TipTapNode[]): string {
  return nodes.map((n) => n.text || '').join('');
}

/** Find the first paragraph child (direct or via nested ordering) and return its text. */
function firstParagraphText(nodes: TipTapNode[]): string {
  for (const n of nodes) {
    if (n.type === 'paragraph') return extractInlineText(n.content || []);
  }
  return '';
}

/** Sum inline marks across all inline children. */
function countInlineMarks(nodes: TipTapNode[]): StructureSig {
  let bold = 0, italic = 0, links = 0, code = 0;
  for (const n of nodes) {
    if (n.type !== 'text') continue;
    for (const mark of n.marks || []) {
      if (mark.type === 'bold') bold++;
      else if (mark.type === 'italic') italic++;
      else if (mark.type === 'link') links++;
      else if (mark.type === 'code') code++;
    }
  }
  return { bold, italic, links, code };
}

/** Flatten table cell text — table is treated as an opaque block for fingerprinting. */
function extractTableText(table: TipTapNode): string {
  const parts: string[] = [];
  function walk(nodes: TipTapNode[] | undefined): void {
    if (!nodes) return;
    for (const n of nodes) {
      if (n.type === 'text') parts.push(n.text || '');
      else if (n.content) walk(n.content);
    }
  }
  walk(table.content);
  return parts.join(' ');
}

/**
 * Apply pinned IDs from a matcher result back onto the TipTap node tree.
 * Walks the tree in the same pre-order the adapter used and assigns
 * attrs.id from the corresponding pinned entry.
 */
export function applyIdsToTiptap(
  doc: { content?: TipTapNode[] },
  pinnedByPosition: Map<number, string>,
): void {
  let position = 0;
  function walk(nodes: TipTapNode[]): void {
    for (const node of nodes) {
      const isBlock =
        node.type === 'heading' ||
        node.type === 'paragraph' ||
        node.type === 'bulletList' ||
        node.type === 'orderedList' ||
        node.type === 'taskList' ||
        node.type === 'listItem' ||
        node.type === 'taskItem' ||
        node.type === 'blockquote' ||
        node.type === 'codeBlock' ||
        node.type === 'horizontalRule' ||
        node.type === 'table' ||
        node.type === 'image' ||
        CONTAINER_TYPES.has(node.type);

      if (isBlock) {
        const id = pinnedByPosition.get(position);
        if (id) {
          if (!node.attrs) node.attrs = {};
          node.attrs.id = id;
        }
        position++;

        // Descend into container children (matches walkNodes behavior).
        // Tables and images are leaf-like in the walker; descend only for containers.
        const isContainer =
          node.type === 'bulletList' ||
          node.type === 'orderedList' ||
          node.type === 'taskList' ||
          node.type === 'listItem' ||
          node.type === 'taskItem' ||
          node.type === 'blockquote' ||
          CONTAINER_TYPES.has(node.type);
        if (isContainer && node.content) walk(node.content);
      } else if (node.content) {
        walk(node.content);
      }
    }
  }
  walk(doc.content || []);
}
