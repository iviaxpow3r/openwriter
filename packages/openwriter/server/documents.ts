/**
 * Multi-document operations for OpenWriter workspace.
 * Manages listing, switching, creating, deleting documents.
 * Each document is a .md file in ~/.openwriter/.
 */

import { existsSync, readFileSync, writeFileSync, readdirSync, statSync, mkdirSync, renameSync } from 'fs';
import { join } from 'path';
import matter from 'gray-matter';
import trash from 'trash';
import { tiptapToMarkdown, markdownToTiptap } from './markdown.js';
import { parseMarkdownContent } from './compact.js';
import {
  getDocument, getTitle, getFilePath, getIsTemp, getMetadata, save, cancelDebouncedSave, setActiveDocument,
  registerExternalDoc, unregisterExternalDoc, getExternalDocs,
  cacheActiveDocument, getCachedDocument, invalidateDocCache, removePendingCacheEntry, setPendingCacheEntry,
  resetDocVersion,
  type PadDocument, type DocumentInfo,
} from './state.js';
import { getDataDir, TEMP_PREFIX, ensureDataDir, filePathForTitle, tempFilePath, generateNodeId, resolveDocPath, isExternalDoc, atomicWriteFileSync } from './helpers.js';
import { ensureDocId } from './versions.js';
import { renameDocInAllWorkspaces, removeDocFromAllWorkspaces } from './workspaces.js';
import { renameMark } from './marks.js';

import { getDocId as getActiveDocId } from './state.js';

function getDocOrderFile(): string { return join(getDataDir(), '_doc-order.json'); }

/** Scan files for matching docId. Checks active doc first (free), then getDataDir(), then external docs. */
export function filenameByDocId(docId: string): string | null {
  // Fast path: check active document (no disk read)
  if (getActiveDocId() === docId) {
    return getActiveFilename();
  }

  // Scan getDataDir() files
  ensureDataDir();
  for (const f of readdirSync(getDataDir()).filter(f => f.endsWith('.md'))) {
    try {
      const raw = readFileSync(join(getDataDir(), f), 'utf-8');
      const { data } = matter(raw);
      if (data.docId === docId) return f;
    } catch { /* skip */ }
  }

  // Scan external docs
  for (const extPath of getExternalDocs()) {
    try {
      if (!existsSync(extPath)) continue;
      const raw = readFileSync(extPath, 'utf-8');
      const { data } = matter(raw);
      if (data.docId === docId) return extPath;
    } catch { /* skip */ }
  }

  return null;
}

/** Resolve docId to filename. Throws if not found. */
export function resolveDocId(docId: string): string {
  const filename = filenameByDocId(docId);
  if (!filename) throw new Error(`Document not found for docId: ${docId}`);
  return filename;
}

function readDocOrder(): string[] {
  try {
    if (!existsSync(getDocOrderFile())) return [];
    return JSON.parse(readFileSync(getDocOrderFile(), 'utf-8'));
  } catch { return []; }
}

function writeDocOrder(order: string[]): void {
  ensureDataDir();
  writeFileSync(getDocOrderFile(), JSON.stringify(order, null, 2), 'utf-8');
}

export function reorderDocs(orderedFilenames: string[]): void {
  writeDocOrder(orderedFilenames);
}

/** Derive content_type from frontmatter — explicit field first, then fallback from context keys. */
function deriveContentType(data: Record<string, any>): string | undefined {
  if (data.content_type) return data.content_type as string;
  if (data.tweetContext) return data.tweetContext.mode || 'tweet';
  if (data.articleContext) return 'article';
  if (data.linkedinContext) return 'linkedin';
  if (data.newsletterContext) return 'newsletter';
  if (data.blogContext) return 'blog';
  return undefined;
}

