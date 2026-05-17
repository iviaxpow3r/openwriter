/**
 * Clean up HTML pasted from external sources (Google Docs, Word, Notion, etc.).
 *
 * The big offender is Google Docs: it wraps every text run in styled <span>
 * tags and inserts an empty <p></p> between every paragraph as visual spacing.
 * That produces messy markdown with double-spaced blocks and zero semantic value.
 *
 * Runs as TipTap's `transformPastedHTML` — before ProseMirror parses the
 * clipboard HTML — so the editor model sees clean structure from the start.
 *
 * Cleanup steps:
 *   1. Unwrap Office's <!--StartFragment-->/<!--EndFragment--> wrappers
 *   2. Convert style-based formatting (font-weight:700, font-style:italic, etc.)
 *      to semantic tags (<strong>, <em>, <u>) BEFORE we strip styles
 *   3. Unwrap remaining <span> tags (Google Docs uses them as text-run wrappers)
 *   4. Strip style/class/id attributes from every element
 *   5. Drop empty <p> tags (the source of excessive vertical spacing)
 */

const NEEDS_CLEANUP_PATTERNS = [
  '<!--StartFragment-->',
  '<span',
  ' style=',
  ' class=',
];

function needsCleanup(html: string): boolean {
  return (
    NEEDS_CLEANUP_PATTERNS.some((p) => html.includes(p)) ||
    /<p[^>]*>\s*(<br\s*\/?>)?\s*<\/p>/i.test(html)
  );
}

export function cleanPastedHTML(html: string): string {
  if (!needsCleanup(html)) return html;

  // 1. Unwrap Office clipboard fragment markers
  const fragMatch = html.match(/<!--StartFragment-->([\s\S]*?)<!--EndFragment-->/);
  const content = fragMatch ? fragMatch[1] : html;

  // Parse into a detached DOM for surgical cleanup
  const doc = new DOMParser().parseFromString(`<div>${content}</div>`, 'text/html');
  const root = doc.body.firstChild as HTMLElement | null;
  if (!root) return content;

  // 2 + 3. Process <span> tags: promote style-based formatting to semantic
  // tags, then unwrap the span. Snapshot the list since we're mutating.
  for (const span of Array.from(root.querySelectorAll('span'))) {
    const style = span.getAttribute('style') || '';
    const isBold = /font-weight:\s*(bold|[6-9]00)/i.test(style);
    const isItalic = /font-style:\s*italic/i.test(style);
    const isUnderline = /text-decoration:[^;]*underline/i.test(style);

    if (isBold || isItalic || isUnderline) {
      let inner = span.innerHTML;
      if (isBold) inner = `<strong>${inner}</strong>`;
      if (isItalic) inner = `<em>${inner}</em>`;
      if (isUnderline) inner = `<u>${inner}</u>`;
      const wrapper = doc.createElement('div');
      wrapper.innerHTML = inner;
      span.replaceWith(...Array.from(wrapper.childNodes));
    } else {
      // Pure wrapper span — unwrap, keep children
      span.replaceWith(...Array.from(span.childNodes));
    }
  }

  // 4. Strip noise attributes from every remaining element
  for (const el of Array.from(root.querySelectorAll('*'))) {
    el.removeAttribute('style');
    el.removeAttribute('class');
    el.removeAttribute('id');
  }

  // 5. Drop empty <p> tags (no text content, no meaningful children)
  for (const p of Array.from(root.querySelectorAll('p'))) {
    const text = (p.textContent || '').replace(/ /g, '').trim();
    const onlyBr =
      p.children.length === 1 && p.firstElementChild?.tagName === 'BR';
    if (!text && (p.children.length === 0 || onlyBr)) {
      p.remove();
    }
  }

  return root.innerHTML;
}
