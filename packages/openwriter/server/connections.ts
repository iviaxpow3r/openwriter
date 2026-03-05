/**
 * Connection management — CRUD for ~/.openwriter/connections.json
 * Connections are global integrations (newsletter, future: x, blog, shopify).
 * Profile bindings control which connections are active per profile.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { randomBytes } from 'crypto';
import { ROOT_DIR, atomicWriteFileSync, readConfig, saveConfig, listProfiles, getActiveProfile } from './helpers.js';

export interface Connection {
  id: string;
  type: 'newsletter';
  name: string;
  createdAt: string;
  credentials: Record<string, string>;
}

export interface ConnectionsFile {
  connections: Connection[];
  profileBindings: Record<string, string[]>;
}

function getConnectionsFile(): string {
  return join(ROOT_DIR, 'connections.json');
}

export function readConnections(): ConnectionsFile {
  const file = getConnectionsFile();
  if (!existsSync(file)) return { connections: [], profileBindings: {} };
  try {
    return JSON.parse(readFileSync(file, 'utf-8'));
  } catch {
    return { connections: [], profileBindings: {} };
  }
}

export function saveConnections(data: ConnectionsFile): void {
  atomicWriteFileSync(getConnectionsFile(), JSON.stringify(data, null, 2));
}

export function listConnections(): Connection[] {
  return readConnections().connections;
}

export function getConnection(id: string): Connection | undefined {
  return readConnections().connections.find(c => c.id === id);
}

export function createConnection(type: Connection['type'], name: string, credentials: Record<string, string>): Connection {
  const data = readConnections();
  const conn: Connection = {
    id: randomBytes(4).toString('hex'),
    type,
    name,
    createdAt: new Date().toISOString(),
    credentials,
  };
  data.connections.push(conn);
  saveConnections(data);
  return conn;
}

export function updateConnection(id: string, updates: { name?: string; credentials?: Record<string, string> }): Connection {
  const data = readConnections();
  const idx = data.connections.findIndex(c => c.id === id);
  if (idx === -1) throw new Error(`Connection "${id}" not found`);
  if (updates.name !== undefined) data.connections[idx].name = updates.name;
  if (updates.credentials !== undefined) data.connections[idx].credentials = updates.credentials;
  saveConnections(data);
  return data.connections[idx];
}

export function deleteConnection(id: string): void {
  const data = readConnections();
  const idx = data.connections.findIndex(c => c.id === id);
  if (idx === -1) throw new Error(`Connection "${id}" not found`);
  data.connections.splice(idx, 1);
  // Remove from all profile bindings
  for (const profile of Object.keys(data.profileBindings)) {
    data.profileBindings[profile] = data.profileBindings[profile].filter(cid => cid !== id);
  }
  saveConnections(data);
}

export function getActiveConnections(profile: string, type?: Connection['type']): Connection[] {
  const data = readConnections();
  const activeIds = data.profileBindings[profile] || [];
  let conns = data.connections.filter(c => activeIds.includes(c.id));
  if (type) conns = conns.filter(c => c.type === type);
  return conns;
}

export function toggleProfileBinding(profile: string, connectionId: string): boolean {
  const data = readConnections();
  if (!data.connections.some(c => c.id === connectionId)) {
    throw new Error(`Connection "${connectionId}" not found`);
  }
  if (!data.profileBindings[profile]) data.profileBindings[profile] = [];
  const idx = data.profileBindings[profile].indexOf(connectionId);
  let active: boolean;
  if (idx === -1) {
    data.profileBindings[profile].push(connectionId);
    active = true;
  } else {
    data.profileBindings[profile].splice(idx, 1);
    active = false;
  }
  saveConnections(data);
  return active;
}

/** Migrate legacy plugin api-key to a connection if no newsletter connections exist */
export function migratePublishPlugin(): void {
  const data = readConnections();
  if (data.connections.some(c => c.type === 'newsletter')) return;

  const config = readConfig();
  const publishConfig = config.plugins?.['@openwriter/plugin-publish'];
  if (!publishConfig?.config?.['api-key']) return;

  const apiKey = publishConfig.config['api-key'];
  const apiUrl = publishConfig.config['api-url'] || 'https://publish.openwriter.io';

  const conn = createConnection('newsletter', 'OpenWriter Newsletter', {
    'api-key': apiKey,
    'api-url': apiUrl,
  });

  // Bind to all profiles
  const freshData = readConnections();
  const profiles = listProfiles();
  for (const p of profiles) {
    if (!freshData.profileBindings[p]) freshData.profileBindings[p] = [];
    if (!freshData.profileBindings[p].includes(conn.id)) {
      freshData.profileBindings[p].push(conn.id);
    }
  }
  saveConnections(freshData);

  // Clear legacy keys from plugin config
  const updated = { ...publishConfig.config };
  delete updated['api-key'];
  delete updated['api-url'];
  saveConfig({
    plugins: {
      ...config.plugins,
      '@openwriter/plugin-publish': { ...publishConfig, config: updated },
    },
  });

  console.log(`[Connections] Migrated publish plugin api-key → connection "${conn.name}" (${conn.id})`);
}
