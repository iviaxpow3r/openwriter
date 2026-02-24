/**
 * Floating review panel for navigating and accepting/rejecting pending changes.
 * Supports cross-document navigation when multiple docs have pending changes.
 * Includes Original/Modified toggle for rewrite changes.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Editor } from '@tiptap/react';
import { usePendingState, derivePendingState } from '../hooks/usePendingState';
import { setPreviewState, isPreviewActive, getSavedModifiedContent } from '../decorations/plugin';
import { findNodeById } from '../decorations/apply';
import type { PendingDocsPayload } from '../ws/client';

const s = { strokeWidth: 1.5, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
const ChevronLeft = () => <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M10 3L5 8l5 5" stroke="currentColor" {...s} /></svg>;
const ChevronRight = () => <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M6 3l5 5-5 5" stroke="currentColor" {...s} /></svg>;
const ChevronUp = () => <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M3 10l5-5 5 5" stroke="currentColor" {...s} /></svg>;
const ChevronDown = () => <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M3 6l5 5 5-5" stroke="currentColor" {...s} /></svg>;
const Check = () => <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M3 8.5l3.5 3.5L13 5" stroke="currentColor" {...s} /></svg>;
const XIcon = () => <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" {...s} /></svg>;

interface ReviewPanelProps {
  editor: Editor | null;
  pendingDocs: PendingDocsPayload;
  currentFilename: string;
  onSwitchDocument: (filename: string) => void;
  sendMessage: (msg: Record<string, any>) => void;
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
      pendingTextEdits: node.attrs.pendingTextEdits,
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
 * Restore modified content if currently previewing original.
 * Returns true if a restoration was performed.
 */
function restoreIfPreviewing(editor: Editor, previewingNodeId: string | null): boolean {
  if (!isPreviewActive() || !previewingNodeId) return false;

  const modified = getSavedModifiedContent();
  if (modified) {
    replaceNodeContent(editor, previewingNodeId, modified);
  }
  setPreviewState(false);
  return true;
}

