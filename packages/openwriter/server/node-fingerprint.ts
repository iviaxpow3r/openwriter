/**
 * Per-block fingerprint computation for node identity tracking.
 *
 * The math-first signal hierarchy (push math before words):
 *
 *   MATH SIGNALS (exact integers and chars):
 *     - type, charCount, sentenceCount, wordCount, level, language, structureSig
 *     - sentences[]: per-sentence tuples {c, f, l, t, wls, w}
 *         c   = char count (excluding terminator + trailing space)
 *         f   = first PREFIX_LEN chars of sentence (3-char prefix)
 *         l   = last PREFIX_LEN chars before terminator (3-char suffix)
 *         t   = terminator type ('D'|'E'|'Q'|'-')
 *         wls = word length sequence (array of integers)
 *         w   = word array — defense-in-depth disambiguator when math collides
 *
 *   CONTEXT SIGNALS:
 *     - prevType, nextType, parentType
 *
 *   FALLBACK WORD SIGNALS (only when math is ambiguous):
 *     - firstWords, lastWords (sequence of strings)
 *
 * Two sentences match deterministically if their tuples are equal (math + words).
 * Two blocks match deterministically if their sentence arrays are equal.
 * Splits/merges are detected via array prefix/suffix/concatenation of sentence tuples.
 *
 * Prefix/suffix length 3 is chosen because:
 *   - 1 char (single first/last) collided too easily — "Bee ate the deck" vs
 *     "Bug ate the desk" hashed identically.
 *   - 3 chars captures the first/last whole short word in most sentences and
 *     reduces realistic collisions to near zero.
 *   - Longer prefixes (5+) approach "encoding the first word" rather than
 *     a math signal; we get diminishing returns past 3.
 *
 * adr: adr/node-identity-matcher.md
 */

const WORD_FALLBACK_WINDOW = 5;
const PREFIX_LEN = 3;

export type Terminator = 'D' | 'E' | 'Q' | '-';

export interface SentenceTuple {
  c: number;
  f: string;
  l: string;
  t: Terminator;
  wls: number[];
  w: string[];
}

export interface StructureSig {
  bold: number;
  italic: number;
  links: number;
  code: number;
}

export interface Block {
  position: number;
  type: string;
  text: string;
  raw?: string;
  parentPosition: number | null;
  level?: number;
  language?: string;
  ordinalInParent?: number;
  inlineMarks?: StructureSig;
}

export interface Fingerprint {
  type: string;
  position: number;
  parentPosition: number | null;
  ordinalInParent?: number;
  charCount: number;
  sentenceCount: number;
  wordCount: number;
  sentences: SentenceTuple[];
  structureSig: StructureSig;
  prevType: string | null;
  nextType: string | null;
  parentType: string | null;
  firstWords: string[];
  lastWords: string[];
  level?: number;
  language?: string;
  contentHash?: string;
  childCount?: number;
  childTypes?: string[];
}

const CONTAINER_TYPES = new Set([
  'bulletList',
  'orderedList',
  'taskList',
  'blockquote',
  'table',
  'listItem',
  'taskItem',
]);

/** Compute a fingerprint for a single block, given its position in the block list. */
export function fingerprint(block: Block, allBlocks: Block[]): Fingerprint {
  const text = block.text || '';
  const sentences = splitSentences(text);
  const words = tokenizeWords(text);

  const fp: Fingerprint = {
    type: block.type,
    position: block.position,
    parentPosition: block.parentPosition,
    ordinalInParent: block.ordinalInParent,
    charCount: text.length,
    sentenceCount: sentences.length,
    wordCount: words.length,
    sentences: sentences.map(sentenceTuple),
    structureSig: block.inlineMarks || { bold: 0, italic: 0, links: 0, code: 0 },
    prevType: allBlocks[block.position - 1]?.type || null,
    nextType: allBlocks[block.position + 1]?.type || null,
    parentType: block.parentPosition != null ? allBlocks[block.parentPosition]?.type ?? null : null,
    firstWords: words.slice(0, WORD_FALLBACK_WINDOW),
    lastWords: words.slice(-WORD_FALLBACK_WINDOW),
  };

  if (block.type === 'heading') fp.level = block.level;
  if (block.type === 'codeBlock') {
    fp.language = block.language || '';
    fp.contentHash = simpleHash(block.text);
  }

  if (CONTAINER_TYPES.has(block.type)) {
    const children = allBlocks.filter((b) => b.parentPosition === block.position);
    fp.childCount = children.length;
    fp.childTypes = children.map((c) => c.type);
  }

  return fp;
}

/**
 * Build the per-sentence tuple. Math fields (c, f, l, t, wls) form the primary
 * fingerprint. Prefix/suffix `f` and `l` are PREFIX_LEN chars each. Words (`w`)
 * are defense-in-depth for the rare case where math still collides under
 * richer prefixes.
 */
function sentenceTuple(sentence: { text: string; terminator: Terminator }): SentenceTuple {
  const t = sentence.text;
  const words = tokenizeWords(t);
  return {
    c: t.length,
    f: t.slice(0, PREFIX_LEN),
    l: t.slice(-PREFIX_LEN),
    t: sentence.terminator,
    wls: words.map((w) => w.length),
    w: words,
  };
}

