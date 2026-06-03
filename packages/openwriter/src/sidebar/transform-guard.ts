/**
 * Client-side size guard for document transforms (the "ify" commands —
 * Vary / Shrinkify / Expandify / Threadify / Storify / Emailify / Postify).
 *
 * Transforms run the WHOLE document through a model call + the publish plumbing,
 * so an oversized doc means unbounded cost + time. This mirrors the AV apply-editor
 * selection guard in `context-menu/ContextMenu.tsx`: same unit (words), same toast
 * UX (utils/toast `showToast(..., 'error')`), so the two feel identical. We cancel
 * before the request fires — the user gets instant feedback, not a wasted round-trip.
 *
 * Sidebar transform actions are exactly the focus-promptable plugin items
 * (`promptForFocus`), so we gate on that — other plugin actions pass through.
 */
import { showToast } from '../utils/toast';
import type { SidebarMenuItem } from './SidebarContextMenu';
import type { DocumentInfo } from './sidebar-types';

/** Word cap for a whole-document transform — matches the AV guard's 5000-word cap. */
export const MAX_TRANSFORM_WORDS = 5000;

/**
 * True if this transform should be BLOCKED for being too large (and fires the toast).
 * Only gates focus-promptable transform actions; returns false (passes through) for
 * non-transform items or when the doc's size is unknown.
 */
export function transformExceedsSizeCap(
  item: Pick<SidebarMenuItem, 'promptForFocus'>,
  doc: DocumentInfo | undefined,
): boolean {
  if (!item.promptForFocus || !doc) return false;
  if (doc.wordCount > MAX_TRANSFORM_WORDS) {
    showToast(
      `Document too large to transform: ${doc.wordCount.toLocaleString()} words (max ${MAX_TRANSFORM_WORDS.toLocaleString()}). Trim it down first.`,
      'error',
    );
    return true;
  }
  return false;
}
