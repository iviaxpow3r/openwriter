/**
 * Decoration-based loading spinner for insertion points.
 * Shows bouncing dots at the cursor position while waiting for LLM output.
 * Works for both empty nodes (insert/fill-paragraph) and inline positions
 * (fill-sentence). Does NOT replace any content — purely visual.
 *
 * Ported from BreeWriter's InsertionLoadingNode.tsx.
 */

import { Extension, type CommandProps } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

interface InsertionPointData {
  position: number;
  id: string;
  active: boolean;
}

interface InsertionLoadingNodeStorage {
  insertionPoints: Record<string, InsertionPointData>;
}

const insertionLoadingNodePluginKey = new PluginKey('insertionLoadingNode');

// Cache spinner DOM elements to prevent recreation and animation restart
const spinnerElementCache = new Map<string, HTMLElement>();

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    insertionLoadingNode: {
      showInsertionLoading: (id: string, position: number) => ReturnType;
      removeInsertionLoading: (id: string) => ReturnType;
    };
  }
}

export const InsertionLoadingNode = Extension.create<InsertionLoadingNodeStorage>({
  name: 'insertionLoadingNode',

  addStorage() {
    return {
      insertionPoints: {},
    };
  },

  addCommands() {
    return {
      showInsertionLoading: (id: string, position: number) =>
        ({ editor }: CommandProps) => {
          // Only one spinner at a time
          this.storage.insertionPoints = {};
          spinnerElementCache.clear();

          this.storage.insertionPoints = {
            [id]: { position, id, active: true },
          };

          editor.view.dom.classList.add('has-insertion-loading');
          editor.view.dispatch(editor.view.state.tr);

          return true;
        },

      removeInsertionLoading: (id: string) =>
        ({ editor }: CommandProps) => {
          const insertionPoints = { ...this.storage.insertionPoints };

          if (insertionPoints[id]) {
            delete insertionPoints[id];
            this.storage.insertionPoints = insertionPoints;
            spinnerElementCache.delete(id);

            if (Object.keys(insertionPoints).length === 0) {
              editor.view.dom.classList.remove('has-insertion-loading');
            }

            editor.view.dispatch(editor.view.state.tr);
          }

          return true;
        },
    };
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: insertionLoadingNodePluginKey,

        props: {
          decorations: (state) => {
            const insertionPoints = this.storage.insertionPoints;
            const decorations: Decoration[] = [];

            Object.entries(insertionPoints).forEach(([, pointData]) => {
              const point = pointData as InsertionPointData;
              if (!point.active) return;

              decorations.push(
                Decoration.widget(
                  point.position,
                  () => {
                    const cached = spinnerElementCache.get(point.id);
                    if (cached) return cached;

                    const indicator = document.createElement('span');
                    indicator.className = 'inline-insertion-indicator';

                    const spinner = document.createElement('span');
                    spinner.className = 'inline-insertion-spinner';

                    const dot1 = document.createElement('div');
                    dot1.className = 'bounce1';
                    const dot2 = document.createElement('div');
                    dot2.className = 'bounce2';
                    const dot3 = document.createElement('div');

                    spinner.appendChild(dot1);
                    spinner.appendChild(dot2);
                    spinner.appendChild(dot3);
                    indicator.appendChild(spinner);

                    spinnerElementCache.set(point.id, indicator);
                    return indicator;
                  },
                  { id: `insertion-${point.id}` }
                )
              );
            });

            return DecorationSet.create(state.doc, decorations);
          },
        },
      }),
    ];
  },
});