export function fingerprintAll(blocks: Block[]): Fingerprint[] {
  return blocks.map((b) => fingerprint(b, blocks));
}

/**
 * Split text into sentences. Each sentence carries its terminator type:
 *   'D' = declarative (.)
 *   'E' = exclamation (!)
 *   'Q' = question (?)
 *   '-' = no terminator (last fragment with no punctuation)
 */
export function splitSentences(text: string): { text: string; terminator: Terminator }[] {
  if (!text) return [];
  const sentences: { text: string; terminator: Terminator }[] = [];
  const re = /([^.!?]+?)([.!?]+)(\s+|$)/g;
  let lastIdx = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const sentenceText = m[1].trim();
    const term = m[2][0];
    const terminator: Terminator = term === '.' ? 'D' : term === '!' ? 'E' : term === '?' ? 'Q' : '-';
    sentences.push({ text: sentenceText, terminator });
    lastIdx = re.lastIndex;
  }
  if (lastIdx < text.length) {
    const remaining = text.slice(lastIdx).trim();
    if (remaining) sentences.push({ text: remaining, terminator: '-' });
  }
  return sentences;
}

export function tokenizeWords(text: string): string[] {
  if (!text) return [];
  return text
    .split(/\s+/)
    .map((w) => w.replace(/^[^\w]+|[^\w]+$/g, ''))
    .filter((w) => w.length > 0);
}

export function simpleHash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h) + s.charCodeAt(i);
    h |= 0;
  }
  return h.toString(16);
}

/**
 * The strongest possible match: every math dimension equal AND word arrays
 * equal. Pure determinism — adversaries cannot fake exact match without
 * literally using the same content.
 */
export function isExactMatch(a: Fingerprint, b: Fingerprint): boolean {
  if (a.type !== b.type) return false;
  if (a.level !== b.level) return false;
  if (a.language !== b.language) return false;
  if (a.charCount !== b.charCount) return false;
  if (a.sentenceCount !== b.sentenceCount) return false;
  if (a.wordCount !== b.wordCount) return false;
  if (!sentenceArraysEqual(a.sentences, b.sentences)) return false;
  if (!structureEqual(a.structureSig, b.structureSig)) return false;

  if (a.childCount != null || b.childCount != null) {
    if (a.childCount !== b.childCount) return false;
    if (!arraysEqual(a.childTypes, b.childTypes)) return false;
  }

  return true;
}

/** Identical content but possibly different types — used by type-change rule. */
export function isSameContent(a: Fingerprint, b: Fingerprint): boolean {
  const aIsContainer = a.childCount != null;
  const bIsContainer = b.childCount != null;
  if (aIsContainer !== bIsContainer) return false;

  if (aIsContainer) {
    return a.childCount === b.childCount && arraysEqual(a.childTypes, b.childTypes);
  }

  if (a.sentences != null && b.sentences != null) {
    if (!sentenceArraysEqual(a.sentences, b.sentences)) return false;
    return structureEqual(a.structureSig, b.structureSig);
  }
  return false;
}

export function sentenceArraysEqual(a: SentenceTuple[], b: SentenceTuple[]): boolean {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (!sentenceTuplesEqual(a[i], b[i])) return false;
  }
  return true;
}

/** Math + words full equality. The disambiguator for math collisions. */
export function sentenceTuplesEqual(a: SentenceTuple, b: SentenceTuple): boolean {
  return (
    a.c === b.c &&
    a.f === b.f &&
    a.l === b.l &&
    a.t === b.t &&
    arraysEqual(a.wls, b.wls) &&
    arraysEqual(a.w, b.w)
  );
}

export function isSentencePrefix(short: SentenceTuple[], long: SentenceTuple[]): boolean {
  if (!Array.isArray(short) || !Array.isArray(long)) return false;
  if (short.length === 0 || short.length > long.length) return false;
  for (let i = 0; i < short.length; i++) {
    if (!sentenceTuplesEqual(short[i], long[i])) return false;
  }
  return true;
}

export function isSentenceSuffix(short: SentenceTuple[], long: SentenceTuple[]): boolean {
  if (!Array.isArray(short) || !Array.isArray(long)) return false;
  if (short.length === 0 || short.length > long.length) return false;
  const offset = long.length - short.length;
  for (let i = 0; i < short.length; i++) {
    if (!sentenceTuplesEqual(short[i], long[i + offset])) return false;
  }
  return true;
}

export function isSentenceConcat(
  combined: SentenceTuple[],
  first: SentenceTuple[],
  second: SentenceTuple[],
): boolean {
  if (!Array.isArray(combined) || !Array.isArray(first) || !Array.isArray(second)) return false;
  if (combined.length !== first.length + second.length) return false;
  for (let i = 0; i < first.length; i++) {
    if (!sentenceTuplesEqual(combined[i], first[i])) return false;
  }
  for (let i = 0; i < second.length; i++) {
    if (!sentenceTuplesEqual(combined[first.length + i], second[i])) return false;
  }
  return true;
}

function arraysEqual<T>(a: T[] | undefined, b: T[] | undefined): boolean {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function structureEqual(a: StructureSig | undefined, b: StructureSig | undefined): boolean {
  if (!a || !b) return false;
  return a.bold === b.bold && a.italic === b.italic && a.links === b.links && a.code === b.code;
}
