/**
 * File: prompt-debug.ts
 * Purpose: Write AV prompt debug data to timestamped .md files for inspection.
 *   Each enhance creates a new `_prompt-<action>-<ts>.md` doc in the data dir,
 *   visible in the OpenWriter sidebar — so the exact system+user prompt that was
 *   sent to the AI can be reviewed by hand.
 * Control: gated by isPromptDebugEnabled() (OW_PROMPT_DEBUG env). Off by default.
 *   See docs/prompt-debug.md for the on/off switch.
 */

import { getDataDir, ensureDataDir, atomicWriteFileSync } from './helpers.js';
import { join } from 'path';

/** True when the prompt-debug inspector is switched on. Read lazily so the
 *  process picks up OW_PROMPT_DEBUG without code changes. */
export function isPromptDebugEnabled(): boolean {
  const v = process.env.OW_PROMPT_DEBUG;
  return v === '1' || v === 'true';
}

interface PromptDebugData {
  systemPrompt: string;
  userPrompt: string;
  ragExamples?: Array<{ anchor: string; context: string; wordCount: number }>;
}

interface PromptMetadata {
  action?: string;
  profileUsed?: string;
  profileId?: string;
  nodesIn?: number;
  nodesOut?: number;
  ragExamples?: number;
  ragTotalWords?: number;
  processingTimeMs?: number;
  estimatedCost?: number;
}

/**
 * Write prompt debug info to a timestamped markdown file.
 * Returns the filename created.
 */
export function writePromptDebug(
  action: string,
  debug: PromptDebugData,
  metadata?: PromptMetadata
): string {
  ensureDataDir();

  const now = new Date();
  const ts = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const filename = `_prompt-${action || 'debug'}-${ts}.md`;
  const filePath = join(getDataDir(), filename);

  const timeStr = now.toLocaleTimeString('en-US', { hour12: true, hour: '2-digit', minute: '2-digit', second: '2-digit' });

  let md = `---\ntitle: "Prompt Debug: ${action} @ ${timeStr}"\n---\n\n`;

  // Metadata summary
  if (metadata) {
    md += `## Metadata\n\n`;
    md += `| Key | Value |\n|-----|-------|\n`;
    if (metadata.action) md += `| Action | ${metadata.action} |\n`;
    if (metadata.profileUsed) md += `| Profile | ${metadata.profileUsed} |\n`;
    if (metadata.nodesIn != null) md += `| Nodes In | ${metadata.nodesIn} |\n`;
    if (metadata.nodesOut != null) md += `| Nodes Out | ${metadata.nodesOut} |\n`;
    if (metadata.ragExamples != null) md += `| RAG Examples | ${metadata.ragExamples} |\n`;
    if (metadata.ragTotalWords != null) md += `| RAG Total Words | ${metadata.ragTotalWords} |\n`;
    if (metadata.processingTimeMs != null) md += `| Processing Time | ${metadata.processingTimeMs}ms |\n`;
    if (metadata.estimatedCost != null) md += `| Estimated Cost | $${metadata.estimatedCost.toFixed(4)} |\n`;
    md += `\n`;
  }

  // System prompt
  md += `## System Prompt\n\n`;
  md += debug.systemPrompt + '\n\n';

  // User prompt
  md += `---\n\n## User Prompt\n\n`;
  md += debug.userPrompt + '\n\n';

  // RAG examples
  if (debug.ragExamples && debug.ragExamples.length > 0) {
    md += `---\n\n## RAG Examples (${debug.ragExamples.length})\n\n`;
    for (const ex of debug.ragExamples) {
      md += `### ${ex.anchor} (${ex.wordCount} words)\n\n`;
      md += ex.context + '\n\n';
    }
  }

  atomicWriteFileSync(filePath, md);
  return filename;
}
