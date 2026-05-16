/**
 * File-backed document state for OpenWriter.
 * Each document is a .md file in ~/.openwriter/ with YAML frontmatter.
 * Title lives in frontmatter metadata. Filenames are stable identifiers.
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync, readdirSync, statSync, utimesSync, type Stats } from 'fs';
import { join } from 'path';
import matter from 'gray-matter';
import { tiptapToMarkdown, tiptapToBody, markdownToTiptap } from './markdown.js';
import { applyTextEditsToNode, type TextEdit } from './text-edit.js';
import { getDataDir, TEMP_PREFIX, ensureDataDir, filePathForTitle, tempFilePath, generateNodeId, LEAF_BLOCK_TYPES, resolveDocPath, isExternalDoc, atomicWriteFileSync } from './helpers.js';
import { snapshotIfNeeded, ensureDocId } from './versions.js';
import { extractForwardLinks, extractForwardLinksFromDisk, updateBacklinksForSource, type ForwardLink } from './backlinks.js';
import { isAutoAcceptInheritedForDoc } from './workspaces.js';

export interface NodeChange {
  operation: 'rewrite' | 'insert' | 'delete';
  nodeId?: string;
  afterNodeId?: string;
  content?: any;
  /** When true, the change committed directly without pending decoration —
   *  client should apply it as a normal edit, not as a pending review item. */
  autoAccept?: boolean;
}

export interface PadDocument {
  type: 'doc';
  content: any[];
}

export interface DocumentInfo {
  filename: string;
  title: string;
  path: string;
  lastModified: string;
  wordCount: number;
  isActive: boolean;
  docId?: string;
  lastSent?: string;  // ISO date — doc was sent/posted
  postedUrl?: string; // URL of posted tweet/thread (X only)
  contentType?: string; // Explicit content_type from frontmatter
  masterDocId?: string; // Parent document ID (variant relationship)
  variantType?: string; // Content type of this variant (blog, tweet, etc.)
  autoAccept?: boolean; // True when this doc bypasses pending-review (agent writes commit directly)
}

interface PadState {
  document: PadDocument;
  title: string;
  metadata: Record<string, any>;      // All frontmatter fields (including title)
  filePath: string;                   // Current file on disk
  isTemp: boolean;                    // True = untitled temp file, cleaned up if empty on close
  lastModified: Date;
  docId: string;                      // 8-char hex ID for version history
  originalFrontmatter: string | null; // Raw frontmatter for external files (preserved verbatim on save)
}

type ChangeListener = (changes: NodeChange[], version: number) => void;

const DEFAULT_DOC: PadDocument = {
  type: 'doc',
  content: [{ type: 'paragraph', content: [] }],
};

let state: PadState = {
  document: DEFAULT_DOC,
  title: 'Untitled',
  metadata: { title: 'Untitled' },
  filePath: '',
  isTemp: true,
  lastModified: new Date(),
  docId: '',
  originalFrontmatter: null,
};

const listeners: Set<ChangeListener> = new Set();

// ============================================================================
// EXTERNAL DOCUMENT REGISTRY
// ============================================================================

function getExternalDocsFile(): string { return join(getDataDir(), 'external-docs.json'); }
const externalDocs = new Set<string>();

function persistExternalDocs(): void {
  try {
    atomicWriteFileSync(getExternalDocsFile(), JSON.stringify([...externalDocs]));
  } catch { /* best-effort */ }
}

function loadExternalDocs(): void {
  try {
    if (existsSync(getExternalDocsFile())) {
      const paths: string[] = JSON.parse(readFileSync(getExternalDocsFile(), 'utf-8'));
      for (const p of paths) {
        if (existsSync(p)) externalDocs.add(p);
      }
    }
  } catch { /* corrupt file — start fresh */ }
}

export function registerExternalDoc(fullPath: string): void {
  externalDocs.add(fullPath);
  persistExternalDocs();
}

export function unregisterExternalDoc(fullPath: string): void {
  externalDocs.delete(fullPath);
  persistExternalDocs();
}

export function getExternalDocs(): string[] {
  return [...externalDocs];
}

function isDocEmpty(doc: PadDocument): boolean {
  if (!doc.content || doc.content.length === 0) return true;
  if (doc.content.length === 1) {
    const node = doc.content[0];
    if (!node.content || node.content.length === 0) return true;
    if (node.content.length === 1 && !node.content[0].text?.trim()) return true;
  }
  return false;
}

// ============================================================================
// GETTERS
// ============================================================================

export function getDocument(): PadDocument {
  return state.document;
}

export function getTitle(): string {
  return state.title;
}

export function getFilePath(): string {
  return state.filePath;
}

export function getIsTemp(): boolean {
  return state.isTemp;
}

export function getDocId(): string {
  return state.docId;
}

export function getPlainText(): string {
  return extractText(state.document.content);
}

export function extractText(nodes: any[]): string {
  if (!nodes) return '';
  return nodes
    .map((node) => {
      if (node.text) return node.text;
      if (node.content) return extractText(node.content);
      return '';
    })
    .join('\n');
}

/**
 * Compute linear text from a node's inline content array.
 * Matches the frontend's mapTextOffsetToPos: text chars + hardBreak=1 char.
 */
function linearText(content: any[]): string {
  if (!content) return '';
  let out = '';
  for (const child of content) {
    if (child.type === 'text' && typeof child.text === 'string') out += child.text;
    else if (child.type === 'hardBreak') out += '\n';
  }
  return out;
}

/**
 * Tokenize text into words with character offsets.
 */
function tokenize(text: string): Array<{ word: string; start: number; end: number }> {
  const words: Array<{ word: string; start: number; end: number }> = [];
  const re = /\S+/g;
  let match;
  while ((match = re.exec(text))) {
    words.push({ word: match[0], start: match.index, end: match.index + match[0].length });
  }
  return words;
}

/**
 * Compute sub-node selection range by word-level diff.
 * Finds first and last differing words → decoration spans that range.
 */
function computePartialRange(origContent: any[], newContent: any[]): {
  selectionFrom: number; selectionTo: number;
  originalFrom: number; originalTo: number;
} | null {
  const origText = linearText(origContent || []);
  const newText = linearText(newContent || []);
  if (!origText || !newText || origText === newText) return null;

  const origWords = tokenize(origText);
  const newWords = tokenize(newText);
  if (origWords.length === 0 || newWords.length === 0) return null;

  // First differing word from start
  let firstDiff = 0;
  while (firstDiff < origWords.length && firstDiff < newWords.length &&
    origWords[firstDiff].word === newWords[firstDiff].word) firstDiff++;

  // All words identical (shouldn't happen since text differs, but guard)
  if (firstDiff === origWords.length && firstDiff === newWords.length) return null;

  // Last differing word from end
  let origEnd = origWords.length - 1;
  let newEnd = newWords.length - 1;
  while (origEnd >= firstDiff && newEnd >= firstDiff &&
    origWords[origEnd].word === newWords[newEnd].word) {
    origEnd--;
    newEnd--;
  }

  // No common words at start or end → full rewrite, skip partial
  if (firstDiff === 0 && origEnd === origWords.length - 1 && newEnd === newWords.length - 1) return null;

  // Raw character offsets from first/last changed words
  let origFrom = firstDiff < origWords.length ? origWords[firstDiff].start : origText.length;
  let origTo = origEnd >= firstDiff && origEnd < origWords.length ? origWords[origEnd].end : origFrom;
  let newFrom = firstDiff < newWords.length ? newWords[firstDiff].start : newText.length;
  let newTo = newEnd >= firstDiff && newEnd < newWords.length ? newWords[newEnd].end : newFrom;

  // Snap start back to previous sentence boundary (after ". " or ".\n")
  const snapBack = (text: string, pos: number): number => {
    let i = pos - 1;
    while (i > 0) {
      if (text[i] === '.' && i + 1 < text.length && (text[i + 1] === ' ' || text[i + 1] === '\n')) return i + 2;
      i--;
    }
    return 0; // No period found → start of text
  };

  // Snap end forward to next sentence boundary (". " or ".\n" or end of text)
  const snapForward = (text: string, pos: number): number => {
    let i = pos;
    while (i < text.length) {
      if (text[i] === '.' && (i + 1 >= text.length || text[i + 1] === ' ' || text[i + 1] === '\n')) return i + 1;
      i++;
    }
    return text.length;
  };

  origFrom = snapBack(origText, origFrom);
  origTo = snapForward(origText, origTo);
  newFrom = snapBack(newText, newFrom);
  newTo = snapForward(newText, newTo);

  // If almost everything changed, full-node decoration
  if ((origTo - origFrom + newTo - newFrom) >= (origText.length + newText.length) * 0.8) return null;

  return {
    selectionFrom: newFrom,
    selectionTo: newTo,
    originalFrom: origFrom,
    originalTo: origTo,
  };
}

