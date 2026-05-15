import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Editor } from '@tiptap/react';

import { applyNodeChangesFromBridge } from '../decorations/bridge';
import { applyRewrite } from '../decorations/apply';
import type { SelectionRange } from '../decorations/apply';
import { getMarksData } from '../decorations/marks-plugin';
import { getBacklinksForNode, type BacklinkEntry } from '../decorations/backlinks-plugin';
import { injectSelectionMarkers, stripSelectionMarkers } from './selection-markers';
import { formatLinkHref, linkHrefIdentifier } from '../editor/link-href';

/** True if this doc appears in the linked-ids list (matches by docId or filename). */
function isDocLinked(d: { filename: string; docId?: string }, linkedIds: string[]): boolean {
  if (d.docId && linkedIds.includes(d.docId)) return true;
  return linkedIds.includes(d.filename);
}

interface PluginMenuItem {
  label: string;
  shortcut?: string;
  action: string;
  condition?: 'has-selection' | 'empty-node' | 'always';
  promptForInput?: boolean;
  pluginDisplayName?: string;
}

type CoreAction = 'agent-mark' | 'delete' | 'link' | 'unlink';

interface MenuItem {
  action: string;
  label: string;
  shortcut?: string;
  isPlugin?: boolean;
  promptForInput?: boolean;
  pluginDisplayName?: string;
}

interface ContextMenuProps {
  editorRef: React.MutableRefObject<Editor | null>;
  allEditors?: Editor[];
  documentId?: string;
}

interface MenuPosition {
  x: number;
  y: number;
}

const CORE_ACTIONS: Array<{ action: CoreAction; label: string; shortcut?: string; condition?: 'has-selection' }> = [
  { action: 'agent-mark', label: 'Agent Mark', shortcut: 'M', condition: 'has-selection' },
  { action: 'delete', label: 'Delete', shortcut: 'D' },
];

interface CapturedSelection {
  from: number;
  to: number;
  nodes: any[];
  nodeIds: string[];
}

