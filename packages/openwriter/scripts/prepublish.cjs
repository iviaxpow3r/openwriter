/**
 * Prepublish script: copies skill files and bundles plugins into dist/plugins/
 * so they ship with the npm package.
 */

const fs = require('fs');
const path = require('path');

// --- Copy skill files ---
const skillRoot = path.resolve('../../skills/openwriter');
const skillSrc = path.join(skillRoot, 'SKILL.md');
if (fs.existsSync(skillSrc)) {
  fs.copyFileSync(skillSrc, 'skill/SKILL.md');

  // Public-safe docs only (excludes changelog.md, publish-gotchas.md)
  fs.mkdirSync('skill/docs', { recursive: true });
  for (const doc of ['welcome.md', 'voices.md', 'anti-ai.md']) {
    const src = path.join(skillRoot, 'docs', doc);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join('skill/docs', doc));
  }

  // Voice frames (5 files, all public-safe)
  const voicesSrc = path.join(skillRoot, 'voices');
  if (fs.existsSync(voicesSrc)) {
    fs.mkdirSync('skill/voices', { recursive: true });
    for (const f of fs.readdirSync(voicesSrc)) {
      if (f.endsWith('.md')) fs.copyFileSync(path.join(voicesSrc, f), path.join('skill/voices', f));
    }
  }
}

// --- Bundle plugins into dist/plugins/ ---
const pluginsRoot = path.resolve('../../plugins');
const distPlugins = path.resolve('dist/plugins');

if (!fs.existsSync(pluginsRoot)) {
  console.log('[prepublish] No plugins/ directory found, skipping plugin bundling');
  process.exit(0);
}

function copyDirSync(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

let count = 0;
for (const dir of fs.readdirSync(pluginsRoot, { withFileTypes: true })) {
  if (!dir.isDirectory()) continue;

  const pluginDir = path.join(pluginsRoot, dir.name);
  const pkgJson = path.join(pluginDir, 'package.json');
  const distDir = path.join(pluginDir, 'dist');

  if (!fs.existsSync(pkgJson) || !fs.existsSync(distDir)) {
    console.log(`[prepublish] Skipping ${dir.name} — missing package.json or dist/`);
    continue;
  }

  const outDir = path.join(distPlugins, dir.name);
  fs.mkdirSync(outDir, { recursive: true });
  fs.copyFileSync(pkgJson, path.join(outDir, 'package.json'));
  copyDirSync(distDir, path.join(outDir, 'dist'));

  count++;
  console.log(`[prepublish] Bundled plugin: ${dir.name}`);
}

console.log(`[prepublish] Bundled ${count} plugins into dist/plugins/`);