export function listDocuments(): DocumentInfo[] {
  ensureDataDir();
  const currentPath = getFilePath();
  const files = readdirSync(getDataDir())
    .filter((f) => f.endsWith('.md'))
    .map((f) => {
      const fullPath = join(getDataDir(), f);
      try {
        const stat = statSync(fullPath);
        const raw = readFileSync(fullPath, 'utf-8');

        // Use gray-matter directly — skip full TipTap parse for listing
        const { data, content } = matter(raw);
        const title = (data.title as string) || 'Untitled';

        // Skip archived docs
        if (data.archivedAt) return null;

        // Skip empty temp files (not the active doc)
        const trimmed = content.trim();
        if (f.startsWith(TEMP_PREFIX) && !trimmed && fullPath !== currentPath) return null;

        const wordCount = trimmed ? trimmed.split(/\s+/).length : 0;

        return {
          filename: f,
          title,
          path: fullPath,
          lastModified: stat.mtime.toISOString(),
          wordCount,
          isActive: fullPath === currentPath,
          ...(data.docId ? { docId: data.docId as string } : {}),
          ...(data.newsletterContext?.lastSend?.sentAt ? { lastSent: data.newsletterContext.lastSend.sentAt } : data.tweetContext?.lastPost?.postedAt ? { lastSent: data.tweetContext.lastPost.postedAt } : data.blogContext?.lastPublish?.publishedAt ? { lastSent: data.blogContext.lastPublish.publishedAt } : data.articleContext?.lastPost?.postedAt ? { lastSent: data.articleContext.lastPost.postedAt } : data.manualPost?.postedAt ? { lastSent: data.manualPost.postedAt } : {}),
          ...(data.tweetContext?.lastPost?.tweetUrl ? { postedUrl: data.tweetContext.lastPost.tweetUrl } : {}),
          ...(data.newsletterContext ? { isNewsletter: true } : {}),
          ...(deriveContentType(data) ? { contentType: deriveContentType(data) } : {}),
        } as DocumentInfo;
      } catch {
        return null;
      }
    })
    .filter((f): f is DocumentInfo => f !== null);

  // Append registered external docs
  for (const extPath of getExternalDocs()) {
    try {
      if (!existsSync(extPath)) {
        unregisterExternalDoc(extPath); // Clean up stale registry entries
        continue;
      }
      const stat = statSync(extPath);
      const raw = readFileSync(extPath, 'utf-8');
      const { data, content } = matter(raw);
      let title = (data.title as string) || 'Untitled';
      // Title fallback: use filename stem for external files without a title
      if (title === 'Untitled') {
        const stem = extPath.split(/[/\\]/).pop()?.replace(/\.md$/i, '');
        if (stem) title = stem;
      }
      const trimmed = content.trim();
      const wordCount = trimmed ? trimmed.split(/\s+/).length : 0;

      files.push({
        filename: extPath, // Full path as identifier
        title,
        path: extPath,
        lastModified: stat.mtime.toISOString(),
        wordCount,
        isActive: extPath === currentPath,
        ...(data.docId ? { docId: data.docId as string } : {}),
        ...(data.newsletterContext?.lastSend?.sentAt ? { lastSent: data.newsletterContext.lastSend.sentAt } : data.tweetContext?.lastPost?.postedAt ? { lastSent: data.tweetContext.lastPost.postedAt } : data.blogContext?.lastPublish?.publishedAt ? { lastSent: data.blogContext.lastPublish.publishedAt } : {}),
        ...(data.tweetContext?.lastPost?.tweetUrl ? { postedUrl: data.tweetContext.lastPost.tweetUrl } : {}),
        ...(data.newsletterContext ? { isNewsletter: true } : {}),
        ...(deriveContentType(data) ? { contentType: deriveContentType(data) } : {}),
      });
    } catch { /* skip unreadable external files */ }
  }

  // Sort by persisted order; docs not in manifest prepend (newest first by mtime)
  const order = readDocOrder();
  if (order.length > 0) {
    const orderIndex = new Map(order.map((f, i) => [f, i]));
    const hasUnknown = files.some(f => !orderIndex.has(f.filename));
    files.sort((a, b) => {
      const ai = orderIndex.get(a.filename) ?? -1;
      const bi = orderIndex.get(b.filename) ?? -1;
      // Both unknown → newest first by mtime
      if (ai === -1 && bi === -1) return new Date(b.lastModified).getTime() - new Date(a.lastModified).getTime();
      // Unknown docs sort before known (prepend)
      if (ai === -1) return -1;
      if (bi === -1) return 1;
      return ai - bi;
    });
    // Absorb unknown docs into manifest so they stay put after edits
    if (hasUnknown) {
      writeDocOrder(files.map(f => f.filename));
    }
  } else {
    // No manifest yet — create one from current mtime order so all docs are tracked
    writeDocOrder(files.map(f => f.filename));
  }

  return files;
}

