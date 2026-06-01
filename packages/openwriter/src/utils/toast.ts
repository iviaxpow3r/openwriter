/**
 * Minimal toast — pure DOM, no deps, no React state. Bottom-center, self-dismissing.
 * OpenWriter had no toast system; this is the lightweight primitive for transient
 * user feedback (e.g. "selection too large"). Call showToast(msg) from anywhere.
 */

let container: HTMLDivElement | null = null;

function ensureContainer(): HTMLDivElement {
  if (container && document.body.contains(container)) return container;
  container = document.createElement('div');
  container.style.cssText = [
    'position:fixed', 'left:50%', 'bottom:32px', 'transform:translateX(-50%)',
    'z-index:99999', 'display:flex', 'flex-direction:column', 'gap:8px',
    'align-items:center', 'pointer-events:none',
  ].join(';');
  document.body.appendChild(container);
  return container;
}

export type ToastKind = 'info' | 'error';

export function showToast(message: string, kind: ToastKind = 'info', durationMs = 3500): void {
  const root = ensureContainer();
  const el = document.createElement('div');
  el.textContent = message;
  // Match the context-menu popout: --bg-surface, --border, 8px radius, the same shadow,
  // --font-body, --ink-dark. Global :root / [data-mode="dark"] tokens auto-adapt to theme.
  // Error variant adds a left accent in the standard pending-delete red, surface stays neutral.
  el.style.cssText = [
    'background:var(--bg-surface)',
    `border:1px solid var(--border)`,
    kind === 'error' ? 'border-left:3px solid var(--color-pending-delete)' : '',
    'color:var(--ink-dark)', 'font-family:var(--font-body)',
    'padding:10px 14px', 'border-radius:8px', 'font-size:13px', 'line-height:1.4',
    'max-width:420px', 'box-shadow:0 4px 20px rgba(0,0,0,0.15)', 'pointer-events:auto',
    'opacity:0', 'transition:opacity 160ms ease, transform 160ms ease',
    'transform:translateY(6px)',
  ].filter(Boolean).join(';');
  root.appendChild(el);
  // fade in
  requestAnimationFrame(() => { el.style.opacity = '1'; el.style.transform = 'translateY(0)'; });
  // fade out + remove
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transform = 'translateY(6px)';
    setTimeout(() => { el.remove(); if (root.childElementCount === 0) { root.remove(); container = null; } }, 200);
  }, durationMs);
}
