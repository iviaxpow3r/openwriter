/**
 * Build every plugin under ../../plugins that declares a `build` script.
 *
 * Why this exists: the app build (`vite build && tsc`) does NOT build the
 * plugins, and `npm publish` runs `prepublishOnly` (which bundles plugin
 * dist/) but NOT `npm run build`. Without a single, enforced plugin-build
 * step, a plugin source change ships/runs STALE dist from every path —
 * the release bundle, a local dev restart, and openwriter-testing. This is
 * the same stale-bundle class as the skill-bundle bug.
 *
 * Run from packages/openwriter (npm sets cwd there). Wired into the `build`
 * script and called by scripts/prepublish.cjs before it bundles.
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const pluginsRoot = path.resolve('../../plugins');
if (!fs.existsSync(pluginsRoot)) {
  console.log('[build-plugins] no plugins/ directory, nothing to build');
  process.exit(0);
}

let built = 0;
for (const dir of fs.readdirSync(pluginsRoot, { withFileTypes: true })) {
  if (!dir.isDirectory()) continue;
  const pluginDir = path.join(pluginsRoot, dir.name);
  const pkgPath = path.join(pluginDir, 'package.json');
  if (!fs.existsSync(pkgPath)) continue;
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
  if (!pkg.scripts || !pkg.scripts.build) continue;
  console.log(`[build-plugins] building ${dir.name}`);
  execSync('npm run build', { cwd: pluginDir, stdio: 'inherit' });
  built++;
}
console.log(`[build-plugins] built ${built} plugin(s)`);
