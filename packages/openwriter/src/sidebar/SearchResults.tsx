import type { SearchResult, SidebarActions } from './sidebar-types';
import { formatDate } from './sidebar-utils';

interface SearchResultsProps {
  results: SearchResult[];
  query: string;
  onSwitchDocument: (filename: string) => void;
  actions: SidebarActions;
}

/** Highlight matching text with <mark> tags. */
function highlightText(text: string, query: string): (string | JSX.Element)[] {
  if (!query) return [text];
  const parts: (string | JSX.Element)[] = [];
  const lower = text.toLowerCase();
  const q = query.toLowerCase();
  let cursor = 0;

  while (cursor < text.length) {
    const idx = lower.indexOf(q, cursor);
    if (idx === -1) {
      parts.push(text.slice(cursor));
      break;
    }
    if (idx > cursor) parts.push(text.slice(cursor, idx));
    parts.push(<mark key={idx}>{text.slice(idx, idx + query.length)}</mark>);
    cursor = idx + query.length;
  }

  return parts;
}

function ResultItem({ r, query, onClick }: { r: SearchResult; query: string; onClick: () => void }) {
  return (
    <div
      className={`sidebar-item search-result-item ${r.isActive ? 'active' : ''} ${r.isArchived ? 'search-result-archived' : ''}`}
      onClick={onClick}
    >
      <div className="sidebar-item-title">
        <span className="sidebar-item-title-text">
          {r.matchType === 'title' ? highlightText(r.title, query) : r.title}
        </span>
        {r.isArchived && <span className="search-archived-badge">archived</span>}
      </div>
      {r.matchType === 'tag' && r.matchedTag && (
        <div className="search-result-tag">
          Tag: {highlightText(r.matchedTag, query)}
        </div>
      )}
      {r.matchType === 'content' && r.snippet && (
        <div className="search-result-snippet">
          {highlightText(r.snippet, query)}
        </div>
      )}
      <div className="sidebar-item-meta">
        {r.wordCount.toLocaleString()} words &middot; {formatDate(r.lastModified)}
      </div>
    </div>
  );
}

export default function SearchResults({ results, query, onSwitchDocument, actions }: SearchResultsProps) {
  if (results.length === 0) {
    return (
      <div className="sidebar-scroll">
        <div className="search-empty">No results for "{query}"</div>
      </div>
    );
  }

  const activeResults = results.filter(r => !r.isArchived);
  const archivedResults = results.filter(r => r.isArchived);

  return (
    <div className="sidebar-scroll">
      <div className="search-results">
        {activeResults.map(r => (
          <ResultItem key={r.filename} r={r} query={query} onClick={() => onSwitchDocument(r.filename)} />
        ))}
        {archivedResults.length > 0 && (
          <>
            <div className="search-archived-divider">
              <span>Archived</span>
            </div>
            {archivedResults.map(r => (
              <ResultItem key={r.filename} r={r} query={query} onClick={() => actions.handleUnarchive(r.filename)} />
            ))}
          </>
        )}
      </div>
    </div>
  );
}
