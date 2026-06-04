import { useEffect, useState } from 'react';

interface UpdateInfo {
  currentVersion: string;
  latestVersion: string;
  updateCommand: string;
}

const DISMISS_KEY = 'ow-update-dismissed';

/**
 * Update nudge banner. Appears only when the running instance is behind the
 * latest published version. Dismissal persists (localStorage) until the next
 * new version ships — we store the dismissed version, so a newer release
 * re-surfaces the banner.
 *
 * The update command is install-aware (server-detected): `npm update -g
 * openwriter` for global installs, `git pull && npm run build` for git
 * checkouts. The titlebar badge carries the same info passively; this banner
 * is the visible-but-dismissable surface.
 */
export default function UpdateBanner() {
  const [info, setInfo] = useState<UpdateInfo | null>(null);

  useEffect(() => {
    fetch('/api/update-info')
      .then((r) => r.json())
      .then((data) => {
        if (!data.updateAvailable) return;
        let dismissed = '';
        try { dismissed = localStorage.getItem(DISMISS_KEY) || ''; } catch {}
        // Re-show whenever the latest version differs from the one last dismissed.
        if (dismissed === data.updateAvailable) return;
        setInfo({
          currentVersion: data.currentVersion,
          latestVersion: data.updateAvailable,
          updateCommand: data.updateCommand || 'npm update -g openwriter',
        });
      })
      .catch(() => {});
  }, []);

  if (!info) return null;

  const dismiss = () => {
    try { localStorage.setItem(DISMISS_KEY, info.latestVersion); } catch {}
    setInfo(null);
  };

  return (
    <div className="editor-update-banner" role="status" aria-live="polite">
      <span className="editor-update-dot" aria-hidden="true" />
      <span>
        OpenWriter <strong>v{info.latestVersion}</strong> is available
        {' '}(you're on v{info.currentVersion}) — update with{' '}
        <code className="editor-update-cmd">{info.updateCommand}</code>
      </span>
      <button
        type="button"
        className="editor-update-dismiss"
        onClick={dismiss}
        aria-label="Dismiss update notification"
      >
        ×
      </button>
    </div>
  );
}
