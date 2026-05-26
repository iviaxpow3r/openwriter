/**
 * GitHub plugin settings — custom panel for the Plugins tab.
 *
 * Lists registered blog sites and lets the user add/remove repos via the
 * github plugin's MCP tools (inspect_blog_repo, add_blog_site, list_blog_sites,
 * remove_blog_site). All calls go through `/api/mcp-call`.
 *
 * Mounted inside PluginsTab when `p.name === '@openwriter/plugin-github'`.
 */
import { useCallback, useEffect, useState } from 'react';
import './GithubPluginSettings.css';

interface BlogSite {
  id: string;
  label: string;
  owner: string;
  repo: string;
  branch: string;
  content_dir: string;
  image_dir: string;
  image_public_prefix: string;
  framework: 'astro' | 'next' | 'jekyll' | 'hugo' | 'unknown';
  frontmatter_defaults?: Record<string, any>;
  frontmatter_field_map?: Record<string, string>;
  frontmatter_schema?: string[];
}

interface InspectResult {
  owner: string;
  repo: string;
  framework: BlogSite['framework'];
  content_dir: string;
  image_dir: string;
  image_public_prefix: string;
  frontmatter_schema: string[];
  frontmatter_defaults: Record<string, any>;
  frontmatter_field_map: Record<string, string>;
  samples_analyzed: number;
  markdown_files_found: number;
  confidence: 'high' | 'medium' | 'low';
  error?: string;
}

type AddStage = 'closed' | 'url' | 'review' | 'saving';

async function mcpCall<T = any>(tool: string, args: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch('/api/mcp-call', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tool, arguments: args }),
  });
  const data = await res.json();
  if (data?.content?.[0]?.text) {
    try { return JSON.parse(data.content[0].text) as T; }
    catch { return data.content[0].text as unknown as T; }
  }
  return data as T;
}

