/**
 * Floating review panel for navigating and accepting/rejecting pending changes.
 * Supports cross-document navigation when multiple docs have pending changes.
 * Supports multi-editor views (e.g. tweet threads with one editor per tweet).
 * Includes Original/Modified toggle for rewrite changes.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Editor } from '@tiptap/react';
import { usePendingState, derivePendingState } from '../hooks/usePendingState';
import { setPreviewState, isPreviewActive, getSavedModifiedContent, getPreviewGroupId } from '../decorations/plugin';
import { findNodeById, findGroupMembers } from '../decorations/apply';
import type { PendingDocsPayload } from '../ws/client';

const s = { strokeWidth: 1.5, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
const ChevronLeft = () => <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M10 3L5 8l5 5" stroke="currentColor" {...s} /></svg>;
const ChevronRight = () => <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M6 3l5 5-5 5" stroke="currentColor" {...s} /></svg>;
const ChevronUp = () => <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M3 10l5-5 5 5" stroke="currentColor" {...s} /></svg>;
const ChevronDown = () => <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M3 6l5 5 5-5" stroke="currentColor" {...s} /></svg>;
const Check = () => <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M3 8.5l3.5 3.5L13 5" stroke="currentColor" {...s} /></svg>;
const XIcon = () => <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" {...s} /></svg>;

interface ReviewPanelProps {
  editors: Editor[];
  pendingDocs: PendingDocsPayload;
  currentFilename: string;
  onSwitchDocument: (filename: string) => void;
  sendMessage: (msg: Record<string, any>) => void;
  getDocument?: () => any;
  docVersionRef?: React.RefObject<number>;
}

// ============================================================================
// PREVIEW HELPERS
// ============================================================================

/**
 * Replace a node's content in the document, preserving pending attrs.
 * Uses the same deleteRange + insertContentAt pattern as resolve.ts.
 * Suppresses undo history via addToHistory: false.
 */
function replaceNodeContent(editor: Editor, nodeId: string, newContent: any): boolean {
  const result = findNodeById(editor, nodeId);
  if (!result) return false;

  const { pos, node } = result;

  // Build replacement: use newContent's structure but overlay current pending attrs
  const replacement = {
    type: newContent.type || node.type.name,
    attrs: {
      ...(newContent.attrs || {}),
      id: node.attrs.id,
      pendingStatus: node.attrs.pendingStatus,
      pendingOriginalContent: node.attrs.pendingOriginalContent,
      pendingSelectionFrom: node.attrs.pendingSelectionFrom,
      pendingSelectionTo: node.attrs.pendingSelectionTo,
      pendingOriginalFrom: node.attrs.pendingOriginalFrom,
      pendingOriginalTo: node.attrs.pendingOriginalTo,
    },
    content: newContent.content,
  };

  try {
    editor.chain()
      .command(({ tr }) => {
        tr.setMeta('addToHistory', false);
        return true;
      })
      .deleteRange({ from: pos, to: pos + node.nodeSize })
      .insertContentAt(pos, replacement)
      .run();
    return true;
  } catch {
    return false;
  }
}

/**
 * Replace an entire group range in the document. Used for group preview toggle.
 * Suppresses undo history.
 */
function replaceGroupRange(editor: Editor, groupId: string, newContent: any[]): boolean {
  const members = findGroupMembers(editor, groupId);
  if (members.length === 0) return false;

  const rangeFrom = members[0].pos;
  const rangeTo = members[members.length - 1].pos + members[members.length - 1].node.nodeSize;

  try {
    editor.chain()
      .command(({ tr }) => { tr.setMeta('addToHistory', false); return true; })
      .deleteRange({ from: rangeFrom, to: rangeTo })
      .insertContentAt(rangeFrom, newContent)
      .run();
    return true;
  } catch {
    return false;
  }
}

/**
 * Restore modified content if currently previewing original.
 * Returns true if a restoration was performed.
 */
function restoreIfPreviewing(editor: Editor, previewingNodeId: string | null): boolean {
  if (!isPreviewActive() || !previewingNodeId) return false;

  const modified = getSavedModifiedContent();
  const groupId = getPreviewGroupId();

  if (groupId && modified && Array.isArray(modified)) {
    // Group restore: replace the preview range with saved modified members
    replaceGroupRange(editor, groupId, modified);
  } else if (modified) {
    // Single node restore
    replaceNodeContent(editor, previewingNodeId, modified);
  }
  setPreviewState(false);
  return true;
}

