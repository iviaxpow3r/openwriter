/**
 * Word-level diff utility for computing inline text edit ranges.
 * Compares original text vs new text and returns character ranges
 * in the new text that differ from the original.
 */

export interface InlineDiffRange {
  from: number;
  to: number;
  type: string;
}

interface Token {
  word: string;
  from: number;
  to: number;
}

/** Tokenize text into words with character positions. */
function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  const regex = /\S+/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    tokens.push({
      word: match[0],
      from: match.index,
      to: match.index + match[0].length,
    });
  }
  return tokens;
}

/** Compute LCS length table for two word arrays. */
function lcsTable(a: string[], b: string[]): number[][] {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }
  return dp;
}

/** Backtrack LCS to find which indices in b are NOT part of the LCS (changed/added). */
function findChangedIndices(a: string[], b: string[], dp: number[][]): Set<number> {
  const matched = new Set<number>();
  let i = a.length;
  let j = b.length;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      matched.add(j - 1);
      i--;
      j--;
    } else if (dp[i - 1][j] >= dp[i][j - 1]) {
      i--;
    } else {
      j--;
    }
  }
  const changed = new Set<number>();
  for (let k = 0; k < b.length; k++) {
    if (!matched.has(k)) changed.add(k);
  }
  return changed;
}

/** Merge adjacent changed tokens into contiguous character ranges. */
function mergeRanges(tokens: Token[], changed: Set<number>): InlineDiffRange[] {
  const ranges: InlineDiffRange[] = [];
  let runStart = -1;

  for (let i = 0; i < tokens.length; i++) {
    if (changed.has(i)) {
      if (runStart === -1) runStart = i;
    } else {
      if (runStart !== -1) {
        ranges.push({
          from: tokens[runStart].from,
          to: tokens[i - 1].to,
          type: 'rewrite',
        });
        runStart = -1;
      }
    }
  }

  if (runStart !== -1) {
    ranges.push({
      from: tokens[runStart].from,
      to: tokens[tokens.length - 1].to,
      type: 'rewrite',
    });
  }

  return ranges;
}

/**
 * Compute word-level diff between original and new text.
 * Returns character ranges in the NEW text that differ from original.
 *
 * - InlineDiffRange[] with changed ranges → stored as pendingTextEdits
 * - null if texts are too different (>60% changed words) → full-node decoration
 * - [] if texts are identical
 */
export function computeInlineDiff(originalText: string, newText: string): InlineDiffRange[] | null {
  if (originalText === newText) return [];
  if (!originalText.trim() || !newText.trim()) return null;

  const origWords = tokenize(originalText);
  const newWords = tokenize(newText);

  if (origWords.length === 0 || newWords.length === 0) return null;

  const dp = lcsTable(origWords.map(t => t.word), newWords.map(t => t.word));
  const lcsLen = dp[origWords.length][newWords.length];

  // If less than 40% of words match, text is too different → full-node decoration
  const matchRatio = lcsLen / Math.max(origWords.length, newWords.length);
  if (matchRatio < 0.4) return null;

  const changed = findChangedIndices(
    origWords.map(t => t.word),
    newWords.map(t => t.word),
    dp,
  );

  if (changed.size === 0) return [];

  return mergeRanges(newWords, changed);
}
