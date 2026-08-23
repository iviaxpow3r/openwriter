/** Host renderer for declarative plugin sidebar layouts. */
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { SidebarModeProps } from './sidebar-types';
import SearchResults from './SearchResults';
import './PluginSidebarLayout.css';

type Contribution = { tabId: string; label: string; endpoint: string; surface?: 'rail' | 'plugins' | 'sidebar-layout' };
type Item = { id: string; title: string; detail?: string };
type Column = { id: string; label: string; color?: string; items: Item[] };
type Group = { id: string; label: string; kind?: 'workspace'; detail?: string; empty?: string; columns?: Column[]; groups?: Group[] };
type Board = { type: 'kanban'; id: string; actions?: { move?: string }; columns: Column[]; groups?: Group[] };
type Block = { type: 'heading'; text: string; detail?: string } | { type: 'notice'; text: string; tone?: 'neutral' | 'success' | 'warning' } | Board;
type Model = { title?: string; blocks: Block[] };
type DragSeed = { blockId: string; groupId: string; itemId: string; itemTitle: string; sourceColumnId: string; action: string };
type Drag = DragSeed & { x: number; y: number; drawerX: number; drawerY: number; drawerWidth: number };
type HeldDrag = DragSeed & { pointerId: number; startX: number; startY: number; drawerX: number; drawerY: number; drawerWidth: number; source: HTMLElement };
type Target = Pick<Drag, 'blockId' | 'groupId'> & { columnId: string };
type MoveMenu = { drag: Drag };

interface Props extends SidebarModeProps { layoutId: string; }