export default function ReviewPanel({ editors, pendingDocs, currentFilename, onSwitchDocument, sendMessage, getDocument, docVersionRef }: ReviewPanelProps) {
  const {
    counts,
    currentNode,
    currentIndex,
    hasPending,
    goToNext,
    goToPrevious,
    acceptCurrent,
    rejectCurrent,
    acceptAll,
    rejectAll,
  } = usePendingState(editors);

  const [showOriginal, setShowOriginal] = useState(false);
  const previewNodeIdRef = useRef<string | null>(null);
  const previewEditorRef = useRef<Editor | null>(null);

  const totalPendingDocs = pendingDocs.filenames.length;
  const currentDocIndex = currentDocIndexOf(pendingDocs.filenames, currentFilename);

  const isRewrite = currentNode?.pendingStatus === 'rewrite';
  const isGroup = !!currentNode?.groupId;
  const canPreview = isRewrite;

  // ============================================================================
  // PREVIEW TOGGLE
  // ============================================================================

  const togglePreview = useCallback(() => {
    const editor = currentNode?.editor;
    if (!editor || !currentNode || currentNode.pendingStatus !== 'rewrite') return;

    if (!showOriginal) {
      if (isGroup && currentNode.groupId) {
        // GROUP PREVIEW: save all members, replace range with originals
        const members = findGroupMembers(editor, currentNode.groupId);
        if (members.length === 0) return;

        const originalContent = members[0].node.attrs?.pendingOriginalContent;
        if (!originalContent || !Array.isArray(originalContent)) return;

        // Save current modified members as JSON
        const modifiedJsons = members.map((m) => m.node.toJSON());

        // Build original nodes tagged with group attrs so decorations + restore work
        const previewNodes = originalContent.map((orig: any, i: number) => ({
          ...orig,
          attrs: {
            ...(orig.attrs || {}),
            pendingStatus: 'rewrite',
            pendingGroupId: currentNode.groupId,
            ...(i === 0 ? { pendingOriginalContent: originalContent } : {}),
          },
        }));

        const swapped = replaceGroupRange(editor, currentNode.groupId, previewNodes);
        if (!swapped) return;

        setPreviewState(true, currentNode.nodeId, modifiedJsons, currentNode.groupId);
        previewNodeIdRef.current = currentNode.nodeId;
        previewEditorRef.current = editor;
        setShowOriginal(true);
      } else {
        // SINGLE NODE PREVIEW: save current content, replace with original
        const result = findNodeById(editor, currentNode.nodeId);
        if (!result) return;

        const { node } = result;
        const originalContent = node.attrs?.pendingOriginalContent;
        if (!originalContent) return;

        const modifiedJson = node.toJSON();
        const swapped = replaceNodeContent(editor, currentNode.nodeId, originalContent);
        if (!swapped) return;

        setPreviewState(true, currentNode.nodeId, modifiedJson);
        previewNodeIdRef.current = currentNode.nodeId;
        previewEditorRef.current = editor;
        setShowOriginal(true);
      }
    } else {
      // Switch back to Modified (handles both single + group via restoreIfPreviewing)
      if (previewEditorRef.current) {
        restoreIfPreviewing(previewEditorRef.current, previewNodeIdRef.current);
      }
      previewNodeIdRef.current = null;
      previewEditorRef.current = null;
      setShowOriginal(false);
    }
  }, [currentNode, showOriginal, isGroup]);

  // Auto-restore when navigating away from a previewed node
  useEffect(() => {
    if (!showOriginal) return;

    const prevNodeId = previewNodeIdRef.current;
    const prevEditor = previewEditorRef.current;
    if (prevNodeId && prevEditor && currentNode?.nodeId !== prevNodeId) {
      restoreIfPreviewing(prevEditor, prevNodeId);
      previewNodeIdRef.current = null;
      previewEditorRef.current = null;
      setShowOriginal(false);
    }
  }, [currentNode?.nodeId, showOriginal]);

  // Auto-restore on editors change (document switch)
  useEffect(() => {
    if (editors.length === 0) return;
    return () => {
      if (isPreviewActive() && previewNodeIdRef.current && previewEditorRef.current) {
        restoreIfPreviewing(previewEditorRef.current, previewNodeIdRef.current);
        previewNodeIdRef.current = null;
        previewEditorRef.current = null;
      }
    };
  }, [editors]);

  // ============================================================================
  // RESOLVE ACTIONS (restore preview first)
  // ============================================================================

  const checkResolution = useCallback((action: 'accept' | 'reject') => {
    if (!currentFilename) return;
    // Check if ANY editor still has pending nodes
    const hasRemaining = editors.some(e => {
      if (!e || e.isDestroyed) return false;
      return derivePendingState(e).length > 0;
    });
    if (!hasRemaining) {
      const doc = getDocument?.();
      if (doc) {
        sendMessage({ type: 'doc-update', document: doc, filename: currentFilename, version: docVersionRef?.current ?? 0 });
      }
      sendMessage({ type: 'pending-resolved', filename: currentFilename, action });
    }
  }, [editors, currentFilename, sendMessage, getDocument, docVersionRef]);

  const restorePreviewIfActive = useCallback(() => {
    if (previewEditorRef.current && showOriginal && previewNodeIdRef.current) {
      restoreIfPreviewing(previewEditorRef.current, previewNodeIdRef.current);
      previewNodeIdRef.current = null;
      previewEditorRef.current = null;
      setShowOriginal(false);
    }
  }, [showOriginal]);

  const handleAcceptCurrent = useCallback(() => {
    restorePreviewIfActive();
    acceptCurrent();
    checkResolution('accept');
  }, [restorePreviewIfActive, acceptCurrent, checkResolution]);

  const handleRejectCurrent = useCallback(() => {
    restorePreviewIfActive();
    rejectCurrent();
    checkResolution('reject');
  }, [restorePreviewIfActive, rejectCurrent, checkResolution]);

  const handleAcceptAll = useCallback(() => {
    restorePreviewIfActive();
    acceptAll();
    checkResolution('accept');
  }, [restorePreviewIfActive, acceptAll, checkResolution]);

  // Listen for sidebar approve → auto-accept all pending changes
  useEffect(() => {
    const handler = () => handleAcceptAll();
    window.addEventListener('ow-accept-all', handler);
    return () => window.removeEventListener('ow-accept-all', handler);
  }, [handleAcceptAll]);

  const handleRejectAll = useCallback(() => {
    restorePreviewIfActive();
    rejectAll();
    checkResolution('reject');
  }, [restorePreviewIfActive, rejectAll, checkResolution]);

  // ============================================================================
  // DOC NAVIGATION
  // ============================================================================

  const goToPreviousDoc = useCallback(() => {
    if (totalPendingDocs === 0) return;
    if (totalPendingDocs === 1 && currentDocIndex === 0) return;
    const idx = currentDocIndex <= 0 ? totalPendingDocs - 1 : currentDocIndex - 1;
    onSwitchDocument(pendingDocs.filenames[idx]);
  }, [totalPendingDocs, currentDocIndex, pendingDocs.filenames, onSwitchDocument]);

  const goToNextDoc = useCallback(() => {
    if (totalPendingDocs === 0) return;
    if (totalPendingDocs === 1 && currentDocIndex === 0) return;
    const idx = currentDocIndex >= totalPendingDocs - 1 ? 0 : currentDocIndex + 1;
    onSwitchDocument(pendingDocs.filenames[idx]);
  }, [totalPendingDocs, currentDocIndex, pendingDocs.filenames, onSwitchDocument]);

  // ============================================================================
  // KEYBOARD SHORTCUTS
  // ============================================================================

  useEffect(() => {
    if (!hasPending) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.target instanceof HTMLElement && e.target.closest('[contenteditable]')) return;

      switch (e.key) {
        case 'j':
        case 'ArrowDown':
          if (!e.metaKey && !e.ctrlKey) { e.preventDefault(); goToNext(); }
          break;
        case 'k':
        case 'ArrowUp':
          if (!e.metaKey && !e.ctrlKey) { e.preventDefault(); goToPrevious(); }
          break;
        case 'h':
        case 'ArrowLeft':
          if (!e.metaKey && !e.ctrlKey && !e.altKey) { e.preventDefault(); goToPreviousDoc(); }
          break;
        case 'l':
        case 'ArrowRight':
          if (!e.metaKey && !e.ctrlKey && !e.altKey) { e.preventDefault(); goToNextDoc(); }
          break;
        case 'a':
          if (!e.metaKey && !e.ctrlKey && !e.shiftKey) { e.preventDefault(); handleAcceptCurrent(); }
          break;
        case 'r':
          if (!e.metaKey && !e.ctrlKey) { e.preventDefault(); handleRejectCurrent(); }
          break;
        case 'A':
          if (e.shiftKey && !e.metaKey && !e.ctrlKey) { e.preventDefault(); handleAcceptAll(); }
          break;
        case 'R':
          if (e.shiftKey && !e.metaKey && !e.ctrlKey) { e.preventDefault(); handleRejectAll(); }
          break;
        case 'o':
          if (!e.metaKey && !e.ctrlKey && !e.shiftKey) { e.preventDefault(); togglePreview(); }
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [hasPending, goToNext, goToPrevious, goToPreviousDoc, goToNextDoc, handleAcceptCurrent, handleRejectCurrent, handleAcceptAll, handleRejectAll, togglePreview]);

  if (!hasPending) return null;

  // Compute display index for doc nav (handle -1 gracefully)
  const docDisplayIndex = currentDocIndex >= 0 ? currentDocIndex + 1 : '?';

  return (
    <div className="review-panel">
      {/* Doc navigation — only show when multiple docs have pending */}
      {totalPendingDocs > 1 && (
        <>
          <div className="review-panel__nav">
            <button className="review-panel__btn" onClick={goToPreviousDoc} title="Previous doc (h)"><ChevronLeft /></button>
            <button className="review-panel__btn" onClick={goToNextDoc} title="Next doc (l)"><ChevronRight /></button>
            <span className="review-panel__counter">{docDisplayIndex}/{totalPendingDocs}</span>
          </div>
          <div className="review-panel__divider" />
        </>
      )}

      {/* Change nav + counter merged */}
      <div className="review-panel__nav">
        <button className="review-panel__btn" onClick={goToPrevious} disabled={counts.total === 0} title="Previous (k)"><ChevronUp /></button>
        <button className="review-panel__btn" onClick={goToNext} disabled={counts.total === 0} title="Next (j)"><ChevronDown /></button>
        <span className="review-panel__counter">
          {currentIndex + 1}/{counts.total}
        </span>
      </div>

      {/* Original/Modified toggle — always reserves space, disabled for non-rewrites and groups */}
      <div className="review-panel__divider" />
      <div className="review-panel__toggle">
        <button
          className={`review-panel__toggle-btn${canPreview && !showOriginal ? ' review-panel__toggle-btn--active' : ''}`}
          onClick={() => canPreview && showOriginal && togglePreview()}
          disabled={!canPreview}
          title="Show modified (o)"
        >
          Modified
        </button>
        <button
          className={`review-panel__toggle-btn${canPreview && showOriginal ? ' review-panel__toggle-btn--active' : ''}`}
          onClick={() => canPreview && !showOriginal && togglePreview()}
          disabled={!canPreview}
          title="Show original (o)"
        >
          Original
        </button>
      </div>

      <div className="review-panel__divider" />

      {/* Actions: single then bulk */}
      <div className="review-panel__actions">
        <button className="review-panel__accept" onClick={handleAcceptCurrent} title="Accept (a)"><Check /></button>
        <button className="review-panel__reject" onClick={handleRejectCurrent} title="Reject (r)"><XIcon /></button>
        <button className="review-panel__accept-all" onClick={handleAcceptAll} title="Accept all (Shift+A)"><Check /><span>All</span></button>
        <button className="review-panel__reject-all" onClick={handleRejectAll} title="Reject all (Shift+R)"><XIcon /><span>All</span></button>
      </div>
    </div>
  );
}

function currentDocIndexOf(filenames: string[], current: string): number {
  return filenames.indexOf(current);
}
