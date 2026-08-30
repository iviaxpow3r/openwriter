import type { Editor } from '@tiptap/react';

export type DocumentMetrics = {
  characters: number;
  charactersWithoutSpaces: number;
  words: number;
  sentences: number;
  wordsPerSentence: number | null;
  paragraphs: number;
  lines: number;
  pages: number;
};

export type ReadingTimes = {
  slow: number;
  average: number;
  fast: number;
  aloud: number;
};

export type DocumentMetricsSnapshot = {
  document: DocumentMetrics;
  selection: DocumentMetrics | null;
  reading: ReadingTimes;
};

const WORD_PATTERN = /[\p{L}\p{N}]+(?:['’\-][\p{L}\p{N}]+)*/gu;
const SENTENCE_PATTERN = /[.!?]+(?:[”’"')\]]*)?(?=\s|$)/g;
const LINES_PER_PAGE = 28;

function characterCount(value: string): number {
  return Array.from(value).length;
}

function normaliseText(value: string): string {
  return value.replace(/\u00a0/g, ' ').replace(/\r\n?/g, '\n');
}

function countWords(value: string): number {
  return normaliseText(value).match(WORD_PATTERN)?.length || 0;
}

function countSentences(value: string, words: number): number {
  if (!words) return 0;
  return normaliseText(value).match(SENTENCE_PATTERN)?.length || 1;
}

function textFromJson(value: any): string {
  const parts: string[] = [];
  const visit = (node: any) => {
    if (!node) return;
    if (node.type === 'text' && typeof node.text === 'string') {
      parts.push(node.text);
      return;
    }
    if (node.type === 'hardBreak') {
      parts.push('\n');
      return;
    }
    if (Array.isArray(node.content)) {
      for (const child of node.content) visit(child);
      if (node.type === 'paragraph' || node.type === 'heading' || node.type === 'blockquote' || node.type === 'listItem' || node.type === 'codeBlock') parts.push('\n');
    }
  };
  visit(value);
  return parts.join('').replace(/\n{3,}/g, '\n\n').trim();
}

function blockCountFromJson(value: any): number {
  let count = 0;
  const visit = (node: any) => {
    if (!node) return;
    if (node.type === 'paragraph' || node.type === 'heading' || node.type === 'blockquote' || node.type === 'codeBlock') count += 1;
    if (Array.isArray(node.content)) node.content.forEach(visit);
  };
  visit(value);
  return count;
}

function estimatedLines(value: string): number {
  const lines = normaliseText(value).split('\n').filter((line) => line.trim());
  return lines.length || (value.trim() ? 1 : 0);
}

function visualLineCount(editor: Editor): number {
  const root = editor.view?.dom;
  if (!root || typeof window === 'undefined') return estimatedLines(editor.getText({ blockSeparator: '\n' }));
  const blocks = root.querySelectorAll('p, h1, h2, h3, h4, h5, h6, blockquote, pre');
  let lines = 0;
  blocks.forEach((block) => {
    const style = window.getComputedStyle(block);
    const explicitLineHeight = Number.parseFloat(style.lineHeight);
    const fontSize = Number.parseFloat(style.fontSize) || 16;
    const lineHeight = Number.isFinite(explicitLineHeight) ? explicitLineHeight : fontSize * 1.45;
    const height = block.getBoundingClientRect().height;
    lines += Math.max(1, Math.round(height / lineHeight));
  });
  return lines || estimatedLines(editor.getText({ blockSeparator: '\n' }));
}

function selectedVisualLineCount(editor: Editor, from: number, to: number, fallback: string): number {
  try {
    const start = editor.view.domAtPos(from);
    const end = editor.view.domAtPos(to);
    const range = document.createRange();
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
    const rows = new Set(Array.from(range.getClientRects()).filter((rect) => rect.width > 0 && rect.height > 0).map((rect) => Math.round(rect.top)));
    if (rows.size) return rows.size;
  } catch {
    // A nested NodeView can occasionally reject a DOM range. The text-based
    // fallback still gives a stable, useful count.
  }
  return estimatedLines(fallback);
}

function metricsFor(text: string, paragraphs: number, lines: number): DocumentMetrics {
  const normalised = normaliseText(text);
  const words = countWords(normalised);
  const sentences = countSentences(normalised, words);
  const safeLines = lines || estimatedLines(normalised);
  return {
    characters: characterCount(normalised),
    charactersWithoutSpaces: characterCount(normalised.replace(/\s/gu, '')),
    words,
    sentences,
    wordsPerSentence: sentences ? words / sentences : null,
    paragraphs,
    lines: safeLines,
    pages: safeLines / LINES_PER_PAGE,
  };
}

function documentMetricsFromEditor(editor: Editor): DocumentMetrics {
  const text = editor.getText({ blockSeparator: '\n' });
  let paragraphs = 0;
  editor.state.doc.descendants((node) => {
    if (node.isTextblock) paragraphs += 1;
  });
  return metricsFor(text, paragraphs, visualLineCount(editor));
}

function selectionMetricsFromEditor(editor: Editor): DocumentMetrics | null {
  const { from, to } = editor.state.selection;
  if (from === to) return null;
  const text = editor.state.doc.textBetween(from, to, '\n', '\n');
  if (!text.trim()) return null;
  let paragraphs = 0;
  editor.state.doc.nodesBetween(from, to, (node) => {
    if (node.isTextblock) paragraphs += 1;
  });
  return metricsFor(text, paragraphs || 1, selectedVisualLineCount(editor, from, to, text));
}

export function documentMetricsFromJson(value: any): DocumentMetrics {
  const text = textFromJson(value);
  return metricsFor(text, blockCountFromJson(value), estimatedLines(text));
}

export function readDocumentMetrics(editors: Editor[], fallbackDocument?: any): DocumentMetricsSnapshot {
  const editor = editors.find((item) => !item.isDestroyed && item.isFocused) || editors.find((item) => !item.isDestroyed);
  const document = editor ? documentMetricsFromEditor(editor) : documentMetricsFromJson(fallbackDocument);
  const selection = editor ? selectionMetricsFromEditor(editor) : null;
  const readingWords = (selection || document).words;
  return {
    document,
    selection,
    reading: {
      slow: readingWords * 60 / 180,
      average: readingWords * 60 / 240,
      fast: readingWords * 60 / 300,
      aloud: readingWords * 60 / 120,
    },
  };
}

export function formatMetricNumber(value: number): string {
  return new Intl.NumberFormat().format(value);
}

export function formatMetricDecimal(value: number | null, digits = 1): string {
  if (value === null || !Number.isFinite(value)) return '—';
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: digits, minimumFractionDigits: 0 }).format(value);
}

export function formatReadingTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0 sec';
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))} sec`;
  const minutes = Math.floor(seconds / 60);
  const remaining = Math.round(seconds % 60);
  return remaining ? `${minutes} min ${remaining} sec` : `${minutes} min`;
}
