/**
 * Exports tab — download the active document in various formats.
 * Migrated from src/export/ExportPanel.tsx (titlebar dropdown).
 * adr: adr/right-rail.md
 */
import type { JSX } from 'react';
import type { RightRailTabProps } from '../types';

interface ExportFormat {
  key: string;
  label: string;
  desc: string;
  icon: JSX.Element;
}

const FORMATS: ExportFormat[] = [
  {
    key: 'md', label: 'Markdown', desc: 'Plain .md file',
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <path d="M14 2v6h6" />
      </svg>
    ),
  },
  {
    key: 'html', label: 'HTML', desc: 'Styled web page',
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="16 18 22 12 16 6" />
        <polyline points="8 6 2 12 8 18" />
      </svg>
    ),
  },
  {
    key: 'docx', label: 'Word', desc: 'Microsoft Word .docx',
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <path d="M14 2v6h6" />
        <path d="M16 13H8" />
        <path d="M16 17H8" />
        <path d="M10 9H8" />
      </svg>
    ),
  },
  {
    key: 'txt', label: 'Plain Text', desc: 'Unformatted .txt file',
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M17 6.1H3" />
        <path d="M21 12.1H3" />
        <path d="M15.1 18H3" />
      </svg>
    ),
  },
  {
    key: 'pdf', label: 'PDF', desc: 'Print preview for save as PDF',
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="6 9 6 2 18 2 18 9" />
        <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
        <rect x="6" y="14" width="12" height="8" />
      </svg>
    ),
  },
];

export default function ExportsTab(_props: RightRailTabProps) {
  const handleExport = (format: string) => {
    if (format === 'pdf') {
      window.open('/api/export?format=pdf', '_blank');
      return;
    }
    const a = document.createElement('a');
    a.href = `/api/export?format=${format}`;
    a.download = '';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  return (
    <div className="exports-tab">
      <div className="exports-tab__list">
        {FORMATS.map((f) => (
          <button
            key={f.key}
            type="button"
            className="exports-tab__item"
            onClick={() => handleExport(f.key)}
          >
            <span className="exports-tab__item-icon">{f.icon}</span>
            <span className="exports-tab__item-text">
              <span className="exports-tab__item-label">{f.label}</span>
              <span className="exports-tab__item-desc">{f.desc}</span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