function MoveGlyph() {
  return <svg aria-hidden="true" viewBox="0 0 16 16" fill="none"><path d="M3 5h8M8 2.5 10.5 5 8 7.5M13 11H5M8 8.5 5.5 11 8 13.5" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

const collapseKey = (board: string, id: string) => `${board}:${id}`;
const flattened = (groups: Group[]): Group[] => groups.flatMap((group) => [group, ...flattened(group.groups || [])]);
const destinationDrawerId = (itemId: string) => `plugin-sidebar-layout-destinations-${encodeURIComponent(itemId)}`;

function drawerPosition(x: number, y: number, stageCount: number) {
  const height = 30 + (stageCount * 38);
  const canFitBelow = y + height + 8 <= window.innerHeight;
  return {
    left: Math.min(window.innerWidth - 8, Math.max(8, x)),
    top: canFitBelow ? y : Math.max(8, y - height - 42),
  };
}

export default function PluginSidebarLayout({ layoutId, docs, pendingDocs, onSwitchDocument, searchQuery, searchResults, actions, scrollRef }: Props) {
  const [contribution, setContribution] = useState<Contribution | null>(null);
  const [model, setModel] = useState<Model | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [dragging, setDragging] = useState<Drag | null>(null);
  const [dropTarget, setDropTarget] = useState<Target | null>(null);
  const [moveMenu, setMoveMenu] = useState<MoveMenu | null>(null);
  const [movingItem, setMovingItem] = useState<string | null>(null);
  const activeFilename = useMemo(() => docs.find((document) => document.isActive)?.filename || '', [docs]);
  const docsByFilename = useMemo(() => new Map(docs.map((document) => [document.filename, document])), [docs]);
  const pendingFilenames = useMemo(() => new Set(pendingDocs.filenames), [pendingDocs.filenames]);
  const dragRef = useRef<Drag | null>(null);
  const targetRef = useRef<Target | null>(null);
  const suppressClick = useRef(false);
  const cleanTracking = useRef<() => void>(() => {});
  const storageKey = `ow-plugin-sidebar-layout:${layoutId}:collapsed`;

  const load = useCallback(async () => {
    setError(null);
    try {
      const response = await fetch('/api/plugin-ui/contributions');
      if (!response.ok) throw new Error('Unable to load sidebar layouts');
      const payload = await response.json();
      const next = (payload.contributions || []).find((item: Contribution) => item.tabId === layoutId && item.surface === 'sidebar-layout') || null;
      if (!next) {
        setContribution(null);
        setModel(null);
        setError('This layout is no longer available. Choose another layout in Appearance.');
        return;
      }
      setContribution(next);
      const board = await fetch(`${next.endpoint}?${new URLSearchParams({ filename: activeFilename })}`);
      if (!board.ok) throw new Error((await board.json().catch(() => null))?.error || 'Unable to load this layout');
      setModel(await board.json());
    } catch (err: any) {
      setModel(null);
      setError(err?.message || 'Unable to load this layout');
    }
  }, [activeFilename, layoutId]);

  const toggle = useCallback((board: string, id: string) => {
    const key = collapseKey(board, id);
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key); else next.add(key);
      try { localStorage.setItem(storageKey, JSON.stringify([...next])); } catch { /* Persistence is optional. */ }
      return next;
    });
  }, [storageKey]);

  const move = useCallback(async (drag: Drag, columnId: string) => {
    if (!contribution || drag.sourceColumnId === columnId) return;
    setError(null);
    setMovingItem(drag.itemId);
    try {
      const response = await fetch(contribution.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: activeFilename, action: drag.action, value: JSON.stringify({ itemId: drag.itemId, columnId }) }),
      });
      if (!response.ok) throw new Error((await response.json().catch(() => null))?.error || 'Unable to move this document');
      window.dispatchEvent(new Event('ow-plugin-ui-changed'));
      await load();
    } catch (err: any) {
      setError(err?.message || 'Unable to move this document');
    } finally {
      setMovingItem(null);
    }
  }, [activeFilename, contribution, load]);

  const targetAtPoint = useCallback((x: number, y: number): Target | null => {
    const node = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-plugin-sidebar-drop-target]');
    const blockId = node?.dataset.pluginSidebarBoard;
    const groupId = node?.dataset.pluginSidebarGroup;
    const columnId = node?.dataset.pluginSidebarDropTarget;
    return blockId && groupId && columnId ? { blockId, groupId, columnId } : null;
  }, []);

  const beginDrag = useCallback((event: ReactPointerEvent<HTMLElement>, seed: DragSeed) => {
    if (event.button !== 0) return;
    cleanTracking.current();
    const rect = event.currentTarget.getBoundingClientRect();
    const held: HeldDrag = {
      ...seed,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      // The drawer stays in the sidebar, immediately below (or, if needed,
      // above) the source row. The pointer never has to cross editor text.
      drawerX: rect.left,
      drawerY: rect.bottom + 6,
      drawerWidth: rect.width,
      source: event.currentTarget,
    };
    try { held.source.setPointerCapture(event.pointerId); } catch { /* Pointer capture is a progressive enhancement. */ }
    document.documentElement.classList.add('plugin-sidebar-layout--drag-pending');
    const cleanup = () => {
      dragRef.current = null;
      targetRef.current = null;
      document.body.style.userSelect = '';
      document.documentElement.classList.remove('plugin-sidebar-layout--drag-pending');
      try { if (held.source.hasPointerCapture(held.pointerId)) held.source.releasePointerCapture(held.pointerId); } catch { /* The browser may have released it already. */ }
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
    };
    const setTarget = (x: number, y: number) => {
      const candidate = targetAtPoint(x, y);
      const active = dragRef.current;
      const next = candidate && active && candidate.blockId === active.blockId && candidate.groupId === active.groupId ? candidate : null;
      targetRef.current = next;
      setDropTarget(next);
    };
    const onMove = (nextEvent: PointerEvent) => {
      if (nextEvent.pointerId !== held.pointerId) return;
      let active = dragRef.current;
      if (!active) {
        // A small threshold distinguishes an ordinary click from a normal,
        // immediate click-drag. There is deliberately no hold delay.
        if (Math.hypot(nextEvent.clientX - held.startX, nextEvent.clientY - held.startY) < 4) return;
        active = { ...seed, x: nextEvent.clientX, y: nextEvent.clientY, drawerX: held.drawerX, drawerY: held.drawerY, drawerWidth: held.drawerWidth };
        dragRef.current = active;
        suppressClick.current = true;
        document.body.style.userSelect = 'none';
        setMoveMenu(null);
        setDragging(active);
      } else {
        active = { ...active, x: nextEvent.clientX, y: nextEvent.clientY };
        dragRef.current = active;
        setDragging(active);
      }
      nextEvent.preventDefault();
      setTarget(nextEvent.clientX, nextEvent.clientY);
    };
    const onUp = (endEvent: PointerEvent) => {
      if (endEvent.pointerId !== held.pointerId) return;
      const active = dragRef.current;
      if (active) setTarget(endEvent.clientX, endEvent.clientY);
      const target = targetRef.current;
      cleanup();
      setDragging(null);
      setDropTarget(null);
      if (active && target && target.columnId !== active.sourceColumnId) void move(active, target.columnId);
    };
    const onCancel = (cancelEvent: PointerEvent) => {
      if (cancelEvent.pointerId !== held.pointerId) return;
      cleanup();
      setDragging(null);
      setDropTarget(null);
    };
    cleanTracking.current = cleanup;
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
  }, [move, targetAtPoint]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) || '[]');
      setCollapsed(new Set(Array.isArray(saved) ? saved.filter((item): item is string => typeof item === 'string') : []));
    } catch { setCollapsed(new Set()); }
  }, [storageKey]);
  useEffect(() => () => cleanTracking.current(), []);
  useEffect(() => {
    const refresh = () => { void load(); };
    window.addEventListener('ow-plugins-changed', refresh);
    window.addEventListener('ow-plugin-ui-changed', refresh);
    return () => {
      window.removeEventListener('ow-plugins-changed', refresh);
      window.removeEventListener('ow-plugin-ui-changed', refresh);
    };
  }, [load]);
  useEffect(() => {
    if (!moveMenu) return;
    const closeOnOutsidePress = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest('.plugin-sidebar-layout__destination-drawer, .plugin-sidebar-layout__move-button')) return;
      setMoveMenu(null);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      setMoveMenu(null);
    };
    document.addEventListener('pointerdown', closeOnOutsidePress);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePress);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [moveMenu]);

  const destinationDrawer = (drag: Drag, columns: Column[], isDrag = false, id?: string) => createPortal(
    <section
      id={id}
      className={`plugin-sidebar-layout__destination-drawer${isDrag ? ' plugin-sidebar-layout__destination-drawer--dragging' : ''}`}
      style={{ ...drawerPosition(drag.drawerX, drag.drawerY, columns.length), width: drag.drawerWidth }}
      role="group"
      aria-label={`Move ${drag.itemTitle} to a stage`}
    >
      <span className="plugin-sidebar-layout__destination-label">Move to</span>
      <div className="plugin-sidebar-layout__destination-options">
        {columns.map((column) => {
          const isCurrent = column.id === drag.sourceColumnId;
          const isTarget = dropTarget?.blockId === drag.blockId && dropTarget.groupId === drag.groupId && dropTarget.columnId === column.id;
          return <button
            type="button"
            key={column.id}
            {...(!isCurrent ? {
              'data-plugin-sidebar-drop-target': column.id,
              'data-plugin-sidebar-board': drag.blockId,
              'data-plugin-sidebar-group': drag.groupId,
            } : {})}
            className={`${isTarget ? 'is-target ' : ''}${isCurrent ? 'is-current' : ''}`.trim()}
            disabled={isCurrent}
            aria-current={isCurrent ? 'step' : undefined}
            aria-label={isCurrent ? `Current stage: ${column.label}` : `Move to ${column.label}`}
            onClick={() => {
              if (isDrag || isCurrent) return;
              setMoveMenu(null);
              void move(drag, column.id);
            }}
          >
            <i style={{ backgroundColor: column.color || 'var(--ink-light)' }} />
            {column.label}
            {isCurrent && <span>Current</span>}
          </button>;
        })}
      </div>
    </section>,
    document.body,
  );

  const renderColumns = (board: Board, group: Group, columns: Column[], depth: number): ReactNode => columns.map((column) => {
    const stageKey = `stage:${group.id}:${column.id}`;
    const closed = collapsed.has(collapseKey(board.id, stageKey));
    return <div className={`sidebar-container depth-${Math.min(depth, 2)} plugin-sidebar-layout__stage${closed ? ' collapsed' : ''}`} key={column.id}>
      <button type="button" className="sidebar-container-header plugin-sidebar-layout__tree-toggle" onClick={() => toggle(board.id, stageKey)} aria-expanded={!closed}>
        <span className={`sidebar-chevron${closed ? ' collapsed' : ''}`} aria-hidden="true">&#9662;</span>
        <i className="plugin-sidebar-layout__stage-dot" style={{ backgroundColor: column.color || 'var(--ink-light)' }} />
        <span className="sidebar-container-name">{column.label}</span>
        <span className="plugin-sidebar-layout__stage-count">{column.items.length}</span>
      </button>
      {!closed && <div className="sidebar-container-list">
        {column.items.map((item) => {
          const document = docsByFilename.get(item.id);
          const title = document?.title || item.title;
          const drag: DragSeed | null = board.actions?.move
            ? { blockId: board.id, groupId: group.id, itemId: item.id, itemTitle: title, sourceColumnId: column.id, action: board.actions.move }
            : null;
          const isMoveMenuOpen = moveMenu?.drag.itemId === item.id;
          return <div
            key={item.id}
            className={`sidebar-item plugin-sidebar-layout__item${item.id === activeFilename ? ' active' : ''}${movingItem === item.id ? ' plugin-sidebar-layout__item--moving' : ''}${dragging?.itemId === item.id ? ' plugin-sidebar-layout__item--drag-source' : ''}`}
            role="button"
            tabIndex={0}
            onPointerDown={(event) => { if (drag) beginDrag(event, drag); }}
            onClick={() => {
              if (suppressClick.current) { suppressClick.current = false; return; }
              onSwitchDocument(item.id);
            }}
            onKeyDown={(event) => {
              if ((event.key === 'Enter' || event.key === ' ') && !event.defaultPrevented) {
                event.preventDefault();
                onSwitchDocument(item.id);
              }
            }}
            title={drag ? `Open ${title}. Drag to change stage.` : `Open ${title}`}
          >
            <div className="sidebar-item-title">
              <span className="sidebar-item-title-text">{title}</span>
              {pendingFilenames.has(item.id) && <span className="sidebar-pending-dot" title="Unsynced change" />}
            </div>
            {drag && <button
              type="button"
              className="plugin-sidebar-layout__move-button"
              aria-label={`Move ${title}`}
              aria-controls={destinationDrawerId(item.id)}
              aria-expanded={isMoveMenuOpen}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                if (isMoveMenuOpen) {
                  setMoveMenu(null);
                  return;
                }
                const source = event.currentTarget.closest<HTMLElement>('.plugin-sidebar-layout__item');
                const rect = source?.getBoundingClientRect() || event.currentTarget.getBoundingClientRect();
                setMoveMenu({ drag: { ...drag, x: rect.left, y: rect.top, drawerX: rect.left, drawerY: rect.bottom + 6, drawerWidth: rect.width } });
              }}
            ><MoveGlyph /></button>}
          </div>;
        })}
      </div>}
    </div>;
  });

  const renderGroup = (board: Board, group: Group, depth = 0): ReactNode => {
    const groupKey = `group:${group.id}`;
    const closed = collapsed.has(collapseKey(board.id, groupKey));
    if (group.kind === 'workspace') {
      return <div className={`sidebar-section sidebar-workspace-section plugin-sidebar-layout__workspace${closed ? ' ws-collapsed' : ''}`} key={group.id}>
        <button type="button" className="sidebar-section-header plugin-sidebar-layout__tree-toggle" onClick={() => toggle(board.id, groupKey)} aria-expanded={!closed}>
          <span className={`sidebar-chevron${closed ? ' collapsed' : ''}`} aria-hidden="true">&#9662;</span>
          <span className="sidebar-label sidebar-workspace-label">{group.label}</span>
        </button>
        {!closed && <div className="sidebar-section-list">
          {group.groups?.map((child) => renderGroup(board, child, depth))}
          {group.columns?.length ? renderColumns(board, group, group.columns, depth) : !group.groups?.length && <div className="plugin-sidebar-layout__group-empty">{group.empty || 'No workflow documents yet.'}</div>}
        </div>}
      </div>;
    }
    return <div className={`sidebar-container depth-${Math.min(depth, 2)} plugin-sidebar-layout__group${closed ? ' collapsed' : ''}`} key={group.id}>
      <button type="button" className="sidebar-container-header plugin-sidebar-layout__tree-toggle" onClick={() => toggle(board.id, groupKey)} aria-expanded={!closed}>
        <span className={`sidebar-chevron${closed ? ' collapsed' : ''}`} aria-hidden="true">&#9662;</span>
        <span className="sidebar-container-name">{group.label}</span>
      </button>
      {!closed && <div className="sidebar-container-list">
        {group.groups?.map((child) => renderGroup(board, child, depth + 1))}
        {group.columns?.length ? renderColumns(board, group, group.columns, depth + 1) : !group.groups?.length && <div className="plugin-sidebar-layout__group-empty">{group.empty || 'No workflow documents yet.'}</div>}
      </div>}
    </div>;
  };

  if (searchQuery && searchResults) return <SearchResults results={searchResults} query={searchQuery} onSwitchDocument={onSwitchDocument} actions={actions} />;

  return <div className="plugin-sidebar-layout sidebar-scroll" ref={scrollRef} aria-label={contribution?.label || 'Plugin layout'}>
    {error && <div className="plugin-sidebar-layout__notice plugin-sidebar-layout__notice--warning" role="alert">{error}</div>}
    {!model && !error && <div className="plugin-sidebar-layout__empty">Loading layout…</div>}
    {model?.blocks.map((block) => {
      if (block.type === 'heading') return <div className="plugin-sidebar-layout__notice" key={`heading-${block.text}`}>{block.text}</div>;
      if (block.type === 'notice') return <div className={`plugin-sidebar-layout__notice plugin-sidebar-layout__notice--${block.tone || 'neutral'}`} key={`notice-${block.text}`}>{block.text}</div>;
      const root: Group = { id: '__root__', label: '', columns: block.columns };
      const currentGroup = flattened(block.groups || []).find((group) => group.id === dragging?.groupId) || root;
      return <div className="plugin-sidebar-layout__pipeline" key={block.id}>
        {block.groups?.length ? block.groups.map((group) => renderGroup(block, group)) : renderColumns(block, root, block.columns, 0)}
        {dragging?.blockId === block.id && <>
          {createPortal(<div className="plugin-sidebar-layout__drag-preview" style={{ left: dragging.x + 12, top: dragging.y + 12 }} aria-hidden="true">{dragging.itemTitle}</div>, document.body)}
          {destinationDrawer(dragging, currentGroup.columns || [], true)}
        </>}
      </div>;
    })}
    {moveMenu && (() => {
      const board = model?.blocks.find((block): block is Board => block.type === 'kanban' && block.id === moveMenu.drag.blockId);
      const group = board && flattened(board.groups || []).find((item) => item.id === moveMenu.drag.groupId);
      return group ? destinationDrawer(moveMenu.drag, group.columns || [], false, destinationDrawerId(moveMenu.drag.itemId)) : null;
    })()}
  </div>;
}
