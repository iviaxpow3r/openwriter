/**
 * Per-block fingerprint computation for node identity tracking.
 *
 * In-memory shape (Fingerprint) is rich — it carries position, neighbor types,
 * counts, container children, etc. so matcher rules read what they need
 * directly. Disk shape is ultra-lean — only fields the matcher cannot
 * recompute from the body tree + per-block stored signals get persisted.
 *
 *   PER-SENTENCE: bare hash string. simpleHash(text + terminator) folds the
 *   terminator type into the hash, so "Hello?" and "Hello." produce distinct
 *   hashes without needing a separate field. Unsigned hex, up to 8 chars.
 *
 *   PER-BLOCK on disk (tuple array, position-indexed):
 *     paragraph (default):  [id, sentences[], marks?]
 *     empty paragraph:      [id]
 *     heading:              [id, "h1".."h6", sentences[], marks?]
 *     codeBlock:            [id, "code", language, contentHash]
 *     horizontalRule:       [id, "hr"]
 *     image:                [id, "img"]
 *     table:                [id, "tbl"]
 *     bulletList:           [id, "ul", childTypes[]]
 *     orderedList:          [id, "ol", childTypes[]]
 *     taskList:             [id, "tl", childTypes[]]
 *     blockquote:           [id, "bq", childTypes[]]
 *     listItem:             [id, "li", childTypes[]]
 *     taskItem:             [id, "ti", childTypes[]]
 *
 *   `marks` is a compact object with non-zero entries only: {b?, i?, l?, c?}.
 *   childTypes uses the same compact tags as the type position itself.
 *
 *   Derived at enrich time (never on disk): position, parentPosition,
 *   ordinalInParent, charCount, sentenceCount, wordCount, prevType, nextType,
 *   parentType. Each is a function of the array index + sibling tree at the
 *   time of read.
 *
 * Two sentences are equal iff their hashes are equal (string ==).
 * Two blocks match exactly iff type matches, sentences arrays are equal,
 * non-zero structureSig is equal, and any container child-type array is equal.
 * Splits/merges are detected via prefix/suffix/concatenation of sentence arrays.
 *
 * adr: adr/node-identity-matcher.md
 */

export type Terminator = 'D' | 'E' | 'Q' | '-';

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
  /**
   * Existing block ID carried from the TipTap node's `attrs.id`.
   *
   * The matcher's insert rule preserves this when present so that an ID
   * already assigned by the agent (or by `applyChangesToDocument`) survives
   * the rewrite pass. Minting a fresh ID here when one already existed
   * causes server↔browser divergence — the browser still has the old ID
   * and can never resolve subsequent updates that target the new one.
   *
   * adr: adr/node-identity-matcher.md
   */
  id?: string;
}

/**
 * In-memory fingerprint shape. Rich — contains all derivable fields the
 * matcher reads. Disk persistence uses the slim tuple form via slimEntry /
 * enrichEntry below.
 */
