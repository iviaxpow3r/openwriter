/**
 * Markdown -> TipTap JSON parsing.
 * Parses markdown (with optional YAML frontmatter) into TipTap document JSON.
 *
 * Node identity is reassigned via the matcher when the frontmatter carries a
 * `nodes` array (the new path). For legacy docs without `nodes`, trailing
 * `^id` caret anchors and `<!-- ^id -->` empty-paragraph markers are still
 * recognized as ID sources so existing files keep their identities through
 * the migration. Once a migrated doc is saved, the body is clean and all
 * identity lives in frontmatter.
 *
 * adr: adr/node-identity-matcher.md
 */

import MarkdownIt from 'markdown-it';
import matter from 'gray-matter';
import type Token from 'markdown-it/lib/token.mjs';
import markdownItIns from 'markdown-it-ins';
import markdownItMark from 'markdown-it-mark';
import markdownItSub from 'markdown-it-sub';
import markdownItSup from 'markdown-it-sup';
import { generateNodeId, LEAF_BLOCK_TYPES } from './helpers.js';
import { nodeText } from './markdown-serialize.js';
import { tiptapToBlocks, applyIdsToTiptap } from './node-blocks.js';
import { matchNodes, type NodeEntry } from './node-matcher.js';
import {
  type Fingerprint,
  enrichEntries,
  fingerprintAll,
  isLegacyRawEntry,
  anyLegacyRaw,
  type SlimEntry,
} from './node-fingerprint.js';

// ============================================================================
// Markdown -> TipTap
// ============================================================================

const md = new MarkdownIt({ linkify: false, html: true });
md.enable('strikethrough');
md.use(markdownItIns);
md.use(markdownItMark);
md.use(markdownItSub);
md.use(markdownItSup);

export interface ParsedMarkdown {
  title: string;
  metadata: Record<string, any>;
  document: { type: 'doc'; content: any[] };
  rawFrontmatter: string | null;
  /** Persisted graveyard from frontmatter — recently-deleted node fingerprints
   *  carried across saves so paste-back/undo can restore the original ID. */
  graveyard: NodeEntry[];
  /** Persisted nodes graph from frontmatter — used as previousNodes input on
   *  the next matcher run (save-time or load-time). */
  previousNodes: NodeEntry[];
}

/**
 * Normalize blank lines INSIDE markdown tables before parsing.
 *
 * Per CommonMark, a blank line terminates a table block. Agents writing
 * markdown content frequently insert blank lines between table rows for
 * readability (e.g. `| row |\n\n| row |`), which the strict parser then
 * splits into "table with 1 header row" + N orphan paragraphs that happen
 * to contain pipe characters. The broken structure persists across saves
 * because every serialize → re-parse cycle re-breaks it.
 *
 * This pre-pass detects "table region" (saw a separator row `| --- |`,
 * haven't hit a non-pipe-row yet) and strips blank lines between pipe-rows
 * inside that region. Code fences (` ``` `, `~~~`) are honored — pipes
 * inside them stay untouched.
 *
 * Self-healing: a doc on disk with blank-separated rows loads as a proper
 * N-row table; the next save writes contiguous markdown. No migration
 * script needed.
 */
