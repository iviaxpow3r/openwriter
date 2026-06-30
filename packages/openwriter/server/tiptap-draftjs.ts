/**
 * TipTap / ProseMirror JSON  ->  X Articles DraftJS `content_state`.
 *
 * X's `POST /2/articles/draft` takes the article body as a DraftJS raw content
 * state, in X's snake_case field naming:
 *
 *   {
 *     blocks: [
 *       { key, text, type, depth?, inline_style_ranges?, entity_ranges? }
 *     ],
 *     entities: [ { key, value: { type, mutability, data } } ]
 *   }
 *
 * (Minimal valid body: `{"blocks":[{"text":"hi","type":"unstyled"}],"entities":[]}`.)
 *
 * This is the SINGLE shared converter imported by both posting paths — the
 * direct plugin (plugins/x-api) and the managed plugin (plugins/publish) — so
 * the OpenWriter-doc → X conversion lives in exactly one place. It is a pure
 * function with no runtime deps, which keeps it trivially unit-testable and
 * importable from either plugin's compiled context.
 *
 * v1 fidelity:
 *   - blocks:  heading (h1–h6), paragraph, bullet/ordered/task lists (nested
 *              via `depth`), blockquote, code-block.
 *   - inline:  bold, italic, underline, strikethrough, inline code, links.
 *   - tables:  degrade to pipe-joined text rows (no DraftJS table primitive).
 *   - cover:   handled out of band via `cover_media` on the draft call — NOT
 *              here. Body images degrade to their alt text (an inline-image
 *              atomic-block shape isn't confirmed against X's schema yet).
 *   - rules:   horizontalRule degrades to a blank separator block.
 *   - marks X's DraftJS editor doesn't model (highlight, sub/superscript)
 *     drop to plain text — the text always survives.
 */

export interface DraftInlineStyleRange {
  offset: number;
  length: number;
  style: string;
}

export interface DraftEntityRange {
  offset: number;
  length: number;
  key: string;
}

export interface DraftBlock {
  key: string;
  text: string;
  type: string;
  depth?: number;
  inline_style_ranges?: DraftInlineStyleRange[];
  entity_ranges?: DraftEntityRange[];
}

export interface DraftEntity {
  key: string;
  value: { type: string; mutability: string; data: Record<string, any> };
}

export interface DraftContentState {
  blocks: DraftBlock[];
  entities: DraftEntity[];
}

/** TipTap mark type -> DraftJS inline style. Anything absent here (highlight,
 *  subscript, superscript) drops silently — the underlying text is unaffected. */
const MARK_STYLE: Record<string, string> = {
  bold: 'BOLD',
  italic: 'ITALIC',
  underline: 'UNDERLINE',
  strike: 'STRIKETHROUGH',
  code: 'CODE',
};

const HEADER_TYPE = ['', 'header-one', 'header-two', 'header-three', 'header-four', 'header-five', 'header-six'];

interface InlineResult {
  text: string;
  styles: DraftInlineStyleRange[];
  entityRanges: DraftEntityRange[];
}

/** Accumulates blocks + entities and hands out unique keys. */
class BuildContext {
  blocks: DraftBlock[] = [];
  entities: DraftEntity[] = [];
  private blockN = 0;
  private entityN = 0;

  private nextBlockKey(): string {
    return 'b' + (this.blockN++).toString(36);
  }

  addEntity(type: string, mutability: string, data: Record<string, any>): string {
    const key = String(this.entityN++);
    this.entities.push({ key, value: { type, mutability, data } });
    return key;
  }

  pushText(text: string, type: string, depth = 0): void {
    const block: DraftBlock = { key: this.nextBlockKey(), text, type };
    if (depth) block.depth = depth;
    this.blocks.push(block);
  }

  pushInline(inline: InlineResult, type: string, depth = 0): void {
    const block: DraftBlock = { key: this.nextBlockKey(), text: inline.text, type };
    if (depth) block.depth = depth;
    if (inline.styles.length) block.inline_style_ranges = mergeStyleRanges(inline.styles);
    if (inline.entityRanges.length) block.entity_ranges = inline.entityRanges;
    this.blocks.push(block);
  }
}

