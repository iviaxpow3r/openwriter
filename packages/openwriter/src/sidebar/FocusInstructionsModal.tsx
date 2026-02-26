import { useCallback, useEffect, useRef, useState } from 'react';
import './FocusInstructionsModal.css';

interface FocusInstructionsModalProps {
  actionLabel: string;
  docTitle: string;
  onConfirm: (instructions: string) => void;
  onClose: () => void;
}

export default function FocusInstructionsModal({ actionLabel, docTitle, onConfirm, onClose }: FocusInstructionsModalProps) {
  const [instructions, setInstructions] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  const handleConfirm = useCallback(() => {
    onConfirm(instructions.trim());
  }, [instructions, onConfirm]);

  return (
    <div className="focus-modal-overlay" onClick={onClose}>
      <div className="focus-modal" onClick={(e) => e.stopPropagation()}>
        <div className="focus-modal-header">
          <h2>{actionLabel}</h2>
          <button className="focus-modal-close" onClick={onClose}>&times;</button>
        </div>
        <div className="focus-modal-body">
          <label>
            Focus instructions for "{docTitle}"
            <textarea
              ref={textareaRef}
              value={instructions}
              onChange={(e) => setInstructions(e.target.value.slice(0, 500))}
              placeholder="Optional: guide the transformation (e.g. 'focus on the intro section', 'keep it professional')..."
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) handleConfirm();
              }}
            />
          </label>
          <div className="focus-modal-hint">{instructions.length}/500</div>
          <div className="focus-modal-actions">
            <button className="focus-modal-btn secondary" onClick={onClose}>Cancel</button>
            <button className="focus-modal-btn primary" onClick={handleConfirm}>Go</button>
          </div>
        </div>
      </div>
    </div>
  );
}