export function getWordCount(): number {
  const text = getPlainText();
  return text.trim() ? text.trim().split(/\s+/).length : 0;
}

export function getPendingChangeCount(): number {
  let count = 0;
  function scan(nodes: any[]) {
    if (!nodes) return;
    for (const node of nodes) {
      if (node.attrs?.pendingStatus) count++;
      if (node.content) scan(node.content);
    }
  }
  scan(state.document.content);
  return count;
}

export function getNodesByIds(ids: string[]): any[] {
  const result: any[] = [];
  const idSet = new Set(ids);
  function scan(nodes: any[]) {
    if (!nodes) return;
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      if (node.attrs?.id && idSet.has(node.attrs.id)) {
        result.push(node);
        // Preserve horizontalRule separators between matched nodes (thread structure)
        if (i + 1 < nodes.length && nodes[i + 1].type === 'horizontalRule') {
          result.push(nodes[i + 1]);
        }
      }
      if (node.content) scan(node.content);
    }
  }
  scan(state.document.content);
  // Remove trailing horizontalRule (don't end with separator)
  if (result.length > 0 && result[result.length - 1].type === 'horizontalRule') {
    result.pop();
  }
  return result;
}

/** Pure version of getNodesByIds — takes content array instead of reading state. */
export function findNodesByIds(docContent: any[], ids: string[]): any[] {
  const result: any[] = [];
  const idSet = new Set(ids);
  function scan(nodes: any[]) {
    if (!nodes) return;
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      if (node.attrs?.id && idSet.has(node.attrs.id)) {
        result.push(node);
        if (i + 1 < nodes.length && nodes[i + 1].type === 'horizontalRule') {
          result.push(nodes[i + 1]);
        }
      }
      if (node.content) scan(node.content);
    }
  }
  scan(docContent);
  if (result.length > 0 && result[result.length - 1].type === 'horizontalRule') {
    result.pop();
  }
  return result;
}

export function getMetadata(): Record<string, any> {
  return state.metadata;
}

/**
 * Apply contamination guards + deep-merge context keys. Pure function.
 * Returns the merged metadata object, or null if all updates were filtered out.
 */
export function mergeMetadataUpdates(existing: Record<string, any>, updates: Record<string, any>): Record<string, any> | null {
  // Clone so we don't mutate the caller's object
  updates = { ...updates };

  // Prevent blogContext contamination
  if (updates.blogContext && !updates.blogContext.active && !existing?.blogContext?.active) {
    delete updates.blogContext;
    if (Object.keys(updates).length === 0) return null;
  }
  // Same guard for newsletterContext
  if (updates.newsletterContext && !updates.newsletterContext.active && !existing?.newsletterContext?.active) {
    delete updates.newsletterContext;
    if (Object.keys(updates).length === 0) return null;
  }

  // Deep-merge known context objects
  const CONTEXT_KEYS = ['blogContext', 'newsletterContext', 'articleContext', 'tweetContext', 'linkedinContext'];
  for (const key of CONTEXT_KEYS) {
    if (updates[key] && typeof updates[key] === 'object' && existing?.[key] && typeof existing[key] === 'object') {
      updates[key] = { ...existing[key], ...updates[key] };
    }
  }

  return { ...existing, ...updates };
}

export function setMetadata(updates: Record<string, any>): void {
  const merged = mergeMetadataUpdates(state.metadata, updates);
  if (!merged) return;

  state.metadata = merged;
  if (updates.title) state.title = updates.title;

  // Auto-tag based on context metadata
  const filename = state.filePath
    ? (isExternalDoc(state.filePath) ? state.filePath : state.filePath.split(/[/\\]/).pop() || '')
    : '';
  if (filename) {
    // tweetContext / articleContext → "x" + mode tag
    for (const key of ['tweetContext', 'articleContext'] as const) {
      if (key in updates) {
        if (updates[key]) {
          addDocTag(filename, 'x');
          const mode = updates[key]?.mode || (key === 'articleContext' ? 'article' : undefined);
          if (mode) addDocTag(filename, mode);
        } else {
          removeDocTag(filename, 'x');
        }
      }
    }
    // blogContext / linkedinContext / newsletterContext → single tag
    const contextTags: Record<string, string> = {
      blogContext: 'blog',
      linkedinContext: 'linkedin',
      newsletterContext: 'newsletter',
    };
    for (const [key, tag] of Object.entries(contextTags)) {
      if (key in updates) {
        if (updates[key]) addDocTag(filename, tag);
        else removeDocTag(filename, tag);
      }
    }
  }
}

export function getStatus() {
  return {
    title: state.title,
    wordCount: getWordCount(),
    pendingChanges: getPendingChangeCount(),
    lastModified: state.lastModified.toISOString(),
  };
}

// ============================================================================
// SETTERS
// ============================================================================

export function updateDocument(doc: PadDocument): void {
  // Safety: reject dramatically smaller documents (same logic as destructive save check).
  // Prevents stale browser tabs from overwriting the correct in-memory state with
  // corrupted content (e.g. tweet compose view sending 4-node doc vs 40-node original).
  const currentNodes = state.document?.content?.length ?? 0;
  const incomingNodes = doc?.content?.length ?? 0;
  if (currentNodes > 5 && incomingNodes < currentNodes * 0.3) {
    console.error(`[State] BLOCKED destructive updateDocument: ${incomingNodes} nodes would replace ${currentNodes} nodes`);
    return;
  }

  // Preserve pending attrs from server state → incoming browser doc.
  // The browser's PendingAttributes extension tracks pendingStatus in the TipTap
  // document model, but transferPendingAttrs provides a safety net in case the
  // browser's doc-update lost them (e.g. timing edge case, stale transaction).
  const serverHadPending = hasPendingChanges();
  if (serverHadPending) {
    transferPendingAttrs(state.document, doc);
  }
  state.document = doc;
  state.lastModified = new Date();

  // Validate: if server had pending changes, verify they survived the transfer
  if (serverHadPending && !hasPendingChanges()) {
    console.error('[State] WARNING: pending changes lost after updateDocument — browser doc-update overwrote pending attrs');
  }
}

/**
 * Transfer pending attrs from source doc to target doc by matching node IDs.
 * Copies all pending-related attrs: status, original content, group ID,
 * selection ranges, and text edits.
 */
