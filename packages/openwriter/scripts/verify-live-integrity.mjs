/**
 * Live integrity verifier — runs the full sync observer chain against a real
 * on-disk document.
 *
 * For every doc passed (or all docs in the active profile), this script:
 *
 *   1. Loads the markdown body + frontmatter from disk
 *   2. Parses via markdownToTiptap (load-time matcher runs)
 *   3. Re-serializes via tiptapToMarkdownChecked (save-time sync observer runs)
 *   4. Reports any shape drift
 *   5. Audits the frontmatter `nodes:` graph against the body's top-level blocks
 *   6. Checks for legacy caret anchors in the body (clean post-v0.14.0)
 *   7. Confirms no duplicate IDs anywhere in the doc
 *
 * Output is a compact PASS/FAIL per check per doc.
 *
 * Run: `node scripts/verify-live-integrity.mjs [docNameOrPath]`
 *      `node scripts/verify-live-integrity.mjs`            # all docs in active profile
 *      `node scripts/verify-live-integrity.mjs "Beat Sheet"`
 */

import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import matter from 'gray-matter';
import {
  markdownToTiptap,
  tiptapToMarkdownChecked,
  shapeOfTiptap,
  compareShapes,
} from '../dist/server/markdown.js';
import { tiptapToBlocks } from '../dist/server/node-blocks.js';

const args = process.argv.slice(2);
const targetName = args[0] || null;

const PROFILE_DIR = join(homedir(), '.openwriter', 'profiles', 'Default');

function findDocs() {
  const files = readdirSync(PROFILE_DIR)
    .filter((f) => f.endsWith('.md') && !f.startsWith('.'))
    .filter((f) => !targetName || f.includes(targetName));
  return files.map((f) => join(PROFILE_DIR, f));
}

function colorize(label, pass) {
  return pass ? `\x1b[32m${label}\x1b[0m` : `\x1b[31m${label}\x1b[0m`;
}

let totalDocs = 0;
let totalChecks = 0;
let totalFails = 0;

const docs = findDocs();
if (docs.length === 0) {
  console.error(`No docs match "${targetName}"`);
  process.exit(1);
}

console.log(`\nLive integrity check across ${docs.length} doc(s)\n`);

