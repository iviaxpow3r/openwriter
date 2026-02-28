/**
 * Multi-document operations for OpenWriter workspace.
 * Manages listing, switching, creating, deleting documents.
 * Each document is a .md file in ~/.openwriter/.
 */

import { existsSync, readFileSync, writeFileSync, readdirSync, statSync, mkdirSync } from 'fs';
import { join } from 'path';
import matter from 'gray-matter';
import trash from 'trash';
import { tiptapToMarkdown, markdownToTiptap } from './markdown.js';
import { parseMarkdownContent } from './compact.js';
import {
  getDocument, getTitle, getFilePath, save, cancelDebouncedSave, setActiveDocument,
  registerExternalDoc, unregisterExternalDoc, getExternalDocs,
  type PadDocument, type DocumentInfo,
} from './state.js';
import { DATA_DIR, TEMP_PREFIX, ensureDataDir, filePathForTitle, tempFilePath, generateNodeId, resolveDocPath, isExternalDoc, atomicWriteFileSync } from './helpers.js';
import { ensureDocId } from './versions.js';

const DOC_ORDER_FILE = join(DATA_DIR, '_doc-order.json');

function readDocOrder(): string[] {
  try {
    if (!existsSync(DOC_ORDER_FILE)) return [];
    return JSON.parse(readFileSync(DOC_ORDER_FILE, 'utf-8'));
  } catch { return []; }
}

function writeDocOrder(order: string[]): void {
  ensureDataDir();
  writeFileSync(DOC_ORDER_FILE, JSON.stringify(order, null, 2), 'utf-8');
}

export function reorderDocs(orderedFilenames: string[]): void {
  writeDocOrder(orderedFilenames);
}

export function listDocuments(): DocumentInfo[] {
  ensureDataDir();
  const currentPath = getFilePath();
  const files = readdirSync(DATA_DIR)
    .filter((f) => f.endsWith('.md'))
    .map((f) => {
      const fullPath = join(DATA_DIR, f);
      try {
        const stat = statSync(fullPath);
        const raw = readFileSync(fullPath, 'utf-8');

        // Use gray-matter directly — skip full TipTap parse for listing
        const { data, content } = matter(raw);
        const title = (data.title as string) || 'Untitled';

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
        };
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
      const title = (data.title as string) || 'Untitled';
      const trimmed = content.trim();
      const wordCount = trimmed ? trimmed.split(/\s+/).length : 0;

      files.push({
        filename: extPath, // Full path as identifier
        title,
        path: extPath,
        lastModified: stat.mtime.toISOString(),
        wordCount,
        isActive: extPath === currentPath,
      });
    } catch { /* skip unreadable external files */ }
  }

  // Sort by persisted order; docs not in manifest prepend (newest first by mtime)
  const order = readDocOrder();
  if (order.length > 0) {
    const orderIndex = new Map(order.map((f, i) => [f, i]));
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
  }

  return files;
}

export function switchDocument(filename: string): { document: PadDocument; title: string; filename: string } {
  // Cancel any pending debounced save, then save current doc immediately.
  cancelDebouncedSave();
  save();

  // Read target from disk — markdownToTiptap rehydrates pending state
  const targetPath = resolveDocPath(filename);
  if (!existsSync(targetPath)) {
    throw new Error(`Document not found: ${filename}`);
  }

  // Register external docs so they appear in listings
  if (isExternalDoc(filename)) {
    registerExternalDoc(targetPath);
  }

  const raw = readFileSync(targetPath, 'utf-8');
  const parsed = markdownToTiptap(raw);
  const mtime = new Date(statSync(targetPath).mtimeMs);

  // Ensure docId exists on loaded doc metadata (lazy migration)
  ensureDocId(parsed.metadata);

  const baseName = targetPath.split(/[/\\]/).pop() || '';
  setActiveDocument(parsed.document, parsed.title, targetPath, baseName.startsWith(TEMP_PREFIX), mtime, parsed.metadata);
  return { document: getDocument(), title: getTitle(), filename };
}

export function createDocument(title?: string, content?: string | PadDocument, path?: string): { document: PadDocument; title: string; filename: string } {
  // Cancel any pending debounced save, then save current doc immediately
  cancelDebouncedSave();
  save();

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
    newDoc = { type: 'doc', content: [{ type: 'paragraph', content: [] }] };
  }

  const metadata: Record<string, any> = { title: docTitle, docId: generateNodeId() };
  setActiveDocument(newDoc, docTitle, filePath, isTemp, undefined, metadata);

  // Write doc to disk
  const markdown = tiptapToMarkdown(newDoc, docTitle, metadata);
  ensureDataDir();
  atomicWriteFileSync(filePath, markdown);

  // Prepend to doc order so new docs appear at top
  const order = readDocOrder();
  order.unshift(filename);
  writeDocOrder(order);

  return { document: getDocument(), title: getTitle(), filename };
}

export async function deleteDocument(filename: string): Promise<{ switched: boolean; newDoc?: { document: PadDocument; title: string; filename: string } }> {
  ensureDataDir();
  const targetPath = resolveDocPath(filename);

  // Unregister if external
  if (isExternalDoc(filename)) {
    unregisterExternalDoc(targetPath);
  }

  const allDocs = readdirSync(DATA_DIR).filter((f) => f.endsWith('.md'));
  if (allDocs.length <= 1) {
    throw new Error('Cannot delete the only document');
  }

  const isDeletingActive = targetPath === getFilePath();

  if (existsSync(targetPath)) {
    await trash(targetPath);
  }

  // Remove from doc order
  const order = readDocOrder();
  const orderIdx = order.indexOf(filename);
  if (orderIdx >= 0) { order.splice(orderIdx, 1); writeDocOrder(order); }

  if (isDeletingActive) {
    const remaining = readdirSync(DATA_DIR)
      .filter((f) => f.endsWith('.md'))
      .map((f) => ({ name: f, path: join(DATA_DIR, f), mtime: statSync(join(DATA_DIR, f)).mtimeMs }))
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

  // Register as external if not in DATA_DIR
  if (isExternalDoc(fullPath)) {
    registerExternalDoc(fullPath);
  }

  const raw = readFileSync(fullPath, 'utf-8');
  const parsed = markdownToTiptap(raw);
  const mtime = new Date(statSync(fullPath).mtimeMs);

  ensureDocId(parsed.metadata);

  const baseName = fullPath.split(/[/\\]/).pop() || '';
  setActiveDocument(parsed.document, parsed.title, fullPath, baseName.startsWith(TEMP_PREFIX), mtime, parsed.metadata);

  // Use full path as filename for external docs, basename for DATA_DIR docs
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
