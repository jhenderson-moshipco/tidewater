import {
  IconBraces,
  IconChevronDown,
  IconChevronRight,
  IconCode,
  IconColumns,
  IconDatabase,
  IconEye,
  IconFolder,
  IconListNumbers,
  IconMathFunction,
  IconPuzzle,
  IconSchema,
  IconTable,
  IconTableOptions,
  IconTableShortcut,
  IconX,
  type Icon,
} from '@tabler/icons-react';
import { useState, type KeyboardEvent, type MouseEvent, type UIEvent } from 'react';
import type { NodeIcon } from '../generated/catalog';
import { useDialogStore } from '../store/dialogs';
import { useExplorerStore } from '../store/explorer';
import { useServerStore } from '../store/servers';
import { useTreeStore } from '../store/tree';
import { environmentLabel } from './connection-form';
import classes from './servers.module.css';
import { retryRow, rowMenu, showContextMenu } from './tree-menu';
import { buildRows, keyAction, type TreeRow } from './tree-rows';

const ROW_HEIGHT = 24;
const OVERSCAN = 12;

const node_icons: Readonly<Record<NodeIcon, Icon>> = {
  database: IconDatabase,
  schema: IconSchema,
  folder: IconFolder,
  extension: IconPuzzle,
  table: IconTable,
  partitioned_table: IconTableOptions,
  view: IconEye,
  materialized_view: IconTableShortcut,
  function: IconMathFunction,
  procedure: IconCode,
  sequence: IconListNumbers,
  type: IconBraces,
  column: IconColumns,
};

const connection_labels = {
  idle: 'not connected',
  connecting: 'connecting',
  connected: 'connected',
  failed: 'connection failed',
} as const;

function domId(row_id: string): string {
  return `tree-row-${row_id}`;
}

function toggle(row: TreeRow): void {
  const tree = useTreeStore.getState();
  if (row.expanded) tree.collapseRow(row);
  else void tree.expandRow(row);
}

function activate(row: TreeRow, rows: ReadonlyArray<TreeRow>): void {
  if (row.item.type === 'error') void retryRow(row, rows);
  else if (row.expandable) toggle(row);
}

function scrollToIndex(container: HTMLElement, index: number): void {
  const top = index * ROW_HEIGHT;
  if (top < container.scrollTop) container.scrollTop = top;
  else if (top + ROW_HEIGHT > container.scrollTop + container.clientHeight) container.scrollTop = top + ROW_HEIGHT - container.clientHeight;
}

function openRowMenu(row: TreeRow, rows: ReadonlyArray<TreeRow>, container: HTMLElement, index: number): void {
  const box = container.getBoundingClientRect();
  const y = box.top + index * ROW_HEIGHT - container.scrollTop + ROW_HEIGHT;
  void showContextMenu(rowMenu(row, rows), { x: box.left + 24, y });
}

function shortcut(event: KeyboardEvent<HTMLDivElement>, row: TreeRow, rows: ReadonlyArray<TreeRow>, index: number): boolean {
  const item = row.item;
  const dialogs = useDialogStore.getState();
  if (event.key === 'Enter') {
    activate(row, rows);
    return true;
  }
  if ((event.key === 'F10' && event.shiftKey) || event.key === 'ContextMenu') {
    openRowMenu(row, rows, event.currentTarget, index);
    return true;
  }
  if (event.key === 'F5') {
    void useTreeStore.getState().refreshRow(row);
    return true;
  }
  if (event.key === 'F2' && item.type === 'server') {
    dialogs.openConnection(item.server);
    return true;
  }
  if (event.key === 'F2' && item.type === 'group') {
    dialogs.show({ kind: 'group', editing: item.group });
    return true;
  }
  if ((event.key === 'Delete' || event.key === 'Backspace') && item.type === 'server') {
    dialogs.show({ kind: 'delete-server', server: item.server });
    return true;
  }
  if ((event.key === 'Delete' || event.key === 'Backspace') && item.type === 'group') {
    dialogs.show({ kind: 'delete-group', group: item.group, server_count: item.server_count });
    return true;
  }
  return false;
}

function RowLead({ row }: { row: TreeRow }) {
  const item = row.item;
  if (item.type === 'server') {
    const state = item.connection?.status ?? 'idle';
    return <span aria-hidden className={classes.dot} data-state={state} />;
  }
  if (item.type === 'node') {
    const NodeIconComponent = node_icons[item.node.icon];
    return <NodeIconComponent size={14} aria-hidden className={classes.rowIcon} />;
  }
  if (item.type === 'group') return <IconFolder size={14} aria-hidden className={classes.rowIcon} />;
  if (item.type === 'error') return <IconX size={14} aria-hidden className={classes.failed} />;
  return null;
}

