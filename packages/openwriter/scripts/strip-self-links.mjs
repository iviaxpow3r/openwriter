#!/usr/bin/env node
/**
 * strip-self-links.mjs — remove self-referencing doc-links and self-references.
 *
 * Problem: prior to v0.20, certain code paths (older link_to behavior, manual
 * authoring patterns, title-as-permalink scaffolds) ended up writing prose
 * links of the form `[title](doc:OWN_DOC_ID)` where OWN_DOC_ID matches the
 * containing doc's own docId. Clicking such a link just reloads the same doc;
 * it carries no information. v0.21's auto-sync from prose into references also
 * means these self-prose-links can plant OWN_DOC_ID into the doc's own
 * references array — a self-loop in the connection graph.
 *
 * This script walks every .md under each profile and:
 *   1. Strips `[text](doc:OWN_DOC_ID)` and `[text](<doc:OWN_DOC_ID>)` prose
 *      patterns from the body, leaving the bare `text` behind. Anchored
 *      variants (`doc:OWN_DOC_ID#NODEID`) are also stripped — a link to your
 *      own paragraph is still a no-op for navigation purposes.
 *   2. Removes OWN_DOC_ID from the `references` array in frontmatter.
 *
 * Dry-run by default. Pass `--apply` to write changes. Idempotent — safe to
 * re-run; will report 0 changes after a successful run.
 */
import { readdirSync, readFileSync, writeFileSync, statSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const APPLY = process.argv.includes('--apply');
const PROFILE = process.argv.find((a) => a.startsWith('--profile='))?.split('=')[1] || 'Default';
const PROFILE_DIR = join(homedir(), '.openwriter', 'profiles', PROFILE);

function parseFrontmatter(raw) {
  const m = raw.match(/^---\n([\s\S]+?)\n---\n([\s\S]*)$/);
  if (!m) return null;
  try {
    return { meta: JSON.parse(m[1]), body: m[2] };
  } catch {
    return null;
  }
}

function serialize(meta, body) {
  return `---\n${JSON.stringify(meta)}\n---\n${body}`;
}

/**
 * Strip self-referencing prose links. Both `[text](doc:DOCID)` and
 * `[text](<doc:DOCID>)` forms, with optional `#NODEID` anchor. Leaves
 * the visible text behind unwrapped.
 */
function stripSelfLinksFromBody(body, ownDocId) {
  // Match: [text](doc:DOCID), [text](doc:DOCID#NODEID), [text](<doc:DOCID>), [text](<doc:DOCID#NODEID>)
  // text is non-greedy and excludes nested brackets.
  const pattern = new RegExp(
    `\\[([^\\]]+?)\\]\\(<?doc:${ownDocId}(?:#[a-f0-9]{8})?>?\\)`,
    'g'
  );
  let count = 0;
  const next = body.replace(pattern, (_match, text) => {
    count++;
    return text;
  });
  return { body: next, count };
}

function walkMarkdownFiles(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walkMarkdownFiles(full, out);
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      out.push(full);
    }
  }
  return out;
}

const files = walkMarkdownFiles(PROFILE_DIR);
console.log(`Scanning ${files.length} .md files under ${PROFILE_DIR}\n${APPLY ? '** WRITING CHANGES **' : '(dry-run — pass --apply to write)'}\n`);

let totalDocs = 0;
let totalProseLinks = 0;
let totalRefSelfLoops = 0;
const touched = [];

for (const file of files) {
  let raw;
  try {
    raw = readFileSync(file, 'utf-8');
  } catch {
    continue;
  }
  const parsed = parseFrontmatter(raw);
  if (!parsed) continue;
  const ownDocId = parsed.meta?.docId;
  if (!ownDocId || !/^[a-f0-9]{8}$/.test(ownDocId)) continue;

  // 1) Strip self-links from prose
  const { body: newBody, count: proseCount } = stripSelfLinksFromBody(parsed.body, ownDocId);

  // 2) Strip self-loop from references array
  let newRefs = parsed.meta.references;
  let refDelta = 0;
  if (Array.isArray(newRefs) && newRefs.includes(ownDocId)) {
    refDelta = newRefs.filter((r) => r === ownDocId).length;
    newRefs = newRefs.filter((r) => r !== ownDocId);
  }

  if (proseCount === 0 && refDelta === 0) continue;

  totalDocs++;
  totalProseLinks += proseCount;
  totalRefSelfLoops += refDelta;
  touched.push({ file, ownDocId, title: parsed.meta.title, proseCount, refDelta });

  if (APPLY) {
    const updatedMeta = { ...parsed.meta };
    if (refDelta > 0) updatedMeta.references = newRefs;
    writeFileSync(file, serialize(updatedMeta, newBody), 'utf-8');
  }
}

for (const t of touched) {
  const parts = [];
  if (t.proseCount > 0) parts.push(`${t.proseCount} prose self-link${t.proseCount > 1 ? 's' : ''}`);
  if (t.refDelta > 0) parts.push(`${t.refDelta} self-ref${t.refDelta > 1 ? 's' : ''}`);
  console.log(`  ${t.title} [${t.ownDocId}] — ${parts.join(', ')}`);
}

console.log('');
console.log(`============================================================`);
console.log(`Docs touched: ${totalDocs}`);
console.log(`Prose self-links stripped: ${totalProseLinks}`);
console.log(`References self-loops stripped: ${totalRefSelfLoops}`);
console.log(`============================================================`);
if (!APPLY && totalDocs > 0) {
  console.log(`\nRe-run with --apply to write changes.`);
}
