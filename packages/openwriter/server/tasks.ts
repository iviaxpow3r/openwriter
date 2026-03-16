/**
 * Per-profile task persistence. Stores tasks.json in the profile data dir.
 */

import { join } from 'path';
import { existsSync, readFileSync } from 'fs';
import { getDataDir, atomicWriteFileSync, generateNodeId } from './helpers.js';

export interface Task {
  id: string;
  text: string;
  completed: boolean;
  position: number;
}

function tasksPath(): string {
  return join(getDataDir(), 'tasks.json');
}

export function readTasks(): Task[] {
  const p = tasksPath();
  if (!existsSync(p)) return [];
  try {
    return JSON.parse(readFileSync(p, 'utf-8'));
  } catch {
    return [];
  }
}

export function writeTasks(tasks: Task[]): void {
  atomicWriteFileSync(tasksPath(), JSON.stringify(tasks, null, 2));
}

export function addTask(text: string): Task {
  const tasks = readTasks();
  const maxPos = tasks.reduce((m, t) => Math.max(m, t.position), -1);
  const task: Task = { id: generateNodeId(), text, completed: false, position: maxPos + 1 };
  tasks.push(task);
  writeTasks(tasks);
  return task;
}

export function updateTask(id: string, patch: { text?: string; completed?: boolean }): Task | null {
  const tasks = readTasks();
  const task = tasks.find((t) => t.id === id);
  if (!task) return null;
  if (patch.text !== undefined) task.text = patch.text;
  if (patch.completed !== undefined) task.completed = patch.completed;
  writeTasks(tasks);
  return task;
}

export function removeTask(id: string): boolean {
  const tasks = readTasks();
  const idx = tasks.findIndex((t) => t.id === id);
  if (idx === -1) return false;
  tasks.splice(idx, 1);
  writeTasks(tasks);
  return true;
}
