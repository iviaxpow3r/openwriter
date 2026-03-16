import { useState, useEffect, useCallback, useRef } from 'react';
import './SidebarTasks.css';

interface Task {
  id: string;
  text: string;
  completed: boolean;
  position: number;
}

export default function SidebarTasks({ onBack }: { onBack: () => void }) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [addValue, setAddValue] = useState('');
  const [completingId, setCompletingId] = useState<string | null>(null);
  const [showInput, setShowInput] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const fetchTasks = useCallback(async () => {
    try {
      const res = await fetch('/api/tasks');
      if (res.ok) {
        const data = await res.json();
        setTasks(data.tasks || []);
      }
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { fetchTasks(); }, [fetchTasks]);

  const handleAdd = async () => {
    const text = addValue.trim();
    if (!text) return;
    setAddValue('');
    try {
      const res = await fetch('/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      if (res.ok) {
        const data = await res.json();
        setTasks((prev) => [...prev, data.task]);
      }
    } catch { /* ignore */ }
  };

  const handleComplete = (id: string) => {
    setCompletingId(id);
    // Start completion on server immediately
    fetch(`/api/tasks/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ completed: true }),
    }).catch(() => {});
    // After animation, remove from list
    setTimeout(() => {
      setTasks((prev) => prev.filter((t) => t.id !== id));
      setCompletingId(null);
    }, 400);
  };

  const handleDelete = async (id: string) => {
    try {
      const res = await fetch(`/api/tasks/${id}`, { method: 'DELETE' });
      if (res.ok) setTasks((prev) => prev.filter((t) => t.id !== id));
    } catch { /* ignore */ }
  };

  const handleShowInput = () => {
    setShowInput(true);
    setTimeout(() => inputRef.current?.focus(), 0);
  };

  const incompleteTasks = tasks.filter((t) => !t.completed);

  return (
    <div className="sidebar-tasks">
      <div className="sidebar-tasks-header">
        <button className="sidebar-tasks-back" onClick={onBack} title="Back to documents">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="m15 18-6-6 6-6" />
          </svg>
        </button>
        <h3>Tasks</h3>
        <button className="sidebar-tasks-add-btn" onClick={handleShowInput} title="Add task">+</button>
      </div>

      {incompleteTasks.length === 0 && !showInput ? (
        <div className="sidebar-tasks-empty">
          <div className="sidebar-tasks-empty-title">No tasks</div>
          <div className="sidebar-tasks-empty-desc">Add tasks to track your checklist.</div>
        </div>
      ) : (
        <div className="sidebar-tasks-list">
          {incompleteTasks.map((task) => (
            <div key={task.id} className={`sidebar-tasks-item${completingId === task.id ? ' completing' : ''}`}>
              <input
                type="checkbox"
                className="sidebar-tasks-checkbox"
                checked={completingId === task.id}
                onChange={() => handleComplete(task.id)}
              />
              <span className={`sidebar-tasks-text${completingId === task.id ? ' completed' : ''}`}>
                {task.text}
              </span>
              <button className="sidebar-tasks-delete" onClick={() => handleDelete(task.id)} title="Remove">&times;</button>
            </div>
          ))}
        </div>
      )}

      {showInput && (
        <div className="sidebar-tasks-add">
          <input
            ref={inputRef}
            type="text"
            placeholder="New task..."
            value={addValue}
            onChange={(e) => setAddValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleAdd();
              if (e.key === 'Escape') { setShowInput(false); setAddValue(''); }
            }}
            onBlur={() => { if (!addValue.trim()) setShowInput(false); }}
          />
        </div>
      )}
    </div>
  );
}