export default function ContextMenu({ editorRef, allEditors, documentId }: ContextMenuProps) {
  const [visible, setVisible] = useState(false);
  const [position, setPosition] = useState<MenuPosition>({ x: 0, y: 0 });
  const [loading, setLoading] = useState(false);
  const [customInput, setCustomInput] = useState('');
  const [showCustom, setShowCustom] = useState(false);
  const [customAction, setCustomAction] = useState('');
  const [showLinkPicker, setShowLinkPicker] = useState(false);
  const [docList, setDocList] = useState<Array<{ filename: string; title: string; docId?: string }>>([]);
  const [linkedDocs, setLinkedDocs] = useState<string[]>([]);
  const [showNewLinkInput, setShowNewLinkInput] = useState(false);
  const [newLinkTitle, setNewLinkTitle] = useState('');
  const [pluginItems, setPluginItems] = useState<PluginMenuItem[]>([]);
  const [showMarkInput, setShowMarkInput] = useState(false);
  const [markNote, setMarkNote] = useState('');
  const [editingMark, setEditingMark] = useState<{ id: string; text: string } | null>(null);
  const [markOnlyMenu, setMarkOnlyMenu] = useState<{ id: string; text: string; note: string } | null>(null);
  // Backlinks panel: populated when right-click target is on a `.linked-paragraph` decoration.
  // entries is a snapshot at right-click time so the panel renders deterministically.
  const [backlinksMenu, setBacklinksMenu] = useState<{ nodeId: string; entries: BacklinkEntry[] } | null>(null);
  const [showBacklinksPanel, setShowBacklinksPanel] = useState(false);
  // Paragraph drill-in for the link picker: when set, the link panel shows the
  // paragraphs of a specific target doc instead of the doc list.
  const [paragraphPicker, setParagraphPicker] = useState<{
    docId: string;
    filename: string;
    title: string;
    paragraphs: Array<{ nodeId: string; type: string; level?: number; preview: string }>;
    loading: boolean;
  } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  // Capture selection at right-click time (before the click changes cursor position)
  const capturedSelection = useRef<CapturedSelection | null>(null);
  // Track which editor was right-clicked (for thread mode with multiple editors)
  const activeEditorRef = useRef<Editor | null>(null);

  // Find which editor contains the click target
  const findEditorForTarget = useCallback((target: Node): Editor | null => {
    // Check allEditors first (thread mode)
    if (allEditors && allEditors.length > 0) {
      for (const editor of allEditors) {
        if (editor.view.dom.contains(target)) return editor;
      }
    }
    // Fallback to single editorRef
    const editor = editorRef.current;
    if (editor && editor.view.dom.contains(target)) return editor;
    return null;
  }, [allEditors, editorRef]);

  // Adjust position to keep menu within viewport
  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu || !visible) return;
    const rect = menu.getBoundingClientRect();
    const pad = 8;
    let { x, y } = position;
    if (y + rect.height + pad > window.innerHeight) y = position.y - rect.height;
    if (x + rect.width + pad > window.innerWidth) x = position.x - rect.width;
    if (y < pad) y = pad;
    if (x < pad) x = pad;
    if (x !== position.x || y !== position.y) setPosition({ x, y });
  }, [visible, position]);

  // Fetch plugin menu items
  const fetchPluginItems = useCallback(() => {
    fetch('/api/plugins')
      .then((r) => r.json())
      .then((data) => {
        const items: PluginMenuItem[] = [];
        for (const plugin of data.plugins || []) {
          const displayName = plugin.displayName || undefined;
          for (const item of plugin.contextMenuItems || []) {
            items.push({ ...item, pluginDisplayName: displayName });
          }
        }
        setPluginItems(items);
      })
      .catch(() => {});
  }, []);

  // Fetch on mount
  useEffect(() => { fetchPluginItems(); }, [fetchPluginItems]);

  // Re-fetch when plugins are enabled/disabled
  useEffect(() => {
    const handler = () => fetchPluginItems();
    window.addEventListener('ow-plugins-changed', handler);
    return () => window.removeEventListener('ow-plugins-changed', handler);
  }, [fetchPluginItems]);

  // Close on click outside
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setVisible(false);
        setShowCustom(false);
        setShowLinkPicker(false);
        setShowMarkInput(false);
        setMarkNote('');
        setEditingMark(null);
        setMarkOnlyMenu(null);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  // Check if selection is inside a link
  const isOnLink = useCallback(() => {
    const editor = activeEditorRef.current || editorRef.current;
    if (!editor) return false;
    return editor.isActive('link');
  }, [editorRef]);

  // Check if any captured node has pending status
  const selectionHasPending = useCallback((): boolean => {
    const editor = activeEditorRef.current || editorRef.current;
    const captured = capturedSelection.current;
    if (!editor || !captured) return false;
    const { from, to } = captured;
    let hasPending = false;
    editor.state.doc.nodesBetween(from, to, (node) => {
      if (node.attrs?.pendingStatus) hasPending = true;
      return !hasPending; // stop traversal early
    });
    return hasPending;
  }, [editorRef]);

  // Build dynamic actions list based on context (uses captured selection)
  const getActions = useCallback((): MenuItem[] => {
    const editor = activeEditorRef.current || editorRef.current;
    const captured = capturedSelection.current;
    const from = captured?.from ?? 0;
    const to = captured?.to ?? 0;
    const hasSelection = from !== to;
    const isEmptyNode = (() => {
      if (!editor) return false;
      try {
        const $from = editor.state.doc.resolve(from);
        return $from.parent.content.size === 0;
      } catch { return false; }
    })();

    const hasPending = selectionHasPending();

    // Plugin items first (filtered by condition)
    const items: MenuItem[] = [];
    for (const pi of pluginItems) {
      if (pi.condition === 'has-selection' && !hasSelection) continue;
      if (pi.condition === 'empty-node' && !isEmptyNode) continue;
      items.push({
        action: pi.action,
        label: pi.label,
        shortcut: pi.shortcut,
        isPlugin: true,
        promptForInput: pi.promptForInput,
        pluginDisplayName: pi.pluginDisplayName,
      });
    }

    // Core actions
    for (const ca of CORE_ACTIONS) {
      // Agent Mark: only show with text selection and no pending overlap
      if (ca.condition === 'has-selection' && (!hasSelection || hasPending)) continue;
      items.push(ca);
    }
    if (hasSelection) {
      items.push({ action: 'link', label: 'Link to doc', shortcut: 'L' });
    }
    if (isOnLink()) {
      items.push({ action: 'unlink', label: 'Unlink' });
    }
    // "See connections" surfaces when right-click landed on a linked paragraph.
    // Show it first — it's the most relevant action for a linked node.
    if (backlinksMenu && backlinksMenu.entries.length > 0) {
      items.unshift({
        action: 'see-connections',
        label: `See connections (${backlinksMenu.entries.length})`,
      });
    }
    return items;
  }, [editorRef, isOnLink, pluginItems, selectionHasPending, backlinksMenu]);

  // Open on right-click in editor — capture selection BEFORE the click changes it
  useEffect(() => {
    const captureSelectionOnMouseDown = (e: MouseEvent) => {
      if (e.button !== 2) return; // Only right-click
      const editor = findEditorForTarget(e.target as Node);
      if (!editor) return;
      activeEditorRef.current = editor;

      // Capture the current selection state NOW, before ProseMirror handles the mousedown
      const { from, to } = editor.state.selection;
      const nodes: any[] = [];
      const nodeIds: string[] = [];

      if (from !== to) {
        editor.state.doc.nodesBetween(from, to, (node) => {
          if (node.isBlock && node.type.name !== 'doc') {
            nodes.push(node.toJSON());
            if (node.attrs.id) nodeIds.push(node.attrs.id);
          }
        });
      }

      // Fallback: cursor on a block with no selection
      if (nodes.length === 0) {
        const { $from } = editor.state.selection;
        const parentNode = $from.parent;
        if (parentNode && parentNode.type.name !== 'doc') {
          nodes.push(parentNode.toJSON());
          if (parentNode.attrs?.id) nodeIds.push(parentNode.attrs.id);
        }
      }

      capturedSelection.current = { from, to, nodes, nodeIds };
    };

    const handleContextMenu = (e: MouseEvent) => {
      const editor = findEditorForTarget(e.target as Node);
      if (!editor) return;

      // Shift+right-click passes through to native menu (spellcheck, etc.)
      if (e.shiftKey) return;

      // Right-clicking on an existing agent mark: show mark-only menu (Edit/Resolve)
      const markEl = (e.target as Element | null)?.closest?.('[data-mark-id]') as HTMLElement | null;
      const markId = markEl?.getAttribute('data-mark-id') || null;

      // Right-clicking on a linked paragraph: capture its backlinks for "See connections"
      const linkedEl = (e.target as Element | null)?.closest?.('.linked-paragraph[data-backlinks-node]') as HTMLElement | null;
      const linkedNodeId = linkedEl?.getAttribute('data-backlinks-node') || null;

      e.preventDefault();
      setPosition({ x: e.clientX, y: e.clientY });
      setVisible(true);
      setShowCustom(false);
      setShowLinkPicker(false);
      setShowBacklinksPanel(false);
      setShowMarkInput(false);
      setMarkNote('');
      setEditingMark(null);

      if (markId) {
        const mark = getMarksData().find((m) => m.id === markId);
        if (mark) {
          setMarkOnlyMenu({ id: mark.id, text: mark.text, note: mark.note });
          setBacklinksMenu(null);
          return;
        }
      }
      setMarkOnlyMenu(null);

      if (linkedNodeId) {
        const entries = getBacklinksForNode(linkedNodeId);
        setBacklinksMenu(entries.length > 0 ? { nodeId: linkedNodeId, entries } : null);
      } else {
        setBacklinksMenu(null);
      }
    };

    // mousedown fires BEFORE ProseMirror's selection update
    document.addEventListener('mousedown', captureSelectionOnMouseDown, true);
    document.addEventListener('contextmenu', handleContextMenu);
    return () => {
      document.removeEventListener('mousedown', captureSelectionOnMouseDown, true);
      document.removeEventListener('contextmenu', handleContextMenu);
    };
  }, [findEditorForTarget]);

  const callPluginAction = useCallback(async (action: string, instruction?: string) => {
    const editor = activeEditorRef.current || editorRef.current;
    if (!editor) return;

    // Use captured selection from right-click time (before ProseMirror changed cursor)
    const captured = capturedSelection.current;
    if (!captured || captured.nodes.length === 0) {
      console.warn('[ContextMenu] No captured selection for action:', action);
      return;
    }

    let { nodes, nodeIds } = captured;
    const { from, to } = captured;

    setLoading(true);
    setVisible(false);
    setShowCustom(false);

    const loadingId = `ctx-${Date.now()}`;
    // Strip namespace prefix early (needed for action-type detection)
    const backendAction = action.includes(':') ? action.split(':').slice(1).join(':') : action;
    const isInsertAction = ['insert', 'fill', 'fill-sentence'].includes(backendAction);

    if (isInsertAction) {
      // Bouncing-dots spinner at cursor position (works for empty + inline)
      editor.commands.showInsertionLoading(loadingId, from);
    } else {
      // Sub-paragraph selection (sentence/word): blur just the selected range
      const $from = editor.state.doc.resolve(from);
      const $to = editor.state.doc.resolve(to);
      const sameBlock = $from.sameParent($to) && from !== to;
      editor.commands.applyLoadingEffect(loadingId, from, to, sameBlock ? 'selection' : 'paragraph');
    }

    try {
      const nodesBefore: string[] = [];
      const nodesAfter: string[] = [];
      const targetIdSet = new Set(nodeIds);
      let pastTarget = false;

      // Iterate top-level doc children only — collect plain text
      const doc = editor.state.doc;
      for (let i = 0; i < doc.childCount; i++) {
        const child = doc.child(i);
        const childId = child.attrs?.id;
        if (childId && targetIdSet.has(childId)) {
          pastTarget = true;
        } else if (!pastTarget) {
          const text = child.textContent.trim();
          if (text) nodesBefore.push(text);
        } else {
          const text = child.textContent.trim();
          if (text) nodesAfter.push(text);
        }
      }

      // Sub-paragraph selection: inject [[START_SELECTION]]/[[END_SELECTION]] markers
      // so the backend AI only modifies the selected text
      let markedNodes = nodes;
      let isSubParagraph = false;
      let subParaStartOffset = 0;
      let subParaEndOffset = 0;
      const $from = from !== to ? editor.state.doc.resolve(from) : null;
      const $to = from !== to ? editor.state.doc.resolve(to) : null;
      const sameBlock = $from && $to ? $from.sameParent($to) : false;
      if (sameBlock && $from && nodes.length === 1) {
        const contentStart = $from.start($from.depth);
        subParaStartOffset = from - contentStart;
        subParaEndOffset = to - contentStart;
        const nodeTextLength = nodes[0]?.content
          ?.reduce((len: number, c: any) => len + (c.text?.length || (c.type === 'hardBreak' ? 1 : 0)), 0) ?? 0;
        // Only inject markers for partial selections (not full paragraph)
        if (subParaStartOffset > 0 || subParaEndOffset < nodeTextLength) {
          markedNodes = injectSelectionMarkers(nodes, subParaStartOffset, subParaEndOffset);
          isSubParagraph = true;
        }
      }

      // Full document text for broad context awareness
      const fullDocText = editor.state.doc.textContent;

      const body: any = {
        nodes: markedNodes,
        action: backendAction,
        nodeIds,
        contextBefore: nodesBefore.slice(-3),
        contextAfter: nodesAfter.slice(0, 3),
        fullDocument: fullDocText,
        documentId,
        debug: true,
      };
      if (isSubParagraph) body.hasSelectionMarkers = true;
      if (instruction) body.instruction = instruction;

      const res = await fetch(`${window.location.origin}/api/voice/apply-editor`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        console.error('[ContextMenu] API error:', res.status, errData);
        return;
      }

      const data = await res.json();
      if (data.success && data.nodes) {
        // Flatten nested arrays (backend sometimes wraps in extra array)
        let responseNodes = data.nodes;
        if (responseNodes.length === 1 && Array.isArray(responseNodes[0])) {
          responseNodes = responseNodes[0];
        }
        // Strip selection markers from response before applying
        stripSelectionMarkers(responseNodes);

        if (isSubParagraph && responseNodes.length === 1 && nodeIds.length === 1) {
          // Sub-paragraph: highlight the selection range (not word-level diff)
          // Count text + hardBreak lengths (matching ProseMirror position offsets)
          const linearLen = (content: any[]) =>
            content?.reduce((len: number, c: any) =>
              len + (c.text?.length || (c.type === 'hardBreak' ? 1 : 0)), 0) ?? 0;
          const originalText = linearLen(nodes[0]?.content);
          const newText = linearLen(responseNodes[0]?.content);

          // Prefix is unchanged → selectionFrom = original startOffset
          // Suffix is unchanged → selectionTo = newLen - (origLen - endOffset)
          const selectionRange: SelectionRange = {
            selectionFrom: subParaStartOffset,
            selectionTo: newText - (originalText - subParaEndOffset),
            originalFrom: subParaStartOffset,
            originalTo: subParaEndOffset,
          };
          applyRewrite(editor, nodeIds[0], responseNodes[0], selectionRange);
        } else {
          // Full node / multi-node: full-node decoration (no inline diffs)
          applyNodeChangesFromBridge(editor, responseNodes, nodeIds, backendAction);
        }
      } else {
        console.warn('[ContextMenu] Unexpected response:', data);
      }
    } catch (err) {
      console.error('[ContextMenu] Plugin action failed:', err);
    } finally {
      if (isInsertAction) {
        editor.commands.removeInsertionLoading(loadingId);
      } else {
        editor.commands.removeLoadingEffect(loadingId);
      }
      setLoading(false);
    }
  }, [editorRef]);

  const handleImageGenAction = useCallback(async (instruction: string) => {
    const editor = activeEditorRef.current || editorRef.current;
    if (!editor) return;

    const { $from } = editor.state.selection;
    const from = $from.before($from.depth);
    const to = $from.after($from.depth);
    const isEmptyNode = $from.parent.content.size === 0;

    setLoading(true);
    setVisible(false);
    setShowCustom(false);

    // Insert imageLoading placeholder
    const insertPos = isEmptyNode ? from : to;
    if (isEmptyNode) {
      editor.chain()
        .focus()
        .deleteRange({ from, to })
        .insertContentAt(from, { type: 'imageLoading' })
        .run();
    } else {
      editor.chain()
        .focus()
        .insertContentAt(to, { type: 'imageLoading' })
        .run();
    }

    // Find the imageLoading node we just inserted
    let loadingPos = -1;
    let loadingNodeSize = 0;
    editor.state.doc.descendants((node, pos) => {
      if (node.type.name === 'imageLoading' && loadingPos === -1) {
        loadingPos = pos;
        loadingNodeSize = node.nodeSize;
        return false;
      }
    });

    try {
      const res = await fetch('/api/image-gen/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: instruction }),
      });

      const data = await res.json().catch(() => ({ success: false, error: `Generation failed (${res.status})` }));
      if (data.success && data.src) {
        // Find the imageLoading node again (positions may have shifted)
        let currentPos = -1;
        let currentSize = 0;
        editor.state.doc.descendants((node, pos) => {
          if (node.type.name === 'imageLoading' && currentPos === -1) {
            currentPos = pos;
            currentSize = node.nodeSize;
            return false;
          }
        });
        if (currentPos >= 0) {
          const { tr } = editor.state;
          tr.replaceWith(currentPos, currentPos + currentSize,
            editor.schema.nodes.image.create({ src: data.src, alt: instruction }));
          editor.view.dispatch(tr);
        }
      } else {
        console.error('[ContextMenu] Image generation failed:', data.error);
        // Remove the placeholder on failure
        let currentPos = -1;
        let currentSize = 0;
        editor.state.doc.descendants((node, pos) => {
          if (node.type.name === 'imageLoading' && currentPos === -1) {
            currentPos = pos;
            currentSize = node.nodeSize;
            return false;
          }
        });
        if (currentPos >= 0) {
          const { tr } = editor.state;
          tr.delete(currentPos, currentPos + currentSize);
          editor.view.dispatch(tr);
        }
      }
    } catch (err) {
      console.error('[ContextMenu] Image generation failed:', err);
      // Remove the placeholder on error
      let currentPos = -1;
      let currentSize = 0;
      editor.state.doc.descendants((node, pos) => {
        if (node.type.name === 'imageLoading' && currentPos === -1) {
          currentPos = pos;
          currentSize = node.nodeSize;
          return false;
        }
      });
      if (currentPos >= 0) {
        const { tr } = editor.state;
        tr.delete(currentPos, currentPos + currentSize);
        editor.view.dispatch(tr);
      }
    } finally {
      setLoading(false);
    }
  }, [editorRef]);

  const handleAction = useCallback((item: MenuItem) => {
    const { action, isPlugin, promptForInput } = item;

    if (isPlugin && promptForInput) {
      setCustomAction(action);
      setShowCustom(true);
      return;
    }
    if (isPlugin) {
      if (action.startsWith('img:')) {
        // Image gen actions with no prompt — shouldn't happen (all have promptForInput)
        return;
      }
      callPluginAction(action);
      return;
    }
    if (action === 'agent-mark') {
      setShowMarkInput(true);
      return;
    }
    if (action === 'delete') {
      const editor = activeEditorRef.current || editorRef.current;
      const captured = capturedSelection.current;
      if (editor && captured && captured.nodeIds.length > 0) {
        const { tr } = editor.state;
        const idsToDelete = new Set(captured.nodeIds);
        const ranges: { from: number; to: number }[] = [];

        editor.state.doc.descendants((node, pos) => {
          if (node.attrs?.id && idsToDelete.has(node.attrs.id)) {
            ranges.push({ from: pos, to: pos + node.nodeSize });
            return false;
          }
        });

        // Delete in reverse order to maintain valid positions
        for (const range of ranges.reverse()) {
          tr.delete(range.from, range.to);
        }
        if (ranges.length > 0) editor.view.dispatch(tr);
      }
      setVisible(false);
      return;
    }
    if (action === 'link') {
      const editor = activeEditorRef.current || editorRef.current;
      if (editor) {
        const ids: string[] = [];
        editor.state.doc.descendants((node) => {
          node.marks?.forEach((mark: any) => {
            if (mark.type.name === 'link' && mark.attrs?.href?.startsWith('doc:')) {
              const id = linkHrefIdentifier(mark.attrs.href);
              if (id && !ids.includes(id)) ids.push(id);
            }
          });
        });
        setLinkedDocs(ids);
      }
      fetch('/api/documents')
        .then((r) => r.json())
        .then((docs) => {
          if (Array.isArray(docs)) {
            setDocList(docs.map((d: any) => ({ filename: d.filename, title: d.title, docId: d.docId })));
          }
          setShowNewLinkInput(false);
          setNewLinkTitle('');
          setShowLinkPicker(true);
        })
        .catch(() => {});
      return;
    }
    if (action === 'unlink') {
      const editor = activeEditorRef.current || editorRef.current;
      if (editor) {
        editor.chain().focus().unsetLink().run();
      }
      setVisible(false);
      return;
    }
    if (action === 'see-connections') {
      // Preload doc list so we can resolve from_doc → title for the panel.
      fetch('/api/documents')
        .then((r) => r.json())
        .then((docs) => {
          if (Array.isArray(docs)) {
            setDocList(docs.map((d: any) => ({ filename: d.filename, title: d.title, docId: d.docId })));
          }
        })
        .catch(() => {});
      setShowBacklinksPanel(true);
      return;
    }
  }, [callPluginAction, editorRef]);

  const handleCustomSubmit = useCallback(() => {
    if (customInput.trim()) {
      if (customAction.startsWith('img:')) {
        handleImageGenAction(customInput.trim());
      } else {
        callPluginAction(customAction, customInput.trim());
      }
      setCustomInput('');
      setCustomAction('');
    }
  }, [callPluginAction, handleImageGenAction, customAction, customInput]);

  const handleMarkSubmit = useCallback(() => {
    if (!documentId) return;

    // Edit mode: PATCH existing mark
    if (editingMark) {
      fetch('/api/marks', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filename: documentId,
          id: editingMark.id,
          note: markNote.trim(),
        }),
      })
        .then(() => {
          setVisible(false);
          setShowMarkInput(false);
          setMarkNote('');
          setEditingMark(null);
        })
        .catch((err) => {
          console.error('[ContextMenu] Agent mark edit failed:', err);
        });
      return;
    }

    // Create mode: POST new mark from captured selection
    const editor = activeEditorRef.current || editorRef.current;
    const captured = capturedSelection.current;
    if (!editor || !captured) return;

    const { from, to, nodeIds } = captured;
    if (from === to || nodeIds.length === 0) return;

    const selectedText = editor.state.doc.textBetween(from, to, '\n');
    if (!selectedText.trim()) return;

    fetch('/api/marks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filename: documentId,
        text: selectedText,
        note: markNote.trim(),
        nodeId: nodeIds[nodeIds.length - 1],
        nodeIds: nodeIds,
      }),
    })
      .then(() => {
        setVisible(false);
        setShowMarkInput(false);
        setMarkNote('');
      })
      .catch((err) => {
        console.error('[ContextMenu] Agent mark failed:', err);
      });
  }, [editorRef, documentId, markNote, editingMark]);

  const handleMarkEdit = useCallback(() => {
    if (!markOnlyMenu) return;
    setEditingMark({ id: markOnlyMenu.id, text: markOnlyMenu.text });
    setMarkNote(markOnlyMenu.note);
    setShowMarkInput(true);
    setMarkOnlyMenu(null);
  }, [markOnlyMenu]);

  const handleMarkResolve = useCallback(() => {
    if (!markOnlyMenu) return;
    fetch('/api/marks', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [markOnlyMenu.id] }),
    })
      .then(() => {
        setVisible(false);
        setMarkOnlyMenu(null);
      })
      .catch((err) => {
        console.error('[ContextMenu] Agent mark resolve failed:', err);
      });
  }, [markOnlyMenu]);

  const handleLinkSelect = useCallback((
    doc: { filename: string; docId?: string },
    extras?: { nodeId?: string; quote?: string },
  ) => {
    const editor = activeEditorRef.current || editorRef.current;
    if (editor) {
      // Prefer stable docId; fall back to filename for docs that haven't been
      // touched since the docId/caret-anchor migration landed.
      const href = doc.docId
        ? formatLinkHref({ docId: doc.docId, nodeId: extras?.nodeId, quote: extras?.quote })
        : formatLinkHref({ filename: doc.filename });
      editor.chain().focus().setLink({ href }).run();
    }
    fetch('/api/auto-tag-link', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetFile: doc.filename }),
    }).catch(() => {});
    setVisible(false);
    setShowLinkPicker(false);
    setParagraphPicker(null);
  }, [editorRef]);

  // Drill into a doc's paragraphs for paragraph-level link targeting.
  // Whole-doc click (single-row click) keeps the existing handleLinkSelect path;
  // this is the ▸ button affordance per row.
  const openParagraphPicker = useCallback((doc: { filename: string; docId?: string; title: string }) => {
    if (!doc.docId) {
      // Legacy doc without docId — can't paragraph-target. Fall back to whole-doc.
      handleLinkSelect(doc);
      return;
    }
    setParagraphPicker({ docId: doc.docId, filename: doc.filename, title: doc.title, paragraphs: [], loading: true });
    fetch(`/api/documents/by-doc-id/${doc.docId}/paragraphs`)
      .then((r) => r.json())
      .then((data) => {
        setParagraphPicker((cur) => cur && cur.docId === doc.docId
          ? { ...cur, paragraphs: Array.isArray(data.paragraphs) ? data.paragraphs : [], loading: false }
          : cur);
      })
      .catch(() => {
        setParagraphPicker((cur) => cur && cur.docId === doc.docId
          ? { ...cur, paragraphs: [], loading: false }
          : cur);
      });
  }, [handleLinkSelect]);

  const handleNewLinkDoc = useCallback(() => {
    const title = newLinkTitle.trim();
    if (!title) return;
    const editor = activeEditorRef.current || editorRef.current;
    if (!editor) return;

    fetch('/api/create-link-doc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }),
    })
      .then((r) => r.json())
      .then((data) => {
        if (data.filename) {
          // New doc may not have a docId yet (assigned on first proper load).
          // Use docId if present; otherwise legacy filename — resolver handles both.
          const href = formatLinkHref(data.docId ? { docId: data.docId } : { filename: data.filename });
          editor.chain().focus().setLink({ href }).run();
        }
      })
      .catch(() => {});

    setVisible(false);
    setShowLinkPicker(false);
    setShowNewLinkInput(false);
    setNewLinkTitle('');
  }, [editorRef, newLinkTitle]);

  if (!visible) return null;

  return (
    <div
      ref={menuRef}
      className="context-menu"
      style={{ left: position.x, top: position.y }}
    >
      {loading ? (
        <div className="context-menu-loading">Applying...</div>
      ) : showMarkInput ? (
        <div className="context-menu-mark-editor">
          {(() => {
            const quoted = editingMark?.text
              ?? (() => {
                const editor = activeEditorRef.current || editorRef.current;
                const captured = capturedSelection.current;
                if (!editor || !captured || captured.from === captured.to) return '';
                return editor.state.doc.textBetween(captured.from, captured.to, '\n');
              })();
            return quoted ? <div className="context-menu-mark-quote">{quoted}</div> : null;
          })()}
          <textarea
            autoFocus
            className="context-menu-mark-textarea"
            value={markNote}
            onChange={(e) => setMarkNote(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                handleMarkSubmit();
              }
              if (e.key === 'Escape') {
                setVisible(false);
                setShowMarkInput(false);
                setMarkNote('');
                setEditingMark(null);
              }
            }}
            placeholder="Note for agent (optional)..."
            rows={4}
          />
          <div className="context-menu-mark-actions">
            <span className="context-menu-mark-hint">⌘↵ to save · Esc to cancel</span>
            <button onClick={handleMarkSubmit}>{editingMark ? 'Save' : 'Mark'}</button>
          </div>
        </div>
      ) : markOnlyMenu ? (
        <>
          <button className="context-menu-item" onClick={handleMarkEdit}>
            <span>Edit mark</span>
          </button>
          <button className="context-menu-item" onClick={handleMarkResolve}>
            <span>Resolve mark</span>
          </button>
        </>
      ) : showCustom ? (
        <div className="context-menu-custom">
          <input
            autoFocus
            value={customInput}
            onChange={(e) => setCustomInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleCustomSubmit();
              if (e.key === 'Escape') setVisible(false);
            }}
            placeholder="Custom instruction..."
          />
          <button onClick={handleCustomSubmit}>Apply</button>
        </div>
      ) : paragraphPicker ? (
        <div className="context-menu-link-picker">
          <div className="context-menu-link-header">
            <button
              className="context-menu-link-back"
              onClick={() => setParagraphPicker(null)}
              title="Back to doc list"
            >
              ←
            </button>
            <span>Pick paragraph in "{paragraphPicker.title}"</span>
          </div>
          <button
            className="context-menu-item context-menu-new-link"
            onClick={() => handleLinkSelect({ filename: paragraphPicker.filename, docId: paragraphPicker.docId })}
          >
            <span>Link whole doc</span>
          </button>
          <div className="context-menu-link-list">
            {paragraphPicker.loading ? (
              <div className="context-menu-loading">Loading…</div>
            ) : paragraphPicker.paragraphs.length === 0 ? (
              <div className="context-menu-loading">No paragraphs</div>
            ) : (
              paragraphPicker.paragraphs.map((p) => {
                const quote = p.preview.replace(/…$/, '').slice(0, 50);
                const indent = p.type === 'heading' ? Math.max(0, (p.level || 1) - 1) * 12 : 12;
                return (
                  <button
                    key={p.nodeId}
                    className={`context-menu-item context-menu-paragraph-row context-menu-paragraph-row--${p.type}`}
                    style={{ paddingLeft: 8 + indent }}
                    onClick={() => handleLinkSelect(
                      { filename: paragraphPicker.filename, docId: paragraphPicker.docId },
                      { nodeId: p.nodeId, quote },
                    )}
                  >
                    <span>{p.preview}</span>
                  </button>
                );
              })
            )}
          </div>
        </div>
      ) : showBacklinksPanel && backlinksMenu ? (
        <div className="context-menu-link-picker">
          <div className="context-menu-link-header">
            Linked from {backlinksMenu.entries.length} {backlinksMenu.entries.length === 1 ? 'place' : 'places'}
          </div>
          <div className="context-menu-link-list">
            {backlinksMenu.entries.map((entry, idx) => {
              const sourceDoc = docList.find((d) => d.docId === entry.from_doc);
              const sourceTitle = sourceDoc?.title || entry.from_doc;
              return (
                <button
                  key={`${entry.from_doc}-${entry.from_node}-${idx}`}
                  className="context-menu-item"
                  onClick={() => {
                    // Navigate to source: dispatch event for App.tsx to route via handleLinkClick
                    window.dispatchEvent(new CustomEvent('ow-navigate-to-link', {
                      detail: { docId: entry.from_doc, nodeId: entry.from_node, filename: null, quote: null },
                    }));
                    setVisible(false);
                    setShowBacklinksPanel(false);
                  }}
                >
                  <span>{sourceTitle}</span>
                  <span className="context-menu-shortcut">"{entry.text}"</span>
                </button>
              );
            })}
          </div>
        </div>
      ) : showLinkPicker ? (
        <div className="context-menu-link-picker">
          <div className="context-menu-link-header">Link to document</div>
          {showNewLinkInput ? (
            <div className="context-menu-custom">
              <input
                autoFocus
                value={newLinkTitle}
                onChange={(e) => setNewLinkTitle(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleNewLinkDoc();
                  if (e.key === 'Escape') setShowNewLinkInput(false);
                }}
                placeholder="New document title..."
              />
              <button onClick={handleNewLinkDoc}>Create</button>
            </div>
          ) : (
            <button
              className="context-menu-item context-menu-new-link"
              onClick={() => setShowNewLinkInput(true)}
            >
              <span>+ New link doc</span>
            </button>
          )}
          <div className="context-menu-link-list">
            {linkedDocs.length > 0 && (
              <>
                <div className="context-menu-section-header">Linked in this doc</div>
                {docList
                  .filter((d) => isDocLinked(d, linkedDocs))
                  .map((d) => (
                    <div key={`linked-${d.filename}`} className="context-menu-link-row">
                      <button
                        className="context-menu-item context-menu-link-row__main"
                        onClick={() => handleLinkSelect(d)}
                      >
                        <span>{d.title}</span>
                      </button>
                      {d.docId && (
                        <button
                          className="context-menu-link-row__drill"
                          title="Pick a paragraph in this doc"
                          onClick={() => openParagraphPicker(d)}
                        >
                          ▸
                        </button>
                      )}
                    </div>
                  ))}
              </>
            )}
            <div className="context-menu-section-header">All documents</div>
            {docList
              .filter((d) => !isDocLinked(d, linkedDocs))
              .map((d) => (
                <div key={d.filename} className="context-menu-link-row">
                  <button
                    className="context-menu-item context-menu-link-row__main"
                    onClick={() => handleLinkSelect(d)}
                  >
                    <span>{d.title}</span>
                  </button>
                  {d.docId && (
                    <button
                      className="context-menu-link-row__drill"
                      title="Pick a paragraph in this doc"
                      onClick={() => openParagraphPicker(d)}
                    >
                      ▸
                    </button>
                  )}
                </div>
              ))}
            {docList.length === 0 && (
              <div className="context-menu-loading">No documents</div>
            )}
          </div>
        </div>
      ) : (
        (() => {
          const actions = getActions();
          let lastPluginName: string | undefined;
          return actions.map((item, idx) => {
            const showHeader = item.isPlugin && item.pluginDisplayName && item.pluginDisplayName !== lastPluginName;
            const prevWasPlugin = lastPluginName !== undefined;
            if (item.isPlugin) lastPluginName = item.pluginDisplayName;
            else lastPluginName = undefined;
            const showDivider = !item.isPlugin && prevWasPlugin;
            return (
              <span key={item.action}>
                {showHeader && <div className="context-menu-section-header">{item.pluginDisplayName}</div>}
                {showDivider && <div className="context-menu-divider" />}
                <button
                  className="context-menu-item"
                  onClick={() => handleAction(item)}
                >
                  <span>{item.label}</span>
                  {item.shortcut && <span className="context-menu-shortcut">{item.shortcut}</span>}
                </button>
              </span>
            );
          });
        })()
      )}
    </div>
  );
}
