/**
 * Review tab — pending agent changes for the active doc.
 *
 * Migrated from src/review/ReviewPanel.tsx (which lived as a floating
 * action bar at the bottom of the editor). Same logic, restructured for
 * a vertical rail body. Auto-open of this tab when pending writes arrive
 * lives in RightRail.tsx — this component is just the body.
 *
 * adr: adr/right-rail.md
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Editor } from '@tiptap/react';
import { usePendingState, derivePendingState } from '../../hooks/usePendingState';
import { setPreviewState, isPreviewActive, getSavedModifiedContent, getPreviewGroupId } from '../../decorations/plugin';
import { findNodeById, findGroupMembers } from '../../decorations/apply';
import type { RightRailTabProps } from '../types';

const s = { strokeWidth: 1.5, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
const ChevronLeft = () => <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M10 3L5 8l5 5" stroke="currentColor" {...s} /></svg>;
const ChevronRight = () => <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M6 3l5 5-5 5" stroke="currentColor" {...s} /></svg>;
const ChevronUp = () => <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M3 10l5-5 5 5" stroke="currentColor" {...s} /></svg>;
const ChevronDown = () => <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M3 6l5 5 5-5" stroke="currentColor" {...s} /></svg>;
const Check = () => <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M3 8.5l3.5 3.5L13 5" stroke="currentColor" {...s} /></svg>;
const XIcon = () => <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" {...s} /></svg>;

function replaceNodeContent(editor: Editor, nodeId: string, newContent: any): boolean {
  const result = findNodeById(editor, nodeId);
  if (!result) return false;
  const { pos, node } = result;
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
      .command(({ tr }) => { tr.setMeta('addToHistory', false); return true; })
      .deleteRange({ from: pos, to: pos + node.nodeSize })
      .insertContentAt(pos, replacement)
      .run();
    return true;
  } catch { return false; }
}

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
  } catch { return false; }
}

function restoreIfPreviewing(editor: Editor, previewingNodeId: string | null): boolean {
  if (!isPreviewActive() || !previewingNodeId) return false;
  const modified = getSavedModifiedContent();
  const groupId = getPreviewGroupId();
  if (groupId && modified && Array.isArray(modified)) {
    replaceGroupRange(editor, previewingNodeId, modified);
  } else if (modified) {
    replaceNodeContent(editor, previewingNodeId, modified);
  }
  setPreviewState(false);
  return true;
}

function currentDocIndexOf(filenames: string[], current: string): number {
  return filenames.indexOf(current);
}

export default function ReviewTab({
  editors,
  pendingDocs,
  currentFilename,
  onSwitchDocument,
  sendMessage,
  getDocument,
  docVersionRef,
}: RightRailTabProps) {
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

  const togglePreview = useCallback(() => {
    const editor = currentNode?.editor;
    if (!editor || !currentNode || currentNode.pendingStatus !== 'rewrite') return;

    if (!showOriginal) {
      if (isGroup && currentNode.groupId) {
        const members = findGroupMembers(editor, currentNode.groupId);
        if (members.length === 0) return;
        const originalContent = members[0].node.attrs?.pendingOriginalContent;
        if (!originalContent || !Array.isArray(originalContent)) return;
        const modifiedJsons = members.map((m) => m.node.toJSON());
        const previewNodes = originalContent.map((orig: any, i: number) => ({
          ...orig,
          attrs: {
            ...(orig.attrs || {}),
            pendingStatus: 'rewrite',
            pendingGroupId: currentNode.groupId,
            ...(i === 0 ? { pendingOriginalContent: originalContent } : {}),
          },
        }));
        setPreviewState(true, currentNode.nodeId, modifiedJsons, currentNode.groupId);
        const swapped = replaceGroupRange(editor, currentNode.groupId, previewNodes);
        if (!swapped) {
          setPreviewState(false);
          return;
        }
        previewNodeIdRef.current = currentNode.nodeId;
        previewEditorRef.current = editor;
        setShowOriginal(true);
      } else {
        const result = findNodeById(editor, currentNode.nodeId);
        if (!result) return;
        const { node } = result;
        const originalContent = node.attrs?.pendingOriginalContent;
        if (!originalContent) return;
        const modifiedJson = node.toJSON();
        setPreviewState(true, currentNode.nodeId, modifiedJson);
        const swapped = replaceNodeContent(editor, currentNode.nodeId, originalContent);
        if (!swapped) {
          setPreviewState(false);
          return;
        }
        previewNodeIdRef.current = currentNode.nodeId;
        previewEditorRef.current = editor;
        setShowOriginal(true);
      }
    } else {
      if (previewEditorRef.current) {
        restoreIfPreviewing(previewEditorRef.current, previewNodeIdRef.current);
      }
      previewNodeIdRef.current = null;
      previewEditorRef.current = null;
      setShowOriginal(false);
    }
  }, [currentNode, showOriginal, isGroup]);

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

  const checkResolution = useCallback((action: 'accept' | 'reject') => {
    if (!currentFilename) return;
    const hasRemaining = editors.some((e) => {
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

  // External "approve all" event from the sidebar context menu.
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

  // Global keyboard shortcuts — only active when there's pending work.
  useEffect(() => {
    if (!hasPending) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.target instanceof HTMLElement && e.target.closest('[contenteditable]')) return;

      switch (e.key) {
        case 'j': case 'ArrowDown':
          if (!e.metaKey && !e.ctrlKey) { e.preventDefault(); goToNext(); } break;
        case 'k': case 'ArrowUp':
          if (!e.metaKey && !e.ctrlKey) { e.preventDefault(); goToPrevious(); } break;
        case 'h': case 'ArrowLeft':
          if (!e.metaKey && !e.ctrlKey && !e.altKey) { e.preventDefault(); goToPreviousDoc(); } break;
        case 'l': case 'ArrowRight':
          if (!e.metaKey && !e.ctrlKey && !e.altKey) { e.preventDefault(); goToNextDoc(); } break;
        case 'a':
          if (!e.metaKey && !e.ctrlKey && !e.shiftKey) { e.preventDefault(); handleAcceptCurrent(); } break;
        case 'r':
          if (!e.metaKey && !e.ctrlKey) { e.preventDefault(); handleRejectCurrent(); } break;
        case 'A':
          if (e.shiftKey && !e.metaKey && !e.ctrlKey) { e.preventDefault(); handleAcceptAll(); } break;
        case 'R':
          if (e.shiftKey && !e.metaKey && !e.ctrlKey) { e.preventDefault(); handleRejectAll(); } break;
        case 'o':
          if (!e.metaKey && !e.ctrlKey && !e.shiftKey) { e.preventDefault(); togglePreview(); } break;
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [hasPending, goToNext, goToPrevious, goToPreviousDoc, goToNextDoc, handleAcceptCurrent, handleRejectCurrent, handleAcceptAll, handleRejectAll, togglePreview]);

  const docDisplayIndex = currentDocIndex >= 0 ? currentDocIndex + 1 : '?';

  // Genuinely all clear — nothing pending anywhere in the profile.
  if (!hasPending && totalPendingDocs === 0) {
    return (
      <div className="review-tab__empty">
        <div className="review-tab__empty-title">All caught up</div>
        <div className="review-tab__empty-note">No pending agent changes. New writes from agents will land here for review.</div>
      </div>
    );
  }

  // Current doc is resolved but other docs still have pending changes — keep
  // the doc navigator visible so the user can jump to the next pending doc.
  if (!hasPending && totalPendingDocs > 0) {
    return (
      <div className="review-tab">
        <div className="review-tab__section">
          <div className="review-tab__section-label">Document</div>
          <div className="review-tab__row">
            <button className="review-panel__btn" onClick={goToPreviousDoc} title="Previous doc (h)"><ChevronLeft /></button>
            <span className="review-panel__counter">{docDisplayIndex} / {totalPendingDocs}</span>
            <button className="review-panel__btn" onClick={goToNextDoc} title="Next doc (l)"><ChevronRight /></button>
          </div>
        </div>
        <div className="review-tab__empty review-tab__empty--inline">
          <div className="review-tab__empty-title">This doc is up to date</div>
          <div className="review-tab__empty-note">
            {totalPendingDocs} {totalPendingDocs === 1 ? 'doc has' : 'docs have'} pending changes. Use the arrows to navigate.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="review-tab">
      {totalPendingDocs > 1 && (
        <div className="review-tab__section">
          <div className="review-tab__section-label">Document</div>
          <div className="review-tab__row">
            <button className="review-panel__btn" onClick={goToPreviousDoc} title="Previous doc (h)"><ChevronLeft /></button>
            <span className="review-panel__counter">{docDisplayIndex} / {totalPendingDocs}</span>
            <button className="review-panel__btn" onClick={goToNextDoc} title="Next doc (l)"><ChevronRight /></button>
          </div>
        </div>
      )}

      <div className="review-tab__section">
        <div className="review-tab__section-label">Change</div>
        <div className="review-tab__row">
          <button className="review-panel__btn" onClick={goToPrevious} disabled={counts.total === 0} title="Previous (k)"><ChevronUp /></button>
          <span className="review-panel__counter">{currentIndex + 1} / {counts.total}</span>
          <button className="review-panel__btn" onClick={goToNext} disabled={counts.total === 0} title="Next (j)"><ChevronDown /></button>
        </div>
      </div>

      <div className="review-tab__section">
        <div className="review-tab__toggle">
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
      </div>

      <div className="review-tab__section review-tab__section--actions">
        <div className="review-tab__row">
          <button className="review-panel__accept review-tab__action-btn" onClick={handleAcceptCurrent} title="Accept (a)"><Check /><span>Accept</span></button>
          <button className="review-panel__reject review-tab__action-btn" onClick={handleRejectCurrent} title="Reject (r)"><XIcon /><span>Reject</span></button>
        </div>
        <div className="review-tab__row">
          <button className="review-panel__accept-all review-tab__action-btn" onClick={handleAcceptAll} title="Accept all (Shift+A)"><Check /><span>Accept All</span></button>
          <button className="review-panel__reject-all review-tab__action-btn" onClick={handleRejectAll} title="Reject all (Shift+R)"><XIcon /><span>Reject All</span></button>
        </div>
      </div>
    </div>
  );
}