// ============================================================================
// ARCHIVE
// ============================================================================

export function listArchivedDocuments(): DocumentInfo[] {
  ensureDataDir();
  const files = readdirSync(getDataDir())
    .filter((f) => f.endsWith('.md'))
    .map((f) => {
      const fullPath = join(getDataDir(), f);
      try {
        const stat = statSync(fullPath);
        const raw = readFileSync(fullPath, 'utf-8');
        const { data, content } = matter(raw);
        if (!data.archivedAt) return null;
        const title = (data.title as string) || 'Untitled';
        const trimmed = content.trim();
        const wordCount = trimmed ? trimmed.split(/\s+/).length : 0;
        return {
          filename: f,
          title,
          path: fullPath,
          lastModified: stat.mtime.toISOString(),
          wordCount,
          isActive: false,
          ...(data.docId ? { docId: data.docId as string } : {}),
          archivedAt: data.archivedAt as string,
        } as DocumentInfo & { archivedAt: string };
      } catch { return null; }
    })
    .filter((f): f is DocumentInfo & { archivedAt: string } => f !== null);

  // Sort by archivedAt desc (most recently archived first)
  files.sort((a, b) => new Date(b.archivedAt).getTime() - new Date(a.archivedAt).getTime());
  return files;
}

export function archiveDocument(filename: string): { switched: boolean; newDoc?: { document: PadDocument; title: string; filename: string } } {
  ensureDataDir();
  const targetPath = resolveDocPath(filename);
  if (!existsSync(targetPath)) {
    throw new Error(`Document not found: ${filename}`);
  }

  const raw = readFileSync(targetPath, 'utf-8');
  const { data, content } = matter(raw);
  data.archivedAt = new Date().toISOString();
  atomicWriteFileSync(targetPath, matter.stringify(content, data));

  // Remove from workspaces
  removeDocFromAllWorkspaces(filename);

  // Invalidate cache
  invalidateDocCache(targetPath);

  const isArchivingActive = targetPath === getFilePath();
  if (isArchivingActive) {
    // Switch to most recent remaining doc
    const remaining = readdirSync(getDataDir())
      .filter((f) => f.endsWith('.md') && f !== filename)
      .map((f) => {
        const fullPath = join(getDataDir(), f);
        try {
          const stat = statSync(fullPath);
          const raw = readFileSync(fullPath, 'utf-8');
          const { data } = matter(raw);
          if (data.archivedAt) return null;
          return { name: f, path: fullPath, mtime: stat.mtimeMs };
        } catch { return null; }
      })
      .filter((f): f is { name: string; path: string; mtime: number } => f !== null)
      .sort((a, b) => b.mtime - a.mtime);

    if (remaining.length > 0) {
      const next = remaining[0];
      const raw = readFileSync(next.path, 'utf-8');
      const parsed = markdownToTiptap(raw);
      setActiveDocument(parsed.document, parsed.title, next.path, next.name.startsWith(TEMP_PREFIX), new Date(next.mtime), parsed.metadata);
      return { switched: true, newDoc: { document: getDocument(), title: getTitle(), filename: next.name } };
    }
  }

  return { switched: false };
}

export function unarchiveDocument(filename: string): { filename: string; title: string } {
  ensureDataDir();
  const targetPath = resolveDocPath(filename);
  if (!existsSync(targetPath)) {
    throw new Error(`Document not found: ${filename}`);
  }

  const raw = readFileSync(targetPath, 'utf-8');
  const { data, content } = matter(raw);
  delete data.archivedAt;
  atomicWriteFileSync(targetPath, matter.stringify(content, data));

  return { filename, title: (data.title as string) || 'Untitled' };
}

// ============================================================================
// SEARCH
// ============================================================================

export interface SearchResult {
  filename: string;
  title: string;
  lastModified: string;
  wordCount: number;
  isActive: boolean;
  matchType: 'title' | 'tag' | 'content';
  snippet: string | null;
  matchedTag: string | null;
  isArchived?: boolean;
}

