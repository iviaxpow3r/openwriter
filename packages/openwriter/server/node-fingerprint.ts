/**
 * Per-block fingerprint computation for node identity tracking.
 *
 * Signal hierarchy:
 *
 *   PER-SENTENCE TUPLE {c, h, t}:
 *     c = char count of sentence (excluding terminator + trailing space)
 *     h = content hash of sentence text (8-char hex)
 *     t = terminator type ('D'|'E'|'Q'|'-')
 *
 *   BLOCK-LEVEL FIELDS:
 *     type, charCount, sentenceCount, wordCount  — block-wide counts
 *     sentences[]                                — per-sentence tuples
 *     structureSig                               — inline mark counts
 *     prevType, nextType, parentType             — structural context
 *     level / language / contentHash / childCount / childTypes — type-specific
 *
 * Two sentences are equal if their tuples are equal (c, h, t identical).
 * Two blocks match deterministically if their sentence arrays are equal.
 * Splits/merges are detected via array prefix/suffix/concatenation.
 *
 * The single content hash per sentence replaces the v0.14 fingerprint's
 * full word array, word-length array, and 3-char prefix/suffix windows.
 * A hash uniquely identifies a sentence's text in 8 bytes; the v0.14
 * fields were defense-in-depth insurance against collisions that never
 * materialized in the test corpus. The matcher's rules only consume
 * "same or not same" — they never asked "how similar," so the richer
 * signals were storage cost without comparator value.
 *
 * adr: adr/node-identity-matcher.md
 */

export type Terminator = 'D' | 'E' | 'Q' | '-';

export interface SentenceTuple {
  c: number;
  h: string;
  t: Terminator;
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
 * Build the per-sentence tuple. `c` is the sentence length, `h` is the
 * content hash (deterministic from sentence text), `t` is the terminator
 * type. Three fields total — equality on these three is sufficient to
 * detect "same sentence."
 */
function sentenceTuple(sentence: { text: string; terminator: Terminator }): SentenceTuple {
  return {
    c: sentence.text.length,
    h: simpleHash(sentence.text),
    t: sentence.terminator,
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

/** Three-field equality on the compact tuple. Same hash = same sentence text. */
export function sentenceTuplesEqual(a: SentenceTuple, b: SentenceTuple): boolean {
  return a.c === b.c && a.h === b.h && a.t === b.t;
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

// ----------------------------------------------------------------------
// Legacy format migration (v0.14 → v0.15)
// ----------------------------------------------------------------------

/**
 * Detect whether a fingerprint uses the v0.14 sentence-tuple format
 * (with `w` word array, `wls` word lengths, `f`/`l` prefix-suffix windows).
 * The v0.15+ format has only `c`, `h`, `t` per sentence — no `w`/`wls`/`f`/`l`.
 *
 * Used at load-time and save-time to detect "this doc was last saved by an
 * older build" and trigger positional re-fingerprinting before the matcher
 * compares against new-format candidate fingerprints.
 */
export function isLegacyFingerprint(fp: Fingerprint | null | undefined): boolean {
  if (!fp || !Array.isArray(fp.sentences)) return false;
  for (const s of fp.sentences) {
    const sa: any = s;
    if (sa && (sa.w !== undefined || sa.wls !== undefined || sa.f !== undefined || sa.l !== undefined)) {
      return true;
    }
  }
  return false;
}

/**
 * Migrate v0.14 legacy fingerprints to the v0.15 compact format.
 *
 * The caller passes:
 *   - `entries`: array of {id, fingerprint} read from disk frontmatter
 *     (potentially in legacy format)
 *   - `freshBlocks`: blocks freshly parsed from the disk body, ready to be
 *     fingerprinted in the new format
 *
 * Returns a new entries array where each legacy fingerprint is replaced by
 * the fresh fingerprint at the same position (IDs preserved). The next save
 * then writes the new format and migration is complete for this doc.
 *
 * Why positional: at load-time, the disk body IS the previous state — there's
 * nothing before it to compare against. Re-fingerprinting the body produces
 * fingerprints that match what the matcher would compute for an unchanged
 * doc, so exact-match pinning works cleanly across the migration boundary.
 *
 * If `freshBlocks` has fewer entries than `entries`, extra legacy entries are
 * dropped (their slot no longer exists). If more, extra fresh fingerprints
 * are not added (no IDs to assign them to — the matcher's insert rule will
 * mint fresh IDs on the next save for any newly-introduced blocks).
 */
export function migrateLegacyEntries(
  entries: Array<{ id: string; fingerprint: Fingerprint }>,
  freshBlocks: Block[],
): Array<{ id: string; fingerprint: Fingerprint }> {
  if (entries.length === 0) return entries;
  const needsMigration = entries.some((e) => isLegacyFingerprint(e.fingerprint));
  if (!needsMigration) return entries;

  const freshFps = fingerprintAll(freshBlocks);
  const out: Array<{ id: string; fingerprint: Fingerprint }> = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (isLegacyFingerprint(entry.fingerprint) && freshFps[i]) {
      out.push({ id: entry.id, fingerprint: freshFps[i] });
    } else {
      out.push(entry);
    }
  }
  return out;
}

/**
 * Drop graveyard entries whose fingerprints are in legacy format.
 *
 * Graveyard fingerprints describe blocks that no longer exist in the body,
 * so positional re-fingerprinting from the body isn't possible — there's
 * nothing to point at. Best-effort hashing from the legacy `w[]` word array
 * would produce hashes that don't match fresh content (joining words drops
 * punctuation), so paste-back recovery wouldn't fire anyway. Dropping is
 * the honest answer.
 *
 * Cost: paste-back recovery for blocks deleted pre-migration won't work for
 * one save cycle. After the next batch of deletes, graveyard repopulates in
 * the new format and recovery works normally. Acceptable migration tax.
 */
export function dropLegacyGraveyard(
  graveyard: Array<{ id: string; fingerprint: Fingerprint }>,
): Array<{ id: string; fingerprint: Fingerprint }> {
  return graveyard.filter((g) => !isLegacyFingerprint(g.fingerprint));
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
