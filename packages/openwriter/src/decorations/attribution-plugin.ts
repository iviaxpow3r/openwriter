/**
 * ProseMirror plugin: author-attribution heatmap.
 *
 * Colours each block by who authored it — human / agent / mixed / unknown —
 * when the heatmap toggle is ON. Origin data is per-nodeId, fetched from
 * /api/attribution/:docId (computed server-side from the sentence-hash-anchored
 * blame in _blame/{docId}.json). Mirrors the backlinks-plugin data-feed pattern:
 * a module-level map fed via setAttributionData(), painted by nodeId.
 *
 * The heatmap is a VIEW TOGGLE — it must never fight the pending-review colours,
 * so it only paints when `enabled` is true (the user flips it on explicitly).
 *
 * adr: adr/document-history-attribution.md
 */

import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

export type Origin = 'human' | 'agent' | 'mixed' | 'unknown';

export const attributionDecorationKey = new PluginKey('attributionDecoration');

// Module-level state (matches the backlinks/comments-plugin pattern).
let nodeOrigins: Record<string, Origin> = {};
let enabled = false;

/** Feed per-node origin data (from /api/attribution/:docId). */
export function setAttributionData(origins: Record<string, Origin> | null | undefined): void {
  nodeOrigins = origins && typeof origins === 'object' ? origins : {};
}

/** Turn the heatmap view on/off. Returns the new state. */
export function setAttributionEnabled(on: boolean): void {
  enabled = on;
}

export function isAttributionEnabled(): boolean {
  return enabled;
}

function buildAttributionDecorations(doc: any): DecorationSet {
  if (!enabled) return DecorationSet.empty;
  const decorations: Decoration[] = [];
  doc.descendants((node: any, pos: number) => {
    if (!node.isTextblock) return true; // recurse into wrappers (lists, blockquotes)
    const id = node.attrs?.id;
    if (!id) return true;
    const origin = nodeOrigins[id] ?? 'unknown';
    decorations.push(
      Decoration.node(pos, pos + node.nodeSize, {
        class: `attr-block attr-${origin}`,
        'data-attr-origin': origin,
      }),
    );
    return true;
  });
  return DecorationSet.create(doc, decorations);
}

export function createAttributionDecorationPlugin(): Plugin {
  return new Plugin({
    key: attributionDecorationKey,
    state: {
      init(_, state) {
        return buildAttributionDecorations(state.doc);
      },
      apply(tr, oldSet, _oldState, newState) {
        if (tr.docChanged || tr.getMeta('forceAttributionUpdate')) {
          return buildAttributionDecorations(newState.doc);
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

/** Force a re-paint after setAttributionData/setAttributionEnabled changes. */
export function forceAttributionRefresh(view: any): void {
  if (!view) return;
  const { state, dispatch } = view;
  dispatch(state.tr.setMeta('forceAttributionUpdate', true));
}