export function searchDocuments(query: string, includeArchived = false): SearchResult[] {
  if (!query || !query.trim()) return [];
  const q = query.trim().toLowerCase();
  const currentPath = getFilePath();

  // Collect all files (same pattern as listDocuments)
  ensureDataDir();
  const allFiles: { filename: string; path: string; raw: string; mtime: Date }[] = [];

  for (const f of readdirSync(getDataDir()).filter(f => f.endsWith('.md'))) {
    try {
      const fullPath = join(getDataDir(), f);
      const mtime = statSync(fullPath).mtime;
      const raw = readFileSync(fullPath, 'utf-8');
      allFiles.push({ filename: f, path: fullPath, raw, mtime });
    } catch { /* skip */ }
  }

  for (const extPath of getExternalDocs()) {
    try {
      if (!existsSync(extPath)) { unregisterExternalDoc(extPath); continue; }
      const mtime = statSync(extPath).mtime;
      const raw = readFileSync(extPath, 'utf-8');
      allFiles.push({ filename: extPath, path: extPath, raw, mtime });
    } catch { /* skip */ }
  }

  const results: SearchResult[] = [];

  for (const file of allFiles) {
    const { data, content } = matter(file.raw);
    const title = (data.title as string) || 'Untitled';
    const trimmed = content.trim();
    const isArchived = !!data.archivedAt;

    // Skip archived unless requested
    if (isArchived && !includeArchived) continue;

    // Skip empty temp files (not active)
    if (file.filename.startsWith(TEMP_PREFIX) && !trimmed && file.path !== currentPath) continue;

    const wordCount = trimmed ? trimmed.split(/\s+/).length : 0;
    const isActive = file.path === currentPath;
    const tags: string[] = Array.isArray(data.tags) ? data.tags : [];

    const base = { filename: file.filename, title, lastModified: file.mtime.toISOString(), wordCount, isActive, isArchived };

    // Title match
    if (title.toLowerCase().includes(q)) {
      results.push({ ...base, matchType: 'title', snippet: null, matchedTag: null });
      continue; // Only best match type per doc
    }

    // Tag match
    const matchedTag = tags.find(t => t.toLowerCase().includes(q));
    if (matchedTag) {
      results.push({ ...base, matchType: 'tag', snippet: null, matchedTag });
      continue;
    }

    // Content match
    const lowerContent = content.toLowerCase();
    const idx = lowerContent.indexOf(q);
    if (idx !== -1) {
      // ~80 char snippet around match
      const start = Math.max(0, idx - 30);
      const end = Math.min(content.length, idx + q.length + 50);
      let snippet = content.slice(start, end).replace(/\n/g, ' ').trim();
      if (start > 0) snippet = '...' + snippet;
      if (end < content.length) snippet = snippet + '...';
      results.push({ ...base, matchType: 'content', snippet, matchedTag: null });
    }
  }

  // Sort: active first, then title > tag > content, within each group by mtime desc
  // Archived results sort after active results
  const typeOrder = { title: 0, tag: 1, content: 2 };
  results.sort((a, b) => {
    // Archived always after active
    if (a.isArchived !== b.isArchived) return a.isArchived ? 1 : -1;
    const typeDiff = typeOrder[a.matchType] - typeOrder[b.matchType];
    if (typeDiff !== 0) return typeDiff;
    return new Date(b.lastModified).getTime() - new Date(a.lastModified).getTime();
  });

  return results;
}

