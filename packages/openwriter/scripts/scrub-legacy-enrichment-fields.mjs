/**
 * One-off migration script — v0.18 → v0.19 enrichment schema.
 *
 * Deletes the legacy fields `domain`, `concepts`, `docRole` from every
 * .md frontmatter under each ~/.openwriter/profiles/<profile>/ directory.
 * Loglines, status, enrichmentStale, baselines, and every other field are
 * left untouched. Pure disk migration — no Haiku, no minion, no body parse.
 *
 * Preserves OpenWriter's single-line JSON frontmatter exactly — uses
 * surgical string ops, not matter.stringify (which would convert JSON to
 * YAML and produce a massive spurious diff on every file).
 *
 * Usage:
 *   node scripts/scrub-legacy-enrichment-fields.mjs           # dry-run (default)
 *   node scripts/scrub-legacy-enrichment-fields.mjs --apply   # actually write
 *
 * v0.19.0's `mark_enriched` retires these fields naturally on every call,
 * but that only fires on docs that drift past threshold and get re-enriched.
 * Stable docs keep their legacy fields indefinitely. This script forces the
 * cleanup in one pass.
 *
 * See brief: 2026-05-21-simplify-enrichment-schema-three-fields.
 */

import { readdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const APPLY = process.argv.includes('--apply');
const LEGACY_FIELDS = ['domain', 'concepts', 'docRole'];

const profilesRoot = join(homedir(), '.openwriter', 'profiles');
const profiles = readdirSync(profilesRoot, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name);

console.log(`${APPLY ? 'APPLYING' : 'DRY RUN'} — scrub legacy enrichment fields`);
console.log(`Fields to delete: ${LEGACY_FIELDS.join(', ')}`);
console.log(`Profiles found:   ${profiles.join(', ')}`);
console.log('');

let totalDocs = 0;
let touchedDocs = 0;
let totalFieldDeletions = 0;
const sample = [];
const fieldCounts = Object.fromEntries(LEGACY_FIELDS.map((f) => [f, 0]));

/** Match OpenWriter's `---\n{...JSON...}\n---\n` frontmatter exactly.
 *  The JSON is a single line; the closing `---` is on its own line. */
const FM_REGEX = /^---\n(.+?)\n---\n/;

for (const profile of profiles) {
  const dir = join(profilesRoot, profile);
  let files;
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.md'));
  } catch {
    continue;
  }

  console.log(`Profile: ${profile} (${files.length} .md files)`);

  let profileTouched = 0;
  for (const f of files) {
    const filePath = join(dir, f);
    let raw;
    try {
      raw = readFileSync(filePath, 'utf-8');
    } catch {
      continue;
    }
    totalDocs++;

    const fmMatch = raw.match(FM_REGEX);
    if (!fmMatch) continue; // no frontmatter — skip

    const fmRaw = fmMatch[1];
    let fmData;
    try {
      fmData = JSON.parse(fmRaw);
    } catch {
      // Not JSON frontmatter (could be YAML). OpenWriter only emits JSON,
      // so this would be an externally-edited file. Skip rather than risk
      // reformatting.
      continue;
    }

    const present = LEGACY_FIELDS.filter((field) => fmData[field] !== undefined);
    if (present.length === 0) continue;

    for (const field of present) {
      delete fmData[field];
      totalFieldDeletions++;
      fieldCounts[field]++;
    }
    touchedDocs++;
    profileTouched++;

    if (sample.length < 5) {
      sample.push({
        profile,
        file: f,
        title: fmData.title || '(no title)',
        deleted: present,
      });
    }

    if (APPLY) {
      // Reassemble: same `---\n{JSON}\n---\n` shape OpenWriter uses, with
      // the original body content appended verbatim.
      const newFmRaw = JSON.stringify(fmData);
      const body = raw.slice(fmMatch[0].length);
      const newContent = `---\n${newFmRaw}\n---\n${body}`;
      writeFileSync(filePath, newContent, 'utf-8');
    }
  }

  console.log(`  → ${profileTouched} docs ${APPLY ? 'touched' : 'would be touched'}`);
}

console.log('');
console.log(`SUMMARY`);
console.log(`  Total docs scanned:   ${totalDocs}`);
console.log(`  Docs with legacy:     ${touchedDocs}`);
console.log(`  Field deletions:      ${totalFieldDeletions}`);
for (const field of LEGACY_FIELDS) {
  console.log(`    ${field.padEnd(10)} ${fieldCounts[field]}`);
}

if (sample.length > 0) {
  console.log('');
  console.log(`SAMPLE (first ${sample.length} touched docs):`);
  for (const s of sample) {
    console.log(`  [${s.profile}] ${s.title}`);
    console.log(`    file:    ${s.file}`);
    console.log(`    deleted: ${s.deleted.join(', ')}`);
  }
}

if (!APPLY) {
  console.log('');
  console.log(`Dry run only. Re-run with --apply to write changes.`);
}