for (const docPath of docs) {
  const filename = docPath.split(/[\\/]/).pop();
  totalDocs++;
  const checks = [];

  let raw, parsed, frontmatter, body;
  try {
    raw = readFileSync(docPath, 'utf-8');
    const parsedMatter = matter(raw);
    frontmatter = parsedMatter.data;
    body = parsedMatter.content;
  } catch (e) {
    checks.push({ name: 'read', pass: false, detail: `error: ${e.message}` });
    continue;
  }

  // -------- Parse via markdownToTiptap (load-time matcher) ----------------
  parsed = markdownToTiptap(raw);

  // -------- Check 1: re-serialize and re-parse → shape preserved ----------
  const { syncReport, markdown: serialized } = tiptapToMarkdownChecked(
    parsed.document,
    parsed.title,
    parsed.metadata,
  );
  checks.push({
    name: 'TipTap→markdown→TipTap shape parity',
    pass: syncReport.ok,
    detail: syncReport.ok
      ? `${syncReport.expectedLength} blocks, identical shape`
      : `${syncReport.mismatches.length} mismatch(es) at positions ${syncReport.mismatches.map((m) => m.position).join(',')}`,
  });

  // -------- Check 2: re-parse the serialized output and compare again -----
  // This is the round-trip stability check — does N saves change the shape?
  const reparsed = markdownToTiptap(serialized);
  const reparsedShape = shapeOfTiptap(reparsed.document);
  const originalShape = shapeOfTiptap(parsed.document);
  const stabilityReport = compareShapes(originalShape, reparsedShape);
  checks.push({
    name: 'Round-trip stability (parse → serialize → parse)',
    pass: stabilityReport.ok,
    detail: stabilityReport.ok
      ? `stable across two parse cycles`
      : `drift at positions ${stabilityReport.mismatches.map((m) => m.position).join(',')}`,
  });

  // -------- Check 3: frontmatter nodes count = top-level block count ------
  const fmNodes = Array.isArray(frontmatter.nodes) ? frontmatter.nodes : [];
  const topLevelBlocks = tiptapToBlocks(parsed.document);
  if (fmNodes.length === 0) {
    // External / legacy docs without a nodes graph — skip this check.
    checks.push({
      name: 'frontmatter nodes count == top-level blocks',
      pass: true,
      detail: 'no nodes graph (external/legacy doc)',
      skipped: true,
    });
  } else {
    // Note: the trailing empty paragraph that TipTap parks the cursor on is
    // tracked by the matcher and included in `nodes:`, so we don't trim it.
    checks.push({
      name: 'frontmatter nodes count == top-level blocks',
      pass: fmNodes.length === topLevelBlocks.length,
      detail: `nodes: ${fmNodes.length}, blocks: ${topLevelBlocks.length}`,
    });
  }

  // -------- Check 4: every frontmatter id maps to a top-level block id ----
  if (fmNodes.length > 0) {
    const topIds = new Set(topLevelBlocks.map((b) => b.id).filter(Boolean));
    const fmIds = fmNodes.map((n) => n.id);
    const orphans = fmIds.filter((id) => !topIds.has(id));
    checks.push({
      name: 'every frontmatter id has a matching block id in the parsed tree',
      pass: orphans.length === 0,
      detail: orphans.length === 0
        ? 'all ids paired'
        : `orphans: ${orphans.slice(0, 5).join(', ')}${orphans.length > 5 ? '…' : ''}`,
    });
  } else {
    checks.push({
      name: 'every frontmatter id has a matching block id in the parsed tree',
      pass: true,
      detail: 'no nodes graph',
      skipped: true,
    });
  }

  // -------- Check 5: body has no legacy caret anchors (post-v0.14.0) ------
  // Pattern: ` ^xxxxxxxx` at end of a line — would indicate stale caret syntax.
  // Caret anchors are LEGAL on pre-v0.14.0 docs (those without a `nodes:`
  // frontmatter graph) — they're the legacy identity carrier; they'll be
  // shed on the doc's next save. Only flag them as a real failure when a
  // migrated doc (has `nodes:`) still carries anchors.
  const caretRegex = /\s\^[a-f0-9]{8}(?:\s*$|\s)/gm;
  const bodyWithoutFences = body.replace(/```[\s\S]*?```/g, '');
  const caretMatchCount = (bodyWithoutFences.match(caretRegex) || []).length;
  const isMigrated = fmNodes.length > 0;
  if (!isMigrated) {
    checks.push({
      name: 'no legacy caret anchors in body (clean post-v0.14.0)',
      pass: true,
      detail: caretMatchCount > 0
        ? `${caretMatchCount} caret anchor(s) — legacy doc, will heal on next save`
        : 'clean',
      skipped: caretMatchCount > 0, // mark as skip when legacy-state
    });
  } else {
    checks.push({
      name: 'no legacy caret anchors in body (clean post-v0.14.0)',
      pass: caretMatchCount === 0,
      detail: caretMatchCount === 0
        ? 'clean'
        : `${caretMatchCount} caret anchor(s) found in migrated doc (real corruption)`,
    });
  }

  // -------- Check 6: no duplicate IDs anywhere in the parsed doc tree -----
  const idCounts = new Map();
  function walk(nodes) {
    if (!nodes) return;
    for (const node of nodes) {
      const id = node.attrs?.id;
      if (id) idCounts.set(id, (idCounts.get(id) || 0) + 1);
      if (node.content) walk(node.content);
    }
  }
  walk(parsed.document.content);
  const dups = [...idCounts.entries()].filter(([, c]) => c > 1);
  checks.push({
    name: 'no duplicate ids anywhere in the doc tree',
    pass: dups.length === 0,
    detail: dups.length === 0
      ? `${idCounts.size} unique ids`
      : `${dups.length} duplicate id(s): ${dups.slice(0, 3).map(([id, c]) => `${id}×${c}`).join(', ')}`,
  });

  // -------- Render results ------------------------------------------------
  const docPass = checks.every((c) => c.pass);
  const stat = statSync(docPath);
  const sizeKB = (stat.size / 1024).toFixed(1);
  const wordCount = body.split(/\s+/).filter(Boolean).length;
  console.log(`${colorize(docPass ? 'PASS' : 'FAIL', docPass)}  ${filename}  ${sizeKB}KB, ${wordCount} words`);
  for (const c of checks) {
    const tag = c.skipped ? '  SKIP' : (c.pass ? '   OK ' : '  FAIL');
    const color = c.skipped ? '\x1b[90m' : (c.pass ? '\x1b[32m' : '\x1b[31m');
    console.log(`${color}${tag}\x1b[0m  ${c.name} — ${c.detail}`);
    totalChecks++;
    if (!c.pass) totalFails++;
  }
  console.log();
}

console.log('='.repeat(60));
console.log(`Docs scanned: ${totalDocs}  |  Checks: ${totalChecks}  |  Failures: ${totalFails}`);
console.log('='.repeat(60));
process.exit(totalFails > 0 ? 1 : 0);
