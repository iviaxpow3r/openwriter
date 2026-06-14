/**
 * Platform connection proxy — all connections live on the platform (Neon),
 * local app proxies through the publish API.
 */

import { readConfig, getActiveProfile } from './helpers.js';

const DEFAULT_API_URL = 'https://publish.openwriter.io';

// MCP-6: the platform Bearer key is attached to every request sent to
// `api-url`. Because plugin config is writable (and was writable unauth before
// the MCP-5 gate), a hijacked `api-url` could redirect the next authenticated
// call to an attacker host and exfiltrate the key. We PIN the destination: the
// Bearer key only ever ships to an OpenWriter-controlled host (or loopback for
// local platform dev). Anything else falls back to the default host.
const ALLOWED_PUBLISH_HOSTS = new Set(['publish.openwriter.io', 'openwriter.io']);

/** True when `url` is a safe destination for the platform Bearer key. */
export function isAllowedPublishApiUrl(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  const host = u.hostname.toLowerCase();
  // Local platform development over loopback (either scheme).
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return true;
  // Production: HTTPS only, OpenWriter-controlled host (incl. subdomains).
  if (u.protocol !== 'https:') return false;
  return ALLOWED_PUBLISH_HOSTS.has(host) || host.endsWith('.openwriter.io');
}

/** Get API key and URL from plugin config */
function getPublishConfig(): { apiKey: string; apiUrl: string } {
  const config = readConfig();
  const publishConfig = config.plugins?.['@openwriter/plugin-publish']?.config || {};
  const rawUrl = publishConfig['api-url'] || DEFAULT_API_URL;
  // Pin to an allowed destination — never let a redirected api-url carry the
  // Bearer key off-host. MCP-6.
  const apiUrl = isAllowedPublishApiUrl(rawUrl) ? rawUrl : DEFAULT_API_URL;
  if (apiUrl !== rawUrl) {
    console.warn('[connections] publish api-url not on allowlist — pinned to default host');
  }
  return {
    apiKey: publishConfig['api-key'] || '',
    apiUrl,
  };
}

/** Authenticated fetch to the platform API */
export async function platformFetch(path: string, options: RequestInit = {}): Promise<Response> {
  const { apiKey, apiUrl } = getPublishConfig();
  const profile = getActiveProfile();

  if (!apiKey) {
    throw new Error('Not authenticated. Use the publish plugin to log in first.');
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
    'X-Profile': profile,
    ...(options.headers as Record<string, string> || {}),
  };

  return fetch(`${apiUrl}${path}`, { ...options, headers });
}

/** Check if the user is authenticated with the platform */
export function isAuthenticated(): boolean {
  const { apiKey } = getPublishConfig();
  return !!apiKey;
}
