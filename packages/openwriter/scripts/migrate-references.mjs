/**
 * One-off migration script — v0.19 → v0.20 connections model.
 *
 * For every .md under ~/.openwriter/profiles/<profile>/:
 *   1. Extract every `[text](doc:DOCID)` prose link target from the body.
 *   2. Merge those docIds into the frontmatter `references:` array (dedup).
 *   3. Strip the legacy `backlinks:` field — v0.20 computes that live.
 *
 * Preserves OpenWriter's single-line JSON frontmatter exactly (no
 * matter.stringify — that would convert JSON to YAML).
 *
 * Usage:
 *   node scripts/migrate-references.mjs           # dry-run (default)
 *   node scripts/migrate-references.mjs --apply   # actually write
 *
 * v0.20.0's writeToDisk auto-syncs references from prose on every save, but
 * stable docs that never get re-saved keep the old shape indefinitely. This
 * script forces the migration in one pass.
 *
 * See brief: 2026-05-22-references-refactor.
 */

import { readdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const APPLY = process.argv.includes('--apply');

const profilesRoot = join(homedir(), '.openwriter', 'profiles');
const profiles = readdirSync(profilesRoot, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name);

console.log(`${APPLY ? 'APPLYING' : 'DRY RUN'} — migrate references (v0.19 → v0.20)`);
console.log(`Profiles found: ${profiles.join(', ')}`);
console.log('');

let totalDocs = 0;
let touchedDocs = 0;
let totalReferencesAdded = 0;
let totalBacklinksStripped = 0;
const sample = [];

/** Match OpenWriter's `---\n{...JSON...}\n---\n` frontmatter exactly. */
const FM_REGEX = /^---\n(.+?)\n---\n/;

/** Match prose markdown links pointing at `doc:DOCID` (8-char hex). */
const DOC_LINK_REGEX = /\]\(<?doc:([a-f0-9]{8})(?:#[a-f0-9]{8})?(?:\?[^)>]*)?>?\)/g;

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
    if (!fmMatch) continue;

    const fmRaw = fmMatch[1];
    let fmData;
    try {
      fmData = JSON.parse(fmRaw);
    } catch {
      // Not JSON frontmatter — skip rather than risk reformatting.
      continue;
    }

    const sourceDocId = fmData.docId;
    if (!sourceDocId) continue;

    const body = raw.slice(fmMatch[0].length);

    // Extract every doc: link target from body.
    const proseTargets = new Set();
    let m;
    while ((m = DOC_LINK_REGEX.exec(body)) !== null) {
      if (m[1] !== sourceDocId) proseTargets.add(m[1]); // never self-reference
    }

    const existing = Array.isArray(fmData.references) ? fmData.references : [];
    const merged = Array.from(new Set([...existing, ...proseTargets])).sort();
    const referencesChanged = JSON.stringify(existing.slice().sort()) !== JSON.stringify(merged);
    const hadLegacyBacklinks = 'backlinks' in fmData;

    if (!referencesChanged && !hadLegacyBacklinks) continue;

    const addedRefs = merged.filter((id) => !existing.includes(id));
    if (addedRefs.length > 0) totalReferencesAdded += addedRefs.length;
    if (hadLegacyBacklinks) totalBacklinksStripped++;

    if (merged.length > 0) fmData.references = merged;
    else delete fmData.references;
    delete fmData.backlinks;

    touchedDocs++;
    profileTouched++;

    if (sample.length < 5) {
      sample.push({
        profile,
        file: f,
        title: fmData.title || '(no title)',
        addedRefs,
        strippedBacklinks: hadLegacyBacklinks,
      });
    }

    if (APPLY) {
      const newFmRaw = JSON.stringify(fmData);
      const newContent = `---\n${newFmRaw}\n---\n${body}`;
      writeFileSync(filePath, newContent, 'utf-8');
    }
  }

  console.log(`  → ${profileTouched} docs ${APPLY ? 'touched' : 'would be touched'}`);
}

console.log('');
console.log('SUMMARY');
console.log(`  Total docs scanned:        ${totalDocs}`);
console.log(`  Docs touched:              ${touchedDocs}`);
console.log(`  References added:          ${totalReferencesAdded}`);
console.log(`  Legacy backlinks stripped: ${totalBacklinksStripped}`);

if (sample.length > 0) {
  console.log('');
  console.log(`SAMPLE (first ${sample.length} touched docs):`);
  for (const s of sample) {
    console.log(`  [${s.profile}] ${s.title}`);
    console.log(`    file:    ${s.file}`);
    console.log(`    added:   ${s.addedRefs.length > 0 ? s.addedRefs.join(', ') : '(none)'}`);
    if (s.strippedBacklinks) console.log(`    stripped legacy backlinks: yes`);
  }
}

if (!APPLY) {
  console.log('');
  console.log('Dry run only. Re-run with --apply to write changes.');
}
