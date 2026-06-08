/**
 * Plugins tab — list available plugins, toggle each on/off, configure them.
 * Migrated from src/plugins/PluginPanel.tsx (titlebar dropdown).
 *
 * BillingSection lives here too — only mounts when the publish plugin is on.
 * adr: adr/right-rail.md
 */
import { useCallback, useEffect, useState } from 'react';
import type { RightRailTabProps } from '../types';
import GithubPluginSettings from './plugin-panels/GithubPluginSettings';
import {
  fetchWalletBilling,
  fetchTopupOptions,
  openTopupCheckout,
  formatDollars,
  type TopupOption,
} from '../../utils/av-billing';

interface ConfigField {
  type: 'string' | 'number' | 'boolean' | 'select';
  required?: boolean;
  env?: string;
  description?: string;
  options?: Array<{ value: string; label: string }>;
}

interface AvailablePlugin {
  name: string;
  version: string;
  description: string;
  enabled: boolean;
  configSchema: Record<string, ConfigField>;
  config: Record<string, string>;
}

interface BillingInfo {
  plan: string;
  limits: Record<string, any> | null;
  billing: { hasPaymentMethod: boolean; paymentFailed: boolean } | null;
  authenticated: boolean;
}

// Value-fenced tiers (offer ratified 2026-06-02). Internal plan KEYS stay
// `creator`/`growth` — the Stripe price IDs are unchanged, so the webhook→plan
// loop still grants those keys; only the labels change. Publisher is archived.
//   creator = Publish ($19/mo)        — scheduler + every channel except email
//   growth  = Publish+Email ($49/mo)  — everything in Publish + newsletter/email
const PLAN_LABELS: Record<string, string> = {
  none: 'No Plan',
  free: 'No Plan',
  creator: 'Publish — $19/mo',
  growth: 'Publish+Email — $49/mo',
};

const UPGRADE_OPTIONS: { plan: string; label: string }[] = [
  { plan: 'creator', label: 'Publish $19/mo' },
  { plan: 'growth', label: 'Publish+Email $49/mo' },
];

function BillingSection() {
  const [billing, setBilling] = useState<BillingInfo | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/billing')
      .then((r) => r.json())
      .then((data) => setBilling(data))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const handleUpgrade = useCallback(async (plan: string) => {
    const res = await fetch('/api/billing/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plan }),
    });
    if (res.ok) {
      const data = await res.json();
      if (data.url) window.open(data.url, '_blank');
    }
  }, []);

  const handlePortal = useCallback(async () => {
    const res = await fetch('/api/billing/portal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    if (res.ok) {
      const data = await res.json();
      if (data.url) window.open(data.url, '_blank');
    }
  }, []);

  if (loading) return <div className="billing-section"><div className="billing-loading">Loading...</div></div>;
  if (!billing?.authenticated) return null;

  const currentPlan = billing.plan || 'free';
  const upgradeOptions = UPGRADE_OPTIONS.filter((o) => {
    const rank = ['free', 'creator', 'growth'];
    return rank.indexOf(o.plan) > rank.indexOf(currentPlan);
  });

  return (
    <div className="billing-section">
      <div className="billing-plan">
        <span className="billing-plan-label">Plan</span>
        <span className={`billing-plan-badge billing-plan-badge--${currentPlan}`}>
          {PLAN_LABELS[currentPlan] || currentPlan}
        </span>
      </div>
      {billing.billing?.paymentFailed && (
        <div className="billing-warning">Payment failed — update card to keep your plan.</div>
      )}
      {upgradeOptions.length > 0 && (
        <div className="billing-upgrades">
          {upgradeOptions.map((o) => (
            <button key={o.plan} className="billing-upgrade-btn" onClick={() => handleUpgrade(o.plan)}>
              Upgrade to {o.label}
            </button>
          ))}
        </div>
      )}
      {billing.billing?.hasPaymentMethod && (
        <button className="billing-manage-btn" onClick={handlePortal}>
          Manage Billing
        </button>
      )}
    </div>
  );
}

// Relative per-model cost legend for Author's Voice. There is NO fixed per-edit price — the charge
// scales with edit length, so hard cents read as a fixed menu and were misleading. These are
// qualitative tiers (free → $$$), not prices.
const AV_MODEL_COSTS: { label: string; cost: string }[] = [
  { label: 'Fast', cost: 'free' },
  { label: 'Fast+', cost: '$' },
  { label: 'Sonnet', cost: '$$' },
  { label: 'Opus', cost: '$$$' },
];

