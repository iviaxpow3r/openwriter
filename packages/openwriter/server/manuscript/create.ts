/**
 * Helpers for creating a manuscript binding from an ordered document selection.
 *
 * The manuscript engine deliberately has no chapter or book-specific concepts:
 * this produces the same ordinary `doc:` pointer list an author can edit in a
 * manuscript manifest. The selected documents retain their own structure.
 */

export interface ManuscriptBindingSource {
  docId: string;
  title: string;
}

function escapeLinkText(value: string): string {
  return value.replace(/([\\\[\]])/g, '\\$1');
}

/** Build the normal manifest body in the exact order selected by the author. */
export function buildManuscriptBinding(sources: ManuscriptBindingSource[]): string {
  return sources
    .map(({ docId, title }) => `[${escapeLinkText(title)}](<doc:${docId}>)`)
    .join('\n\n');
}

/** Keep the binding distinct in navigation while retaining a clean book title. */
export function manuscriptDocumentTitle(bookTitle: string): string {
  const trimmed = bookTitle.trim();
  return /\s*[—–-]\s*manuscript\s*$/i.test(trimmed)
    ? trimmed
    : `${trimmed} — Manuscript`;
}