export interface Fingerprint {
  type: string;
  position: number;
  parentPosition: number | null;
  ordinalInParent?: number;
  sentences: string[];
  structureSig: StructureSig;
  prevType: string | null;
  nextType: string | null;
  parentType: string | null;
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

const ZERO_MARKS: StructureSig = { bold: 0, italic: 0, links: 0, code: 0 };

/** Compute a fingerprint for a single block, given its position in the block list. */
export function fingerprint(block: Block, allBlocks: Block[]): Fingerprint {
  const text = block.text || '';
  const sentences = splitSentences(text).map(sentenceHash);

  const fp: Fingerprint = {
    type: block.type,
    position: block.position,
    parentPosition: block.parentPosition,
    ordinalInParent: block.ordinalInParent,
    sentences,
    structureSig: block.inlineMarks || { bold: 0, italic: 0, links: 0, code: 0 },
    prevType: allBlocks[block.position - 1]?.type || null,
    nextType: allBlocks[block.position + 1]?.type || null,
    parentType: block.parentPosition != null ? allBlocks[block.parentPosition]?.type ?? null : null,
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

/** Hash one sentence's text including its terminator so "X." and "X?" don't collide. */
function sentenceHash(sentence: { text: string; terminator: Terminator }): string {
  return simpleHash(sentence.text + sentence.terminator);
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

/** 32-bit unsigned content hash → 1-8 hex chars, no sign prefix. */
export function simpleHash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h) + s.charCodeAt(i);
    h |= 0;
  }
  return (h >>> 0).toString(16);
}

/**
 * Exact match: type + content fingerprint + structure agree. Used by Phase 1
 * pinning and graveyard-restore. Sentence-array equality implies same sentence
 * count and same content text; charCount/wordCount are redundant once hashes
 * line up and have been removed from the Fingerprint shape.
 */
export function isExactMatch(a: Fingerprint, b: Fingerprint): boolean {
  if (a.type !== b.type) return false;
  if (a.level !== b.level) return false;
  if (a.language !== b.language) return false;
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

export function sentenceArraysEqual(a: string[], b: string[]): boolean {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/** Backwards-compatible alias — sentence equality is now string equality. */
export function sentenceTuplesEqual(a: string, b: string): boolean {
  return a === b;
}

export function isSentencePrefix(short: string[], long: string[]): boolean {
  if (!Array.isArray(short) || !Array.isArray(long)) return false;
  if (short.length === 0 || short.length > long.length) return false;
  for (let i = 0; i < short.length; i++) {
    if (short[i] !== long[i]) return false;
  }
  return true;
}

export function isSentenceSuffix(short: string[], long: string[]): boolean {
  if (!Array.isArray(short) || !Array.isArray(long)) return false;
  if (short.length === 0 || short.length > long.length) return false;
  const offset = long.length - short.length;
  for (let i = 0; i < short.length; i++) {
    if (short[i] !== long[i + offset]) return false;
  }
  return true;
}

export function isSentenceConcat(
  combined: string[],
  first: string[],
  second: string[],
): boolean {
  if (!Array.isArray(combined) || !Array.isArray(first) || !Array.isArray(second)) return false;
  if (combined.length !== first.length + second.length) return false;
  for (let i = 0; i < first.length; i++) {
    if (combined[i] !== first[i]) return false;
  }
  for (let i = 0; i < second.length; i++) {
    if (combined[first.length + i] !== second[i]) return false;
  }
  return true;
}

// ----------------------------------------------------------------------
// Slim ↔ rich serialization (disk ↔ in-memory)
// ----------------------------------------------------------------------

/**
 * Disk-side block entry. A position-indexed array:
 *   [id, sentencesOrTypeTag, sentencesOrChildTypes?, marksOrExtra?, ...]
 *
 * Distinguished shapes:
 *   ["id"]                                — empty paragraph
 *   ["id", [sentenceHashes]]              — paragraph (type implied)
 *   ["id", [sentenceHashes], marks]       — paragraph with non-zero marks
 *   ["id", "hN", [hashes]]                — heading (level encoded in tag)
 *   ["id", "hN", [hashes], marks]         — heading with marks
 *   ["id", "code", "lang", "hash"]        — codeBlock
 *   ["id", "hr"|"img"|"tbl"]              — atomic block, no content fingerprint
 *   ["id", "ul"|"ol"|"tl"|"bq"|"li"|"ti", [childTypes]]  — container
 */
export type SlimEntry = (string | string[] | { b?: number; i?: number; l?: number; c?: number })[];

/** Compact type tags as written to disk. */
const SHORT_TAG: Record<string, string> = {
  bulletList: 'ul',
  orderedList: 'ol',
  taskList: 'tl',
  blockquote: 'bq',
  listItem: 'li',
  taskItem: 'ti',
  horizontalRule: 'hr',
  image: 'img',
  table: 'tbl',
};

const FULL_TYPE: Record<string, string> = {
  ul: 'bulletList',
  ol: 'orderedList',
  tl: 'taskList',
  bq: 'blockquote',
  li: 'listItem',
  ti: 'taskItem',
  hr: 'horizontalRule',
  img: 'image',
  tbl: 'table',
};

function slimMarks(sig: StructureSig | undefined): { b?: number; i?: number; l?: number; c?: number } | null {
  if (!sig) return null;
  const out: { b?: number; i?: number; l?: number; c?: number } = {};
  if (sig.bold) out.b = sig.bold;
  if (sig.italic) out.i = sig.italic;
  if (sig.links) out.l = sig.links;
  if (sig.code) out.c = sig.code;
  return Object.keys(out).length > 0 ? out : null;
}

function enrichMarks(raw: any): StructureSig {
  if (!raw || typeof raw !== 'object') return { ...ZERO_MARKS };
  return {
    bold: raw.b || 0,
    italic: raw.i || 0,
    links: raw.l || 0,
    code: raw.c || 0,
  };
}

/** Encode a rich Fingerprint + id into the slim disk tuple. */
export function slimEntry(id: string, fp: Fingerprint): SlimEntry {
  const marks = slimMarks(fp.structureSig);

  if (fp.type === 'paragraph') {
    const out: SlimEntry = [id];
    if (fp.sentences && fp.sentences.length > 0) out.push(fp.sentences);
    if (marks) {
      if (out.length === 1) out.push([]);
      out.push(marks);
    }
    return out;
  }

  if (fp.type === 'heading') {
    const tag = `h${fp.level || 1}`;
    const out: SlimEntry = [id, tag, fp.sentences || []];
    if (marks) out.push(marks);
    return out;
  }

  if (fp.type === 'codeBlock') {
    return [id, 'code', fp.language || '', fp.contentHash || ''];
  }

  if (CONTAINER_TYPES.has(fp.type)) {
    const tag = SHORT_TAG[fp.type] || fp.type;
    const out: SlimEntry = [id, tag];
    if (fp.childTypes && fp.childTypes.length > 0) {
      out.push(fp.childTypes.map((t) => SHORT_TAG[t] || t));
    }
    return out;
  }

  // Atomic blocks: horizontalRule, image, table
  const tag = SHORT_TAG[fp.type] || fp.type;
  return [id, tag];
}

/**
 * Decode a slim disk tuple back into {id, fingerprint}. Block context (the
 * block at this entry's position in the freshly-parsed body, plus the full
 * block list for neighbor lookups) supplies the derived fields. If no block
 * context is available (graveyard entries — deleted blocks have no body),
 * derived position/neighbor fields default to safe values; matcher rules
 * for graveyard restore only consult type + sentences + marks + childTypes,
 * which are all carried in slim.
 */
export function enrichEntry(
  slim: SlimEntry,
  block: Block | null,
  allBlocks: Block[],
): { id: string; fingerprint: Fingerprint } | null {
  if (!Array.isArray(slim) || slim.length === 0 || typeof slim[0] !== 'string') return null;
  const id = slim[0] as string;
  const second = slim[1];

  let type = 'paragraph';
  let sentences: string[] = [];
  let level: number | undefined;
  let language: string | undefined;
  let contentHash: string | undefined;
  let childTypes: string[] | undefined;
  let marksRaw: any = null;

  if (slim.length === 1) {
    // Empty paragraph
  } else if (Array.isArray(second)) {
    // Paragraph with sentences
    sentences = (second as string[]).filter((x) => typeof x === 'string');
    if (slim.length >= 3 && !Array.isArray(slim[2])) marksRaw = slim[2];
  } else if (typeof second === 'string') {
    const tag = second;
    if (/^h([1-6])$/.test(tag)) {
      type = 'heading';
      level = parseInt(tag.slice(1), 10);
      if (Array.isArray(slim[2])) sentences = (slim[2] as string[]).filter((x) => typeof x === 'string');
      if (slim.length >= 4 && !Array.isArray(slim[3])) marksRaw = slim[3];
    } else if (tag === 'code') {
      type = 'codeBlock';
      language = typeof slim[2] === 'string' ? (slim[2] as string) : '';
      contentHash = typeof slim[3] === 'string' ? (slim[3] as string) : '';
    } else if (FULL_TYPE[tag]) {
      type = FULL_TYPE[tag];
      if (CONTAINER_TYPES.has(type) && Array.isArray(slim[2])) {
        childTypes = (slim[2] as string[]).map((t) => FULL_TYPE[t] || t);
      }
    } else {
      // Unknown short tag — carry through verbatim
      type = tag;
    }
  }

  const structureSig = enrichMarks(marksRaw);

  // Derived from block context, with safe fallbacks for graveyard entries
  // (where `block` is null — the deleted block is gone from the body).
  const fingerprint: Fingerprint = {
    type,
    position: block ? block.position : -1,
    parentPosition: block ? block.parentPosition : null,
    ordinalInParent: block ? block.ordinalInParent : undefined,
    sentences,
    structureSig,
    prevType: block ? allBlocks[block.position - 1]?.type || null : null,
    nextType: block ? allBlocks[block.position + 1]?.type || null : null,
    parentType: block && block.parentPosition != null
      ? allBlocks[block.parentPosition]?.type ?? null
      : null,
  };

  if (type === 'heading' && level !== undefined) fingerprint.level = level;
  if (type === 'codeBlock') {
    fingerprint.language = language || '';
    fingerprint.contentHash = contentHash || '';
  }
  if (CONTAINER_TYPES.has(type)) {
    if (childTypes !== undefined) {
      fingerprint.childCount = childTypes.length;
      fingerprint.childTypes = childTypes;
    } else if (block) {
      // No childTypes in slim (older entry) — derive from current tree.
      const children = allBlocks.filter((b) => b.parentPosition === block.position);
      fingerprint.childCount = children.length;
      fingerprint.childTypes = children.map((c) => c.type);
    } else {
      fingerprint.childCount = 0;
      fingerprint.childTypes = [];
    }
  }

  return { id, fingerprint };
}

/**
 * Slim a list of {id, fingerprint} entries for disk. Containers and headings
 * carry their type marker; paragraphs default. Caller passes them in the same
 * order they appear in the block tree (matcher output naturally is).
 */
export function slimEntries(
  entries: Array<{ id: string; fingerprint: Fingerprint }>,
): SlimEntry[] {
  return entries.map((e) => slimEntry(e.id, e.fingerprint));
}

/**
 * Enrich slim disk entries against the freshly-parsed block list. Each slim
 * entry at index i is paired with blocks[i]. Entries past the end of `blocks`
 * use null context (typical for graveyard).
 */
export function enrichEntries(
  slimList: SlimEntry[],
  blocks: Block[],
): Array<{ id: string; fingerprint: Fingerprint }> {
  const out: Array<{ id: string; fingerprint: Fingerprint }> = [];
  for (let i = 0; i < slimList.length; i++) {
    const slim = slimList[i];
    const block = blocks[i] || null;
    const enriched = enrichEntry(slim, block, blocks);
    if (enriched) out.push(enriched);
  }
  return out;
}

// ----------------------------------------------------------------------
// Legacy format detection (v0.14 / v0.15 → ultra-lean)
// ----------------------------------------------------------------------

/**
 * Detect legacy (pre-ultra-lean) format at the frontmatter raw-parse layer.
 * Legacy entries are objects with `id` + `fp` keys (or `firstWords`/`w`/`wls`
 * within sentences). Ultra-lean entries are arrays. Mixed input is rare but
 * tolerated by the legacy-migration path, which re-fingerprints positionally.
 */
export function isLegacyRawEntry(raw: any): boolean {
  return raw != null && typeof raw === 'object' && !Array.isArray(raw);
}

export function anyLegacyRaw(rawList: any): boolean {
  if (!Array.isArray(rawList)) return false;
  for (const r of rawList) {
    if (isLegacyRawEntry(r)) return true;
  }
  return false;
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