export function switchDocument(filename: string): { document: PadDocument; title: string; filename: string } {
  // No-op if already on this document — avoids save/reload cycle that can clear editor content
  if (filename === getActiveFilename()) {
    return { document: getDocument(), title: getTitle(), filename };
  }

  // Cancel any pending debounced save, then save current doc immediately.
  cancelDebouncedSave();
  save();

  // Cache current doc before switching (preserves node IDs)
  cacheActiveDocument();

  // Reset version counter — new document starts a fresh version lineage
  resetDocVersion();

  // Read target from disk — markdownToTiptap rehydrates pending state
  const targetPath = resolveDocPath(filename);
  if (!existsSync(targetPath)) {
    throw new Error(`Document not found: ${filename}`);
  }

  // Register external docs so they appear in listings
  if (isExternalDoc(filename)) {
    registerExternalDoc(targetPath);
  }

  // Check cache first — preserves stable node IDs across switches
  const cached = getCachedDocument(targetPath);
  if (cached) {
    setActiveDocument(cached.document, cached.title, targetPath, cached.isTemp, cached.lastModified, cached.metadata, cached.originalFrontmatter);
    return { document: getDocument(), title: getTitle(), filename };
  }

  const raw = readFileSync(targetPath, 'utf-8');
  const parsed = markdownToTiptap(raw);
  const mtime = new Date(statSync(targetPath).mtimeMs);

  // Ensure docId exists on loaded doc metadata (lazy migration)
  ensureDocId(parsed.metadata);

  const baseName = targetPath.split(/[/\\]/).pop() || '';
  setActiveDocument(parsed.document, parsed.title, targetPath, baseName.startsWith(TEMP_PREFIX), mtime, parsed.metadata, parsed.rawFrontmatter);
  return { document: getDocument(), title: getTitle(), filename };
}