/** Convert a TipTap document (`{ type: 'doc', content: [...] }`) to X's DraftJS
 *  content_state. Always returns at least one block — an empty doc yields a
 *  single empty unstyled block, since X rejects a draft with no blocks. */
export function tiptapToDraftjs(doc: any): DraftContentState {
  const ctx = new BuildContext();
  walkBlocks(doc?.content || [], 0, ctx);
  if (ctx.blocks.length === 0) ctx.pushText('', 'unstyled');
  return { blocks: ctx.blocks, entities: ctx.entities };
}

function walkBlocks(nodes: any[], depth: number, ctx: BuildContext): void {
  for (const node of nodes || []) {
    switch (node?.type) {
      case 'heading': {
        const level = Math.min(Math.max(Number(node.attrs?.level) || 1, 1), 6);
        ctx.pushInline(buildInline(node.content, ctx), HEADER_TYPE[level], depth);
        break;
      }
      case 'paragraph':
        ctx.pushInline(buildInline(node.content, ctx), 'unstyled', depth);
        break;
      case 'bulletList':
        walkList(node.content, 'unordered-list-item', depth, ctx);
        break;
      case 'orderedList':
        walkList(node.content, 'ordered-list-item', depth, ctx);
        break;
      case 'taskList':
        walkTaskList(node.content, depth, ctx);
        break;
      case 'blockquote':
        walkBlockquote(node.content, depth, ctx);
        break;
      case 'codeBlock': {
        // DraftJS models a code block as one code-block per line; this is the
        // faithful raw shape and round-trips cleanly in X's editor.
        const lines = plainText(node.content).split('\n');
        for (const line of lines) ctx.pushText(line, 'code-block', depth);
        break;
      }
      case 'horizontalRule':
        // No confirmed DraftJS divider primitive in X's article schema — emit a
        // blank separator block rather than risk a rejected payload.
        ctx.pushText('', 'unstyled', depth);
        break;
      case 'image':
        // Inline body images need an uploaded media_id + an atomic-block entity
        // shape not yet confirmed against X's schema. Preserve the alt text so
        // context isn't silently lost; the hero/cover image is handled by
        // cover_media on the draft call, not here.
        if (node.attrs?.alt) ctx.pushText(String(node.attrs.alt), 'unstyled', depth);
        break;
      case 'table':
        walkTable(node, depth, ctx);
        break;
      case 'footnoteSection':
        walkFootnoteSection(node.content, depth, ctx);
        break;
      default:
        // Unknown container — descend so nested content isn't dropped.
        if (node?.content) walkBlocks(node.content, depth, ctx);
    }
  }
}

/** Walk a bullet/ordered list. Each listItem's first paragraph becomes one
 *  list-item block; nested lists recurse at depth+1 (DraftJS list nesting). */
function walkList(items: any[], blockType: string, depth: number, ctx: BuildContext): void {
  for (const item of items || []) {
    for (const child of item.content || []) {
      if (child.type === 'bulletList') walkList(child.content, 'unordered-list-item', depth + 1, ctx);
      else if (child.type === 'orderedList') walkList(child.content, 'ordered-list-item', depth + 1, ctx);
      else if (child.type === 'paragraph') ctx.pushInline(buildInline(child.content, ctx), blockType, depth);
      else walkBlocks([child], depth, ctx);
    }
  }
}

/** X's DraftJS has no task-list type; degrade each task item to a bullet with a
 *  leading checkbox glyph (☑ / ☐) so the checked state survives visually. */
function walkTaskList(items: any[], depth: number, ctx: BuildContext): void {
  for (const item of items || []) {
    const prefix = item.attrs?.checked ? '☑ ' : '☐ ';
    let prefixed = false;
    for (const child of item.content || []) {
      if (child.type === 'taskList') walkTaskList(child.content, depth + 1, ctx);
      else if (child.type === 'paragraph') {
        const inline = buildInline(child.content, ctx);
        if (!prefixed) {
          shiftRanges(inline, prefix.length);
          inline.text = prefix + inline.text;
          prefixed = true;
        }
        ctx.pushInline(inline, 'unordered-list-item', depth);
      } else walkBlocks([child], depth, ctx);
    }
  }
}

