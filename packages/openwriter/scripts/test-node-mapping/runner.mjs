/**
 * Test runner.
 *
 * For each stage in corpus/:
 *   1. Load original.md → walk → bootstrap previousNodes
 *   2. For each mutation in mutations/:
 *      a. Load the mutated md → walk
 *      b. Run matchNodes(previousNodes, mutatedBlocks)
 *      c. Print summary + per-block detail
 *      d. Flag any non-empty unmatched as "needs a rule"
 *
 * Output is plain text to stdout. Optionally write JSON reports under results/.
 *
 * Usage:
 *   node scripts/test-node-mapping/runner.mjs              — run all stages
 *   node scripts/test-node-mapping/runner.mjs stage1-flat  — run one stage
 */

import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { walkMarkdown } from './walker.mjs';
import { matchNodes, bootstrapPreviousNodes, rebuildPreviousFromResult } from './matcher.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CORPUS = join(__dirname, 'corpus');
const RESULTS = join(__dirname, 'results');

// ANSI color helpers (works in most terminals)
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;

function main() {
  const args = process.argv.slice(2);
  const verbose = args.includes('-v') || args.includes('--verbose');
  const stageFilter = args.find((a) => !a.startsWith('-'));
  if (!existsSync(RESULTS)) mkdirSync(RESULTS, { recursive: true });
  globalThis.__verbose = verbose;

  const stages = readdirSync(CORPUS, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((name) => !stageFilter || name === stageFilter)
    .sort();

  if (stages.length === 0) {
    console.error(red(`No stages found${stageFilter ? ` matching "${stageFilter}"` : ''} in ${CORPUS}`));
    process.exit(1);
  }

  let totalUnmatched = 0;
  const overallReports = [];

  for (const stage of stages) {
    console.log('\n' + bold(`━━━ ${stage} ━━━`));
    const stageReport = runStage(stage);
    totalUnmatched += stageReport.totalUnmatched;
    overallReports.push(stageReport);
  }

  console.log('\n' + bold('━━━ OVERALL ━━━'));
  for (const report of overallReports) {
    const status = report.totalUnmatched === 0 ? green('✓') : yellow(`${report.totalUnmatched} unmatched`);
    console.log(`  ${report.stage}: ${status}`);
  }

  if (totalUnmatched > 0) {
    console.log('\n' + yellow(`${totalUnmatched} unmatched blocks total. Each unmatched block needs a Phase 2 mutation rule.`));
  } else {
    console.log('\n' + green('All blocks accounted for across all stages. Matcher is complete for the current corpus.'));
  }

  // Write a machine-readable summary
  writeFileSync(
    join(RESULTS, 'latest.json'),
    JSON.stringify({ stages: overallReports, totalUnmatched }, null, 2),
  );
}

function runStage(stageName) {
  const stageDir = join(CORPUS, stageName);
  const originalPath = join(stageDir, 'original.md');
  if (!existsSync(originalPath)) {
    console.log(red(`  Missing original.md in ${stageDir}`));
    return { stage: stageName, totalUnmatched: 0, mutations: [] };
  }

  const originalMd = readFileSync(originalPath, 'utf-8');
  const originalBlocks = walkMarkdown(originalMd);
  const previousNodes = bootstrapPreviousNodes(originalBlocks);

  console.log(dim(`  original.md: ${originalBlocks.length} blocks`));

  const mutationsDir = join(stageDir, 'mutations');
  if (!existsSync(mutationsDir)) {
    console.log(red(`  No mutations/ dir in ${stageDir}`));
    return { stage: stageName, totalUnmatched: 0, mutations: [] };
  }

  // Entries can be either single .md files (one-shot mutation) or
  // directories containing step1.md, step2.md, ... (multi-step sequential test).
  const entries = readdirSync(mutationsDir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  );

  const mutationReports = [];
  let stageTotalUnmatched = 0;

  for (const entry of entries) {
    const entryPath = join(mutationsDir, entry.name);

    if (entry.isFile() && entry.name.endsWith('.md')) {
      // Single-shot mutation
      const mutationMd = readFileSync(entryPath, 'utf-8');
      const mutationBlocks = walkMarkdown(mutationMd);
      const result = matchNodes(previousNodes, mutationBlocks);
      const name = entry.name.replace(/\.md$/, '');
      printMutationReport(name, result);
      stageTotalUnmatched += result.unmatched.length;
      mutationReports.push({ mutation: name, ...result.summary });
    } else if (entry.isDirectory()) {
      // Multi-step sequential test
      const stepFiles = readdirSync(entryPath)
        .filter((f) => f.endsWith('.md'))
        .sort();
      let runningPrev = previousNodes;
      let runningGraveyard = [];
      const stepResults = [];
      for (const stepFile of stepFiles) {
        const stepMd = readFileSync(join(entryPath, stepFile), 'utf-8');
        const stepBlocks = walkMarkdown(stepMd);
        const result = matchNodes(runningPrev, stepBlocks, { graveyard: runningGraveyard });
        const stepName = `${entry.name}/${stepFile.replace(/\.md$/, '')}`;
        printMutationReport(stepName, result);
        stageTotalUnmatched += result.unmatched.length;
        stepResults.push({ step: stepName, ...result.summary });
        // Thread state to next step
        runningPrev = rebuildPreviousFromResult(result);
        runningGraveyard = result.nextGraveyard;
      }
      mutationReports.push({ mutation: entry.name, steps: stepResults });
    }
  }

  return {
    stage: stageName,
    totalUnmatched: stageTotalUnmatched,
    mutations: mutationReports,
  };
}

function printMutationReport(name, result) {
  const { summary, pinned, unmatched, orphaned } = result;
  const ok = unmatched.length === 0;
  const tag = ok ? green('✓') : yellow('?');
  const coverage = (summary.coverage * 100).toFixed(0);

  console.log(`  ${tag} ${bold(name.padEnd(40))} ${dim(`${summary.pinnedCount}/${summary.totalBlocks} (${coverage}%)  unmatched=${summary.unmatchedCount}  orphaned=${summary.orphanedCount}`)}`);

  // Verbose detail or any unmatched/orphaned → print breakdown
  if (globalThis.__verbose || unmatched.length > 0) {
    if (pinned.length > 0) {
      const byPos = [...pinned].sort((a, b) => a.position - b.position);
      for (const p of byPos) {
        const tag = mutationTag(p.mutation);
        console.log(dim(`    pin   ${p.id.padEnd(7)}  pos=${p.position}  ${p.block.type.padEnd(14)} ${tag}  ${preview(p.block.text)}`));
      }
    }
    if (unmatched.length > 0) {
      for (const u of unmatched) {
        console.log(yellow(`    ?     pos=${u.position}  ${u.block.type.padEnd(14)} ${preview(u.block.text)}`));
      }
    }
    if (orphaned.length > 0) {
      for (const o of orphaned) {
        const first = o.fingerprint.firstWords?.join(' ') || '';
        console.log(red(`    orph  ${o.id.padEnd(7)}  ${o.fingerprint.type.padEnd(14)} ${preview(first)}`));
      }
    }
  }
}

function preview(s, n = 60) {
  if (!s) return '';
  s = s.replace(/\s+/g, ' ').trim();
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

function mutationTag(m) {
  switch (m) {
    case 'unchanged':    return dim('unchanged  ');
    case 'moved':        return yellow('moved      ');
    case 'edited':       return yellow('edited     ');
    case 'split-first':  return yellow('split-first');
    case 'split-second': return yellow('split-2nd  ');
    case 'merge':        return yellow('merge      ');
    case 'inserted':     return green('inserted   ');
    default:             return dim(m || '?').padEnd(11);
  }
}

main();
