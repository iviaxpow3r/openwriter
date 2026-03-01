/**
 * Agent Marks: sidecar JSON storage for inline user feedback.
 * Each document gets a sidecar file at DATA_DIR/_marks/{filename}.json.
 */

import { join } from 'path';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, unlinkSync } from 'fs';
import { randomUUID } from 'crypto';
import { DATA_DIR, ensureDataDir } from './helpers.js';

export interface AgentMark {
  id: string;
  text: string;
  note: string;
  nodeId: string;
  createdAt: string;
}

interface MarkFile {
  marks: AgentMark[];
}

const MARKS_DIR = join(DATA_DIR, '_marks');

function ensureMarksDir(): void {
  ensureDataDir();
  if (!existsSync(MARKS_DIR)) mkdirSync(MARKS_DIR, { recursive: true });
}

function markFilePath(filename: string): string {
  // Sanitize: replace path separators to avoid nested paths
  const safe = filename.replace(/[/\\]/g, '_');
  return join(MARKS_DIR, `${safe}.json`);
}

function readMarkFile(filename: string): MarkFile {
  const path = markFilePath(filename);
  if (!existsSync(path)) return { marks: [] };
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return { marks: [] };
  }
}

function writeMarkFile(filename: string, data: MarkFile): void {
  ensureMarksDir();
  const path = markFilePath(filename);
  if (data.marks.length === 0) {
    // Clean up empty sidecar files
    if (existsSync(path)) unlinkSync(path);
    return;
  }
  writeFileSync(path, JSON.stringify(data, null, 2));
}

export function addMark(filename: string, text: string, note: string, nodeId: string): AgentMark {
  const data = readMarkFile(filename);
  const mark: AgentMark = {
    id: randomUUID().slice(0, 8),
    text,
    note,
    nodeId,
    createdAt: new Date().toISOString(),
  };
  data.marks.push(mark);
  writeMarkFile(filename, data);
  return mark;
}

export function getMarks(filename?: string): Record<string, AgentMark[]> {
  if (filename) {
    const data = readMarkFile(filename);
    if (data.marks.length === 0) return {};
    return { [filename]: data.marks };
  }

  // All docs: scan _marks directory
  ensureMarksDir();
  const result: Record<string, AgentMark[]> = {};
  try {
    const files: string[] = readdirSync(MARKS_DIR);
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const docFilename = file.replace(/\.json$/, '').replace(/_/g, ' ');
      // Read raw to avoid filename roundtrip issues
      const path = join(MARKS_DIR, file);
      try {
        const data: MarkFile = JSON.parse(readFileSync(path, 'utf-8'));
        if (data.marks.length > 0) result[docFilename] = data.marks;
      } catch { /* skip corrupt files */ }
    }
  } catch { /* dir doesn't exist yet */ }
  return result;
}

export function getMarkCount(filename: string): number {
  return readMarkFile(filename).marks.length;
}

export function resolveMarks(ids: string[]): string[] {
  const idSet = new Set(ids);
  const resolved: string[] = [];

  ensureMarksDir();
  try {
    const files: string[] = readdirSync(MARKS_DIR);
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const filePath = join(MARKS_DIR, file);
      try {
        const data: MarkFile = JSON.parse(readFileSync(filePath, 'utf-8'));
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
          writeMarkFile(docFilename, data);
        }
      } catch { /* skip */ }
    }
  } catch { /* dir doesn't exist */ }

  return resolved;
}

export function pruneStaleMarks(filename: string, validNodeIds: string[]): number {
  const data = readMarkFile(filename);
  if (data.marks.length === 0) return 0;

  const validSet = new Set(validNodeIds);
  const before = data.marks.length;
  data.marks = data.marks.filter((m) => validSet.has(m.nodeId));
  const pruned = before - data.marks.length;
  if (pruned > 0) writeMarkFile(filename, data);
  return pruned;
}
