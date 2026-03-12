/**
 * Barrel re-export for markdown serialization and parsing.
 * All existing imports from './markdown.js' continue to work unchanged.
 */

export { tiptapToMarkdown, tiptapToBody, nodeText, inlineToMarkdown } from './markdown-serialize.js';
export { markdownToTiptap, markdownToNodes } from './markdown-parse.js';