export default function ReviewPanel({ editor, pendingDocs, currentFilename, onSwitchDocument, sendMessage }: ReviewPanelProps) {
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
  } = usePendingState(editor);

  const [showOriginal, setShowOriginal] = useState(false);
  const previewNodeIdRef = useRef<string | null>(null);

  const totalPendingDocs = pendingDocs.filenames.length;
  const otherPendingDocs = currentDocIndexOf(pendingDocs.filenames, currentFilename) >= 0
    ? totalPendingDocs - 1
    : totalPendingDocs;
  const hasAnyPending = hasPending || totalPendingDocs > 0;
  const currentDocIndex = currentDocIndexOf(pendingDocs.filenames, currentFilename);

  const isRewrite = currentNode?.pendingStatus === 'rewrite';

  // ============================================================================
  // PREVIEW TOGGLE
  // ============================================================================

  const togglePreview = useCallback(() => {
    if (!editor || !currentNode || currentNode.pendingStatus !== 'rewrite') return;

    if (!showOriginal) {
      // Switch to Original: save current (modified) content, replace with original
      const result = findNodeById(editor, currentNode.nodeId);
      if (!result) return;

      const { node } = result;
      const originalContent = node.attrs?.pendingOriginalContent;
      if (!originalContent) return;

      // Save the current modified content as JSON BEFORE swapping
      const modifiedJson = node.toJSON();

      // Replace node content with original — only update state on success
      const swapped = replaceNodeContent(editor, currentNode.nodeId, originalContent);
      if (!swapped) return;

      setPreviewState(true, currentNode.nodeId, modifiedJson);
      previewNodeIdRef.current = currentNode.nodeId;
      setShowOriginal(true);
    } else {
      // Switch back to Modified
      restoreIfPreviewing(editor, previewNodeIdRef.current);
      previewNodeIdRef.current = null;
      setShowOriginal(false);
    }
  }, [editor, currentNode, showOriginal]);

  // Auto-restore when navigating away from a previewed node
  useEffect(() => {
    if (!editor || !showOriginal) return;

    const prevNodeId = previewNodeIdRef.current;
    if (prevNodeId && currentNode?.nodeId !== prevNodeId) {
      restoreIfPreviewing(editor, prevNodeId);
      previewNodeIdRef.current = null;
      setShowOriginal(false);
    }
  }, [editor, currentNode?.nodeId, showOriginal]);

  // Auto-restore on editor change (document switch)
  useEffect(() => {
    if (!editor) return;
    return () => {
      if (isPreviewActive() && previewNodeIdRef.current) {
        restoreIfPreviewing(editor, previewNodeIdRef.current);
        previewNodeIdRef.current = null;
      }
    };
  }, [editor]);

  // ============================================================================
  // RESOLVE ACTIONS (restore preview first)
  // ============================================================================

  const checkResolution = useCallback((action: 'accept' | 'reject') => {
    if (!editor || !currentFilename) return;
    const remaining = derivePendingState(editor);
    if (remaining.length === 0) {
      sendMessage({ type: 'doc-update', document: editor.getJSON(), filename: currentFilename });
      sendMessage({ type: 'pending-resolved', filename: currentFilename, action });
    }
  }, [editor, currentFilename, sendMessage]);

  const handleAcceptCurrent = useCallback(() => {
    if (editor && showOriginal && previewNodeIdRef.current) {
      restoreIfPreviewing(editor, previewNodeIdRef.current);
      previewNodeIdRef.current = null;
      setShowOriginal(false);
    }
    acceptCurrent();
    checkResolution('accept');
  }, [editor, showOriginal, acceptCurrent, checkResolution]);

  const handleRejectCurrent = useCallback(() => {
    if (editor && showOriginal && previewNodeIdRef.current) {
      restoreIfPreviewing(editor, previewNodeIdRef.current);
      previewNodeIdRef.current = null;
      setShowOriginal(false);
    }
    rejectCurrent();
    checkResolution('reject');
  }, [editor, showOriginal, rejectCurrent, checkResolution]);

  const handleAcceptAll = useCallback(() => {
    if (editor && showOriginal && previewNodeIdRef.current) {
      restoreIfPreviewing(editor, previewNodeIdRef.current);
      previewNodeIdRef.current = null;
      setShowOriginal(false);
    }
    acceptAll();
    checkResolution('accept');
  }, [editor, showOriginal, acceptAll, checkResolution]);

  const handleRejectAll = useCallback(() => {
    if (editor && showOriginal && previewNodeIdRef.current) {
      restoreIfPreviewing(editor, previewNodeIdRef.current);
      previewNodeIdRef.current = null;
      setShowOriginal(false);
    }
    rejectAll();
    checkResolution('reject');
  }, [editor, showOriginal, rejectAll, checkResolution]);

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
    if (!hasAnyPending) return;

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
  }, [hasAnyPending, goToNext, goToPrevious, goToPreviousDoc, goToNextDoc, handleAcceptCurrent, handleRejectCurrent, handleAcceptAll, handleRejectAll, togglePreview]);

  if (!hasAnyPending) return null;

  const changeType = currentNode?.pendingStatus || 'rewrite';
  const dotClass = `review-panel__dot review-panel__dot--${changeType}`;

  // Current doc has no pending but others do
  if (!hasPending && otherPendingDocs > 0) {
    return (
      <div className="review-panel">
        <div className="review-panel__status">
          No changes here &mdash; {otherPendingDocs} other doc{otherPendingDocs > 1 ? 's have' : ' has'} changes
        </div>
        <div className="review-panel__divider" />
        <div className="review-panel__nav">
          <button
            className="review-panel__btn"
            onClick={goToNextDoc}
            title="Next doc (l)"
          >
            <ChevronRight />
          </button>
        </div>
      </div>
    );
  }

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
        <button className="review-panel__btn" onClick={goToPrevious} disabled={counts.total <= 1} title="Previous (k)"><ChevronUp /></button>
        <button className="review-panel__btn" onClick={goToNext} disabled={counts.total <= 1} title="Next (j)"><ChevronDown /></button>
        <span className="review-panel__counter">
          {currentIndex + 1}/{counts.total}
        </span>
      </div>

      {/* Original/Modified toggle — always reserves space, disabled for non-rewrites */}
      <div className="review-panel__divider" />
      <div className="review-panel__toggle">
        <button
          className={`review-panel__toggle-btn${isRewrite && !showOriginal ? ' review-panel__toggle-btn--active' : ''}`}
          onClick={() => isRewrite && showOriginal && togglePreview()}
          disabled={!isRewrite}
          title="Show modified (o)"
        >
          Modified
        </button>
        <button
          className={`review-panel__toggle-btn${isRewrite && showOriginal ? ' review-panel__toggle-btn--active' : ''}`}
          onClick={() => isRewrite && !showOriginal && togglePreview()}
          disabled={!isRewrite}
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
