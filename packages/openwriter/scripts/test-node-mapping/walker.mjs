/**
 * Markdown walker — turns markdown into a flat ordered list of blocks.
 *
 * Each block has:
 *   - position: index in the pre-order walk (0-based)
 *   - type: block type ('paragraph', 'heading', 'listItem', 'bulletList', etc.)
 *   - text: plain-text content (for fingerprinting)
 *   - raw: original markdown source of the block (for debugging)
 *   - parentPosition: position of the containing block, or null for top-level
 *   - level: heading level (only for headings)
 *   - language: code block language (only for code blocks)
 *   - listType: 'bullet' or 'ordered' (only for listItems' parents)
 *   - ordinalInParent: index within the parent's children (for listItems, etc.)
 *
 * Uses markdown-it for tokenization to match the production parser's behavior.
 */

import MarkdownIt from 'markdown-it';

const md = new MarkdownIt({ linkify: false, html: true });
md.enable('strikethrough');

/**
 * Walk markdown into a flat ordered block list.
 * @param {string} markdown - raw markdown (no frontmatter)
 * @returns {Array<Block>} - blocks in pre-order traversal
 */
export function walkMarkdown(markdown) {
  const tokens = md.parse(markdown, {});
  const blocks = [];
  walkTokens(tokens, blocks, null);
  return blocks;
}

function walkTokens(tokens, blocks, parentPosition) {
  let i = 0;
  let ordinalInParent = 0;

  while (i < tokens.length) {
    const token = tokens[i];

    if (token.type === 'heading_open') {
      const level = parseInt(token.tag.slice(1));
      const inlineToken = tokens[i + 1];
      const text = inlineToken?.content || '';
      const block = {
        position: blocks.length,
        type: 'heading',
        level,
        text,
        raw: rebuildRaw(tokens, i, i + 2),
        parentPosition,
        ordinalInParent: ordinalInParent++,
        inlineMarks: extractInlineMarks(inlineToken),
      };
      blocks.push(block);
      i += 3; // heading_open, inline, heading_close
    }
    else if (token.type === 'paragraph_open') {
      const inlineToken = tokens[i + 1];
      const text = inlineToken?.content || '';
      const block = {
        position: blocks.length,
        type: 'paragraph',
        text,
        raw: rebuildRaw(tokens, i, i + 2),
        parentPosition,
        ordinalInParent: ordinalInParent++,
        inlineMarks: extractInlineMarks(inlineToken),
      };
      blocks.push(block);
      i += 3;
    }
    else if (token.type === 'bullet_list_open' || token.type === 'ordered_list_open') {
      const listType = token.type === 'bullet_list_open' ? 'bullet' : 'ordered';
      const closeType = token.type === 'bullet_list_open' ? 'bullet_list_close' : 'ordered_list_close';
      const endIdx = findMatchingClose(tokens, i, token.type, closeType);
      const listPosition = blocks.length;
      const block = {
        position: listPosition,
        type: listType === 'bullet' ? 'bulletList' : 'orderedList',
        text: '', // containers have no own text
        raw: rebuildRaw(tokens, i, endIdx + 1),
        parentPosition,
        ordinalInParent: ordinalInParent++,
      };
      blocks.push(block);
      walkTokens(tokens.slice(i + 1, endIdx), blocks, listPosition);
      i = endIdx + 1;
    }
    else if (token.type === 'list_item_open') {
      const endIdx = findMatchingClose(tokens, i, 'list_item_open', 'list_item_close');
      const itemPosition = blocks.length;
      // listItem's identity is its FIRST direct paragraph child's text only.
      // Nested children get their own block entries; including their text in the
      // parent would cause cascading fingerprint changes when a nested child is edited.
      const firstParaText = firstParagraphContent(tokens, i + 1, endIdx);
      const block = {
        position: itemPosition,
        type: 'listItem',
        text: firstParaText,
        raw: rebuildRaw(tokens, i, endIdx + 1),
        parentPosition,
        ordinalInParent: ordinalInParent++,
      };
      blocks.push(block);
      walkTokens(tokens.slice(i + 1, endIdx), blocks, itemPosition);
      i = endIdx + 1;
    }
    else if (token.type === 'blockquote_open') {
      const endIdx = findMatchingClose(tokens, i, 'blockquote_open', 'blockquote_close');
      const bqPosition = blocks.length;
      const block = {
        position: bqPosition,
        type: 'blockquote',
        text: '',
        raw: rebuildRaw(tokens, i, endIdx + 1),
        parentPosition,
        ordinalInParent: ordinalInParent++,
      };
      blocks.push(block);
      walkTokens(tokens.slice(i + 1, endIdx), blocks, bqPosition);
      i = endIdx + 1;
    }
    else if (token.type === 'fence') {
      const block = {
        position: blocks.length,
        type: 'codeBlock',
        language: token.info?.trim() || '',
        text: token.content.replace(/\n$/, ''),
        raw: token.markup + token.info + '\n' + token.content + token.markup + '\n',
        parentPosition,
        ordinalInParent: ordinalInParent++,
      };
      blocks.push(block);
      i += 1;
    }
    else if (token.type === 'hr') {
      blocks.push({
        position: blocks.length,
        type: 'horizontalRule',
        text: '',
        raw: '---\n',
        parentPosition,
        ordinalInParent: ordinalInParent++,
      });
      i += 1;
    }
    else if (token.type === 'table_open') {
      const endIdx = findMatchingClose(tokens, i, 'table_open', 'table_close');
      const tablePosition = blocks.length;
      // For now, just capture the whole table as one block with its raw content
      const tableText = collectTextFromRange(tokens, i + 1, endIdx);
      blocks.push({
        position: tablePosition,
        type: 'table',
        text: tableText,
        raw: rebuildRaw(tokens, i, endIdx + 1),
        parentPosition,
        ordinalInParent: ordinalInParent++,
      });
      // Skip table internals for now (stage 4 territory)
      i = endIdx + 1;
    }
    else {
      i += 1;
    }
  }
}

