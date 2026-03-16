/**
 * Express routes for task CRUD.
 * Mounted in index.ts to keep the main file lean.
 */

import { Router } from 'express';
import { readTasks, addTask, updateTask, removeTask } from './tasks.js';

export function createTaskRouter(): Router {
  const router = Router();

  router.get('/api/tasks', (_req, res) => {
    res.json({ tasks: readTasks() });
  });

  router.post('/api/tasks', (req, res) => {
    const { text } = req.body;
    if (!text?.trim()) { res.status(400).json({ error: 'text is required' }); return; }
    res.json({ task: addTask(text.trim()) });
  });

  router.put('/api/tasks/:id', (req, res) => {
    const { text, completed } = req.body;
    const task = updateTask(req.params.id, { text, completed });
    if (!task) { res.status(404).json({ error: 'Task not found' }); return; }
    res.json({ task });
  });

  router.delete('/api/tasks/:id', (req, res) => {
    const ok = removeTask(req.params.id);
    if (!ok) { res.status(404).json({ error: 'Task not found' }); return; }
    res.json({ success: true });
  });

  return router;
}
