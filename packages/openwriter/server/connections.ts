/**
 * Platform connection proxy — all connections live on the platform (Neon),
 * local app proxies through the publish API.
 */

import { readConfig, getActiveProfile } from './helpers.js';

const DEFAULT_API_URL = 'https://publish.openwriter.io';

/** Get API key and URL from plugin config */
function getPublishConfig(): { apiKey: string; apiUrl: string } {
  const config = readConfig();
  const publishConfig = config.plugins?.['@openwriter/plugin-publish']?.config || {};
  return {
    apiKey: publishConfig['api-key'] || '',
    apiUrl: publishConfig['api-url'] || DEFAULT_API_URL,
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
