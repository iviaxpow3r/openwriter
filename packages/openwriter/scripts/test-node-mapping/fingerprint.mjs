/**
 * Fingerprint — compute the signal vector for a single block.
 *
 * Signal hierarchy (most-to-least deterministic — push math before words):
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
 */

const WORD_FALLBACK_WINDOW = 5;  // first/last N words — only used when math is ambiguous
const PREFIX_LEN = 3;            // chars of start/end of each sentence used as math fingerprint

/**
 * Compute a fingerprint for a single block, given its position in the block list.
 * @param {Block} block - from walker output
 * @param {Array<Block>} allBlocks - full block list (for context lookup)
 * @returns {Fingerprint}
 */
export function fingerprint(block, allBlocks) {
  const text = block.text || '';
  const sentences = splitSentences(text);
  const words = tokenizeWords(text);

  const fp = {
    type: block.type,
    position: block.position,
    parentPosition: block.parentPosition,
    ordinalInParent: block.ordinalInParent,

    // Math signals (primary)
    charCount: text.length,
    sentenceCount: sentences.length,
    wordCount: words.length,
    sentences: sentences.map(sentenceTuple),
    structureSig: block.inlineMarks || { bold: 0, italic: 0, links: 0, code: 0 },

    // Context signals
    prevType: allBlocks[block.position - 1]?.type || null,
    nextType: allBlocks[block.position + 1]?.type || null,
    parentType: block.parentPosition != null ? allBlocks[block.parentPosition]?.type : null,

    // Fallback word signals
    firstWords: words.slice(0, WORD_FALLBACK_WINDOW),
    lastWords: words.slice(-WORD_FALLBACK_WINDOW),
  };

  // Type-specific augmentations
  if (block.type === 'heading') fp.level = block.level;
  if (block.type === 'codeBlock') {
    fp.language = block.language || '';
    fp.contentHash = simpleHash(block.text);
  }

  // Container blocks get structural child summary so two empty-text containers
  // with different children can be distinguished. Pure structure — no text
  // content rolled up — so child edits don't cascade.
  const CONTAINER_TYPES = ['bulletList', 'orderedList', 'taskList', 'blockquote', 'table', 'listItem', 'taskItem'];
  if (CONTAINER_TYPES.includes(block.type)) {
    const children = allBlocks.filter((b) => b.parentPosition === block.position);
    fp.childCount = children.length;
    fp.childTypes = children.map((c) => c.type);
  }

  return fp;
}

/**
 * Build the per-sentence tuple. Math signals first; the `w` field carries
 * the actual word strings as the word-level identity check.
 *
 * Math fields (c, f, l, t, wls) form the primary fingerprint. Prefix/suffix
 * `f` and `l` are PREFIX_LEN chars each — much stronger than single-char
 * signals. Words (`w`) are defense-in-depth for the rare case where math
 * still collides under richer prefixes.
 *
 * Example: "He lives in abundance."
 *   → { c: 21, f: 'He ', l: 'nce', t: 'D', wls: [2,5,2,9], w: ['He','lives','in','abundance'] }
 */
function sentenceTuple(sentence) {
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

/**
 * Compute fingerprints for every block in a doc.
 */
export function fingerprintAll(blocks) {
  return blocks.map((b) => fingerprint(b, blocks));
}

/**
 * Split text into sentences. Each sentence carries its terminator type:
 *   'D' = declarative (.)
 *   'E' = exclamation (!)
 *   'Q' = question (?)
 *   '-' = no terminator (last fragment with no punctuation)
 *
 * Simple regex-based approach. Doesn't handle abbreviations (Mr., Dr., etc.)
 * perfectly — for the test corpus we control the input. Real-world handling
 * can refine this later.
 */
export function splitSentences(text) {
  if (!text) return [];
  const sentences = [];
  // Match sentence + terminator, allowing trailing whitespace
  const re = /([^.!?]+?)([.!?]+)(\s+|$)/g;
  let lastIdx = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    const sentenceText = m[1].trim();
    const term = m[2][0]; // first terminator char
    sentences.push({
      text: sentenceText,
      terminator: term === '.' ? 'D' : term === '!' ? 'E' : term === '?' ? 'Q' : '-',
    });
    lastIdx = re.lastIndex;
  }
  // Trailing fragment without terminator
  if (lastIdx < text.length) {
    const remaining = text.slice(lastIdx).trim();
    if (remaining) {
      sentences.push({ text: remaining, terminator: '-' });
    }
  }
  return sentences;
}

/**
 * Split text into words. Whitespace-delimited, punctuation stripped from ends.
 */
export function tokenizeWords(text) {
  if (!text) return [];
  return text
    .split(/\s+/)
    .map((w) => w.replace(/^[^\w]+|[^\w]+$/g, ''))
    .filter((w) => w.length > 0);
}

/**
 * Simple non-cryptographic hash for content-equality checks (code blocks).
 */
export function simpleHash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h) + s.charCodeAt(i);
    h |= 0; // 32-bit
  }
  return h.toString(16);
}

/**
 * Compare two fingerprints. Returns a comparison object describing
 * which dimensions match exactly, partially, or not at all.
 *
 * Used by the matcher to detect mutation patterns.
 */
