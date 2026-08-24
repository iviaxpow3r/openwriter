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

/** The only blocks a manuscript binding may contain. Source prose always
 * remains in its own document, where its history and review state belong. */
export type ManuscriptStructureItem =
  | { kind: 'doc'; docId: string; title: string }
  | { kind: 'heading'; text: string; level: number }
  | { kind: 'toc' };

function escapeLinkText(value: string): string {
  return value.replace(/([\\\[\]])/g, '\\$1');
}

/** Build the normal manifest body in the exact order selected by the author. */
export function buildManuscriptBinding(sources: ManuscriptBindingSource[]): string {
  return sources
    .map(({ docId, title }) => `[${escapeLinkText(title)}](<doc:${docId}>)`)
    .join('\n\n');
}

/** Serialize the constrained manuscript structure back to its portable
 * markdown representation. There is deliberately no generic text case. */
export function buildManuscriptStructure(items: ManuscriptStructureItem[]): string {
  return items
    .map((item) => {
      if (item.kind === 'toc') return '{{toc}}';
      if (item.kind === 'heading') return `${'#'.repeat(item.level)} ${item.text.trim()}`;
      return `[${escapeLinkText(item.title)}](<doc:${item.docId}>)`;
    })
    .join('\n\n');
}

/** Keep the binding distinct in navigation while retaining a clean book title. */
export function manuscriptDocumentTitle(bookTitle: string): string {
  const trimmed = bookTitle.trim();
  return /\s*[—–-]\s*manuscript\s*$/i.test(trimmed)
    ? trimmed
    : `${trimmed} — Manuscript`;
}
