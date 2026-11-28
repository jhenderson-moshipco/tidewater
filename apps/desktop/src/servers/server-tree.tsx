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
  IconPencil,
  IconPlus,
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
import { type_labels } from '../objects/describe';
import { createFromRow, creatableObject, dropRow, editRow, editableObject } from '../objects/open-editor';
import { isQueryable, selectTopRows, sqlTarget } from '../query/tree-queries';
import { useDialogStore } from '../store/dialogs';
import { useExplorerStore } from '../store/explorer';
import { useServerStore, type ConnectionState } from '../store/servers';
import { useTreeStore } from '../store/tree';
import { useWorkspaceStore } from '../store/workspace';
import { Elapsed } from '../shell/elapsed';
import { environmentLabel } from './connection-form';
import classes from './servers.module.css';
import { retryRow, rowMenu, showContextMenu } from './tree-menu';
import { ROW_HEIGHT, buildRows, keyAction, rowIndexAt, rowLayout, type RowLayout, type TreeRow } from './tree-rows';

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

/** The state a server row shows after its badge. */
export function connectionStatus(connection: ConnectionState | undefined): string {
  switch (connection?.status) {
    case undefined:
      return 'Not connected';
    case 'connecting':
      return 'Connecting…';
    case 'connected':
      return `Connected · PG ${connection.info.server_version}`;
    case 'failed':
      return 'Failed';
  }
}

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

function scrollToIndex(container: HTMLElement, layout: RowLayout, index: number): void {
  const top = layout.tops[index] as number;
  const height = layout.heights[index] as number;
  if (top < container.scrollTop) container.scrollTop = top;
  else if (top + height > container.scrollTop + container.clientHeight) container.scrollTop = top + height - container.clientHeight;
}

function openRowMenu(row: TreeRow, rows: ReadonlyArray<TreeRow>, container: HTMLElement, layout: RowLayout, index: number): void {
  const box = container.getBoundingClientRect();
  const y = box.top + (layout.tops[index] as number) - container.scrollTop + ROW_HEIGHT;
  void showContextMenu(rowMenu(row, rows), { x: box.left + 24, y });
}

function shortcut(event: KeyboardEvent<HTMLDivElement>, row: TreeRow, rows: ReadonlyArray<TreeRow>, layout: RowLayout, index: number): boolean {
  const item = row.item;
  const dialogs = useDialogStore.getState();
  if (event.key === 'Escape' && item.type === 'server' && item.connection?.status === 'connecting') {
    void useServerStore.getState().cancelConnect(item.server.id);
    return true;
  }
  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
    const target = sqlTarget(row, rows);
    if (isQueryable(target)) selectTopRows(target);
    return true;
  }
  if (event.key === 'Enter') {
    activate(row, rows);
    return true;
  }
  if ((event.key === 'F10' && event.shiftKey) || event.key === 'ContextMenu') {
    openRowMenu(row, rows, event.currentTarget, layout, index);
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
  return objectShortcut(event.key, row, rows);
}

/** F2 edits a row's object, Insert creates one under it, and Delete or Backspace drops it. */
function objectShortcut(key: string, row: TreeRow, rows: ReadonlyArray<TreeRow>): boolean {
  if (key === 'F2') return editRow(row);
  if (key === 'Insert') return createFromRow(row, rows);
  if (key === 'Delete' || key === 'Backspace') return dropRow(row);
  return false;
}

/** The shortcuts a row answers to beyond moving and opening, for `aria-keyshortcuts`. */
function rowShortcuts(row: TreeRow, rows: ReadonlyArray<TreeRow>): string | undefined {
  const keys = [
    row.item.type === 'server' && row.item.connection?.status === 'connecting' && 'Escape',
    isQueryable(sqlTarget(row, rows)) && 'Meta+Enter',
    editableObject(row) && 'F2 Delete',
    creatableObject(row, rows) && 'Insert',
  ].filter(Boolean);
  return keys.length > 0 ? keys.join(' ') : undefined;
}