function transferPendingAttrs(source: PadDocument, target: PadDocument): void {
  // Build a map of nodeId → all pending attrs from source
  const pendingMap = new Map<string, Record<string, any>>();
  function collectPending(nodes: any[]) {
    if (!nodes) return;
    for (const node of nodes) {
      if (node.attrs?.pendingStatus && node.attrs?.id) {
        const entry: Record<string, any> = {
          pendingStatus: node.attrs.pendingStatus,
        };
        // Copy all pending-related attrs if present
        if (node.attrs.pendingOriginalContent != null) entry.pendingOriginalContent = node.attrs.pendingOriginalContent;
        if (node.attrs.pendingTextEdits != null) entry.pendingTextEdits = node.attrs.pendingTextEdits;
        if (node.attrs.pendingGroupId != null) entry.pendingGroupId = node.attrs.pendingGroupId;
        if (node.attrs.pendingSelectionFrom != null) entry.pendingSelectionFrom = node.attrs.pendingSelectionFrom;
        if (node.attrs.pendingSelectionTo != null) entry.pendingSelectionTo = node.attrs.pendingSelectionTo;
        if (node.attrs.pendingOriginalFrom != null) entry.pendingOriginalFrom = node.attrs.pendingOriginalFrom;
        if (node.attrs.pendingOriginalTo != null) entry.pendingOriginalTo = node.attrs.pendingOriginalTo;
        pendingMap.set(node.attrs.id, entry);
      }
      if (node.content) collectPending(node.content);
    }
  }
  collectPending(source.content);

  if (pendingMap.size === 0) return;

  // Apply pending attrs to matching nodes in target
  let transferred = 0;
  function applyPending(nodes: any[]) {
    if (!nodes) return;
    for (const node of nodes) {
      if (node.attrs?.id && pendingMap.has(node.attrs.id)) {
        const p = pendingMap.get(node.attrs.id)!;
        Object.assign(node.attrs, p);
        transferred++;
      }
      if (node.content) applyPending(node.content);
    }
  }
  applyPending(target.content);

  if (transferred < pendingMap.size) {
    console.warn(`[State] transferPendingAttrs: ${transferred}/${pendingMap.size} nodes matched — ${pendingMap.size - transferred} pending nodes missing in target doc`);
  }
}

// ============================================================================
// AGENT WRITE LOCK
// ============================================================================

const AGENT_LOCK_MS = 3000; // Block browser doc-updates for 3s after agent write
let lastAgentWriteTime = 0;

/** Set the agent write lock (called after agent changes). */
export function setAgentLock(): void {
  lastAgentWriteTime = Date.now();
}

/** Check if the agent write lock is active. */
export function isAgentLocked(): boolean {
  return Date.now() - lastAgentWriteTime < AGENT_LOCK_MS;
}

// ---- Document version counter: prevents stale browser doc-updates ----
let docVersion = 0;

/** Increment version after agent writes. Returns the new version. */
export function bumpDocVersion(): number {
  return ++docVersion;
}

/** Get current document version. */
export function getDocVersion(): number {
  return docVersion;
}

/** Check if a browser doc-update version is current. */
export function isVersionCurrent(browserVersion: number): boolean {
  return browserVersion >= docVersion;
}

/** Reset version on document switch (new document = new version lineage). */
export function resetDocVersion(): void {
  docVersion = 0;
}

// ---- Debounced save: coalesces rapid agent writes into a single disk write ----
let saveTimer: ReturnType<typeof setTimeout> | null = null;
const SAVE_DEBOUNCE_MS = 500;

function debouncedSave(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    save();
  }, SAVE_DEBOUNCE_MS);
}

/** Cancel any pending debounced save. Call before doc switch (which does its own save). */
export function cancelDebouncedSave(): void {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
}

export function applyChanges(changes: NodeChange[]): { count: number; lastNodeId: string | null } {
  // Apply to server-side document (source of truth)
  const processed = applyChangesToDocument(changes);

  // Bump version + lock browser doc-updates to prevent stale state overwrite
  const version = bumpDocVersion();
  setAgentLock();

  // Broadcast processed changes (with server-assigned IDs + version) to browser clients
  for (const listener of listeners) {
    listener(processed, version);
  }

  // Debounced save — coalesces rapid agent writes into a single disk write
  debouncedSave();

  // Update pending doc cache for the active document
  updatePendingCacheForActiveDoc();

  // Find the last created node ID for chaining inserts
  let lastNodeId: string | null = null;
  for (let i = processed.length - 1; i >= 0; i--) {
    const change = processed[i];
    if (change.content) {
      const contentArr = Array.isArray(change.content) ? change.content : [change.content];
      const lastNode = contentArr[contentArr.length - 1];
      if (lastNode?.attrs?.id) {
        lastNodeId = lastNode.attrs.id;
        break;
      }
    }
  }

  return { count: processed.length, lastNodeId };
}

