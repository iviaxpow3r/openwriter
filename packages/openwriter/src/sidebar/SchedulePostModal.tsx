import { useEffect, useState } from 'react';
import './SchedulePostModal.css';

interface SchedulePostModalProps {
  filename: string;
  title: string;
  onClose: () => void;
}

/** Infer content type from document frontmatter. */
function inferContentType(meta: Record<string, any>): string {
  if (meta.tweetContext) return 'tweet';
  if (meta.articleContext) return 'article';
  return 'tweet'; // default
}

export default function SchedulePostModal({ filename, title, onClose }: SchedulePostModalProps) {
  const [mode, setMode] = useState<'queue' | 'now' | 'custom'>('queue');
  const [contentType, setContentType] = useState<string | null>(null);
  const [text, setText] = useState<string | null>(null);
  const [customTime, setCustomTime] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<{ success: boolean; message: string } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Load document metadata on mount to infer content type
  useEffect(() => {
    fetch(`/api/documents/${encodeURIComponent(filename)}/text`)
      .then(r => {
        if (!r.ok) throw new Error('Failed to load document');
        return r.json();
      })
      .then(doc => {
        setText(doc.text || '');
        setContentType(inferContentType(doc.meta || {}));
      })
      .catch(err => setLoadError(err.message));
  }, [filename]);

  const handleSubmit = async () => {
    if (!text || !contentType) return;
    setSubmitting(true);
    try {
      const body: Record<string, string> = {
        content: text,
        content_type: contentType,
        mode,
      };
      if (mode === 'custom' && customTime) {
        body.scheduled_at = new Date(customTime).toISOString();
      }

      const res = await fetch('/api/scheduler/queue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      const data = await res.json();
      if (res.ok) {
        const time = data.item?.scheduled_at
          ? new Date(data.item.scheduled_at).toLocaleString()
          : 'now';
        setResult({ success: true, message: `Scheduled for ${time}` });
      } else {
        setResult({ success: false, message: data.error || 'Failed to schedule' });
      }
    } catch (err: any) {
      setResult({ success: false, message: err.message });
    } finally {
      setSubmitting(false);
    }
  };

  const loading = contentType === null && !loadError;

  return (
    <div className="schedule-post-overlay" onClick={onClose}>
      <div className="schedule-post-modal" onClick={e => e.stopPropagation()}>
        <div className="schedule-post-modal-header">
          <h3>Schedule Post</h3>
          <button className="schedule-post-modal-close" onClick={onClose}>&times;</button>
        </div>

        <div className="schedule-post-modal-doc">{title}</div>

        {loadError ? (
          <div className="schedule-post-modal-result error">
            {loadError}
            <button className="schedule-post-modal-done" onClick={onClose}>Done</button>
          </div>
        ) : result ? (
          <div className={`schedule-post-modal-result ${result.success ? 'success' : 'error'}`}>
            {result.message}
            <button className="schedule-post-modal-done" onClick={onClose}>Done</button>
          </div>
        ) : (
          <>
            <div className="schedule-post-modal-field">
              <label>Content Type</label>
              <div className="schedule-post-modal-type">{loading ? '...' : contentType}</div>
            </div>

            <div className="schedule-post-modal-field">
              <label>Mode</label>
              <div className="schedule-post-modal-modes">
                <button
                  className={`schedule-post-mode ${mode === 'queue' ? 'active' : ''}`}
                  onClick={() => setMode('queue')}
                >
                  Queue Next
                </button>
                <button
                  className={`schedule-post-mode ${mode === 'now' ? 'active' : ''}`}
                  onClick={() => setMode('now')}
                >
                  Post Now
                </button>
                <button
                  className={`schedule-post-mode ${mode === 'custom' ? 'active' : ''}`}
                  onClick={() => setMode('custom')}
                >
                  Custom Time
                </button>
              </div>
            </div>

            {mode === 'custom' && (
              <div className="schedule-post-modal-field">
                <label>Date & Time</label>
                <input
                  type="datetime-local"
                  value={customTime}
                  onChange={e => setCustomTime(e.target.value)}
                />
              </div>
            )}

            <div className="schedule-post-modal-actions">
              <button className="schedule-post-modal-cancel" onClick={onClose}>Cancel</button>
              <button
                className="schedule-post-modal-submit"
                onClick={handleSubmit}
                disabled={submitting || loading || (mode === 'custom' && !customTime)}
              >
                {submitting ? 'Scheduling...' : mode === 'now' ? 'Post Now' : 'Schedule'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