// Author's Voice wallet panel — balance in dollars, per-model cost legend, and the
// $5/$10/$20 top-up buttons (rendered from the API catalog), each opening Stripe checkout.
// Mounts under the AV plugin row, mirroring BillingSection's placement under publish.
function CreditsSection() {
  const [balanceCents, setBalanceCents] = useState<number | null>(null);
  const [options, setOptions] = useState<TopupOption[]>([]);
  const [loading, setLoading] = useState(true);
  // Top-up amounts stay tucked behind a single "Add balance" button until the user wants them —
  // three always-on $5/$10/$20 buttons read as a hard sell every time the panel is open.
  const [topupOpen, setTopupOpen] = useState(false);

  const refresh = useCallback(() => {
    Promise.all([fetchWalletBilling(), fetchTopupOptions()])
      .then(([billing, opts]) => {
        if (billing?.wallet) setBalanceCents(billing.wallet.balanceCents);
        setOptions(opts);
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  // Re-check the balance when the tab regains focus — the user may have just completed
  // a Stripe checkout in the other tab.
  useEffect(() => {
    const handler = () => { if (document.visibilityState === 'visible') refresh(); };
    document.addEventListener('visibilitychange', handler);
    return () => document.removeEventListener('visibilitychange', handler);
  }, [refresh]);

  if (loading) return <div className="billing-section"><div className="billing-loading">Loading…</div></div>;
  // Nothing to show if the proxy/key isn't wired (balance unknown AND no catalog).
  if (balanceCents === null && options.length === 0) return null;

  return (
    <div className="billing-section">
      <div className="billing-plan">
        <span className="billing-plan-label">Balance</span>
        <span className="av-credits-balance">
          {balanceCents === null ? '—' : formatDollars(balanceCents)}
        </span>
      </div>
      <div className="av-credits-legend">
        {AV_MODEL_COSTS.map((m) => (
          <span key={m.label} className="av-credits-legend-item">
            <span className="av-credits-model">{m.label}</span>
            <span className="av-credits-cost">{m.cost}</span>
          </span>
        ))}
      </div>
      {options.length > 0 && (
        <>
          <button
            className="av-credits-topup-toggle"
            onClick={() => setTopupOpen((v) => !v)}
          >
            <svg
              className={`plugin-config-chevron${topupOpen ? ' plugin-config-chevron--open' : ''}`}
              width="12" height="12" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
            >
              <polyline points="9 18 15 12 9 6" />
            </svg>
            Add balance
          </button>
          {topupOpen && (
            <div className="billing-upgrades">
              {options.map((o) => (
                <button
                  key={o.priceId}
                  className="billing-upgrade-btn"
                  onClick={() => openTopupCheckout(o.amountDollars as 5 | 10 | 20)}
                >
                  Add ${o.amountDollars}
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function displayName(name: string): string {
  return name
    .replace(/^@openwriter\/plugin-/, '')
    .replace(/-/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

// Inline per-field save indicator. Mirrors the saving/saved/error stages +
// green checkmark "Saved" language from src/connections/ConnectionConfigModal.tsx.
function ConfigSaveStatus({ status }: { status: SaveStatus }) {
  if (status === 'saving') {
    return <span className="plugin-config-status plugin-config-status--saving">Saving…</span>;
  }
  if (status === 'saved') {
    return (
      <span className="plugin-config-status plugin-config-status--saved">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#22c55e" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="20 6 9 17 4 12" />
        </svg>
        Saved
      </span>
    );
  }
  if (status === 'error') {
    return (
      <span className="plugin-config-status plugin-config-status--error">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#ef4444" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
        Failed
      </span>
    );
  }
  return null;
}

export default function PluginsTab(_props: RightRailTabProps) {
  const [plugins, setPlugins] = useState<AvailablePlugin[]>([]);
  const [loadingPlugin, setLoadingPlugin] = useState<string | null>(null);
  const [expandedConfigs, setExpandedConfigs] = useState<Set<string>>(new Set());
  // Per-field save state, keyed `${pluginName}:${configKey}`. Drives the inline ✓/✗ indicator.
  const [saveStatus, setSaveStatus] = useState<Record<string, SaveStatus>>({});

  const fetchPlugins = useCallback(() => {
    fetch('/api/available-plugins')
      .then((r) => r.json())
      .then((data) => setPlugins(data.plugins || []))
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetchPlugins();
  }, [fetchPlugins]);

  useEffect(() => {
    const handler = () => fetchPlugins();
    window.addEventListener('ow-plugins-changed', handler);
    return () => window.removeEventListener('ow-plugins-changed', handler);
  }, [fetchPlugins]);

  const handleToggle = useCallback(async (name: string, currentlyEnabled: boolean) => {
    setLoadingPlugin(name);
    try {
      const endpoint = currentlyEnabled ? '/api/plugins/disable' : '/api/plugins/enable';
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      if (res.ok) fetchPlugins();
    } catch { /* ignore */ } finally {
      setLoadingPlugin(null);
    }
  }, [fetchPlugins]);

  const handleConfigBlur = useCallback(async (pluginName: string, key: string, value: string) => {
    const statusKey = `${pluginName}:${key}`;
    setSaveStatus((prev) => ({ ...prev, [statusKey]: 'saving' }));
    try {
      const res = await fetch('/api/plugins/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: pluginName, config: { [key]: value } }),
      });
      if (!res.ok) throw new Error(`save failed (${res.status})`);
      setSaveStatus((prev) => ({ ...prev, [statusKey]: 'saved' }));
      // Auto-clear the ✓ after ~2s — but only if nothing newer has touched this field.
      setTimeout(() => {
        setSaveStatus((prev) => (prev[statusKey] === 'saved' ? { ...prev, [statusKey]: 'idle' } : prev));
      }, 2000);
    } catch {
      setSaveStatus((prev) => ({ ...prev, [statusKey]: 'error' }));
    }
  }, []);

  return (
    <div className="plugins-tab">
      {plugins.length === 0 ? (
        <div className="plugin-empty">No plugins found</div>
      ) : (
        plugins.map((p) => (
          <div key={p.name} className="plugin-item">
            <div className="plugin-item-header">
              <div className="plugin-item-info">
                <div className="plugin-item-name">
                  {displayName(p.name)}
                  <span className="plugin-item-version">v{p.version}</span>
                </div>
                {p.description && (
                  <div className="plugin-item-desc">{p.description}</div>
                )}
              </div>
              <label className={`plugin-toggle${loadingPlugin === p.name ? ' loading' : ''}`}>
                <input
                  type="checkbox"
                  checked={p.enabled}
                  disabled={loadingPlugin === p.name}
                  onChange={() => handleToggle(p.name, p.enabled)}
                />
                <span className="plugin-toggle-track" />
                <span className="plugin-toggle-thumb" />
              </label>
            </div>
            {p.enabled && (() => {
              const entries = Object.entries(p.configSchema || {});
              // `select`-type fields (e.g. the AV model picker) surface at the top level —
              // always visible. Text/password fields (API keys, secrets, URLs) stay tucked
              // inside the collapse. Generic: runs identically for every plugin.
              const topLevel = entries.filter(([, field]) => field.type === 'select');
              const collapsed = entries.filter(([, field]) => field.type !== 'select');
              const needsSetup = entries.some(([key, field]) => field.required && !p.config[key]);

              // Plugin-specific rich panel (AV wallet / publish billing / github settings). Rendered
              // BETWEEN the top-level selects and the Settings collapse so the order reads:
              // writing model → balance → settings. Selects on top is the user's primary control;
              // secrets stay last behind the collapse. No-op for plugins without a panel.
              const richPanel =
                p.name === '@openwriter/plugin-authors-voice' ? <CreditsSection /> :
                p.name === '@openwriter/plugin-publish' ? <BillingSection /> :
                p.name === '@openwriter/plugin-github' ? <GithubPluginSettings /> : null;

              const renderField = (key: string, field: ConfigField) => {
                const status = saveStatus[`${p.name}:${key}`] || 'idle';
                return (
                  <div key={key} className="plugin-config-field">
                    <label className="plugin-config-label">
                      {field.description || key}
                      <ConfigSaveStatus status={status} />
                    </label>
                    {field.options ? (
                      <select
                        className="plugin-config-input"
                        defaultValue={p.config[key] || ''}
                        onChange={(e) => handleConfigBlur(p.name, key, e.target.value)}
                      >
                        {!field.required && !field.options.some((o) => o.value === '') && <option value="">—</option>}
                        {field.options.map((opt) => (
                          <option key={opt.value} value={opt.value}>{opt.label}</option>
                        ))}
                      </select>
                    ) : (
                      <input
                        className="plugin-config-input"
                        type={key.toLowerCase().includes('key') || key.toLowerCase().includes('secret') || key.toLowerCase().includes('token') ? 'password' : 'text'}
                        defaultValue={p.config[key] || ''}
                        placeholder={field.env ? `$${field.env}` : ''}
                        onBlur={(e) => handleConfigBlur(p.name, key, e.target.value)}
                      />
                    )}
                  </div>
                );
              };

              // Nothing to show (no config fields, no rich panel) → render nothing rather than
              // an empty bordered section box.
              if (entries.length === 0 && !richPanel) return null;

              return (
                <div className="plugin-config-section">
                  {needsSetup && (
                    <div className="plugin-setup-hint">
                      Ask your agent: &ldquo;set up {displayName(p.name)}&rdquo;
                    </div>
                  )}
                  {topLevel.length > 0 && (
                    <div className="plugin-config">
                      {topLevel.map(([key, field]) => renderField(key, field))}
                    </div>
                  )}
                  {richPanel}
                  {collapsed.length > 0 && (
                    <>
                      <button
                        className="plugin-config-toggle"
                        onClick={() => setExpandedConfigs((prev) => {
                          const next = new Set(prev);
                          if (next.has(p.name)) next.delete(p.name);
                          else next.add(p.name);
                          return next;
                        })}
                      >
                        <svg
                          className={`plugin-config-chevron${expandedConfigs.has(p.name) ? ' plugin-config-chevron--open' : ''}`}
                          width="12" height="12" viewBox="0 0 24 24" fill="none"
                          stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                        >
                          <polyline points="9 18 15 12 9 6" />
                        </svg>
                        Settings
                      </button>
                      {expandedConfigs.has(p.name) && (
                        <div className="plugin-config">
                          {collapsed.map(([key, field]) => renderField(key, field))}
                        </div>
                      )}
                    </>
                  )}
                </div>
              );
            })()}
          </div>
        ))
      )}
    </div>
  );
}
