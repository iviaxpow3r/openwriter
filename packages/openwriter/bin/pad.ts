#!/usr/bin/env node

/**
 * CLI entry point for OpenWriter.
 * Usage: openwriter [--api-key av_live_xxx] [--port 5050] [--no-open] [--av-url URL] [--plugins name1,name2]
 *
 * API key resolution (first wins):
 *   1. --api-key CLI flag
 *   2. AV_API_KEY environment variable
 *   3. Saved in ~/.openwriter/config.json (from a previous --api-key)
 *
 * If no key found, server starts anyway — plugins that need it will report errors.
 *
 * Boot order optimized for fast MCP startup:
 *   1. Parse args + config (light imports only)
 *   2. Port check (fast TCP probe)
 *   3. Start MCP stdio transport (what Claude Code waits for)
 *   4. Lazy-load Express server + plugins (heavy deps deferred)
 */

// Redirect all console output to stderr so MCP stdio protocol stays clean on stdout
const originalLog = console.log;
console.log = (...args: any[]) => console.error(...args);

// ── Crash guards ──
// The MCP StdioServerTransport writes to stdout with no error handler.
// When Claude Code closes the pipe, the write throws EPIPE and kills the process,
// taking the HTTP server (browser UI) down with it. Catch everything so the
// HTTP server survives MCP disconnects.
process.on('uncaughtException', (err: any) => {
  // EPIPE / ERR_STREAM_DESTROYED from broken MCP pipe — non-fatal, ignore
  if (err?.code === 'EPIPE' || err?.code === 'ERR_STREAM_DESTROYED') return;
  console.error('[FATAL] Uncaught exception:', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[WARN] Unhandled rejection:', reason);
});
// Catch broken-pipe errors on stdout directly (MCP transport writes here)
process.stdout.on('error', (err: any) => {
  if (err?.code === 'EPIPE' || err?.code === 'ERR_STREAM_DESTROYED') return;
  console.error('[stdout error]', err);
});
// Monitor stdin lifecycle — when Claude Code closes the pipe, stdin ends.
// Log it so we know exactly when MCP disconnects.
process.stdin.on('end', () => {
  console.error('[MCP] stdin EOF — Claude Code disconnected. HTTP server still running.');
});
process.stdin.on('close', () => {
  console.error('[MCP] stdin closed.');
});

// Only light imports here — helpers.js uses fs/path/os/crypto (all Node stdlib)
import { createConnection } from 'net';
import { readConfig, saveConfig } from '../server/helpers.js';

const args = process.argv.slice(2);

// Subcommands (run and exit, don't start server)
// `setup` is the canonical one-time bootstrap verb (installs the package,
// wires MCP, drops the skill). `install-skill` is kept as a hidden alias for
// backwards compatibility with existing links/docs.
if (args[0] === 'setup' || args[0] === 'install-skill') {
  import('../server/install-skill.js').then(m => m.installSkill());
} else if (args[0] === 'plugin') {
  import('../server/plugin-install.js').then(m => m.handlePluginCommand(args.slice(1)));
} else {
  let port = 5050;
  let noOpen = false;
  let cliApiKey: string | undefined;
  let cliAvUrl: string | undefined;
  let plugins: string[] = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port' && args[i + 1]) {
      port = parseInt(args[i + 1], 10);
      i++;
    }
    if (args[i] === '--no-open') {
      noOpen = true;
    }
    if (args[i] === '--api-key' && args[i + 1]) {
      cliApiKey = args[i + 1];
      i++;
    }
    if (args[i] === '--av-url' && args[i + 1]) {
      cliAvUrl = args[i + 1];
      i++;
    }
    if (args[i] === '--plugins' && args[i + 1]) {
      plugins = args[i + 1].split(',').map((s) => s.trim()).filter(Boolean);
      i++;
    }
  }

  // Resolve API key: CLI flag → env var → saved config
  const config = readConfig();

  // Restore active profile from config
  const { setActiveProfile } = await import('../server/helpers.js');
  setActiveProfile(config.activeProfile || 'Default');

  const avApiKey = cliApiKey || process.env.AV_API_KEY || config.avApiKey || '';
  const avBackendUrl = cliAvUrl || process.env.AV_BACKEND_URL || config.avBackendUrl;

  // Persist new values to config so future starts don't need them
  const updates: Record<string, string> = {};
  if (cliApiKey && cliApiKey !== config.avApiKey) updates.avApiKey = cliApiKey;
  if (cliAvUrl && cliAvUrl !== config.avBackendUrl) updates.avBackendUrl = cliAvUrl;
  if (Object.keys(updates).length > 0) {
    saveConfig(updates);
    console.log('Config saved to ~/.openwriter/config.json');
  }

  // Set env vars for downstream code (plugins read process.env)
  if (avApiKey) process.env.AV_API_KEY = avApiKey;
  if (avBackendUrl) process.env.AV_BACKEND_URL = avBackendUrl;

  // Port check with health verification — detects orphaned servers
  async function checkPort(): Promise<'free' | 'healthy' | 'orphaned'> {
    const taken = await new Promise<boolean>((resolve) => {
      const socket = createConnection({ port, host: '127.0.0.1' });
      socket.once('connect', () => { socket.destroy(); resolve(true); });
      socket.once('error', () => { resolve(false); });
    });
    if (!taken) return 'free';

    // Port is taken — verify it's a healthy OpenWriter server
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/status`, { signal: AbortSignal.timeout(2000) });
      return res.ok ? 'healthy' : 'orphaned';
    } catch {
      return 'orphaned';
    }
  }

  let portState = await checkPort();

  // Orphaned server: wait for it to die, then claim primary mode
  if (portState === 'orphaned') {
    console.error(`[OpenWriter] Port ${port} held by unresponsive process — waiting for release...`);
    await new Promise(r => setTimeout(r, 3000));
    portState = await checkPort();
    if (portState === 'orphaned') {
      // Still held — wait once more
      await new Promise(r => setTimeout(r, 3000));
      portState = await checkPort();
    }
    if (portState !== 'free') {
      console.error(`[OpenWriter] Port ${port} still unavailable — entering client mode`);
    }
  }

  if (portState === 'healthy') {
    // Client mode: proxy MCP calls to existing primary server via HTTP
    console.error(`[OpenWriter] Port ${port} in use by healthy server — entering client mode`);
    const { startMcpClientServer } = await import('../server/mcp-client.js');
    startMcpClientServer(port).catch((err) => {
      console.error('[MCP-Client] Failed to start:', err);
    });
  } else {
    // Primary mode: start MCP stdio FIRST, then lazy-load Express
    const { load } = await import('../server/state.js');
    load();

    const { startMcpServer } = await import('../server/mcp.js');
    startMcpServer().catch((err) => {
      console.error('[MCP] Failed to start:', err);
    });

    // Deferred: load Express + plugins (heavy deps) after MCP is connecting
    const { startHttpServer } = await import('../server/index.js');
    startHttpServer({ port, noOpen, plugins }).catch((err) => {
      console.error('[HTTP] Failed to start:', err);
    });
  }
}
