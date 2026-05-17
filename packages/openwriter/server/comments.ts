/**
 * Comments: sidecar JSON storage for inline user feedback (formerly "agent marks").
 * Each document gets a sidecar file at DATA_DIR/_marks/{filename}.json.
 * Storage directory name `_marks/` is retained for backwards compatibility with
 * existing user data; the public vocabulary is "comment" everywhere else.
 */

import { join } from 'path';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, unlinkSync, renameSync } from 'fs';
import { randomUUID } from 'crypto';
import { getDataDir, ensureDataDir } from './helpers.js';

export interface Comment {
  id: string;
  text: string;
  note: string;
  nodeId: string;
  nodeIds?: string[];
  createdAt: string;
}

interface CommentFile {
  marks: Comment[];
}

function getCommentsDir(): string { return join(getDataDir(), '_marks'); }

function ensureCommentsDir(): void {
  ensureDataDir();
  if (!existsSync(getCommentsDir())) mkdirSync(getCommentsDir(), { recursive: true });
}

function commentFilePath(filename: string): string {
  const safe = filename.replace(/[/\\]/g, '_');
  return join(getCommentsDir(), `${safe}.json`);
}

function readCommentFile(filename: string): CommentFile {
  const path = commentFilePath(filename);
  if (!existsSync(path)) return { marks: [] };
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return { marks: [] };
  }
}

function writeCommentFile(filename: string, data: CommentFile): void {
  ensureCommentsDir();
  const path = commentFilePath(filename);
  if (data.marks.length === 0) {
    if (existsSync(path)) unlinkSync(path);
    return;
  }
  writeFileSync(path, JSON.stringify(data, null, 2));
}

export function addComment(filename: string, text: string, note: string, nodeId: string, nodeIds?: string[]): Comment {
  const data = readCommentFile(filename);
  const comment: Comment = {
    id: randomUUID().slice(0, 8),
    text,
    note,
    nodeId,
    ...(nodeIds && nodeIds.length > 1 ? { nodeIds } : {}),
    createdAt: new Date().toISOString(),
  };
  data.marks.push(comment);
  writeCommentFile(filename, data);
  return comment;
}

export function getComments(filename?: string): Record<string, Comment[]> {
  if (filename) {
    const data = readCommentFile(filename);
    if (data.marks.length === 0) return {};
    return { [filename]: data.marks };
  }

  ensureCommentsDir();
  const result: Record<string, Comment[]> = {};
  try {
    const files: string[] = readdirSync(getCommentsDir());
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const docFilename = file.replace(/\.json$/, '').replace(/_/g, ' ');
      const path = join(getCommentsDir(), file);
      try {
        const data: CommentFile = JSON.parse(readFileSync(path, 'utf-8'));
        if (data.marks.length > 0) result[docFilename] = data.marks;
      } catch { /* skip corrupt files */ }
    }
  } catch { /* dir doesn't exist yet */ }
  return result;
}

export function getCommentCount(filename: string): number {
  return readCommentFile(filename).marks.length;
}

/** Count comments across all documents, optionally excluding one filename. */
export function getGlobalCommentSummary(excludeFilename?: string): { totalComments: number; docCount: number } {
  ensureCommentsDir();
  let totalComments = 0;
  let docCount = 0;
  try {
    const files: string[] = readdirSync(getCommentsDir());
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      if (excludeFilename) {
        const safe = excludeFilename.replace(/[/\\]/g, '_');
        if (file === `${safe}.json`) continue;
      }
      const path = join(getCommentsDir(), file);
      try {
        const data: CommentFile = JSON.parse(readFileSync(path, 'utf-8'));
        if (data.marks.length > 0) {
          totalComments += data.marks.length;
          docCount++;
        }
      } catch { /* skip */ }
    }
  } catch { /* dir doesn't exist */ }
  return { totalComments, docCount };
}

export function editComment(filename: string, id: string, note: string): Comment | null {
  const data = readCommentFile(filename);
  const comment = data.marks.find((m) => m.id === id);
  if (!comment) return null;
  comment.note = note;
  writeCommentFile(filename, data);
  return comment;
}

export function resolveComments(ids: string[]): string[] {
  const idSet = new Set(ids);
  const resolved: string[] = [];

  ensureCommentsDir();
  try {
    const files: string[] = readdirSync(getCommentsDir());
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const filePath = join(getCommentsDir(), file);
      try {
        const data: CommentFile = JSON.parse(readFileSync(filePath, 'utf-8'));
        const before = data.marks.length;
        data.marks = data.marks.filter((m) => {
          if (idSet.has(m.id)) {
            resolved.push(m.id);
            return false;
          }
          return true;
        });
        if (data.marks.length !== before) {
          const docFilename = file.replace(/\.json$/, '').replace(/_/g, ' ');
          writeCommentFile(docFilename, data);
        }
      } catch { /* skip */ }
    }
  } catch { /* dir doesn't exist */ }

  return resolved;
}

export function pruneStaleComments(filename: string, validNodeIds: string[]): number {
  const data = readCommentFile(filename);
  if (data.marks.length === 0) return 0;

  const validSet = new Set(validNodeIds);
  const before = data.marks.length;
  data.marks = data.marks.filter((m) => {
    if (m.nodeIds && m.nodeIds.length > 0) {
      return m.nodeIds.some((id) => validSet.has(id));
    }
    return validSet.has(m.nodeId);
  });
  const pruned = before - data.marks.length;
  if (pruned > 0) writeCommentFile(filename, data);
  return pruned;
}

/** Rename a comment sidecar file when a document is renamed. */
export function renameComments(oldFilename: string, newFilename: string): void {
  const oldPath = commentFilePath(oldFilename);
  if (!existsSync(oldPath)) return;
  const newPath = commentFilePath(newFilename);
  renameSync(oldPath, newPath);
}
