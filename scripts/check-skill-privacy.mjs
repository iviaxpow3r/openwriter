#!/usr/bin/env node
// Privacy gate for bundled skills/plugins. Blocks publish/release when
// personal content from the operator's local skill copies leaks into the
// public tree. Run: node scripts/check-skill-privacy.mjs
// Exit 0 = clean, exit 1 = hits found (listed on stdout).
//
// Convention (CLAUDE.md § Bundled-skill hygiene): bundled skill docs use
// FICTIONAL worked examples only (the sleep book, RecipeBox). Personal/live
// work never ships, even as an example.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOTS = ['skills', 'plugins'];
const EXTENSIONS = ['.md', '.js', '.mjs', '.ts', '.json', '.txt'];

// Lowercase substring/regex denylist. Add a line when a new personal
// surface appears. Keep patterns specific enough to avoid false positives
// (e.g. 'travsteward' the public GitHub handle is allowed; 'travis' is not).
// Allowed exceptions checked BEFORE the denylist. 'travsteward' is the
// public GitHub handle; 'c:/users/me' is a deliberately generic doc example.
const ALLOWLIST = [/travsteward/, /c:[\\/]users[\\/]me\b/, /av_api_key/];

const DENYLIST = [
  // identity / family / machine
  /\btravis\b/, /\btanya\b/, /\btravy\b/, /\bsteward\b/,
  /meta[-_ ]?trav/, /rival[-_ ]?chad/, /@gmail\.com/, /c:\\users|c:\/users/,
  // ventures (none of these are part of the openwriter product)
  /paybot/, /caloriebot/, /suppliersift/, /tournament[- ]?male/,
  /\bgreprag\b/, /repblend/, /hyperframes/,
  // TM book vocabulary (the 2026-06-10 leak)
  /dimorph/, /hypergamy/, /tournament male|tournament-vs|tournament behavior/,
  /contest mosaic/, /frame holding/, /alpha widow/, /pairbond/,
  /\bsisson\b/, /crossfit/, /apicella/, /aromatase/, /\bhadza\b/,
  /the ick\b/,
  // secrets (belt and suspenders)
  /sk-[a-z0-9]{20,}/, /api[_-]?key\s*[:=]\s*['"][a-z0-9]/,
];

const hits = [];

function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git') continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p);
    else if (EXTENSIONS.some((e) => name.endsWith(e))) scan(p);
  }
}

function scan(file) {
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    const lower = line.toLowerCase();
    if (ALLOWLIST.some((re) => re.test(lower))) return;
    for (const re of DENYLIST) {
      if (re.test(lower)) {
        hits.push(`${file}:${i + 1}  [${re}]  ${line.trim().slice(0, 100)}`);
        break;
      }
    }
  });
}

for (const root of ROOTS) {
  try { walk(root); } catch { /* root missing — fine */ }
}

if (hits.length) {
  console.error(`PRIVACY GATE FAILED — ${hits.length} hit(s):\n`);
  for (const h of hits) console.error('  ' + h);
  console.error('\nGenericize these before publishing (fictional examples only).');
  process.exit(1);
}
console.log('privacy gate: clean');