function normalizeTableBlankLines(markdown: string): string {
  if (!markdown.includes('|')) return markdown;
  const lines = markdown.split('\n');
  const out: string[] = [];
  let inFence = false;
  let inTable = false; // true between a separator row and the next non-pipe-row

  const isPipeRow = (s: string): boolean => /^\s*\|.*\|\s*$/.test(s);
  const isSeparator = (s: string): boolean => /^\s*\|[\s:|-]+\|\s*$/.test(s);
  const isBlank = (s: string): boolean => s.trim() === '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Code-fence toggle — pipes inside fences stay verbatim
    if (/^[`~]{3,}/.test(line)) {
      inFence = !inFence;
      inTable = false;
      out.push(line);
      continue;
    }
    if (inFence) { out.push(line); continue; }

    if (isSeparator(line)) {
      // Separator confirms we're in a table region from here on
      inTable = true;
      out.push(line);
      continue;
    }

    if (inTable && isBlank(line)) {
      // Look ahead past additional blanks for the next non-blank line
      let j = i + 1;
      while (j < lines.length && lines[j].trim() === '') j++;
      // If the next non-blank line is another pipe-row, it's EITHER a
      // continuation row (merge across the blank) OR the header of a NEW
      // table (the blank is the boundary, don't merge). We tell them apart
      // by peeking one further: if line j+1 is a separator row, j is a new
      // table's header — preserve the blank and exit the current table region.
      if (j < lines.length && isPipeRow(lines[j])) {
        if (j + 1 < lines.length && isSeparator(lines[j + 1])) {
          // New table starting — keep the boundary blank, end current region
          inTable = false;
          out.push(line);
          continue;
        }
        // Continuation row — drop the blank
        continue;
      }
      // Lookahead found non-pipe content — table region is ending
      inTable = false;
      out.push(line);
      continue;
    }

    if (inTable && !isPipeRow(line)) {
      // Non-pipe content ends the table region
      inTable = false;
    }

    out.push(line);
  }

  return out.join('\n');
}

export function markdownToTiptap(markdown: string): ParsedMarkdown {
  const result = matter(markdown);
  const { data, content } = result;
  const title = (data.title as string) || 'Untitled';

  const normalizedContent = normalizeTableBlankLines(content);
  const tokens = md.parse(normalizedContent, {});
  const docContent = tokensToTiptap(tokens);

  const doc = {
    type: 'doc' as const,
    content: docContent.length > 0 ? docContent : [{ type: 'paragraph', attrs: { id: generateNodeId() }, content: [] }],
  };

  // Resolve identity graph from frontmatter. Two on-disk formats live in the
  // wild: ultra-lean slim tuples (current) and legacy verbose objects (v0.14
  // and v0.15). Legacy entries get positionally re-fingerprinted from the
  // freshly-parsed body — the body IS the previous state at load time, and
  // re-fingerprinting produces hashes the matcher can pin against cleanly.
  // adr: adr/node-identity-matcher.md
  const blocksForEnrich = tiptapToBlocks(doc);
  const previousNodes = resolvePreviousNodes(data.nodes, blocksForEnrich);
  const graveyard = resolveGraveyard(data.graveyard);

  if (previousNodes.length > 0) {
    applyMatcher(doc, previousNodes, graveyard);
  }

  // Rehydrate pending state from frontmatter into node attrs
  if (data.pending) {
    rehydratePendingState(doc, data.pending);
  }

  // Strip consumed keys from returned metadata
  const metadata = { ...data };
  delete metadata.pending;
  delete metadata.nodes;
  delete metadata.graveyard;

  return {
    title,
    metadata,
    document: doc,
    rawFrontmatter: result.matter || null,
    graveyard,
    previousNodes,
  };
}

/**
 * Resolve `nodes:` frontmatter into rich NodeEntry[] suitable for the matcher.
 *
 * Two on-disk formats:
 *   - Ultra-lean: each entry is an array tuple. enrichEntries fills derived
 *     fields against the freshly-parsed block tree.
 *   - Legacy (v0.14/v0.15): each entry is an object with `id` and `fp` keys.
 *     We re-fingerprint positionally from the body — the body IS the previous
 *     state at load time, and a fresh fingerprint over the same body produces
 *     hashes the matcher can pin against. After the next save, disk is in the
 *     ultra-lean format.
 */
export function resolvePreviousNodes(raw: any, blocks: any[]): NodeEntry[] {
  if (!Array.isArray(raw) || raw.length === 0) return [];

  if (anyLegacyRaw(raw)) {
    // Positional re-fingerprint: take each legacy entry's id, assign it to a
    // freshly-computed fingerprint at the same position in the body.
    const freshFps = fingerprintAll(blocks);
    const out: NodeEntry[] = [];
    for (let i = 0; i < raw.length; i++) {
      const r = raw[i];
      const id = isLegacyRawEntry(r) ? r.id : (Array.isArray(r) ? r[0] : null);
      if (!id || typeof id !== 'string' || !freshFps[i]) continue;
      out.push({ id, fingerprint: freshFps[i] });
    }
    return out;
  }

  // Ultra-lean: every entry is an array tuple. Enrich positionally.
  return enrichEntries(raw as SlimEntry[], blocks).map((e) => ({
    id: e.id,
    fingerprint: e.fingerprint,
  }));
}

/**
 * Resolve `graveyard:` frontmatter into rich NodeEntry[].
 *
 * Ultra-lean tuples enrich without block context (deleted blocks have no
 * body). Derived fields default to safe values; matcher rules for graveyard
 * restore only consult type + sentences + structureSig + childTypes, all
 * carried in slim. Legacy graveyard entries are dropped — their stored
 * fingerprints don't translate to the new hash semantics (terminator is now
 * folded into the hash), so they'd never match a fresh paste-back anyway.
 */
export function resolveGraveyard(raw: any): NodeEntry[] {
  if (!Array.isArray(raw) || raw.length === 0) return [];

  if (anyLegacyRaw(raw)) {
    // Mixed input: drop legacy entries, enrich slim ones.
    const slimOnly = raw.filter((r) => Array.isArray(r)) as SlimEntry[];
    return enrichEntries(slimOnly, []).map((e) => ({ id: e.id, fingerprint: e.fingerprint }));
  }

  return enrichEntries(raw as SlimEntry[], []).map((e) => ({
    id: e.id,
    fingerprint: e.fingerprint,
  }));
}

/**
 * Run the matcher: compare frontmatter `nodes` (previous fingerprints) to
 * the current TipTap tree's blocks, then apply pinned IDs back onto the tree.
 *
 * Graveyard is passed through so paste-back of recently-deleted content
 * restores the original ID (matched by exact fingerprint).
 */
function applyMatcher(doc: { content: any[] }, previousNodes: NodeEntry[], graveyard: NodeEntry[]): void {
  if (previousNodes.length === 0) return;

  const newBlocks = tiptapToBlocks(doc);
  const matchResult = matchNodes(previousNodes, newBlocks, { graveyard });

  const pinnedByPosition = new Map<number, string>();
  for (const p of matchResult.pinned) {
    pinnedByPosition.set(p.position, p.id);
  }
  applyIdsToTiptap(doc, pinnedByPosition);
}

/**
 * Rehydrate pending state from frontmatter into leaf block node attrs.
 * Uses text fingerprint matching to survive position shifts caused by
 * empty paragraphs disappearing during markdown round-trips.
 */
function rehydratePendingState(doc: { content: any[] }, pending: Record<string, any>): void {
  // Build ordered list of leaf blocks with text fingerprints
  const leaves: { node: any; text: string }[] = [];
  function collect(nodes: any[]): void {
    if (!nodes) return;
    for (const node of nodes) {
      if (LEAF_BLOCK_TYPES.has(node.type)) {
        leaves.push({ node, text: nodeText(node) });
      } else if (node.content) {
        collect(node.content);
      }
    }
  }
  collect(doc.content);

  const used = new Set<number>();

  for (const [posStr, entry] of Object.entries(pending)) {
    const pos = parseInt(posStr, 10);
    let target: any = null;

    // 1. Try position match (with text verification if fingerprint exists)
    if (pos < leaves.length && !used.has(pos)) {
      if (!entry.t || leaves[pos].text === entry.t) {
        target = leaves[pos].node;
        used.add(pos);
      }
    }

    // 2. Fallback: search by text fingerprint
    if (!target && entry.t) {
      for (let i = 0; i < leaves.length; i++) {
        if (!used.has(i) && leaves[i].text === entry.t) {
          target = leaves[i].node;
          used.add(i);
          break;
        }
      }
    }

    if (target) {
      target.attrs = target.attrs || {};
      target.attrs.pendingStatus = entry.s;
      if (entry.o) {
        target.attrs.pendingOriginalContent = entry.o;
      }
      if (entry.g) {
        target.attrs.pendingGroupId = entry.g;
      }
      // Selection range attrs (sub-paragraph enhance)
      if (entry.sf != null) target.attrs.pendingSelectionFrom = entry.sf;
      if (entry.st != null) target.attrs.pendingSelectionTo = entry.st;
      if (entry.of != null) target.attrs.pendingOriginalFrom = entry.of;
      if (entry.ot != null) target.attrs.pendingOriginalTo = entry.ot;
    }
  }
}

/** Parse a markdown string into TipTap block nodes (no frontmatter). */
export function markdownToNodes(markdown: string): any[] {
  const tokens = md.parse(markdown, {});
  const nodes = tokensToTiptap(tokens);
  return nodes.length > 0 ? nodes : [{ type: 'paragraph', attrs: { id: generateNodeId() }, content: [] }];
}

// ---- Token tree walker ----

function tokensToTiptap(tokens: Token[]): any[] {
  const nodes: any[] = [];
  let i = 0;

  while (i < tokens.length) {
    const token = tokens[i];

    if (token.type === 'heading_open') {
      const level = parseInt(token.tag.slice(1));
      const inlineToken = tokens[i + 1];
      const rawContent = inlineToken?.children ? inlineTokensToTiptap(inlineToken.children) : [];
      const { content, id } = extractTrailingNodeId(rawContent);
      nodes.push({ type: 'heading', attrs: { id: id || generateNodeId(), level }, content });
      i += 3;
    } else if (token.type === 'paragraph_open') {
      const inlineToken = tokens[i + 1];
      const rawContent = inlineToken?.children ? inlineTokensToTiptap(inlineToken.children) : [];
      const { content, id } = extractTrailingNodeId(rawContent);
      // Check for solo image — promote to block-level image node
      if (content.length === 1 && content[0].type === 'image') {
        nodes.push(content[0]);
      } else {
        nodes.push({ type: 'paragraph', attrs: { id: id || generateNodeId() }, content });
      }
      i += 3;
    } else if (token.type === 'bullet_list_open') {
      const end = findClosingToken(tokens, i, 'bullet_list');
      const items = parseListItems(tokens.slice(i + 1, end));
      const listNode = { type: 'bulletList', attrs: { id: generateNodeId() }, content: items };
      // Try converting to taskList if all items start with checkboxes
      const taskNode = tryConvertToTaskList(listNode);
      nodes.push(taskNode || listNode);
      i = end + 1;
    } else if (token.type === 'ordered_list_open') {
      const end = findClosingToken(tokens, i, 'ordered_list');
      const items = parseListItems(tokens.slice(i + 1, end));
      nodes.push({ type: 'orderedList', attrs: { id: generateNodeId() }, content: items });
      i = end + 1;
    } else if (token.type === 'blockquote_open') {
      const end = findClosingToken(tokens, i, 'blockquote');
      const inner = tokensToTiptap(tokens.slice(i + 1, end));
      nodes.push({ type: 'blockquote', attrs: { id: generateNodeId() }, content: inner });
      i = end + 1;
    } else if (token.type === 'fence') {
      const lang = token.info?.trim() || '';
      const text = token.content.replace(/\n$/, '');
      const content = text ? [{ type: 'text', text }] : [];
      const attrs: any = { id: generateNodeId() };
      if (lang) attrs.language = lang;
      nodes.push({ type: 'codeBlock', attrs, content });
      i += 1;
    } else if (token.type === 'hr') {
      nodes.push({ type: 'horizontalRule', attrs: { id: generateNodeId() } });
      i += 1;
    } else if (token.type === 'html_block') {
      // <!-- --> is our sentinel for empty paragraphs.
      // <!-- ^abc12345 --> is the same sentinel with a persisted nodeId.
      const trimmed = token.content.trim();
      if (trimmed === '<!-- -->') {
        nodes.push({ type: 'paragraph', attrs: { id: generateNodeId() }, content: [] });
      } else {
        const idMatch = trimmed.match(/^<!--\s*\^([a-f0-9]{8})\s*-->$/);
        if (idMatch) {
          nodes.push({ type: 'paragraph', attrs: { id: idMatch[1] }, content: [] });
        }
      }
      i += 1;
    } else if (token.type === 'table_open') {
      const end = findClosingToken(tokens, i, 'table');
      const tableNode = parseTableTokens(tokens.slice(i + 1, end));
      nodes.push(tableNode);
      i = end + 1;
    } else {
      i += 1;
    }
  }

  return nodes;
}

function findClosingToken(tokens: Token[], startIndex: number, type: string): number {
  let depth = 0;
  for (let i = startIndex; i < tokens.length; i++) {
    if (tokens[i].type === `${type}_open`) depth++;
    if (tokens[i].type === `${type}_close`) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return tokens.length - 1;
}

function parseListItems(tokens: Token[]): any[] {
  const items: any[] = [];
  let i = 0;

  while (i < tokens.length) {
    if (tokens[i].type === 'list_item_open') {
      const end = findClosingToken(tokens, i, 'list_item');
      const inner = tokensToTiptap(tokens.slice(i + 1, end));
      items.push({ type: 'listItem', attrs: { id: generateNodeId() }, content: inner });
      i = end + 1;
    } else {
      i++;
    }
  }

  return items;
}

/**
 * Post-process a bulletList: if every listItem starts with [ ] or [x],
 * convert to taskList/taskItem nodes and strip the checkbox prefix.
 */
function tryConvertToTaskList(bulletList: any): any | null {
  const items = bulletList.content;
  if (!items || items.length === 0) return null;

  const checkboxRe = /^\[([ xX])\]\s?/;
  const taskItems: any[] = [];

  for (const item of items) {
    const firstChild = item.content?.[0];
    if (!firstChild || firstChild.type !== 'paragraph') return null;
    const firstText = firstChild.content?.[0];
    if (!firstText || firstText.type !== 'text') return null;

    const match = checkboxRe.exec(firstText.text);
    if (!match) return null;

    const checked = match[1] !== ' ';
    // Strip checkbox prefix from text
    const remaining = firstText.text.slice(match[0].length);
    const newContent = [...firstChild.content];
    if (remaining) {
      newContent[0] = { ...firstText, text: remaining };
    } else {
      newContent.shift();
    }
    const newParagraph = { ...firstChild, content: newContent };
    const restChildren = item.content.slice(1);

    taskItems.push({
      type: 'taskItem',
      attrs: { id: generateNodeId(), checked },
      content: [newParagraph, ...restChildren],
    });
  }

  return {
    type: 'taskList',
    attrs: { id: generateNodeId() },
    content: taskItems,
  };
}

function parseTableTokens(tokens: Token[]): any {
  const rows: any[] = [];
  let i = 0;

  while (i < tokens.length) {
    const token = tokens[i];

    if (token.type === 'thead_open' || token.type === 'tbody_open') {
      i++; // skip section open, process rows inside
      continue;
    }
    if (token.type === 'thead_close' || token.type === 'tbody_close') {
      i++;
      continue;
    }

    if (token.type === 'tr_open') {
      const trEnd = findClosingToken(tokens, i, 'tr');
      const cells: any[] = [];
      let j = i + 1;

      while (j < trEnd) {
        const cellToken = tokens[j];
        if (cellToken.type === 'th_open' || cellToken.type === 'td_open') {
          const cellType = cellToken.type === 'th_open' ? 'tableHeader' : 'tableCell';
          const cellEnd = findClosingToken(tokens, j, cellToken.type === 'th_open' ? 'th' : 'td');
          // Inline content is between open and close
          let content: any[] = [];
          if (j + 1 < cellEnd && tokens[j + 1].type === 'inline') {
            content = tokens[j + 1].children ? inlineTokensToTiptap(tokens[j + 1].children!) : [];
          }
          cells.push({
            type: cellType,
            attrs: { id: generateNodeId() },
            content: [{
              type: 'paragraph',
              attrs: { id: generateNodeId() },
              content,
            }],
          });
          j = cellEnd + 1;
        } else {
          j++;
        }
      }

      rows.push({
        type: 'tableRow',
        attrs: { id: generateNodeId() },
        content: cells,
      });
      i = trEnd + 1;
    } else {
      i++;
    }
  }

  return {
    type: 'table',
    attrs: { id: generateNodeId() },
    content: rows,
  };
}

function inlineTokensToTiptap(tokens: Token[]): any[] {
  const nodes: any[] = [];
  const markStack: any[] = [];

  for (const token of tokens) {
    if (token.type === 'text') {
      if (!token.content) continue; // ProseMirror rejects empty text nodes
      const textNode: any = { type: 'text', text: token.content };
      if (markStack.length > 0) {
        textNode.marks = deduplicateMarks(markStack);
      }
      nodes.push(textNode);
    } else if (token.type === 'code_inline') {
      if (!token.content) continue;
      const marks = deduplicateMarks([...markStack, { type: 'code' }]);
      nodes.push({ type: 'text', text: token.content, marks });
    } else if (token.type === 'strong_open') {
      markStack.push({ type: 'bold' });
    } else if (token.type === 'strong_close') {
      popMarkByType(markStack, 'bold');
    } else if (token.type === 'em_open') {
      markStack.push({ type: 'italic' });
    } else if (token.type === 'em_close') {
      popMarkByType(markStack, 'italic');
    } else if (token.type === 's_open') {
      markStack.push({ type: 'strike' });
    } else if (token.type === 's_close') {
      popMarkByType(markStack, 'strike');
    } else if (token.type === 'ins_open') {
      markStack.push({ type: 'underline' });
    } else if (token.type === 'ins_close') {
      popMarkByType(markStack, 'underline');
    } else if (token.type === 'mark_open') {
      markStack.push({ type: 'highlight' });
    } else if (token.type === 'mark_close') {
      popMarkByType(markStack, 'highlight');
    } else if (token.type === 'sub_open') {
      markStack.push({ type: 'subscript' });
    } else if (token.type === 'sub_close') {
      popMarkByType(markStack, 'subscript');
    } else if (token.type === 'sup_open') {
      markStack.push({ type: 'superscript' });
    } else if (token.type === 'sup_close') {
      popMarkByType(markStack, 'superscript');
    } else if (token.type === 'link_open') {
      const rawHref = token.attrGet('href') || '';
      const href = decodeURI(rawHref);
      markStack.push({ type: 'link', attrs: { href } });
    } else if (token.type === 'link_close') {
      popMarkByType(markStack, 'link');
    } else if (token.type === 'image') {
      const src = token.attrGet('src') || '';
      const alt = token.content || token.attrGet('alt') || '';
      nodes.push({
        type: 'image',
        attrs: { id: generateNodeId(), src, alt },
      });
    } else if (token.type === 'html_inline') {
      // <br> is our serialized form of hardBreak
      if (/^<br\s*\/?>$/i.test(token.content.trim())) {
        nodes.push({ type: 'hardBreak' });
      } else {
        // Preserve raw HTML-looking text so user content isn't silently dropped.
        // On serialize, escapeInlineHtml converts `<` to `&lt;`; on the next
        // parse markdown-it decodes `&lt;` back to a single text token, so the
        // round-trip is stable after the first save.
        const textNode: any = { type: 'text', text: token.content };
        if (markStack.length > 0) {
          textNode.marks = deduplicateMarks(markStack);
        }
        nodes.push(textNode);
      }
    } else if (token.type === 'hardbreak') {
      nodes.push({ type: 'hardBreak' });
    } else if (token.type === 'softbreak') {
      nodes.push({ type: 'text', text: ' ' });
    }
  }

  return nodes;
}

/** Remove duplicate mark types (e.g. nested **bold** producing two bold marks). */
function deduplicateMarks(marks: any[]): any[] {
  const seen = new Set<string>();
  return marks.filter((m) => {
    const key = m.type === 'link' ? `link:${m.attrs?.href}` : m.type;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function popMarkByType(stack: any[], type: string): void {
  for (let i = stack.length - 1; i >= 0; i--) {
    if (stack[i].type === type) {
      stack.splice(i, 1);
      return;
    }
  }
}

/**
 * Extract a trailing nodeId anchor from inline content.
 * Format: ` ^abc12345` (space + caret + 8 lowercase hex chars at end of line).
 * Strips the marker from the visible text and returns the captured id.
 * Returns id=null if no anchor found.
 *
 * Known limit: prose ending with the literal pattern ` ^[8 lowercase hex]`
 * will be interpreted as an anchor. Vanishingly rare in real writing.
 */
function extractTrailingNodeId(content: any[]): { content: any[]; id: string | null } {
  if (!content || content.length === 0) return { content, id: null };
  const lastNode = content[content.length - 1];
  if (lastNode.type !== 'text' || !lastNode.text) return { content, id: null };

  const match = lastNode.text.match(/ \^([a-f0-9]{8})\s*$/);
  if (!match) return { content, id: null };

  const id = match[1];
  const newText = lastNode.text.slice(0, match.index);

  const newContent = [...content];
  if (newText) {
    newContent[newContent.length - 1] = { ...lastNode, text: newText };
  } else {
    newContent.pop();
  }

  return { content: newContent, id };
}