export function createDocument(title?: string, content?: string | PadDocument, path?: string): { document: PadDocument; title: string; filename: string } {
  // Cancel any pending debounced save, then save current doc immediately
  cancelDebouncedSave();
  save();

  // Cache current doc before switching to new one
  cacheActiveDocument();

  const docTitle = title || 'Untitled';
  let filePath: string;
  let isTemp: boolean;
  let filename: string;

  if (path) {
    // External path — create file at the specified location
    filePath = path;
    isTemp = false;
    filename = path; // Full path as identifier for external docs
    registerExternalDoc(path);
    // Ensure parent directory exists
    const dir = filePath.substring(0, Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\')));
    if (dir && !existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  } else {
    isTemp = !title;
    if (isTemp) {
      filePath = tempFilePath();
    } else {
      filePath = filePathForTitle(docTitle);
      // Deduplicate: append counter if file already exists
      if (existsSync(filePath)) {
        let counter = 2;
        while (existsSync(filePathForTitle(`${docTitle} ${counter}`))) counter++;
        filePath = filePathForTitle(`${docTitle} ${counter}`);
      }
    }
    filename = filePath.split(/[/\\]/).pop()!;
  }

  let newDoc: PadDocument;
  if (content) {
    if (typeof content === 'string') {
      // Markdown string → TipTap JSON
      newDoc = { type: 'doc', content: parseMarkdownContent(content) };
    } else {
      // Already TipTap JSON
      newDoc = content;
    }
  } else {
    newDoc = { type: 'doc', content: [{ type: 'paragraph', attrs: { id: generateNodeId() }, content: [] }] };
  }

  const metadata: Record<string, any> = { title: docTitle, docId: generateNodeId() };
  setActiveDocument(newDoc, docTitle, filePath, isTemp, undefined, metadata);

  // Write doc to disk
  const markdown = tiptapToMarkdown(newDoc, docTitle, metadata);
  ensureDataDir();
  atomicWriteFileSync(filePath, markdown);

  // Prepend to doc order so new docs appear at top and stay put after edits
  const order = readDocOrder();
  const fn = filePath.split(/[/\\]/).pop()!;
  if (!order.includes(fn)) {
    order.unshift(fn);
    writeDocOrder(order);
  }

  return { document: getDocument(), title: getTitle(), filename };
}

/**
 * Create a new document file on disk WITHOUT switching the active document.
 * Used by the two-step creation flow (create_document → populate_document)
 * so the user's editor isn't hijacked during agent content generation.
 * The file is written with agentCreated: true in frontmatter.
 */
export function createDocumentFile(title?: string, path?: string, extraMeta?: Record<string, any>): { filename: string; docId: string; title: string } {
  const docTitle = title || 'Untitled';
  let filePath: string;
  let filename: string;

  if (path) {
    filePath = path;
    filename = path;
    registerExternalDoc(path);
    const dir = filePath.substring(0, Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\')));
    if (dir && !existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  } else {
    if (!title) {
      filePath = tempFilePath();
    } else {
      filePath = filePathForTitle(docTitle);
      if (existsSync(filePath)) {
        let counter = 2;
        while (existsSync(filePathForTitle(`${docTitle} ${counter}`))) counter++;
        filePath = filePathForTitle(`${docTitle} ${counter}`);
      }
    }
    filename = filePath.split(/[/\\]/).pop()!;
  }

  const newDoc: PadDocument = { type: 'doc', content: [{ type: 'paragraph', attrs: { id: generateNodeId() }, content: [] }] };
  const metadata: Record<string, any> = { title: docTitle, docId: generateNodeId(), agentCreated: true, ...extraMeta };

  const markdown = tiptapToMarkdown(newDoc, docTitle, metadata);
  ensureDataDir();
  atomicWriteFileSync(filePath, markdown);

  // Prepend to doc order so new docs appear at top and stay put after edits
  const order = readDocOrder();
  const fn = filePath.split(/[/\\]/).pop()!;
  if (!order.includes(fn)) {
    order.unshift(fn);
    writeDocOrder(order);
  }

  return { filename, docId: metadata.docId, title: docTitle };
}

export async function deleteDocument(filename: string): Promise<{ switched: boolean; newDoc?: { document: PadDocument; title: string; filename: string } }> {
  ensureDataDir();
  const targetPath = resolveDocPath(filename);

  // Invalidate cache for deleted doc
  invalidateDocCache(targetPath);

  // Unregister if external
  if (isExternalDoc(filename)) {
    unregisterExternalDoc(targetPath);
  }

  const allDocs = readdirSync(getDataDir()).filter((f) => f.endsWith('.md'));
  if (allDocs.length <= 1) {
    throw new Error('Cannot delete the only document');
  }

  const isDeletingActive = targetPath === getFilePath();

  if (!isExternalDoc(filename) && existsSync(targetPath)) {
    await trash(targetPath);
  }

  if (isDeletingActive) {
    const remaining = readdirSync(getDataDir())
      .filter((f) => f.endsWith('.md'))
      .map((f) => ({ name: f, path: join(getDataDir(), f), mtime: statSync(join(getDataDir(), f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);

    if (remaining.length > 0) {
      const next = remaining[0];
      const raw = readFileSync(next.path, 'utf-8');
      const parsed = markdownToTiptap(raw);
      setActiveDocument(parsed.document, parsed.title, next.path, next.name.startsWith(TEMP_PREFIX), new Date(next.mtime), parsed.metadata);
      return { switched: true, newDoc: { document: getDocument(), title: getTitle(), filename: next.name } };
    }
  }

  return { switched: false };
}

export function reloadDocument(): { document: PadDocument; title: string; filename: string } {
  const filePath = getFilePath();
  if (!existsSync(filePath)) {
    throw new Error('Active document file not found on disk');
  }

  // Force fresh parse — invalidate any cached version
  invalidateDocCache(filePath);
  const filename = filePath.split(/[/\\]/).pop()!;
  const raw = readFileSync(filePath, 'utf-8');
  const parsed = markdownToTiptap(raw);
  const mtime = new Date(statSync(filePath).mtimeMs);

  setActiveDocument(parsed.document, parsed.title, filePath, filename.startsWith(TEMP_PREFIX), mtime, parsed.metadata);
  return { document: getDocument(), title: getTitle(), filename };
}

export function updateDocumentTitle(filename: string, newTitle: string): void {
  ensureDataDir();
  const filePath = resolveDocPath(filename);
  if (!existsSync(filePath)) {
    throw new Error(`Document not found: ${filename}`);
  }

  const raw = readFileSync(filePath, 'utf-8');
  const parsed = markdownToTiptap(raw);
  const metadata = { ...parsed.metadata, title: newTitle };
  const markdown = tiptapToMarkdown(parsed.document, newTitle, metadata);
  atomicWriteFileSync(filePath, markdown);

  // Update state if this is the active document
  const baseName = filePath.split(/[/\\]/).pop() || '';
  if (getFilePath() === filePath) {
    setActiveDocument(getDocument(), newTitle, filePath, baseName.startsWith(TEMP_PREFIX), undefined, metadata);
  }
}

/** Open an existing file from any path. Saves current doc, registers as external, sets as active. */
export function openFile(fullPath: string): { document: PadDocument; title: string; filename: string } {
  if (!existsSync(fullPath)) {
    throw new Error(`File not found: ${fullPath}`);
  }

  // Cancel any pending debounced save, then save current doc immediately
  cancelDebouncedSave();
  save();

  // Cache current doc before switching
  cacheActiveDocument();

  // Register as external if not in getDataDir()
  if (isExternalDoc(fullPath)) {
    registerExternalDoc(fullPath);
  }

  // Check cache first — preserves stable node IDs
  const cached = getCachedDocument(fullPath);
  if (cached) {
    setActiveDocument(cached.document, cached.title, fullPath, cached.isTemp, cached.lastModified, cached.metadata, cached.originalFrontmatter);
    const filename = isExternalDoc(fullPath) ? fullPath : (fullPath.split(/[/\\]/).pop() || '');
    return { document: getDocument(), title: getTitle(), filename };
  }

  const raw = readFileSync(fullPath, 'utf-8');
  const parsed = markdownToTiptap(raw);
  const mtime = new Date(statSync(fullPath).mtimeMs);

  ensureDocId(parsed.metadata);

  // Title fallback: use filename stem instead of "Untitled" for files without a title
  let title = parsed.title;
  if (title === 'Untitled') {
    const stem = fullPath.split(/[/\\]/).pop()?.replace(/\.md$/i, '');
    if (stem) title = stem;
  }

  const baseName = fullPath.split(/[/\\]/).pop() || '';
  setActiveDocument(parsed.document, title, fullPath, baseName.startsWith(TEMP_PREFIX), mtime, parsed.metadata, parsed.rawFrontmatter);

  // Use full path as filename for external docs, basename for getDataDir() docs
  const filename = isExternalDoc(fullPath) ? fullPath : baseName;
  return { document: getDocument(), title: getTitle(), filename };
}

export function duplicateDocument(filename: string): { document: PadDocument; title: string; filename: string } {
  // Cancel any pending debounced save, then save current doc immediately
  cancelDebouncedSave();
  save();

  const sourcePath = resolveDocPath(filename);
  if (!existsSync(sourcePath)) {
    throw new Error(`Document not found: ${filename}`);
  }

  const raw = readFileSync(sourcePath, 'utf-8');
  const parsed = markdownToTiptap(raw);

  // Generate deduplicated title
  let newTitle = `${parsed.title} (Copy)`;
  let filePath = filePathForTitle(newTitle);
  if (existsSync(filePath)) {
    let counter = 2;
    while (existsSync(filePathForTitle(`${parsed.title} (Copy ${counter})`))) counter++;
    newTitle = `${parsed.title} (Copy ${counter})`;
    filePath = filePathForTitle(newTitle);
  }

  const metadata: Record<string, any> = { ...parsed.metadata, title: newTitle, docId: generateNodeId() };
  setActiveDocument(parsed.document, newTitle, filePath, false, undefined, metadata);

  const markdown = tiptapToMarkdown(parsed.document, newTitle, metadata);
  ensureDataDir();
  atomicWriteFileSync(filePath, markdown);

  const newFilename = filePath.split(/[/\\]/).pop()!;
  return { document: getDocument(), title: getTitle(), filename: newFilename };
}

export function getActiveFilename(): string {
  const filePath = getFilePath();
  // For external docs, return the full path as the identifier
  if (isExternalDoc(filePath)) return filePath;
  return filePath.split(/[/\\]/).pop() || '';
}

/**
 * Promote a temp file (_untitled-xxx.md) to a named file when the title is set.
 * Renames the file on disk, updates state, workspace refs, marks sidecar, and caches.
 * Returns the new filename, or null if not applicable (not temp, or title is 'Untitled').
 */
export function promoteTempFile(newTitle: string): string | null {
  if (!getIsTemp() || !newTitle || newTitle === 'Untitled') return null;

  const oldPath = getFilePath();
  const oldFilename = oldPath.split(/[/\\]/).pop() || '';
  if (!oldFilename || !existsSync(oldPath)) return null;

  // Generate new path with dedup
  let newPath = filePathForTitle(newTitle);
  if (existsSync(newPath)) {
    let counter = 2;
    while (existsSync(filePathForTitle(`${newTitle} ${counter}`))) counter++;
    newPath = filePathForTitle(`${newTitle} ${counter}`);
  }
  const newFilename = newPath.split(/[/\\]/).pop()!;

  // Rename on disk
  renameSync(oldPath, newPath);

  // Update state
  setActiveDocument(getDocument(), newTitle, newPath, false, undefined, getMetadata());

  // Invalidate old caches
  removePendingCacheEntry(oldFilename);
  invalidateDocCache(oldPath);

  // Update workspace references
  renameDocInAllWorkspaces(oldFilename, newFilename, newTitle);

  // Rename marks sidecar
  renameMark(oldFilename, newFilename);

  return newFilename;
}

// ============================================================================
// BATCH RESOLVE — accept/reject pending changes across multiple docs
// ============================================================================

const PENDING_ATTRS = ['pendingStatus', 'pendingOriginalContent', 'pendingGroupId', 'pendingSelectionFrom', 'pendingSelectionTo', 'pendingOriginalFrom', 'pendingOriginalTo'];

function clearPendingAttrs(attrs: Record<string, any>): Record<string, any> {
  const clean = { ...attrs };
  for (const key of PENDING_ATTRS) delete clean[key];
  return clean;
}

/** Walk TipTap JSON, accept all pending changes in-place. Returns count of resolved nodes. */
function acceptAllInDoc(doc: any): number {
  let count = 0;
  function walk(nodes: any[]): any[] {
    const result: any[] = [];
    for (const node of nodes) {
      const status = node.attrs?.pendingStatus;
      if (status === 'delete') {
        count++;
        continue; // Remove delete nodes
      }
      if (status === 'insert' || status === 'rewrite') {
        node.attrs = clearPendingAttrs(node.attrs);
        count++;
      }
      if (node.content) {
        node.content = walk(node.content);
      }
      result.push(node);
    }
    return result;
  }
  if (doc.content) doc.content = walk(doc.content);
  return count;
}

/** Walk TipTap JSON, reject all pending changes in-place. Returns count of resolved nodes. */
function rejectAllInDoc(doc: any): number {
  let count = 0;
  function walk(nodes: any[]): any[] {
    const result: any[] = [];
    for (const node of nodes) {
      const status = node.attrs?.pendingStatus;
      if (status === 'insert') {
        count++;
        continue; // Remove inserted nodes
      }
      if (status === 'rewrite') {
        const original = node.attrs?.pendingOriginalContent;
        if (original) {
          // Replace with original content
          result.push(original);
        }
        // If no original, just drop the node
        count++;
        continue;
      }
      if (status === 'delete') {
        // Keep the node, just clear pending status
        node.attrs = clearPendingAttrs(node.attrs);
        count++;
      }
      if (node.content) {
        node.content = walk(node.content);
      }
      result.push(node);
    }
    return result;
  }
  if (doc.content) doc.content = walk(doc.content);
  return count;
}

/** Resolve a single doc file on disk. Returns number of changes resolved. */
function resolveDocFile(filePath: string, action: 'accept' | 'reject'): number {
  const raw = readFileSync(filePath, 'utf-8');
  const { data, content } = matter(raw);

  // Skip docs with no pending changes
  if (!data.pending) return 0;

  const doc = markdownToTiptap(content);
  // Hydrate pending state from frontmatter onto nodes (the parse does this automatically)

  const count = action === 'accept' ? acceptAllInDoc(doc) : rejectAllInDoc(doc);
  if (count === 0) return 0;

  // Re-serialize — pending attrs are cleared so pending key will be removed from frontmatter
  const metadata = { ...data };
  delete metadata.title;
  const newRaw = tiptapToMarkdown(doc, data.title || 'Untitled', metadata);
  atomicWriteFileSync(filePath, newRaw);

  return count;
}

export function batchResolve(filenames: string[], action: 'accept' | 'reject'): { docsResolved: number; changesResolved: number } {
  let docsResolved = 0;
  let changesResolved = 0;

  for (const filename of filenames) {
    const filePath = isExternalDoc(filename) ? filename : join(getDataDir(), filename);
    if (!existsSync(filePath)) continue;

    try {
      const count = resolveDocFile(filePath, action);
      if (count > 0) {
        docsResolved++;
        changesResolved += count;
        // If this is the active doc, reload it from disk
        if (filePath === getFilePath()) {
          reloadDocument();
        }
      }
    } catch { /* skip unreadable files */ }
  }

  return { docsResolved, changesResolved };
}
