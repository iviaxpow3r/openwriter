/**
 * PendingTitleField — shared pending-title decoration for compose views.
 *
 * When an agent stages a title rename (rename_item / set_metadata gates the
 * title through the pending-overlay), the server broadcasts
 * `pending-metadata-changed`; App lifts it into `pendingTitle` and hands it to
 * the active doc's compose view. This component renders the proposed title with
 * the same `.pending-insert` visual body decorations use, and mirrors the
 * right-rail Review panel's focused-slot gutter + Modified/Original toggle (via
 * the `ow-pending-review-cursor` event the ReviewTab dispatches). Accept/Reject
 * lives in the Review panel — there is no inline control here.
 *
 * When no rename is pending it renders `children` unchanged (the view's own
 * editable title element). It is content-type agnostic: each view passes its
 * own `baseClass` (e.g. 'article-title-input', 'blog-title-input') so the
 * decoration inherits that view's title box; the pending modifier is always
 * `${baseClass}--pending`.
 *
 * Extracted from ArticleComposeView so every title-bearing compose view renders
 * the same decoration and the two can't drift — the drift was the bug: a title
 * rename on a non-article doc staged a pending record the Review panel surfaced
 * but the editor title never decorated.
 *
 * adr: adr/pending-overlay-model.md
 */

import { useEffect, useState, type ReactNode } from 'react';

interface PendingTitleFieldProps {
  /** The agent's staged rename for this doc, or null/undefined when none. */
  pendingTitle?: { from: string; to: string } | null;
  /** Active doc id — filters `ow-pending-review-cursor` events to THIS doc so
   *  a background doc's review cursor never lights up this title. */
  docId?: string;
  /** Base CSS class for the title element (e.g. 'article-title-input',
   *  'blog-title-input'). The pending decoration reuses it plus the
   *  `${baseClass}--pending` modifier so the box matches the editable field. */
  baseClass: string;
  /** The view's editable title element, rendered when no rename is pending. */
  children: ReactNode;
}

export default function PendingTitleField({ pendingTitle, docId, baseClass, children }: PendingTitleFieldProps) {
  // Mirror the body's "focused review slot" gutter on the title when ReviewTab
  // signals title is the current cursor, and respond to its Modified/Original
  // toggle by swapping the rendered text between the proposed `to` and the
  // canonical `from`. Body nodes get .pending-active.pending-active--insert
  // from the editor decoration plugin; we apply the same classes on the same
  // trigger. adr: adr/pending-overlay-model.md
  const [titleFocused, setTitleFocused] = useState(false);
  const [titleShowOriginal, setTitleShowOriginal] = useState(false);
  useEffect(() => {
    function handler(e: Event) {
      const detail = (e as CustomEvent).detail as { docId?: string; titleFocused?: boolean; titleShowOriginal?: boolean } | null;
      if (!detail) return;
      if (docId && detail.docId && detail.docId !== docId) return;
      setTitleFocused(!!detail.titleFocused);
      setTitleShowOriginal(!!detail.titleShowOriginal);
    }
    window.addEventListener('ow-pending-review-cursor', handler);
    return () => window.removeEventListener('ow-pending-review-cursor', handler);
  }, [docId]);

  if (!pendingTitle) return <>{children}</>;

  // Outer block keeps layout + box; inner span carries the tint so the colored
  // background only wraps the text — matches body decorations which apply
  // pending-* classes as inline spans.
  return titleShowOriginal ? (
    <div
      className={`${baseClass} ${baseClass}--pending${titleFocused ? ' pending-active pending-active--original' : ''}`}
      title={`Showing original title. Toggle back to Modified to see the agent's proposal "${pendingTitle.to}".`}
      aria-label={`Original title ${pendingTitle.from} (agent proposed ${pendingTitle.to})`}
    >
      <span className="pending-original">{pendingTitle.from}</span>
    </div>
  ) : (
    <div
      className={`${baseClass} ${baseClass}--pending${titleFocused ? ' pending-active pending-active--insert' : ''}`}
      title={`Agent proposed rename from "${pendingTitle.from}". Accept or reject in the Review panel.`}
      aria-label={`Pending title rename from ${pendingTitle.from} to ${pendingTitle.to}`}
    >
      <span className="pending-insert">{pendingTitle.to}</span>
    </div>
  );
}
