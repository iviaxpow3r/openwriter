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

function isGloballyInstalled(): boolean {
  try {
    const result = execSync('openwriter --version', {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 10000,
    });
    return true;
  } catch {
    return false;
  }
}

function installGlobally(): boolean {
  log('\n② Installing openwriter globally...');

  // Try without sudo first (works on Windows, nvm, Homebrew, volta, etc.)
  try {
    execSync('npm install -g openwriter', { stdio: 'inherit', timeout: 120000 });
    log('  ✓ Installed globally');
    return true;
  } catch {
    // Likely permission error on macOS/Linux system Node
  }

  // Try with sudo on non-Windows
  if (process.platform !== 'win32') {
    log('  Retrying with sudo...');
    try {
      execSync('sudo npm install -g openwriter', { stdio: 'inherit', timeout: 120000 });
      log('  ✓ Installed globally (sudo)');
      return true;
    } catch {
      // sudo failed too
    }
  }

  log('  ✗ Could not install globally. Run manually:');
  log('    npm install -g openwriter');
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

function configureMcp(): boolean {
  log('\n③ Configuring MCP server for Claude Code...');

  // Try using claude CLI
  try {
    execSync('claude mcp add -s user openwriter -- openwriter --no-open', {
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
      openwriter: { command: 'openwriter', args: ['--no-open'] },
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

  // Step 2: Global install (skip if already installed)
  const alreadyInstalled = isGloballyInstalled();
  if (alreadyInstalled) {
    log('\n② openwriter already installed globally — skipping');
  } else {
    if (!installGlobally()) {
      process.exit(1);
    }
  }

  // Step 3: Configure MCP server (skip if already configured)
  if (isMcpConfigured()) {
    log('\n③ MCP server already configured — skipping');
  } else {
    configureMcp();
  }

  // Done
  log('\n✓ OpenWriter is ready!');
  log('  Restart Claude Code, then type /openwriter to start writing.\n');
  process.exit(0);
}
