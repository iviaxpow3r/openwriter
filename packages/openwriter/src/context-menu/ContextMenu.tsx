import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Editor } from '@tiptap/react';

import { applyNodeChangesFromBridge } from '../decorations/bridge';
import { applyRewrite } from '../decorations/apply';
import type { SelectionRange } from '../decorations/apply';
import { injectSelectionMarkers, stripSelectionMarkers } from './selection-markers';

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
  const [docList, setDocList] = useState<Array<{ filename: string; title: string }>>([]);
  const [linkedDocs, setLinkedDocs] = useState<string[]>([]);
  const [showNewLinkInput, setShowNewLinkInput] = useState(false);
  const [newLinkTitle, setNewLinkTitle] = useState('');
  const [pluginItems, setPluginItems] = useState<PluginMenuItem[]>([]);
  const [showMarkInput, setShowMarkInput] = useState(false);
  const [markNote, setMarkNote] = useState('');
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
    return items;
  }, [editorRef, isOnLink, pluginItems, selectionHasPending]);

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

      e.preventDefault();
      setPosition({ x: e.clientX, y: e.clientY });
      setVisible(true);
      setShowCustom(false);
      setShowLinkPicker(false);
      setShowMarkInput(false);
      setMarkNote('');
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
    // Sub-paragraph selection (sentence/word): blur just the selected range
    const $from = editor.state.doc.resolve(from);
    const $to = editor.state.doc.resolve(to);
    const sameBlock = $from.sameParent($to) && from !== to;
    editor.commands.applyLoadingEffect(loadingId, from, to, sameBlock ? 'selection' : 'paragraph');

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

      // Strip namespace prefix (e.g. "av:rewrite" → "rewrite") for the backend
      const backendAction = action.includes(':') ? action.split(':').slice(1).join(':') : action;

      // Sub-paragraph selection: inject [[START_SELECTION]]/[[END_SELECTION]] markers
      // so the backend AI only modifies the selected text
      let markedNodes = nodes;
      let isSubParagraph = false;
      let subParaStartOffset = 0;
      let subParaEndOffset = 0;
      if (sameBlock && nodes.length === 1) {
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
      editor.commands.removeLoadingEffect(loadingId);
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

    const loadingId = `ctx-img-${Date.now()}`;
    editor.commands.applyLoadingEffect(loadingId, from, to, 'paragraph');

    try {
      const res = await fetch('/api/image-gen/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: instruction }),
      });

      const data = await res.json();
      if (data.success && data.src) {
        if (isEmptyNode) {
          // Empty node: replace it with the image
          editor.chain()
            .focus()
            .deleteRange({ from, to })
            .insertContentAt(from, { type: 'image', attrs: { src: data.src, alt: instruction } })
            .run();
        } else {
          // Node has content: insert image after the current node
          editor.chain()
            .focus()
            .insertContentAt(to, { type: 'image', attrs: { src: data.src, alt: instruction } })
            .run();
        }
      } else {
        console.error('[ContextMenu] Image generation failed:', data.error);
      }
    } catch (err) {
      console.error('[ContextMenu] Image generation failed:', err);
    } finally {
      editor.commands.removeLoadingEffect(loadingId);
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
      if (editor) {
        const { from, to } = editor.state.selection;
        editor.state.doc.nodesBetween(from, to, (node) => {
          if (node.isBlock && node.type.name !== 'doc' && node.attrs.id) {
            applyNodeChangesFromBridge(editor, [], [node.attrs.id], 'delete');
          }
        });
      }
      setVisible(false);
      return;
    }
    if (action === 'link') {
      const editor = activeEditorRef.current || editorRef.current;
      if (editor) {
        const hrefs: string[] = [];
        editor.state.doc.descendants((node) => {
          node.marks?.forEach((mark: any) => {
            if (mark.type.name === 'link' && mark.attrs?.href?.startsWith('doc:')) {
              const file = mark.attrs.href.slice(4);
              if (!hrefs.includes(file)) hrefs.push(file);
            }
          });
        });
        setLinkedDocs(hrefs);
      }
      fetch('/api/documents')
        .then((r) => r.json())
        .then((docs) => {
          if (Array.isArray(docs)) {
            setDocList(docs.map((d: any) => ({ filename: d.filename, title: d.title })));
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
    const editor = activeEditorRef.current || editorRef.current;
    const captured = capturedSelection.current;
    if (!editor || !captured || !documentId) return;

    const { from, to, nodeIds } = captured;
    if (from === to || nodeIds.length === 0) return;

    // Get selected text
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
  }, [editorRef, documentId, markNote]);

  const handleLinkSelect = useCallback((filename: string) => {
    const editor = activeEditorRef.current || editorRef.current;
    if (editor) {
      editor.chain().focus().setLink({ href: `doc:${filename}` }).run();
    }
    fetch('/api/auto-tag-link', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetFile: filename }),
    }).catch(() => {});
    setVisible(false);
    setShowLinkPicker(false);
  }, [editorRef]);

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
          editor.chain().focus().setLink({ href: `doc:${data.filename}` }).run();
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
        <div className="context-menu-custom">
          <input
            autoFocus
            value={markNote}
            onChange={(e) => setMarkNote(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleMarkSubmit();
              if (e.key === 'Escape') { setShowMarkInput(false); setMarkNote(''); }
            }}
            placeholder="Note for agent (optional)..."
          />
          <button onClick={handleMarkSubmit}>Mark</button>
        </div>
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
                  .filter((d) => linkedDocs.includes(d.filename))
                  .map(({ filename, title }) => (
                    <button
                      key={`linked-${filename}`}
                      className="context-menu-item"
                      onClick={() => handleLinkSelect(filename)}
                    >
                      <span>{title}</span>
                    </button>
                  ))}
              </>
            )}
            <div className="context-menu-section-header">All documents</div>
            {docList
              .filter((d) => !linkedDocs.includes(d.filename))
              .map(({ filename, title }) => (
                <button
                  key={filename}
                  className="context-menu-item"
                  onClick={() => handleLinkSelect(filename)}
                >
                  <span>{title}</span>
                </button>
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
