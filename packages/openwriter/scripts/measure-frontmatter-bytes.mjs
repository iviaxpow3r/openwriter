/**
 * Migrate-and-measure: load each .md in the Default profile through
 * production parse → re-serialize path, report frontmatter byte savings.
 *
 * Read-only against the real profile. Writes a sibling .new file per doc
 * so you can diff before committing the migration.
 */

import { mkdirSync, readFileSync, writeFileSync, readdirSync, existsSync, rmSync } from 'fs';
import { join, basename } from 'path';
import { homedir } from 'os';
import { markdownToTiptap } from '../dist/server/markdown.js';
import { tiptapToMarkdown } from '../dist/server/markdown-serialize.js';

const PROFILE_DIR = join(homedir(), '.openwriter', 'profiles', 'Default');
const files = readdirSync(PROFILE_DIR)
  .filter((f) => f.endsWith('.md') && !f.startsWith('.'))
  .sort();

let totalOld = 0;
let totalNew = 0;
let docCount = 0;

console.log(`${'Doc'.padEnd(46)} ${'fm-old'.padStart(8)} ${'fm-new'.padStart(8)} ${'saved'.padStart(8)} ${'body'.padStart(8)} new/body`);
console.log('-'.repeat(96));

for (const f of files) {
  const path = join(PROFILE_DIR, f);
  const raw = readFileSync(path, 'utf-8');
  try {
    const { document, title, metadata } = markdownToTiptap(raw);
    const newRaw = tiptapToMarkdown(document, title, metadata);

    const oldFmMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    const newFmMatch = newRaw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    const oldFm = oldFmMatch ? oldFmMatch[0].length : 0;
    const newFm = newFmMatch ? newFmMatch[0].length : 0;
    const body = newRaw.length - newFm;

    if (oldFm === 0 && newFm === 0) continue;

    totalOld += oldFm;
    totalNew += newFm;
    docCount++;

    const ratio = body > 0 ? (newFm / body).toFixed(2) + 'x' : 'N/A';
    const shortName = f.length > 44 ? f.slice(0, 41) + '…' : f;
    console.log(`${shortName.padEnd(46)} ${String(oldFm).padStart(8)} ${String(newFm).padStart(8)} ${String(oldFm - newFm).padStart(8)} ${String(body).padStart(8)} ${ratio}`);
  } catch (e) {
    console.log(`${f.padEnd(46)} SKIP: ${e.message}`);
  }
}

console.log('-'.repeat(96));
console.log(`${docCount} docs   ${'TOTAL'.padEnd(40)} ${String(totalOld).padStart(8)} ${String(totalNew).padStart(8)} ${String(totalOld - totalNew).padStart(8)}`);
console.log(`Avg per doc: old=${Math.round(totalOld / docCount)} new=${Math.round(totalNew / docCount)} saved=${Math.round((totalOld - totalNew) / docCount)} (${((totalOld - totalNew) / totalOld * 100).toFixed(1)}% reduction)`);
