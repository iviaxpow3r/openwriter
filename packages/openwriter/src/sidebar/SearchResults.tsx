import type { SearchResult } from './sidebar-types';
import { formatDate } from './sidebar-utils';

interface SearchResultsProps {
  results: SearchResult[];
  query: string;
  onSwitchDocument: (filename: string) => void;
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

export default function SearchResults({ results, query, onSwitchDocument }: SearchResultsProps) {
  if (results.length === 0) {
    return (
      <div className="sidebar-scroll">
        <div className="search-empty">No results for "{query}"</div>
      </div>
    );
  }

  return (
    <div className="sidebar-scroll">
      <div className="search-results">
        {results.map(r => (
          <div
            key={r.filename}
            className={`sidebar-item search-result-item ${r.isActive ? 'active' : ''}`}
            onClick={() => onSwitchDocument(r.filename)}
          >
            <div className="sidebar-item-title">
              <span className="sidebar-item-title-text">
                {r.matchType === 'title' ? highlightText(r.title, query) : r.title}
              </span>
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
        ))}
      </div>
    </div>
  );
}
