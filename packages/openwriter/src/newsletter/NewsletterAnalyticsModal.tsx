import { useState, useEffect, useRef } from 'react';
import './NewsletterComposeModal.css';

interface NewsletterAnalyticsModalProps {
  docId: string;
  title: string;
  onClose: () => void;
}

interface Stats {
  opens: { unique: number; total: number };
  clicks: { unique: number; total: number };
  bounces: number;
  unsubscribes: number;
}

type Stage = 'loading' | 'loaded' | 'no-data' | 'error';

export default function NewsletterAnalyticsModal({ docId, title, onClose }: NewsletterAnalyticsModalProps) {
  const [stage, setStage] = useState<Stage>('loading');
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        // Step 1: find the publication for this document
        const pubRes = await fetch(`/api/publications?documentId=${encodeURIComponent(docId)}`);
        if (!pubRes.ok) throw new Error('Failed to fetch publications');
        const pubData = await pubRes.json();

        const pubs = pubData.publications || pubData;
        const newsletter = Array.isArray(pubs)
          ? pubs.find((p: any) => p.platform === 'newsletter')
          : null;

        if (!newsletter) {
          if (!cancelled) setStage('no-data');
          return;
        }

        // Step 2: fetch stats for this publication
        const statsRes = await fetch(`/api/publications/${newsletter.id}/stats`);
        if (!statsRes.ok) throw new Error('Failed to fetch stats');
        const statsData = await statsRes.json();

        if (!cancelled) {
          setStats({
            opens: { unique: statsData.opens_unique || 0, total: statsData.opens_total || 0 },
            clicks: { unique: statsData.clicks_unique || 0, total: statsData.clicks_total || 0 },
            bounces: statsData.bounces || 0,
            unsubscribes: statsData.unsubscribes || 0,
          });
          setStage('loaded');
        }
      } catch (err: any) {
        if (!cancelled) {
          setError(err.message);
          setStage('error');
        }
      }
    }

    load();
    return () => { cancelled = true; };
  }, [docId]);

  // Close on click outside
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  return (
    <div className="newsletter-modal-overlay">
      <div className="newsletter-modal" ref={ref}>
        <div className="newsletter-modal__header">
          <h3>Newsletter Analytics</h3>
          <button className="newsletter-modal__close" onClick={onClose}>&times;</button>
        </div>

        <div className="newsletter-modal__body">
          {stage === 'loading' && (
            <div className="newsletter-modal__status">
              <div className="newsletter-modal__spinner" />
              <span>Loading analytics...</span>
            </div>
          )}

          {stage === 'loaded' && stats && (
            <>
              <p style={{ margin: 0, fontSize: 13, color: 'var(--ink-light)' }}>
                {title}
              </p>
              <div style={{
                display: 'grid',
                gridTemplateColumns: '1fr 1fr',
                gap: 12,
              }}>
                <StatCard label="Opens" unique={stats.opens.unique} total={stats.opens.total} />
                <StatCard label="Clicks" unique={stats.clicks.unique} total={stats.clicks.total} />
                <StatCard label="Bounces" value={stats.bounces} />
                <StatCard label="Unsubscribes" value={stats.unsubscribes} />
              </div>
            </>
          )}

          {stage === 'no-data' && (
            <div className="newsletter-modal__status">
              <span>No analytics data yet. Stats will appear after SendGrid processes events.</span>
            </div>
          )}

          {stage === 'error' && (
            <div className="newsletter-modal__error">{error}</div>
          )}

          <div className="newsletter-modal__actions">
            <button className="newsletter-modal__btn newsletter-modal__btn--primary" onClick={onClose}>Done</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function StatCard({ label, unique, total, value }: { label: string; unique?: number; total?: number; value?: number }) {
  return (
    <div style={{
      padding: '12px 14px',
      background: 'var(--bg-hover)',
      borderRadius: 8,
      display: 'flex',
      flexDirection: 'column',
      gap: 2,
    }}>
      <div style={{ fontSize: 11, fontWeight: 500, color: 'var(--ink-light)', textTransform: 'uppercase' as const, letterSpacing: '0.5px' }}>
        {label}
      </div>
      {value != null ? (
        <div style={{ fontSize: 22, fontWeight: 600, color: 'var(--ink-dark)' }}>
          {value.toLocaleString()}
        </div>
      ) : (
        <>
          <div style={{ fontSize: 22, fontWeight: 600, color: 'var(--ink-dark)' }}>
            {(unique ?? 0).toLocaleString()} <span style={{ fontSize: 12, fontWeight: 400, color: 'var(--ink-light)' }}>unique</span>
          </div>
          <div style={{ fontSize: 12, color: 'var(--ink-light)' }}>
            {(total ?? 0).toLocaleString()} total
          </div>
        </>
      )}
    </div>
  );
}