function RowTrail({ row }: { row: TreeRow }) {
  const item = row.item;
  if (item.type === 'server') {
    const state = item.connection?.status ?? 'idle';
    return (
      <>
        <span className="visually-hidden">, {connection_labels[state]}</span>
        <span className={classes.badge} data-environment={item.server.environment}>
          {environmentLabel(item.server.environment)}
        </span>
      </>
    );
  }
  if (item.type === 'group') {
    return (
      <span className={classes.rowDetail}>
        {item.server_count}
        <span className="visually-hidden">{item.server_count === 1 ? ' server' : ' servers'}</span>
      </span>
    );
  }
  if (item.type === 'node' && item.node.detail) return <span className={classes.rowDetail}>{item.node.detail}</span>;
  return null;
}

export function ServerTree() {
  const groups = useServerStore((state) => state.groups);
  const servers = useServerStore((state) => state.servers);
  const connections = useServerStore((state) => state.connections);
  const collapsed_groups = useExplorerStore((state) => state.collapsed_groups);
  const expanded = useTreeStore((state) => state.expanded);
  const children = useTreeStore((state) => state.children);
  const active_id = useTreeStore((state) => state.active_id);
  const announcement = useTreeStore((state) => state.announcement);
  const [scroll_top, setScrollTop] = useState(0);

  const rows = buildRows({ groups, servers, connections, collapsed_groups, expanded, children });
  const active_index = Math.max(0, rows.findIndex((row) => row.id === active_id));
  const active = rows[active_index];

  const first = Math.max(0, Math.floor(scroll_top / ROW_HEIGHT) - OVERSCAN);
  const count = Math.ceil(window.innerHeight / ROW_HEIGHT) + OVERSCAN * 2;
  const shown = rows.slice(first, first + count).map((row, offset) => ({ row, index: first + offset }));
  if (active && (active_index < first || active_index >= first + count)) shown.push({ row: active, index: active_index });

  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!active) return;
    if (shortcut(event, active, rows, active_index)) {
      event.preventDefault();
      return;
    }
    const action = keyAction(rows, active.id, event.key);
    if (!action) return;
    event.preventDefault();
    const tree = useTreeStore.getState();
    if (action.type === 'focus') {
      tree.setActive(action.row.id);
      scrollToIndex(event.currentTarget, rows.indexOf(action.row));
    } else if (action.type === 'expand') void tree.expandRow(action.row);
    else tree.collapseRow(action.row);
  };

  const pick = (event: MouseEvent<HTMLElement>, row: TreeRow) => {
    useTreeStore.getState().setActive(row.id);
    event.currentTarget.closest<HTMLElement>('[role="tree"]')?.focus();
  };

  return (
    <>
      <div
        role="tree"
        aria-label="Servers"
        aria-activedescendant={active ? domId(active.id) : undefined}
        tabIndex={0}
        className={classes.tree}
        onKeyDown={keyDown}
        onScroll={(event: UIEvent<HTMLDivElement>) => setScrollTop(event.currentTarget.scrollTop)}
      >
        <div className={classes.treeSpacer} style={{ height: rows.length * ROW_HEIGHT }}>
          {shown.map(({ row, index }) => (
            <div
              key={row.id}
              id={domId(row.id)}
              role="treeitem"
              aria-level={row.level}
              aria-setsize={row.setsize}
              aria-posinset={row.posinset}
              aria-expanded={row.expandable ? row.expanded : undefined}
              aria-selected={row.id === active?.id}
              data-active={row.id === active?.id}
              data-kind={row.item.type}
              className={classes.row}
              style={{ top: index * ROW_HEIGHT, paddingInlineStart: 6 + (row.level - 1) * 10 }}
              onClick={(event) => pick(event, row)}
              onDoubleClick={() => activate(row, rows)}
              onContextMenu={(event) => {
                event.preventDefault();
                pick(event, row);
                void showContextMenu(rowMenu(row, rows));
              }}
            >
              {row.chevron_slot && (
                <span
                  aria-hidden
                  className={classes.chevron}
                  onClick={(event) => {
                    event.stopPropagation();
                    pick(event, row);
                    toggle(row);
                  }}
                >
                  {row.expandable && (row.expanded ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />)}
                </span>
              )}
              <RowLead row={row} />
              <span className={classes.rowLabel}>{row.label}</span>
              <RowTrail row={row} />
            </div>
          ))}
        </div>
      </div>
      <p role="status" className="visually-hidden">
        {announcement}
      </p>
    </>
  );
}