function findMatchingClose(tokens, startIdx, openType, closeType) {
  let depth = 0;
  for (let i = startIdx; i < tokens.length; i++) {
    if (tokens[i].type === openType) depth++;
    else if (tokens[i].type === closeType) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return tokens.length - 1;
}

function collectTextFromRange(tokens, startIdx, endIdx) {
  const parts = [];
  for (let i = startIdx; i < endIdx; i++) {
    if (tokens[i].type === 'inline' && tokens[i].content) {
      parts.push(tokens[i].content);
    }
  }
  return parts.join(' ');
}

/**
 * Get the content of the first paragraph_open block inside the given token range.
 * Used for container fingerprinting — gives containers their OWN identity text
 * without rolling up descendant content (which would cause cascade invalidation).
 */
function firstParagraphContent(tokens, startIdx, endIdx) {
  for (let i = startIdx; i < endIdx; i++) {
    if (tokens[i].type === 'paragraph_open') {
      const inlineToken = tokens[i + 1];
      if (inlineToken?.type === 'inline') return inlineToken.content || '';
      return '';
    }
  }
  return '';
}

function rebuildRaw(tokens, startIdx, endIdx) {
  // Best-effort raw reconstruction for debugging — not always exact since
  // markdown-it tokens don't always preserve original whitespace.
  const parts = [];
  for (let i = startIdx; i < endIdx; i++) {
    const t = tokens[i];
    if (t.markup) parts.push(t.markup);
    if (t.content) parts.push(t.content);
  }
  return parts.join('');
}

function extractInlineMarks(inlineToken) {
  if (!inlineToken?.children) return { bold: 0, italic: 0, links: 0, code: 0 };
  let bold = 0, italic = 0, links = 0, code = 0;
  for (const child of inlineToken.children) {
    if (child.type === 'strong_open') bold++;
    else if (child.type === 'em_open') italic++;
    else if (child.type === 'link_open') links++;
    else if (child.type === 'code_inline') code++;
  }
  return { bold, italic, links, code };
}