export function onChanges(listener: ChangeListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// ============================================================================
// SERVER-SIDE DOCUMENT MUTATIONS
// ============================================================================

// generateNodeId imported from helpers.ts

/**
 * Find a node by ID in any document tree.
 * topLevel is used to resolve the "end" sentinel.
 */
function findNode(nodes: any[], id: string, topLevel: any[]): { parent: any[]; index: number } | null {
  if (id === 'end') {
    if (topLevel && topLevel.length > 0) {
      return { parent: topLevel, index: topLevel.length - 1 };
    }
    return null;
  }
  for (let i = 0; i < nodes.length; i++) {
    if (nodes[i].attrs?.id === id) {
      return { parent: nodes, index: i };
    }
    if (nodes[i].content && Array.isArray(nodes[i].content)) {
      const result = findNode(nodes[i].content, id, topLevel);
      if (result) return result;
    }
  }
  return null;
}

/** Find a node in the active document. */
function findNodeInDoc(nodes: any[], id: string): { parent: any[]; index: number } | null {
  return findNode(nodes, id, state.document.content);
}

/**
 * Core change application logic — operates on any document object.
 * Mutates doc in place and returns processed changes with server-assigned IDs.
 *
 * When `autoAccept` is true, changes commit directly: no pendingStatus tagging,
 * no pendingOriginalContent baseline, and deletes hard-remove from the array
 * (rather than tagging for review). Processed changes carry autoAccept: true
 * so the client knows to apply them as committed edits, not pending review.
 */
function applyChangesToDoc(doc: PadDocument, changes: NodeChange[], autoAccept: boolean = false): NodeChange[] {
  const processed: NodeChange[] = [];

  // Track last insert anchor → last inserted node ID, so consecutive inserts
  // with the same afterNodeId chain naturally (array order = document order).
  let lastInsertAnchor: string | null = null;
  let lastInsertedId: string | null = null;

  for (const change of changes) {
    if (change.operation === 'rewrite' && change.nodeId && change.content) {
      const found = findNode(doc.content, change.nodeId, doc.content);
      if (!found) continue;

      let contentArray = Array.isArray(change.content) ? change.content : [change.content];
      const originalNode = structuredClone(found.parent[found.index]);

      // Preserve target node type when plain text would otherwise demote it.
      // Markdown-it parses plain text as a paragraph, so rewriting a heading or
      // list item with plain prose silently changes the type. Two adaptations:
      //   - Block wrappers (listItem, blockquote) wrap the parsed paragraph as
      //     their child, keeping the wrapper's type and attrs.
      //   - Inline-content leaves (heading, codeBlock) take the paragraph's
      //     inline text and host it inside the original type, preserving level
      //     and other attrs.
      // Explicit markdown (e.g. "## Foo", "- bar") still wins because the
      // parser produces a matching node type before we get here.
      const targetType = originalNode.type;
      const parsedType = contentArray[0]?.type;
      const BLOCK_WRAPPERS = new Set(['listItem', 'blockquote']);
      const INLINE_LEAVES = new Set(['heading', 'codeBlock']);

      let isWrappedRewrite = false;
      if (parsedType === 'paragraph' && targetType !== 'paragraph') {
        if (BLOCK_WRAPPERS.has(targetType)) {
          contentArray = [{
            type: targetType,
            attrs: { ...originalNode.attrs },
            content: contentArray,
          }];
          isWrappedRewrite = true;
        } else if (INLINE_LEAVES.has(targetType)) {
          // Standard stamping handles the leaf case — heading/codeBlock are
          // themselves the decoration target, so no special branch needed below.
          contentArray = [{
            type: targetType,
            attrs: { ...originalNode.attrs },
            content: contentArray[0].content || [],
          }];
        }
      }

      // Empty node rewrite → treat as insert (green, not blue)
      const originalText = extractText(originalNode.content || []);
      const isEmptyNode = !originalText.trim();

      // Only store original on first rewrite (preserve baseline for reject)
      const existingOriginal = found.parent[found.index].attrs?.pendingOriginalContent;

      // Detect partial change: if only a sub-range of the node text changed,
      // attach selection range attrs so the frontend decorates only that part.
      // For wrapped rewrites (listItem), compare paragraph content against the
      // listItem's inner paragraph so offsets align with what the user sees.
      let partialRange: ReturnType<typeof computePartialRange> = null;
      if (!isEmptyNode && contentArray.length === 1 && !autoAccept) {
        const baseContent = isWrappedRewrite
          ? (existingOriginal?.content?.[0]?.content || originalNode.content?.[0]?.content || [])
          : (existingOriginal?.content || originalNode.content || []);
        const newContent = isWrappedRewrite
          ? (contentArray[0].content?.[0]?.content || [])
          : (contentArray[0].content || []);
        partialRange = computePartialRange(baseContent, newContent);
      }

      // Build first node. For wrapped rewrites, pendingStatus and related attrs
      // belong on the inner leaf (paragraph) so the decoration renderer — which
      // keys off LEAF_BLOCK_TYPES — picks them up. The wrapper keeps the original
      // node's id/attrs so subsequent calls can still target it.
      let firstNode: any;
      if (isWrappedRewrite && !autoAccept) {
        const innerLeaf = contentArray[0].content?.[0] || { type: 'paragraph', content: [] };
        const innerWithPending = {
          ...innerLeaf,
          attrs: {
            ...innerLeaf.attrs,
            id: innerLeaf.attrs?.id || generateNodeId(),
            pendingStatus: isEmptyNode ? 'insert' : 'rewrite',
            ...(isEmptyNode ? {} : { pendingOriginalContent: existingOriginal || originalNode }),
            ...(partialRange ? {
              pendingSelectionFrom: partialRange.selectionFrom,
              pendingSelectionTo: partialRange.selectionTo,
              pendingOriginalFrom: partialRange.originalFrom,
              pendingOriginalTo: partialRange.originalTo,
            } : {}),
          },
        };
        firstNode = {
          type: 'listItem',
          attrs: { ...contentArray[0].attrs, id: change.nodeId },
          content: [innerWithPending, ...contentArray[0].content.slice(1)],
        };
      } else {
        firstNode = {
          ...contentArray[0],
          attrs: autoAccept ? {
            ...contentArray[0].attrs,
            id: change.nodeId,
          } : {
            ...contentArray[0].attrs,
            id: change.nodeId,
            pendingStatus: isEmptyNode ? 'insert' : 'rewrite',
            ...(isEmptyNode ? {} : { pendingOriginalContent: existingOriginal || originalNode }),
            ...(partialRange ? {
              pendingSelectionFrom: partialRange.selectionFrom,
              pendingSelectionTo: partialRange.selectionTo,
              pendingOriginalFrom: partialRange.originalFrom,
              pendingOriginalTo: partialRange.originalTo,
            } : {}),
          },
        };
      }

      // Additional nodes get inserted after — as pending inserts in normal mode,
      // as plain blocks in autoAccept mode.
      const extraNodes = contentArray.slice(1).map((node: any) => ({
        ...node,
        attrs: {
          ...node.attrs,
          id: node.attrs?.id || generateNodeId(),
        },
      }));
      if (!autoAccept) markLeafBlocksAsPending(extraNodes, 'insert');

      found.parent.splice(found.index, 1, firstNode, ...extraNodes);

      processed.push({
        ...change,
        content: [firstNode, ...extraNodes],
        ...(autoAccept ? { autoAccept: true } : {}),
      });
    }

    else if (change.operation === 'insert' && change.content) {
      const contentArray = Array.isArray(change.content) ? change.content : [change.content];

      // Assign IDs to all new nodes before broadcast
      const contentWithIds = contentArray.map((node: any, i: number) => ({
        ...node,
        attrs: {
          ...node.attrs,
          id: node.attrs?.id || (change.nodeId && !change.afterNodeId && i === 0 ? change.nodeId : generateNodeId()),
        },
      }));
      // Mark leaf blocks as pending (not containers) — skipped in autoAccept mode
      // so inserts commit as plain content without decoration.
      if (!autoAccept) markLeafBlocksAsPending(contentWithIds, 'insert');

      let resolvedAfterId: string | undefined;

      // Auto-chain: if this insert targets the same anchor as the previous insert,
      // redirect it to insert after the last inserted node instead (preserves array order).
      let effectiveAfterId = change.afterNodeId;
      if (effectiveAfterId && effectiveAfterId === lastInsertAnchor && lastInsertedId) {
        effectiveAfterId = lastInsertedId;
      }

      if (change.nodeId && !change.afterNodeId) {
        // Replace empty node
        const found = findNode(doc.content, change.nodeId, doc.content);
        if (!found) continue;
        found.parent.splice(found.index, 1, ...contentWithIds);
      } else if (effectiveAfterId) {
        const found = findNode(doc.content, effectiveAfterId, doc.content);
        if (!found) continue;
        // Resolve "end" sentinel to actual node ID so browser can find it
        resolvedAfterId = found.parent[found.index]?.attrs?.id;
        found.parent.splice(found.index + 1, 0, ...contentWithIds);
      } else {
        continue;
      }

      // Track for auto-chaining: remember original anchor + last inserted ID
      const newLastId = contentWithIds[contentWithIds.length - 1]?.attrs?.id;
      if (change.afterNodeId && newLastId) {
        if (change.afterNodeId !== lastInsertAnchor) {
          // New anchor — start fresh chain
          lastInsertAnchor = change.afterNodeId;
        }
        lastInsertedId = newLastId;
      }

      // Broadcast with server-assigned IDs and resolved anchor so browser inserts at the correct position
      processed.push({
        ...change,
        afterNodeId: resolvedAfterId && change.afterNodeId === 'end'
          ? resolvedAfterId
          : effectiveAfterId ?? change.afterNodeId,
        content: contentWithIds.length === 1 ? contentWithIds[0] : contentWithIds,
        ...(autoAccept ? { autoAccept: true } : {}),
      });
    }

    else if (change.operation === 'delete' && change.nodeId) {
      const found = findNode(doc.content, change.nodeId, doc.content);
      if (!found) continue;

      // Tweet thread: hard-delete paragraphs + adjacent HR immediately.
      // Tweet compose view can't handle pending deletes near HRs — hard-delete and resync.
      const delNode = found.parent[found.index];
      const hardDeleteTypes = ['paragraph', 'image', 'imageLoading'];
      if (hardDeleteTypes.includes(delNode.type) && state.metadata?.tweetContext) {
        const idx = found.index;
        if (idx > 0 && found.parent[idx - 1].type === 'horizontalRule') {
          found.parent.splice(idx, 1);
          found.parent.splice(idx - 1, 1);
        } else if (idx + 1 < found.parent.length && found.parent[idx + 1].type === 'horizontalRule') {
          found.parent.splice(idx + 1, 1);
          found.parent.splice(idx, 1);
        } else {
          found.parent.splice(idx, 1);
        }
        // Push a synthetic HR change so ws.ts detects it and sends document-switched
        processed.push({ operation: 'delete' as const, nodeId: change.nodeId, content: [{ type: 'horizontalRule' }] });
        continue;
      }

      if (autoAccept) {
        // Hard-delete: remove the node entirely from its parent array.
        found.parent.splice(found.index, 1);
        processed.push({ ...change, autoAccept: true });
      } else {
        found.parent[found.index] = {
          ...found.parent[found.index],
          attrs: {
            ...found.parent[found.index].attrs,
            pendingStatus: 'delete',
          },
        };
        processed.push(change);
      }
    }
  }

  return processed;
}

/**
 * Effective auto-accept for a doc: true if the doc's own frontmatter has it,
 * OR if any workspace/container ancestor in the workspace tree has it on.
 */
export function isAutoAcceptActive(filename: string, metadata?: Record<string, any>): boolean {
  if (metadata?.autoAccept === true) return true;
  if (metadata?.autoAccept === false) return false; // explicit doc-level override of inheritance
  if (!filename) return false;
  return isAutoAcceptInheritedForDoc(filename);
}

/** Apply changes to the active document singleton. */
function applyChangesToDocument(changes: NodeChange[]): NodeChange[] {
  const autoAccept = isAutoAcceptActive(activeDocFilename(), state.metadata);
  const processed = applyChangesToDoc(state.document, changes, autoAccept);
  if (processed.length > 0) {
    state.lastModified = new Date();
  }
  return processed;
}

/**
 * Apply fine-grained text edits to a node. Resolves text matches,
 * produces a modified node, and routes through applyChanges as a rewrite.
 */
export function applyTextEdits(nodeId: string, edits: TextEdit[]): { success: boolean; error?: string } {
  const found = findNodeInDoc(state.document.content, nodeId);
  if (!found) return { success: false, error: `Node ${nodeId} not found` };

  const originalNode = found.parent[found.index];
  const result = applyTextEditsToNode(originalNode, edits);
  if (!result) return { success: false, error: 'No edits matched' };

  // Inline edit decoration only matters when there's a review surface — skip in autoAccept.
  if (!isAutoAcceptActive(activeDocFilename(), state.metadata)) {
    result.node.attrs = {
      ...result.node.attrs,
      pendingTextEdits: result.textEdits,
    };
  }

  // Route through applyChanges as a rewrite so it goes through the normal pipeline
  applyChanges([{
    operation: 'rewrite',
    nodeId,
    content: result.node,
  }]);

  return { success: true };
}

/** Set the active document state. Used by documents.ts for multi-doc operations. */
export function setActiveDocument(
  doc: PadDocument, title: string, filePath: string, isTemp: boolean,
  lastModified?: Date, metadata?: Record<string, any>, originalFrontmatter?: string | null,
): void {
  state.document = doc;
  state.title = title;
  state.metadata = metadata || { title };
  state.filePath = filePath;
  state.isTemp = isTemp;
  state.lastModified = lastModified || new Date();
  state.docId = ensureDocId(state.metadata);
  state.originalFrontmatter = originalFrontmatter ?? null;
}

// ============================================================================
// PENDING DOCUMENT CACHE (avoids disk scans on every broadcast)
// ============================================================================

/** In-memory cache: filename → pending change count. Populated on load(), updated incrementally. */
const pendingDocCache = new Map<string, number>();

/** Get the active doc's filename identifier (mirrors getActiveFilename in documents.ts). */
function activeDocFilename(): string {
  return state.filePath
    ? (isExternalDoc(state.filePath) ? state.filePath : state.filePath.split(/[/\\]/).pop() || '')
    : '';
}

/** Update the pending cache for the active document from in-memory state. */
export function updatePendingCacheForActiveDoc(): void {
  const filename = activeDocFilename();
  if (!filename) return;
  const count = getPendingChangeCount();
  if (count > 0) {
    pendingDocCache.set(filename, count);
  } else {
    pendingDocCache.delete(filename);
  }
}

/** Remove a filename from the pending cache (after pending attrs are stripped). */
export function removePendingCacheEntry(filename: string): void {
  pendingDocCache.delete(filename);
}

/** Set the pending cache entry for a specific filename (for non-active doc population). */
export function setPendingCacheEntry(filename: string, count: number): void {
  if (count > 0) {
    pendingDocCache.set(filename, count);
  } else {
    pendingDocCache.delete(filename);
  }
}

/** Populate the pending cache from a full disk scan. Called once on startup. */
function populatePendingCache(): void {
  pendingDocCache.clear();
  try {
    const files = readdirSync(getDataDir()).filter((f) => f.endsWith('.md'));
    for (const f of files) {
      try {
        const raw = readFileSync(join(getDataDir(), f), 'utf-8');
        const { data } = matter(raw);
        if (data.pending && Object.keys(data.pending).length > 0) {
          pendingDocCache.set(f, Object.keys(data.pending).length);
        }
      } catch { /* skip unreadable files */ }
    }
  } catch { /* ignore */ }
  // Scan external docs
  for (const extPath of externalDocs) {
    try {
      if (!existsSync(extPath)) continue;
      const raw = readFileSync(extPath, 'utf-8');
      const { data } = matter(raw);
      if (data.pending && Object.keys(data.pending).length > 0) {
        pendingDocCache.set(extPath, Object.keys(data.pending).length);
      }
    } catch { /* skip unreadable files */ }
  }
}

// ============================================================================
// IN-MEMORY DOCUMENT CACHE (preserves TipTap JSON + node IDs across switches)
// ============================================================================

interface CachedDoc {
  document: PadDocument;
  metadata: Record<string, any>;
  title: string;
  isTemp: boolean;
  lastModified: Date;
  docId: string;
  fileMtime: number; // file mtime when cached, for external-change detection
  originalFrontmatter: string | null;
}
const docCache = new Map<string, CachedDoc>(); // key = filePath

/** Cache the active document's full state, keyed by filePath. Call after save(). */
export function cacheActiveDocument(): void {
  if (!state.filePath) return;
  let fileMtime = 0;
  try {
    fileMtime = statSync(state.filePath).mtimeMs;
  } catch { /* file may not exist yet */ }
  docCache.set(state.filePath, {
    document: structuredClone(state.document),
    metadata: structuredClone(state.metadata),
    title: state.title,
    isTemp: state.isTemp,
    lastModified: state.lastModified,
    docId: state.docId,
    fileMtime,
    originalFrontmatter: state.originalFrontmatter,
  });
}

/** Get a cached document if the file hasn't been modified externally. Returns null on miss or stale. */
export function getCachedDocument(filePath: string): CachedDoc | null {
  const cached = docCache.get(filePath);
  if (!cached) return null;
  try {
    const currentMtime = statSync(filePath).mtimeMs;
    if (currentMtime !== cached.fileMtime) {
      // File changed on disk — invalidate cache
      docCache.delete(filePath);
      return null;
    }
  } catch {
    // File doesn't exist or can't be read — invalidate
    docCache.delete(filePath);
    return null;
  }
  return cached;
}

/** Remove a specific file from the document cache. */
export function invalidateDocCache(filePath: string): void {
  docCache.delete(filePath);
}

/** Update the cache entry for a file after writing changes (without cloning the active state). */
export function updateCacheEntry(filePath: string, doc: PadDocument, title: string, metadata: Record<string, any>, isTemp: boolean, docId: string): void {
  let fileMtime = 0;
  try {
    fileMtime = statSync(filePath).mtimeMs;
  } catch { /* best-effort */ }
  // Preserve originalFrontmatter from existing cache entry (if any)
  const existing = docCache.get(filePath);
  docCache.set(filePath, {
    document: structuredClone(doc),
    metadata: structuredClone(metadata),
    title,
    isTemp,
    lastModified: new Date(),
    docId,
    fileMtime,
    originalFrontmatter: existing?.originalFrontmatter ?? null,
  });
}

/** Reset all in-memory caches. Called on profile switch. */
export function clearAllCaches(): void {
  docCache.clear();
  pendingDocCache.clear();
  externalDocs.clear();
  state = {
    document: DEFAULT_DOC,
    title: 'Untitled',
    metadata: { title: 'Untitled' },
    filePath: '',
    isTemp: true,
    lastModified: new Date(),
    docId: '',
    originalFrontmatter: null,
  };
}

// ============================================================================
// PENDING DOCUMENT STORE OPERATIONS
// ============================================================================

/** Check if a document (or the current doc) has any pending changes. */
export function hasPendingChanges(doc?: PadDocument): boolean {
  const target = doc || state.document;
  function scan(nodes: any[]): boolean {
    if (!nodes) return false;
    for (const node of nodes) {
      if (node.attrs?.pendingStatus) return true;
      if (node.content && scan(node.content)) return true;
    }
    return false;
  }
  return scan(target.content);
}

/** Strip all pending attrs from the current document (after browser resolves all changes). */
export function stripPendingAttrs(): void {
  function strip(nodes: any[]) {
    if (!nodes) return;
    for (const node of nodes) {
      if (node.attrs?.pendingStatus) {
        delete node.attrs.pendingStatus;
        delete node.attrs.pendingOriginalContent;
        delete node.attrs.pendingTextEdits;
      }
      if (node.content) strip(node.content);
    }
  }
  strip(state.document.content);
  removePendingCacheEntry(activeDocFilename());
}

/**
 * Mark leaf block nodes as pending within a node array.
 * Only marks text-containing blocks (paragraph, heading, codeBlock, etc.)
 * NOT container nodes (bulletList, orderedList, listItem, blockquote).
 * This ensures collectPendingState captures them correctly on save.
 */
function markLeafBlocksAsPending(nodes: any[], status: string): void {
  if (!nodes) return;
  for (const node of nodes) {
    if (node.type && LEAF_BLOCK_TYPES.has(node.type)) {
      node.attrs = { ...node.attrs, pendingStatus: status };
      if (!node.attrs.id) {
        node.attrs.id = generateNodeId();
      }
    } else if (node.content) {
      markLeafBlocksAsPending(node.content, status);
    }
  }
}

export function markAllNodesAsPending(doc: PadDocument, status: 'insert' | 'rewrite'): void {
  markLeafBlocksAsPending(doc.content, status);
}

/** Read pending doc info from in-memory cache (O(1) instead of disk scan). */
export function getPendingDocInfo(): { filenames: string[]; counts: Record<string, number> } {
  const filenames: string[] = [];
  const counts: Record<string, number> = {};
  const stale: string[] = [];
  for (const [filename, count] of pendingDocCache) {
    // Validate file still exists on disk (prunes ghost entries after server restart)
    const filePath = isExternalDoc(filename) ? filename : join(getDataDir(), filename);
    if (!existsSync(filePath)) {
      stale.push(filename);
      continue;
    }
    filenames.push(filename);
    counts[filename] = count;
  }
  // Clean up stale entries
  for (const f of stale) pendingDocCache.delete(f);
  return { filenames, counts };
}

// ============================================================================
// PERSISTENCE
// ============================================================================

function writeToDisk(): void {
  ensureDataDir();

  // Capture old forward links BEFORE we overwrite the file — needed by the
  // backlinks engine to know which target docs to refresh when source changes.
  // Skip for external docs (they don't participate in the doc graph).
  let oldForwardLinks: ForwardLink[] = [];
  if (!isExternalDoc(state.filePath) && state.docId) {
    try {
      oldForwardLinks = extractForwardLinksFromDisk(state.filePath, state.docId);
    } catch { /* best-effort */ }
  }

  let markdown: string;
  if (isExternalDoc(state.filePath)) {
    // External files: preserve original frontmatter verbatim, no OpenWriter metadata injected
    const body = tiptapToBody(state.document).replace(/(?:\s*<!-- -->\s*)+$/, '\n');
    markdown = state.originalFrontmatter
      ? `---\n${state.originalFrontmatter}\n---\n\n${body}`
      : body;
  } else {
    markdown = tiptapToMarkdown(state.document, state.title, state.metadata);
  }

  if (existsSync(state.filePath)) {
    // Skip write if content is identical (prevents phantom git changes on doc switch)
    try {
      const existing = readFileSync(state.filePath, 'utf-8');
      if (existing === markdown) return;
    } catch { /* read failed, proceed with write */ }

    // Safety: don't overwrite a file with substantial content using near-empty content.
    // Prevents save cascades where empty editor state destroys chapter files.
    // Exception: docs with pending changes may legitimately be smaller (agent replaced content).
    if (!hasPendingChanges()) {
      try {
        const existingSize = statSync(state.filePath).size;
        if (existingSize > 200 && markdown.length < existingSize * 0.1) {
          console.error(`[State] BLOCKED destructive save: ${markdown.length} bytes would replace ${existingSize} bytes in ${state.filePath}`);
          return;
        }
      } catch { /* stat failed, proceed with save */ }
    }
  }

  atomicWriteFileSync(state.filePath, markdown);

  // Best-effort version snapshot — never blocks saves
  try { snapshotIfNeeded(state.docId, state.filePath); } catch { /* ignore */ }

  // Backlinks update: refresh target docs' backlinks frontmatter if source's
  // forward links changed. Best-effort — never blocks the save it follows.
  if (!isExternalDoc(state.filePath) && state.docId) {
    try {
      const newForwardLinks = extractForwardLinks(state.document, state.docId);
      updateBacklinksForSource(state.docId, newForwardLinks, oldForwardLinks);
    } catch (err) {
      console.error('[State] backlinks update failed:', err);
    }
  }
}

export function save(): void {
  if (!state.filePath) {
    // First save — assign a file path
    ensureDataDir();
    if (state.title === 'Untitled') {
      state.filePath = tempFilePath();
      state.isTemp = true;
    } else {
      state.filePath = filePathForTitle(state.title);
      state.isTemp = false;
    }
  }
  writeToDisk();
}

export function load(): void {
  ensureDataDir();

  // Restore external document registry from disk
  loadExternalDocs();

  // Migrate any .sw.json files to .md
  migrateSwJsonFiles();

  // Clean up empty temp files from previous sessions
  cleanupEmptyTempFiles();

  // Find most recently modified .md file
  const files = readdirSync(getDataDir())
    .filter((f) => f.endsWith('.md'))
    .map((f) => {
      const fullPath = join(getDataDir(), f);
      const stat = statSync(fullPath);
      return { name: f, path: fullPath, mtime: stat.mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);

  // Walk sorted files until we find a real document with content.
  // Skip empty temp files so we don't open a blank scratch pad when real docs exist.
  for (const file of files) {
    try {
      const raw = readFileSync(file.path, 'utf-8');
      const parsed = markdownToTiptap(raw);
      const isTemp = file.name.startsWith(TEMP_PREFIX);

      // Skip empty temp files — prefer a real document
      if (isTemp && isDocEmpty(parsed.document)) continue;

      state.document = parsed.document;
      state.title = parsed.title;
      state.metadata = parsed.metadata;
      state.lastModified = new Date(statSync(file.path).mtimeMs);
      state.filePath = file.path;
      state.isTemp = isTemp;

      // Lazy docId migration: assign if missing, save to persist
      const hadDocId = !!state.metadata.docId;
      state.docId = ensureDocId(state.metadata);
      if (!hadDocId) {
        const md = tiptapToMarkdown(state.document, state.title, state.metadata);
        atomicWriteFileSync(state.filePath, md);
      }
      break;
    } catch {
      // Corrupt file — try next one
      continue;
    }
  }

  // If nothing loaded (all files were empty temps or corrupt), start fresh
  if (!state.filePath) {
    state.filePath = tempFilePath();
    state.isTemp = true;
  }

  // Populate pending doc cache from disk (single scan on startup)
  populatePendingCache();
  // Overlay active doc's in-memory state (may have unsaved pending changes)
  updatePendingCacheForActiveDoc();

  // Startup lock: block browser doc-updates briefly to prevent stale reconnect pushes
  setAgentLock();
}

/** Migrate legacy .sw.json files to .md format */
function migrateSwJsonFiles(): void {
  try {
    const jsonFiles = readdirSync(getDataDir()).filter((f) => f.endsWith('.sw.json'));
    for (const f of jsonFiles) {
      const jsonPath = join(getDataDir(), f);
      const mdName = f.replace(/\.sw\.json$/, '.md');
      const mdPath = join(getDataDir(), mdName);

      // Skip if .md already exists
      if (existsSync(mdPath)) {
        try { unlinkSync(jsonPath); } catch { /* ignore */ }
        continue;
      }

      try {
        const raw = readFileSync(jsonPath, 'utf-8');
        const data = JSON.parse(raw);
        if (data.document) {
          const title = data.title || 'Untitled';
          const markdown = tiptapToMarkdown(data.document, title);
          writeFileSync(mdPath, markdown, 'utf-8');
          console.log(`[State] Migrated ${f} → ${mdName}`);
        }
        unlinkSync(jsonPath);
      } catch {
        // Corrupt JSON file — delete it
        try { unlinkSync(jsonPath); } catch { /* ignore */ }
      }
    }
  } catch { /* ignore errors during migration */ }
}

/** Collect all filenames referenced by any workspace manifest. */
function getWorkspaceReferencedFiles(): Set<string> {
  const referenced = new Set<string>();
  try {
    const wsDir = join(getDataDir(), '_workspaces');
    if (!existsSync(wsDir)) return referenced;
    const manifests = readdirSync(wsDir).filter((f) => f.endsWith('.json'));
    for (const m of manifests) {
      try {
        const raw = readFileSync(join(wsDir, m), 'utf-8');
        const ws = JSON.parse(raw);
        // Recursively collect doc files from root tree
        const collect = (nodes: any[]) => {
          for (const n of nodes) {
            if (n.type === 'doc' && n.file) referenced.add(n.file);
            if (n.type === 'container' && Array.isArray(n.items)) collect(n.items);
          }
        };
        if (Array.isArray(ws.root)) collect(ws.root);
        else if (Array.isArray(ws.items)) {
          // v1 format
          for (const item of ws.items) {
            if (item.file) referenced.add(item.file);
          }
        }
      } catch { /* skip corrupt manifests */ }
    }
  } catch { /* ignore */ }
  return referenced;
}

/** Remove temp files that are empty (from abandoned sessions) */
function cleanupEmptyTempFiles(): void {
  try {
    const wsRefs = getWorkspaceReferencedFiles();
    const files = readdirSync(getDataDir()).filter((f) => f.startsWith(TEMP_PREFIX) && f.endsWith('.md'));
    for (const f of files) {
      // Never delete temp files that are referenced by a workspace
      if (wsRefs.has(f)) continue;
      const fullPath = join(getDataDir(), f);
      try {
        const raw = readFileSync(fullPath, 'utf-8');
        const parsed = markdownToTiptap(raw);
        // Keep temp files that have meaningful metadata (templates, pending changes, tags)
        const meta = parsed.metadata || {};
        const hasMetadata = meta.tweetContext || meta.articleContext || meta.pending || meta.agentCreated
          || (Array.isArray(meta.tags) && meta.tags.length > 0);
        if (isDocEmpty(parsed.document) && !hasMetadata) {
          unlinkSync(fullPath);
        }
      } catch {
        // Corrupt temp file — delete it (but only if not workspace-referenced)
        try { unlinkSync(fullPath); } catch { /* ignore */ }
      }
    }
  } catch { /* ignore errors during cleanup */ }
}


// ============================================================================
// MTIME HELPERS (preserve file modification time for metadata-only writes)
// ============================================================================

function safeGetMtime(filePath: string): Date | null {
  try { return statSync(filePath).mtime; } catch { return null; }
}

function safeRestoreMtime(filePath: string, mtime: Date): void {
  try { utimesSync(filePath, new Date(), mtime); } catch { /* best-effort */ }
}

// ============================================================================
// DOCUMENT-LEVEL TAG OPERATIONS
// ============================================================================

/** Get tags for the active document from its metadata. */
export function getDocTags(): string[] {
  const tags = state.metadata.tags;
  return Array.isArray(tags) ? tags : [];
}

/** Get tags for any document by filename (reads from disk if not active). */
export function getDocTagsByFilename(filename: string): string[] {
  // If it's the active doc, use in-memory state
  const activeFilename = state.filePath
    ? (isExternalDoc(state.filePath) ? state.filePath : state.filePath.split(/[/\\]/).pop() || '')
    : '';
  if (filename === activeFilename) return getDocTags();

  // Otherwise read from disk
  const targetPath = resolveDocPath(filename);
  if (!existsSync(targetPath)) return [];
  try {
    const raw = readFileSync(targetPath, 'utf-8');
    const { data } = matter(raw);
    return Array.isArray(data.tags) ? data.tags : [];
  } catch { return []; }
}

/** Add a tag to a document. Works on active doc or any file on disk. */
export function addDocTag(filename: string, tag: string): void {
  const activeFilename = state.filePath
    ? (isExternalDoc(state.filePath) ? state.filePath : state.filePath.split(/[/\\]/).pop() || '')
    : '';

  if (filename === activeFilename) {
    // Active doc — update in-memory metadata
    const tags: string[] = Array.isArray(state.metadata.tags) ? [...state.metadata.tags] : [];
    if (!tags.includes(tag)) {
      tags.push(tag);
      state.metadata.tags = tags;
      // Preserve mtime — tag changes shouldn't affect sidebar sort order
      const mtime = state.filePath ? safeGetMtime(state.filePath) : null;
      save();
      if (mtime && state.filePath) safeRestoreMtime(state.filePath, mtime);
    }
  } else {
    // Non-active doc — read/write disk (skip external files: tags are OpenWriter metadata)
    const targetPath = resolveDocPath(filename);
    if (isExternalDoc(targetPath) || !existsSync(targetPath)) return;
    try {
      const raw = readFileSync(targetPath, 'utf-8');
      const parsed = markdownToTiptap(raw);
      const tags: string[] = Array.isArray(parsed.metadata.tags) ? [...parsed.metadata.tags] : [];
      if (!tags.includes(tag)) {
        tags.push(tag);
        parsed.metadata.tags = tags;
        const mtime = safeGetMtime(targetPath);
        const markdown = tiptapToMarkdown(parsed.document, parsed.title, parsed.metadata);
        atomicWriteFileSync(targetPath, markdown);
        if (mtime) safeRestoreMtime(targetPath, mtime);
      }
    } catch { /* best-effort */ }
  }
}

/** Remove a tag from a document. Works on active doc or any file on disk. */
export function removeDocTag(filename: string, tag: string): void {
  const activeFilename = state.filePath
    ? (isExternalDoc(state.filePath) ? state.filePath : state.filePath.split(/[/\\]/).pop() || '')
    : '';

  if (filename === activeFilename) {
    const tags: string[] = Array.isArray(state.metadata.tags) ? [...state.metadata.tags] : [];
    const idx = tags.indexOf(tag);
    if (idx >= 0) {
      tags.splice(idx, 1);
      state.metadata.tags = tags.length > 0 ? tags : undefined;
      // Preserve mtime — tag changes shouldn't affect sidebar sort order
      const mtime = state.filePath ? safeGetMtime(state.filePath) : null;
      save();
      if (mtime && state.filePath) safeRestoreMtime(state.filePath, mtime);
    }
  } else {
    // Non-active doc — read/write disk (skip external files: tags are OpenWriter metadata)
    const targetPath = resolveDocPath(filename);
    if (isExternalDoc(targetPath) || !existsSync(targetPath)) return;
    try {
      const raw = readFileSync(targetPath, 'utf-8');
      const parsed = markdownToTiptap(raw);
      const tags: string[] = Array.isArray(parsed.metadata.tags) ? [...parsed.metadata.tags] : [];
      const idx = tags.indexOf(tag);
      if (idx >= 0) {
        tags.splice(idx, 1);
        parsed.metadata.tags = tags.length > 0 ? tags : undefined;
        const mtime = safeGetMtime(targetPath);
        const markdown = tiptapToMarkdown(parsed.document, parsed.title, parsed.metadata);
        atomicWriteFileSync(targetPath, markdown);
        if (mtime) safeRestoreMtime(targetPath, mtime);
      }
    } catch { /* best-effort */ }
  }
}

// ============================================================================
// CROSS-DOCUMENT HELPERS (operate on specific files, not the active singleton)
// ============================================================================

/**
 * Save a browser doc-update to a specific file on disk.
 * Used when the browser sends a doc-update for a non-active document (race condition guard).
 */
export function saveDocToFile(filename: string, doc: PadDocument): void {
  const targetPath = resolveDocPath(filename);
  if (!existsSync(targetPath)) return; // Target doesn't exist, nothing to save to
  try {
    const raw = readFileSync(targetPath, 'utf-8');
    const parsed = markdownToTiptap(raw);
    // Transfer pending attrs from on-disk version to the incoming doc
    if (hasPendingChanges(parsed.document)) {
      transferPendingAttrs(parsed.document, doc);
    }
    let markdown: string;
    if (isExternalDoc(targetPath)) {
      const body = tiptapToBody(doc);
      markdown = parsed.rawFrontmatter
        ? `---\n${parsed.rawFrontmatter}\n---\n\n${body}`
        : body;
    } else {
      markdown = tiptapToMarkdown(doc, parsed.title, parsed.metadata);
    }
    atomicWriteFileSync(targetPath, markdown);
  } catch { /* best-effort */ }
}

/**
 * Set or clear the autoAccept flag on a non-active document file on disk.
 * Reads the file, mutates metadata, writes back. Does not touch pending attrs —
 * callers should run stripPendingAttrsFromFile first when enabling.
 */
export function setAutoAcceptOnFile(filename: string, enabled: boolean): void {
  const targetPath = resolveDocPath(filename);
  if (!existsSync(targetPath)) return;
  try {
    const raw = readFileSync(targetPath, 'utf-8');
    const parsed = markdownToTiptap(raw);
    // Explicit false (not delete) so the user's "off" overrides any workspace inheritance.
    parsed.metadata.autoAccept = enabled;
    let markdown: string;
    if (isExternalDoc(targetPath)) {
      const body = tiptapToBody(parsed.document);
      markdown = parsed.rawFrontmatter
        ? `---\n${parsed.rawFrontmatter}\n---\n\n${body}`
        : body;
    } else {
      markdown = tiptapToMarkdown(parsed.document, parsed.title, parsed.metadata);
    }
    atomicWriteFileSync(targetPath, markdown);
    invalidateDocCache(targetPath);
  } catch { /* best-effort */ }
}

/**
 * Strip pending attrs from a specific file on disk (not the active document).
 * Optionally clears agentCreated metadata (on accept).
 */
export function stripPendingAttrsFromFile(filename: string, clearAgentCreated?: boolean): void {
  const targetPath = resolveDocPath(filename);
  if (!existsSync(targetPath)) return;
  try {
    const raw = readFileSync(targetPath, 'utf-8');
    const parsed = markdownToTiptap(raw);
    // Strip pending attrs from the parsed document
    function strip(nodes: any[]) {
      if (!nodes) return;
      for (const node of nodes) {
        if (node.attrs?.pendingStatus) {
          delete node.attrs.pendingStatus;
          delete node.attrs.pendingOriginalContent;
          delete node.attrs.pendingTextEdits;
        }
        if (node.content) strip(node.content);
      }
    }
    strip(parsed.document.content);
    if (clearAgentCreated && parsed.metadata.agentCreated) {
      delete parsed.metadata.agentCreated;
    }
    let markdown: string;
    if (isExternalDoc(targetPath)) {
      const body = tiptapToBody(parsed.document);
      markdown = parsed.rawFrontmatter
        ? `---\n${parsed.rawFrontmatter}\n---\n\n${body}`
        : body;
    } else {
      markdown = tiptapToMarkdown(parsed.document, parsed.title, parsed.metadata);
    }
    atomicWriteFileSync(targetPath, markdown);
    removePendingCacheEntry(filename);
  } catch { /* best-effort */ }
}

/**
 * Populate a non-active document file with content.
 * Writes directly to disk without touching the active singleton.
 * Returns { title, wordCount, pendingCount } for the response message.
 */
/** Count pending nodes in a document tree. */
export function countPending(nodes: any[]): number {
  let count = 0;
  if (!nodes) return 0;
  for (const node of nodes) {
    if (node.attrs?.pendingStatus) count++;
    if (node.content) count += countPending(node.content);
  }
  return count;
}

/** Write a mutated doc back to disk and update the pending cache. */
function flushDocToFile(filename: string, doc: PadDocument, title: string, metadata: Record<string, any>): void {
  const targetPath = resolveDocPath(filename);
  const markdown = tiptapToMarkdown(doc, title, metadata);
  atomicWriteFileSync(targetPath, markdown);
  setPendingCacheEntry(filename, countPending(doc.content));
}

export function populateDocumentFile(filename: string, doc: PadDocument): { title: string; wordCount: number; pendingCount: number } {
  const targetPath = resolveDocPath(filename);
  const raw = readFileSync(targetPath, 'utf-8');
  const parsed = markdownToTiptap(raw);

  // Skip pending tagging when the target doc effectively has autoAccept on —
  // content commits directly as accepted.
  if (!isAutoAcceptActive(filename, parsed.metadata)) {
    markAllNodesAsPending(doc, 'insert');
  }
  flushDocToFile(filename, doc, parsed.title, parsed.metadata);

  const pendingCount = countPending(doc.content);
  const text = extractText(doc.content);
  const wordCount = text.trim() ? text.trim().split(/\s+/).length : 0;

  return { title: parsed.title, wordCount, pendingCount };
}

/**
 * Apply node changes to a non-active document file on disk.
 * Same logic as applyChanges but without touching the active singleton or broadcasting to browser.
 */
export function applyChangesToFile(filename: string, changes: NodeChange[]): { count: number; lastNodeId: string | null } {
  const targetPath = resolveDocPath(filename);

  // Try cache first — preserves stable node IDs
  const cached = getCachedDocument(targetPath);
  let doc: PadDocument;
  let title: string;
  let metadata: Record<string, any>;
  let docId: string;
  let isTemp: boolean;

  if (cached) {
    doc = structuredClone(cached.document);
    title = cached.title;
    metadata = cached.metadata;
    docId = cached.docId;
    isTemp = cached.isTemp;
  } else {
    const raw = readFileSync(targetPath, 'utf-8');
    const parsed = markdownToTiptap(raw);
    doc = parsed.document;
    title = parsed.title;
    metadata = parsed.metadata;
    docId = metadata.docId || '';
    isTemp = false;
  }

  const autoAccept = isAutoAcceptActive(filename, metadata);
  const processed = applyChangesToDoc(doc, changes, autoAccept);
  if (processed.length > 0) {
    flushDocToFile(filename, doc, title, metadata);
    updateCacheEntry(targetPath, doc, title, metadata, isTemp, docId);
  }

  // Find the last created node ID for chaining inserts
  let lastNodeId: string | null = null;
  for (let i = processed.length - 1; i >= 0; i--) {
    const change = processed[i];
    if (change.content) {
      const contentArr = Array.isArray(change.content) ? change.content : [change.content];
      const lastNode = contentArr[contentArr.length - 1];
      if (lastNode?.attrs?.id) {
        lastNodeId = lastNode.attrs.id;
        break;
      }
    }
  }

  return { count: processed.length, lastNodeId };
}

/**
 * Apply fine-grained text edits to a node in a non-active document file on disk.
 */
export function applyTextEditsToFile(filename: string, nodeId: string, edits: TextEdit[]): { success: boolean; error?: string } {
  const targetPath = resolveDocPath(filename);

  // Try cache first — preserves stable node IDs
  const cached = getCachedDocument(targetPath);
  let doc: PadDocument;
  let title: string;
  let metadata: Record<string, any>;
  let docId: string;
  let isTemp: boolean;

  if (cached) {
    doc = structuredClone(cached.document);
    title = cached.title;
    metadata = cached.metadata;
    docId = cached.docId;
    isTemp = cached.isTemp;
  } else {
    const raw = readFileSync(targetPath, 'utf-8');
    const parsed = markdownToTiptap(raw);
    doc = parsed.document;
    title = parsed.title;
    metadata = parsed.metadata;
    docId = metadata.docId || '';
    isTemp = false;
  }

  const found = findNode(doc.content, nodeId, doc.content);
  if (!found) return { success: false, error: `Node ${nodeId} not found` };

  const originalNode = found.parent[found.index];
  const result = applyTextEditsToNode(originalNode, edits);
  if (!result) return { success: false, error: 'No edits matched' };

  const autoAccept = isAutoAcceptActive(filename, metadata);
  // pendingTextEdits is the fine-grained inline-edit decoration — skip in autoAccept
  // since the change commits directly.
  if (!autoAccept) {
    result.node.attrs = {
      ...result.node.attrs,
      pendingTextEdits: result.textEdits,
    };
  }

  // Apply as a rewrite to the doc
  const processed = applyChangesToDoc(doc, [{
    operation: 'rewrite',
    nodeId,
    content: result.node,
  }], autoAccept);

  if (processed.length > 0) {
    flushDocToFile(filename, doc, title, metadata);
    updateCacheEntry(targetPath, doc, title, metadata, isTemp, docId);
  }

  return { success: true };
}
