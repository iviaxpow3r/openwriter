/**
 * Auto-derive a document title from its body content.
 *
 * Algorithm adapted from Joplin's `markdownUtils.titleFromBody`
 * (https://github.com/laurent22/joplin, AGPL-3.0) — algorithm only, fresh
 * implementation in this repo under MIT. Same approach Bear, iA Writer,
 * Apple Notes, and Joplin all converge on: the first non-empty line of
 * the body, stripped of formatting, becomes the title.
 *
 * Lock detection schema: implicit via `shouldAutoTitle()`. While the title
 * is in the `DEFAULT_TITLES` set or empty, we own the title and re-derive
 * on every save. The moment the user (or an agent via rename_item) sets
 * the title to anything else, auto-naming stops permanently for that doc.
 * No frontmatter flag needed — the title itself IS the state.
 *
 * Notes on the TipTap-native approach: we walk the document JSON tree
 * directly instead of running regexes on serialized markdown. Marks like
 * link/bold/italic/strike are transparent to text extraction (TipTap stores
 * inner text on text nodes, not raw `[text](url)`/`**bold**` syntax). That
 * eliminates an entire class of edge cases Joplin's regex chain handles
 * defensively. We still strip leading punctuation as a safety net for
 * users who type raw markdown into a fresh paragraph that hasn't been
 * input-parsed.
 */

const DEFAULT_TITLES: ReadonlySet<string> = new Set(['Untitled', 'New Document', 'Article']);

/**
 * Hard ceiling for an auto-derived title. Titles that fit a natural
 * sentence ending below this cap will use the sentence boundary (clean,
 * no ellipsis). Titles whose first sentence runs past the cap get
 * truncated at the nearest word boundary inside the limit. Tuned to
 * what reads cleanly in a sidebar row — Bear and iA Writer's effective
 * display widths are in this neighborhood. Joplin's 80 was usable but
 * visually heavy; 60 reads tighter without losing useful information.
 */
const TITLE_MAX_LENGTH = 60;

/**
 * Trim a string to a usable title length, preferring sentence ending
 * inside the cap, falling back to word-boundary truncation.
 */
function trimToTitleLength(text: string, maxLen: number): string {
  // Prefer the first sentence boundary if it lands within the cap.
  // Matches up to (but excluding) the punctuation, then whitespace or end.
  const sentenceMatch = text.match(/^([^.!?]+)[.!?](?:\s|$)/);
  if (sentenceMatch && sentenceMatch[1].trim().length <= maxLen) {
    return sentenceMatch[1].trim();
  }

  if (text.length <= maxLen) return text;

  // Hard truncate. Prefer the last word boundary in the last 30% of the
  // window so we don't chop mid-word when a clean break is close at hand.
  const trunc = text.substring(0, maxLen);
  const lastSpace = trunc.lastIndexOf(' ');
  if (lastSpace > maxLen * 0.7) {
    return trunc.substring(0, lastSpace);
  }
  return trunc;
}

/** Block types we skip entirely — code is rarely a good title, and
 *  decorative elements have no useful text. */
const SKIP_BLOCK_TYPES: ReadonlySet<string> = new Set([
  'codeBlock',
  'horizontalRule',
  'hardBreak',
  'image',
]);

interface TipTapNode {
  type: string;
  text?: string;
  attrs?: Record<string, any>;
  content?: TipTapNode[];
}

/** Recursively collect inline text from a node tree, skipping atom/leaf
 *  types we don't want in titles (images, code blocks, etc.). */
function extractText(node: TipTapNode): string {
  if (!node) return '';
  if (SKIP_BLOCK_TYPES.has(node.type)) return '';
  if (typeof node.text === 'string') return node.text;
  if (!node.content || !Array.isArray(node.content)) return '';
  let out = '';
  for (const child of node.content) {
    out += extractText(child);
  }
  return out;
}

/** Strip leading markdown-syntax characters that survive when a user
 *  typed raw markdown into a paragraph that didn't get input-parsed
 *  (e.g. a fresh stub block). Also handles trailing setext-style
 *  underline noise that might cling to a heading line. */
function cleanMarkdownNoise(text: string): string {
  let out = text;
  // Leading list/heading/quote/emphasis markers
  out = out.replace(/^[\s#>*_~`+\-=]+/, '');
  // Trailing setext underline residue or whitespace
  out = out.replace(/[\s#>*_~`+\-=]+$/, '');
  return out.trim();
}

/**
 * Extract a title from a TipTap document. Returns an empty string if
 * the document has no usable text. Caller decides whether to apply.
 */
export function titleFromDoc(doc: TipTapNode | null | undefined): string {
  if (!doc || !doc.content || !Array.isArray(doc.content)) return '';

  for (const block of doc.content) {
    const raw = extractText(block);
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const cleaned = cleanMarkdownNoise(trimmed);
    if (!cleaned) continue;
    return trimToTitleLength(cleaned, TITLE_MAX_LENGTH);
  }

  return '';
}

/**
 * Whether the auto-titler should act on a document with this title. True
 * when the title is empty or one of the system defaults — meaning the
 * user (or agent) has not committed to a name yet, so we're free to
 * derive one. Once `shouldAutoTitle` returns false, auto-naming stops
 * permanently for that doc.
 */
export function shouldAutoTitle(title: string | undefined | null): boolean {
  if (!title) return true;
  return DEFAULT_TITLES.has(title);
}