export default function GithubPluginSettings() {
  const [sites, setSites] = useState<BlogSite[]>([]);
  const [loading, setLoading] = useState(true);

  const [addStage, setAddStage] = useState<AddStage>('closed');
  const [repoUrl, setRepoUrl] = useState('');
  const [inspecting, setInspecting] = useState(false);
  const [inspectError, setInspectError] = useState<string | null>(null);
  const [draft, setDraft] = useState<(InspectResult & { label: string; branch: string }) | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    setLoading(true);
    try {
      const result = await mcpCall<{ sites?: BlogSite[]; error?: string }>('list_blog_sites');
      setSites(result?.sites || []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refetch(); }, [refetch]);

  const resetAdd = () => {
    setAddStage('closed');
    setRepoUrl('');
    setInspectError(null);
    setDraft(null);
    setSaveError(null);
  };

  const handleInspect = async () => {
    if (!repoUrl.trim()) return;
    setInspecting(true);
    setInspectError(null);
    try {
      const result = await mcpCall<InspectResult>('inspect_blog_repo', { repo_url: repoUrl.trim() });
      if (result.error) {
        setInspectError(result.error);
        return;
      }
      setDraft({
        ...result,
        label: result.repo,
        branch: 'main',
      });
      setAddStage('review');
    } catch (err: any) {
      setInspectError(err?.message || 'Inspection failed');
    } finally {
      setInspecting(false);
    }
  };

  const handleSave = async () => {
    if (!draft) return;
    setAddStage('saving');
    setSaveError(null);
    try {
      const result = await mcpCall<{ success?: boolean; error?: string }>('add_blog_site', {
        label: draft.label,
        owner: draft.owner,
        repo: draft.repo,
        branch: draft.branch || 'main',
        content_dir: draft.content_dir,
        image_dir: draft.image_dir,
        image_public_prefix: draft.image_public_prefix,
        framework: draft.framework,
        frontmatter_defaults: draft.frontmatter_defaults || {},
        frontmatter_field_map: draft.frontmatter_field_map || {},
        frontmatter_schema: draft.frontmatter_schema || [],
      });
      if (result?.error) {
        setSaveError(result.error);
        setAddStage('review');
        return;
      }
      resetAdd();
      await refetch();
    } catch (err: any) {
      setSaveError(err?.message || 'Save failed');
      setAddStage('review');
    }
  };

  const handleRemove = async (site: BlogSite) => {
    const ok = window.confirm(
      `Remove "${site.label}" (${site.owner}/${site.repo})?\n\n` +
      `This only removes the OpenWriter registration. Your GitHub repo is untouched.`,
    );
    if (!ok) return;
    const result = await mcpCall<{ success?: boolean; error?: string }>('remove_blog_site', { id: site.id });
    if (result?.error) {
      alert(`Remove failed: ${result.error}`);
      return;
    }
    await refetch();
  };

  return (
    <div className="github-plugin-settings">
      <div className="github-plugin-settings__header">
        <span className="github-plugin-settings__title">Blog repos</span>
        {addStage === 'closed' && (
          <button className="github-plugin-settings__add-btn" onClick={() => setAddStage('url')}>
            + Add
          </button>
        )}
      </div>

      {loading ? (
        <div className="github-plugin-settings__loading">Loading…</div>
      ) : sites.length === 0 && addStage === 'closed' ? (
        <div className="github-plugin-settings__empty">
          Connect a GitHub repo to publish blog posts via local git — no PATs, no Workers. Uses your existing <code>gh auth login</code>.
        </div>
      ) : (
        <div className="github-plugin-settings__list">
          {sites.map((site) => (
            <div key={site.id} className="github-plugin-settings__site">
              <div className="github-plugin-settings__site-info">
                <div className="github-plugin-settings__site-row1">
                  <span className="github-plugin-settings__site-label">{site.label}</span>
                  <span className={`github-plugin-settings__site-framework github-plugin-settings__site-framework--${site.framework}`}>
                    {site.framework}
                  </span>
                </div>
                <div className="github-plugin-settings__site-repo">
                  {site.owner}/{site.repo}@{site.branch}
                </div>
                <div className="github-plugin-settings__site-dirs">
                  <span title="content_dir">{site.content_dir}</span>
                  <span className="github-plugin-settings__site-sep">·</span>
                  <span title="image_public_prefix">{site.image_public_prefix}</span>
                </div>
              </div>
              <button
                className="github-plugin-settings__remove-btn"
                onClick={() => handleRemove(site)}
                title="Remove"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      {addStage === 'url' && (
        <div className="github-plugin-settings__form">
          <label className="github-plugin-settings__label">GitHub repo</label>
          <input
            className="github-plugin-settings__input"
            type="text"
            placeholder="owner/repo or https://github.com/owner/repo"
            value={repoUrl}
            onChange={(e) => setRepoUrl(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !inspecting) handleInspect(); }}
            autoFocus
          />
          {inspectError && <div className="github-plugin-settings__error">{inspectError}</div>}
          <div className="github-plugin-settings__form-buttons">
            <button
              className="github-plugin-settings__btn github-plugin-settings__btn--primary"
              onClick={handleInspect}
              disabled={inspecting || !repoUrl.trim()}
            >
              {inspecting ? 'Inspecting…' : 'Inspect'}
            </button>
            <button className="github-plugin-settings__btn" onClick={resetAdd} disabled={inspecting}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {(addStage === 'review' || addStage === 'saving') && draft && (
        <div className="github-plugin-settings__form">
          <div className="github-plugin-settings__form-meta">
            <span>Detected: {draft.framework}</span>
            <span>·</span>
            <span>{draft.markdown_files_found} posts</span>
            <span>·</span>
            <span className={`github-plugin-settings__confidence github-plugin-settings__confidence--${draft.confidence}`}>
              {draft.confidence} confidence
            </span>
          </div>

          <label className="github-plugin-settings__label">Label</label>
          <input
            className="github-plugin-settings__input"
            type="text"
            value={draft.label}
            onChange={(e) => setDraft({ ...draft, label: e.target.value })}
          />

          <label className="github-plugin-settings__label">Branch</label>
          <input
            className="github-plugin-settings__input"
            type="text"
            value={draft.branch}
            onChange={(e) => setDraft({ ...draft, branch: e.target.value })}
          />

          <label className="github-plugin-settings__label">Content directory</label>
          <input
            className="github-plugin-settings__input"
            type="text"
            value={draft.content_dir}
            onChange={(e) => setDraft({ ...draft, content_dir: e.target.value })}
          />

          <label className="github-plugin-settings__label">Image directory</label>
          <input
            className="github-plugin-settings__input"
            type="text"
            value={draft.image_dir}
            onChange={(e) => setDraft({ ...draft, image_dir: e.target.value })}
          />

          <label className="github-plugin-settings__label">Image public prefix</label>
          <input
            className="github-plugin-settings__input"
            type="text"
            value={draft.image_public_prefix}
            onChange={(e) => setDraft({ ...draft, image_public_prefix: e.target.value })}
          />

          <label className="github-plugin-settings__label">Framework</label>
          <select
            className="github-plugin-settings__input"
            value={draft.framework}
            onChange={(e) => setDraft({ ...draft, framework: e.target.value as BlogSite['framework'] })}
          >
            <option value="astro">Astro</option>
            <option value="next">Next</option>
            <option value="jekyll">Jekyll</option>
            <option value="hugo">Hugo</option>
            <option value="unknown">Unknown</option>
          </select>

          {draft.frontmatter_schema.length > 0 && (
            <div className="github-plugin-settings__schema">
              <span className="github-plugin-settings__label">
                Frontmatter keys detected ({draft.samples_analyzed} {draft.samples_analyzed === 1 ? 'sample' : 'samples'})
              </span>
              <code>{draft.frontmatter_schema.join(', ')}</code>
            </div>
          )}

          {Object.keys(draft.frontmatter_defaults || {}).length > 0 && (
            <div className="github-plugin-settings__schema">
              <span className="github-plugin-settings__label">
                Frontmatter defaults (constants applied to every post)
              </span>
              <code>
                {Object.entries(draft.frontmatter_defaults).map(([k, v]) => (
                  <div key={k}>{k}: {typeof v === 'string' ? v : JSON.stringify(v)}</div>
                ))}
              </code>
            </div>
          )}

          {Object.keys(draft.frontmatter_field_map || {}).length > 0 && (
            <div className="github-plugin-settings__schema">
              <span className="github-plugin-settings__label">
                Field name mapping (openwriter → site)
              </span>
              <code>
                {Object.entries(draft.frontmatter_field_map).map(([k, v]) => (
                  <div key={k}>{k} → {v}</div>
                ))}
              </code>
            </div>
          )}

          {saveError && <div className="github-plugin-settings__error">{saveError}</div>}

          <div className="github-plugin-settings__form-buttons">
            <button
              className="github-plugin-settings__btn github-plugin-settings__btn--primary"
              onClick={handleSave}
              disabled={addStage === 'saving' || !draft.label.trim()}
            >
              {addStage === 'saving' ? 'Saving…' : 'Add site'}
            </button>
            <button className="github-plugin-settings__btn" onClick={resetAdd} disabled={addStage === 'saving'}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