/** Each paragraph inside a blockquote becomes its own `blockquote` block. */
function walkBlockquote(nodes: any[], depth: number, ctx: BuildContext): void {
  for (const child of nodes || []) {
    if (child.type === 'paragraph') ctx.pushInline(buildInline(child.content, ctx), 'blockquote', depth);
    else walkBlocks([child], depth, ctx);
  }
}

/** Degrade a table to one unstyled text block per row, cells pipe-joined. No
 *  data is lost; the grid structure flattens to readable text. */
function walkTable(node: any, depth: number, ctx: BuildContext): void {
  for (const row of node.content || []) {
    const cells = (row.content || []).map((cell: any) =>
      (cell.content || []).map((p: any) => plainInline(p.content)).join(' ').trim(),
    );
    ctx.pushText(cells.join(' | '), 'unstyled', depth);
  }
}

/** Footnote definitions render as plain blocks, first paragraph prefixed with
 *  its label, so the reference text isn't orphaned. */
function walkFootnoteSection(definitions: any[], depth: number, ctx: BuildContext): void {
  for (const def of definitions || []) {
    if (def.type !== 'footnoteDefinition') continue;
    const label = def.attrs?.label || '';
    const paragraphs = (def.content || []).filter((c: any) => c.type === 'paragraph');
    paragraphs.forEach((p: any, i: number) => {
      const inline = buildInline(p.content, ctx);
      if (i === 0) {
        const prefix = `[${label}] `;
        shiftRanges(inline, prefix.length);
        inline.text = prefix + inline.text;
      }
      ctx.pushInline(inline, 'unstyled', depth);
    });
  }
}

/** Walk a node's inline content into { text, inline-style ranges, entity ranges },
 *  registering link entities into the build context as it goes. */
function buildInline(nodes: any[], ctx: BuildContext): InlineResult {
  let text = '';
  const styles: DraftInlineStyleRange[] = [];
  const entityRanges: DraftEntityRange[] = [];

  for (const node of nodes || []) {
    if (node.type === 'hardBreak') {
      text += '\n';
      continue;
    }
    if (node.type === 'footnoteReference') {
      text += `[${node.attrs?.label || ''}]`;
      continue;
    }
    if (node.type !== 'text') {
      if (node.text) text += node.text;
      continue;
    }

    const piece = node.text || '';
    const offset = text.length;
    text += piece;
    const length = piece.length;
    if (length === 0) continue;

    for (const mark of node.marks || []) {
      const style = MARK_STYLE[mark.type];
      if (style) styles.push({ offset, length, style });
      if (mark.type === 'link') {
        const href = mark.attrs?.href || '';
        if (href) {
          const key = ctx.addEntity('LINK', 'MUTABLE', { url: href });
          entityRanges.push({ offset, length, key });
        }
      }
    }
  }

  return { text, styles, entityRanges };
}

/** Shift every range offset right by `n` (used when a text prefix — checkbox
 *  glyph, footnote label — is prepended after inline ranges were computed). */
function shiftRanges(inline: InlineResult, n: number): void {
  for (const s of inline.styles) s.offset += n;
  for (const e of inline.entityRanges) e.offset += n;
}

/** Merge adjacent ranges with the same style (`...a..**b**..` split across
 *  text nodes) into one, keeping the output minimal and stable. */
function mergeStyleRanges(ranges: DraftInlineStyleRange[]): DraftInlineStyleRange[] {
  const sorted = [...ranges].sort((a, b) => a.style.localeCompare(b.style) || a.offset - b.offset);
  const out: DraftInlineStyleRange[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && last.style === r.style && last.offset + last.length === r.offset) {
      last.length += r.length;
    } else {
      out.push({ ...r });
    }
  }
  return out;
}

/** Plain text of a node's inline content, marks ignored. */
function plainInline(nodes: any[]): string {
  if (!nodes) return '';
  return nodes
    .map((n: any) => (n.type === 'hardBreak' ? '\n' : n.text || ''))
    .join('');
}

/** Plain text of block content (e.g. a code block's lines). */
function plainText(nodes: any[]): string {
  if (!nodes) return '';
  return nodes.map((n: any) => n.text || '').join('');
}