export function compareFingerprints(a, b) {
  return {
    typeMatch: a.type === b.type,
    levelMatch: a.level === b.level,
    languageMatch: a.language === b.language,
    contentHashMatch: a.contentHash != null && a.contentHash === b.contentHash,
    charCountMatch: a.charCount === b.charCount,
    sentenceCountMatch: a.sentenceCount === b.sentenceCount,
    wordCountMatch: a.wordCount === b.wordCount,
    sentencesMatch: sentenceArraysEqual(a.sentences, b.sentences),
    structureSigMatch: structureEqual(a.structureSig, b.structureSig),
    parentTypeMatch: a.parentType === b.parentType,
    prevTypeMatch: a.prevType === b.prevType,
    nextTypeMatch: a.nextType === b.nextType,

    // Prefix/suffix relationships on sentence arrays (for split/merge detection)
    aSentencesIsPrefixOfB: isSentencePrefix(a.sentences, b.sentences),
    aSentencesIsSuffixOfB: isSentenceSuffix(a.sentences, b.sentences),
    bSentencesIsPrefixOfA: isSentencePrefix(b.sentences, a.sentences),
    bSentencesIsSuffixOfA: isSentenceSuffix(b.sentences, a.sentences),

    // Fallback word matching (only consulted if math is ambiguous)
    firstWordsMatch: arraysEqual(a.firstWords, b.firstWords),
    lastWordsMatch: arraysEqual(a.lastWords, b.lastWords),
  };
}

/**
 * The strongest possible match: every math dimension equal.
 * Words are NOT consulted — pure math determinism for the exact-match path.
 */
export function isExactMatch(a, b) {
  const c = compareFingerprints(a, b);
  if (
    !c.typeMatch ||
    !c.levelMatch ||
    !c.languageMatch ||
    !c.charCountMatch ||
    !c.sentenceCountMatch ||
    !c.wordCountMatch ||
    !c.sentencesMatch ||
    !c.structureSigMatch
  ) return false;

  // For containers, child structure must also match exactly (count + types).
  // Without this, two empty-text containers with different children would
  // appear identical and the position-distance tiebreaker would misroute IDs.
  if (a.childCount != null || b.childCount != null) {
    if (a.childCount !== b.childCount) return false;
    if (!arraysEqual(a.childTypes, b.childTypes)) return false;
  }

  return true;
}

/** Identical content but possibly different types — used by type-change rule.
 *
 * Containers and leaves compare differently:
 *   - Container ↔ container: identical childCount + childTypes
 *   - Leaf ↔ leaf: sentence-array equality + matching structureSig
 *   - Container ↔ leaf: never (different shape entirely)
 *
 * This prevents two containers with empty text from being considered "same"
 * just because their empty sentence arrays trivially match.
 */
export function isSameContent(a, b) {
  const aIsContainer = a.childCount != null;
  const bIsContainer = b.childCount != null;
  if (aIsContainer !== bIsContainer) return false;

  if (aIsContainer) {
    return a.childCount === b.childCount && arraysEqual(a.childTypes, b.childTypes);
  }

  // Leaf-vs-leaf: sentence equality + matching inline structure (so a bolded
  // version isn't considered "same content" as the un-bolded original).
  if (a.sentences != null && b.sentences != null) {
    if (!sentenceArraysEqual(a.sentences, b.sentences)) return false;
    return structureEqual(a.structureSig, b.structureSig);
  }
  return false;
}

/**
 * Test if two sentence-tuple arrays are equal (every 5-tuple matches).
 */
export function sentenceArraysEqual(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (!sentenceTuplesEqual(a[i], b[i])) return false;
  }
  return true;
}

/**
 * Test if two sentence tuples are equal — math AND words.
 *
 * Word equality (`w`) is the disambiguator for math collisions. Two
 * sentences with identical math signals but different words are different
 * sentences. Edit/slot-continuity rules still catch them via shared math
 * signals; only the strictest equality requires words to match.
 */
export function sentenceTuplesEqual(a, b) {
  return (
    a.c === b.c &&
    a.f === b.f &&
    a.l === b.l &&
    a.t === b.t &&
    arraysEqual(a.wls, b.wls) &&
    arraysEqual(a.w, b.w)
  );
}

/**
 * Test if `short` is a prefix of `long` — every sentence tuple in `short`
 * matches the corresponding tuple in `long` from index 0.
 */
export function isSentencePrefix(short, long) {
  if (!Array.isArray(short) || !Array.isArray(long)) return false;
  if (short.length === 0 || short.length > long.length) return false;
  for (let i = 0; i < short.length; i++) {
    if (!sentenceTuplesEqual(short[i], long[i])) return false;
  }
  return true;
}

/**
 * Test if `short` is a suffix of `long` — every sentence tuple in `short`
 * matches the corresponding tuple in `long` from the end.
 */
export function isSentenceSuffix(short, long) {
  if (!Array.isArray(short) || !Array.isArray(long)) return false;
  if (short.length === 0 || short.length > long.length) return false;
  const offset = long.length - short.length;
  for (let i = 0; i < short.length; i++) {
    if (!sentenceTuplesEqual(short[i], long[i + offset])) return false;
  }
  return true;
}

/**
 * Test if `combined` equals `first` concatenated with `second` (sentence arrays).
 * Used for merge detection: new block's sentences = orphA.sentences ++ orphB.sentences.
 */
export function isSentenceConcat(combined, first, second) {
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

function arraysEqual(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function structureEqual(a, b) {
  if (!a || !b) return false;
  return a.bold === b.bold && a.italic === b.italic && a.links === b.links && a.code === b.code;
}

function isPrefix(short, long) {
  if (!Array.isArray(short) || !Array.isArray(long)) return false;
  if (short.length === 0 || short.length > long.length) return false;
  for (let i = 0; i < short.length; i++) if (short[i] !== long[i]) return false;
  return true;
}

function isSuffix(short, long) {
  if (!Array.isArray(short) || !Array.isArray(long)) return false;
  if (short.length === 0 || short.length > long.length) return false;
  const offset = long.length - short.length;
  for (let i = 0; i < short.length; i++) if (short[i] !== long[i + offset]) return false;
  return true;
}