/**
 * The pencil and + a row shows while hovered or selected. They repeat F2 and Insert for the pointer, so they stay
 * out of the tab order and the accessibility tree, as the tree is one tab stop.
 */
function RowActions({ row, rows }: { row: TreeRow; rows: ReadonlyArray<TreeRow> }) {
  const created = creatableObject(row, rows);
  const editable = editableObject(row) !== null;
  if (!created && !editable) return null;
  const run = (event: MouseEvent<HTMLElement>, action: () => void) => {
    event.stopPropagation();
    useTreeStore.getState().setActive(row.id);
    event.currentTarget.closest<HTMLElement>('[role="tree"]')?.focus();
    action();
  };

  return (
    <span aria-hidden className={classes.rowActions}>
      {created && (
        <span className={classes.rowAction} title={`New ${type_labels[created.object_type]} (Insert)`} onClick={(event) => run(event, () => createFromRow(row, rows))}>
          <IconPlus size={14} />
        </span>
      )}
      {editable && (
        <span className={classes.rowAction} title="Edit (F2)" onClick={(event) => run(event, () => editRow(row))}>
          <IconPencil size={14} />
        </span>
      )}
    </span>
  );
}

function RowLead({ row }: { row: TreeRow }) {
  const item = row.item;
  if (item.type === 'server') {
    const state = item.connection?.status ?? 'idle';
    if (state === 'connecting') return <span aria-hidden="true" className="spinner" />;
    return <span aria-hidden className={classes.dot} data-state={state} />;
  }
  if (item.type === 'loading') return <span aria-hidden="true" className="spinner" />;
  if (item.type === 'node') {
    const NodeIconComponent = node_icons[item.node.icon];
    return <NodeIconComponent size={14} aria-hidden className={classes.rowIcon} />;
  }
  if (item.type === 'group') return <IconFolder size={14} aria-hidden className={classes.rowIcon} />;
  return <IconX size={14} aria-hidden className={classes.failed} />;
}

function RowTrail({ row }: { row: TreeRow }) {
  const item = row.item;
  if (item.type === 'server') {
    const connection = item.connection;
    return (
      <>
        <span className={classes.badge} data-environment={item.server.environment}>
          {environmentLabel(item.server.environment)}
        </span>
        <span className={classes.rowDetail} data-state={connection?.status ?? 'idle'}>
          {connectionStatus(connection)}
          {connection?.status === 'connecting' && (
            <>
              {' '}
              <Elapsed started={connection.started} />
            </>
          )}
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
  const width = useWorkspaceStore((state) => state.sidebar_width);
  const [scroll_top, setScrollTop] = useState(0);

  const rows = buildRows({ groups, servers, connections, collapsed_groups, expanded, children });
  const layout = rowLayout(rows, width);
  const active_index = Math.max(0, rows.findIndex((row) => row.id === active_id));
  const active = rows[active_index];

  const first = Math.max(0, rowIndexAt(layout, scroll_top) - OVERSCAN);
  const count = Math.ceil(window.innerHeight / ROW_HEIGHT) + OVERSCAN * 2;
  const shown = rows.slice(first, first + count).map((row, offset) => ({ row, index: first + offset }));
  if (active && (active_index < first || active_index >= first + count)) shown.push({ row: active, index: active_index });

  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!active) return;
    if (shortcut(event, active, rows, layout, active_index)) {
      event.preventDefault();
      return;
    }
    const action = keyAction(rows, active.id, event.key);
    if (!action) return;
    event.preventDefault();
    const tree = useTreeStore.getState();
    if (action.type === 'focus') {
      tree.setActive(action.row.id);
      scrollToIndex(event.currentTarget, layout, rows.indexOf(action.row));
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
        <div className={classes.treeSpacer} style={{ height: layout.total }}>
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
              aria-keyshortcuts={rowShortcuts(row, rows)}
              data-active={row.id === active?.id}
              data-kind={row.item.type}
              className={classes.row}
              style={{ top: layout.tops[index], height: layout.heights[index], paddingInlineStart: 6 + (row.level - 1) * 10 }}
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
              <RowActions row={row} rows={rows} />
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
