import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function log(msg: string): void {
  console.error(msg);
}

function getGlobalVersion(): string | null {
  try {
    return execSync('openwriter --version', {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 10000,
    }).toString().trim();
  } catch {
    return null;
  }
}

function getLatestVersion(): string | null {
  try {
    return execSync('npm view openwriter version', {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 15000,
    }).toString().trim();
  } catch {
    return null;
  }
}

function installOrUpdateGlobally(): boolean {
  log('\n② Installing/updating openwriter globally...');

  // Try without sudo first (works on Windows, nvm, Homebrew, volta, etc.)
  try {
    execSync('npm install -g openwriter@latest', { stdio: 'inherit', timeout: 120000 });
    log('  ✓ Installed globally');
    return true;
  } catch {
    // Likely permission error on macOS/Linux system Node
  }

  // Try with sudo on non-Windows (only if we have a TTY for password prompt)
  if (process.platform !== 'win32' && process.stdin.isTTY) {
    log('  Retrying with sudo...');
    try {
      execSync('sudo npm install -g openwriter@latest', { stdio: 'inherit', timeout: 120000 });
      log('  ✓ Installed globally (sudo)');
      return true;
    } catch {
      // sudo failed too
    }
  }

  log('  ✗ Could not install globally (permissions)');
  return false;
}

function isMcpConfigured(): boolean {
  const claudeJson = path.join(os.homedir(), '.claude.json');
  if (!fs.existsSync(claudeJson)) return false;
  try {
    const content = JSON.parse(fs.readFileSync(claudeJson, 'utf-8'));
    return !!content?.mcpServers?.openwriter;
  } catch {
    return false;
  }
}

function configureMcp(useNpx: boolean): boolean {
  log('\n③ Configuring MCP server for Claude Code...');

  const mcpCommand = useNpx ? 'npx' : 'openwriter';
  const mcpArgs = useNpx ? ['-y', 'openwriter', '--no-open'] : ['--no-open'];

  // Try using claude CLI
  const cliArgs = useNpx
    ? 'claude mcp add -s user openwriter -- npx -y openwriter --no-open'
    : 'claude mcp add -s user openwriter -- openwriter --no-open';
  try {
    execSync(cliArgs, {
      stdio: 'inherit',
      timeout: 15000,
    });
    log('  ✓ MCP server configured');
    return true;
  } catch {
    // claude CLI not available or failed
  }

  // Fallback: edit ~/.claude.json directly
  log('  claude CLI not found — writing config directly...');
  const claudeJson = path.join(os.homedir(), '.claude.json');
  try {
    let config: any = {};
    if (fs.existsSync(claudeJson)) {
      config = JSON.parse(fs.readFileSync(claudeJson, 'utf-8'));
    }
    if (!config.mcpServers) config.mcpServers = {};

    // Add openwriter as first entry (Claude Code loads sequentially)
    const existing = config.mcpServers;
    config.mcpServers = {
      openwriter: { command: mcpCommand, args: mcpArgs },
      ...existing,
    };

    fs.writeFileSync(claudeJson, JSON.stringify(config, null, 2), 'utf-8');
    log(`  ✓ MCP server added to ${claudeJson}`);
    return true;
  } catch (err) {
    log(`  ✗ Could not configure MCP server. Add manually:`);
    log('    claude mcp add -s user openwriter -- openwriter --no-open');
    return false;
  }
}

export function installSkill(): void {
  // Step 1: Copy SKILL.md
  log('① Installing OpenWriter skill...');
  const source = path.join(__dirname, '../../skill/SKILL.md');
  const targetDir = path.join(os.homedir(), '.claude', 'skills', 'openwriter');
  const target = path.join(targetDir, 'SKILL.md');

  if (!fs.existsSync(source)) {
    log(`  Error: SKILL.md not found at ${source}`);
    process.exit(1);
  }

  fs.mkdirSync(targetDir, { recursive: true });
  fs.copyFileSync(source, target);
  log(`  ✓ Skill installed to ${target}`);

  // Copy docs/ directory (welcome doc, etc.)
  const docsSource = path.join(__dirname, '../../skill/docs');
  const docsTarget = path.join(targetDir, 'docs');
  if (fs.existsSync(docsSource)) {
    fs.mkdirSync(docsTarget, { recursive: true });
    for (const file of fs.readdirSync(docsSource)) {
      fs.copyFileSync(path.join(docsSource, file), path.join(docsTarget, file));
    }
    log(`  ✓ Skill docs copied to ${docsTarget}`);
  }

  // Step 2: Global install or update
  let useNpx = false;
  const currentVersion = getGlobalVersion();
  const latestVersion = getLatestVersion();

  if (currentVersion && latestVersion && currentVersion === latestVersion) {
    log(`\n② openwriter v${currentVersion} is up to date — skipping`);
  } else {
    if (currentVersion && latestVersion) {
      log(`\n② Updating openwriter: v${currentVersion} → v${latestVersion}`);
    }
    if (!installOrUpdateGlobally()) {
      // Global install/update failed (permissions) — fall back to npx
      log('  → Will use npx fallback for MCP server (no global install needed)');
      useNpx = true;
    }
  }

  // Step 3: Configure MCP server
  if (isMcpConfigured() && !useNpx) {
    log('\n③ MCP server already configured — skipping');
  } else {
    configureMcp(useNpx);
  }

  // Done
  log('\n✓ OpenWriter is ready!');
  log('  Restart Claude Code, then type /openwriter to start writing.\n');
  process.exit(0);
}
