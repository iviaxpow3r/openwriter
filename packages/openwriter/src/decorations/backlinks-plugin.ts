/**
 * ProseMirror plugin: renders a dotted underline on paragraphs that have
 * inbound links from other docs (i.e. appear as `to_node` in the active
 * doc's frontmatter `backlinks` array).
 *
 * Data source: frontmatter.backlinks, populated in App.tsx on doc load.
 * Each entry shape: { text, from_doc, from_node, to_node? }.
 *
 * Right-click on a decorated paragraph surfaces "See connections" via the
 * context menu, which reads `data-backlinks-count` from the decoration
 * to know how many sources to list.
 */

import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

export interface BacklinkEntry {
  text: string;
  from_doc: string;
  from_node: string;
  to_node?: string;
}

export const backlinkDecorationKey = new PluginKey('backlinkDecoration');

// Module-level backlinks state (matches the marks-plugin pattern)
let currentBacklinks: BacklinkEntry[] = [];

export function setBacklinksData(entries: BacklinkEntry[]): void {
  currentBacklinks = Array.isArray(entries) ? entries : [];
}

export function getBacklinksData(): BacklinkEntry[] {
  return currentBacklinks;
}

/**
 * Group entries by to_node so we can paint one decoration per target paragraph,
 * with `data-backlinks-count` reflecting how many sources point at it.
 * Entries without to_node are doc-level — handled separately (not by per-paragraph decoration).
 */
function indexByTargetNode(entries: BacklinkEntry[]): Map<string, BacklinkEntry[]> {
  const map = new Map<string, BacklinkEntry[]>();
  for (const e of entries) {
    if (!e.to_node) continue;
    const list = map.get(e.to_node) ?? [];
    list.push(e);
    map.set(e.to_node, list);
  }
  return map;
}

function buildBacklinkDecorations(doc: any): DecorationSet {
  if (currentBacklinks.length === 0) return DecorationSet.empty;

  const byTarget = indexByTargetNode(currentBacklinks);
  if (byTarget.size === 0) return DecorationSet.empty;

  const decorations: Decoration[] = [];
  doc.descendants((node: any, pos: number) => {
    if (!node.isTextblock) return true; // Recurse into wrappers (lists, blockquotes)
    const id = node.attrs?.id;
    if (!id) return true;
    const sources = byTarget.get(id);
    if (!sources) return true;
    decorations.push(
      Decoration.node(pos, pos + node.nodeSize, {
        class: 'linked-paragraph',
        'data-backlinks-count': String(sources.length),
        'data-backlinks-node': id,
      }),
    );
    return true;
  });

  return DecorationSet.create(doc, decorations);
}

export function createBacklinkDecorationPlugin(): Plugin {
  return new Plugin({
    key: backlinkDecorationKey,
    state: {
      init(_, state) {
        return buildBacklinkDecorations(state.doc);
      },
      apply(tr, oldSet, _oldState, newState) {
        if (tr.docChanged || tr.getMeta('forceBacklinkUpdate')) {
          return buildBacklinkDecorations(newState.doc);
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

export function forceBacklinkRefresh(view: any): void {
  const { state, dispatch } = view;
  const tr = state.tr.setMeta('forceBacklinkUpdate', true);
  dispatch(tr);
}

/** Look up all backlink sources for a given target nodeId (for the "See connections" menu). */
export function getBacklinksForNode(nodeId: string): BacklinkEntry[] {
  return currentBacklinks.filter((b) => b.to_node === nodeId);
}
