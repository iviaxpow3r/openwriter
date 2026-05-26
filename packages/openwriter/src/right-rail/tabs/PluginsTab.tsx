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

interface ConfigField {
  type: 'string' | 'number' | 'boolean';
  required?: boolean;
  env?: string;
  description?: string;
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

const PLAN_LABELS: Record<string, string> = {
  none: 'No Plan',
  free: 'No Plan',
  creator: 'Creator — $19/mo',
  growth: 'Growth — $49/mo',
  publisher: 'Publisher — $79/mo',
};

const UPGRADE_OPTIONS: { plan: string; label: string }[] = [
  { plan: 'creator', label: 'Creator $19/mo' },
  { plan: 'growth', label: 'Growth $49/mo' },
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
    const rank = ['free', 'creator', 'growth', 'publisher'];
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

function displayName(name: string): string {
  return name
    .replace(/^@openwriter\/plugin-/, '')
    .replace(/-/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export default function PluginsTab(_props: RightRailTabProps) {
  const [plugins, setPlugins] = useState<AvailablePlugin[]>([]);
  const [loadingPlugin, setLoadingPlugin] = useState<string | null>(null);
  const [expandedConfigs, setExpandedConfigs] = useState<Set<string>>(new Set());

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

  const handleConfigBlur = useCallback((pluginName: string, key: string, value: string) => {
    fetch('/api/plugins/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: pluginName, config: { [key]: value } }),
    }).catch(() => {});
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
            {p.enabled && p.name === '@openwriter/plugin-publish' && <BillingSection />}
            {p.enabled && p.name === '@openwriter/plugin-github' && <GithubPluginSettings />}
            {p.enabled && Object.keys(p.configSchema).length > 0 && (() => {
              const needsSetup = Object.entries(p.configSchema).some(
                ([key, field]) => field.required && !p.config[key]
              );
              return (
                <div className="plugin-config-section">
                  {needsSetup && (
                    <div className="plugin-setup-hint">
                      Ask your agent: &ldquo;set up {displayName(p.name)}&rdquo;
                    </div>
                  )}
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
                      {Object.entries(p.configSchema).map(([key, field]) => (
                        <div key={key} className="plugin-config-field">
                          <label className="plugin-config-label">
                            {field.description || key}
                          </label>
                          <input
                            className="plugin-config-input"
                            type={key.toLowerCase().includes('key') || key.toLowerCase().includes('secret') || key.toLowerCase().includes('token') ? 'password' : 'text'}
                            defaultValue={p.config[key] || ''}
                            placeholder={field.env ? `$${field.env}` : ''}
                            onBlur={(e) => handleConfigBlur(p.name, key, e.target.value)}
                          />
                        </div>
                      ))}
                    </div>
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
