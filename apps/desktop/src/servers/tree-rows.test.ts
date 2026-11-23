import { describe, expect, it } from 'vitest';
import type { CatalogNode } from '../generated/catalog';
import type { ServerSummary } from '../generated/servers';
import {
  buildRows,
  childrenKey,
  groupRowId,
  keyAction as rowAction,
  nodeRowId,
  rowHeight,
  rowIndexAt,
  rowLayout,
  serverRowId,
  type TreeInput,
  type TreeRow,
} from './tree-rows';

/** The action with its row reduced to the row's id, to keep the expectations short. */
function keyAction(rows: ReadonlyArray<TreeRow>, active_id: string | null, key: string) {
  const action = rowAction(rows, active_id, key);
  return action && { type: action.type, id: action.row.id };
}

function server(id: string, group_id: string | null = null): ServerSummary {
  return {
    id,
    name: id,
    group_id,
    environment: 'dev',
    host: 'localhost',
    port: 5432,
    database: 'orders',
    user: 'app',
    has_password: false,
    tls: 'prefer',
    session: { read_only: false, statement_timeout_ms: null },
  };
}

function catalogNode(key: string, label: string, expandable = true): CatalogNode {
  return { key, label, detail: null, icon: 'database', children: expandable ? { level: 'database', database: label } : null };
}

function input(overrides: Partial<TreeInput> = {}): TreeInput {
  return {
    groups: [{ id: 'g1', name: 'Orders platform' }],
    servers: [server('dev', 'g1'), server('prod', 'g1'), server('local')],
    connections: {},
    collapsed_groups: {},
    expanded: {},
    children: {},
    ...overrides,
  };
}

describe('buildRows', () => {
  it('lists groups with their servers, then ungrouped servers, with levels and positions', () => {
    const rows = buildRows(input());
    expect(rows.map((row) => [row.id, row.level, row.posinset, row.setsize])).toEqual([
      [groupRowId('g1'), 1, 1, 2],
      [serverRowId('dev'), 2, 1, 2],
      [serverRowId('prod'), 2, 2, 2],
      [serverRowId('local'), 1, 2, 2],
    ]);
  });

  it('hides the servers of a collapsed group', () => {
    const rows = buildRows(input({ collapsed_groups: { g1: true } }));
    expect(rows.map((row) => row.id)).toEqual([groupRowId('g1'), serverRowId('local')]);
    expect(rows[0].expanded).toBe(false);
  });

  it('shows a loading row under an expanded server whose databases are not loaded yet', () => {
    const rows = buildRows(input({ expanded: { [serverRowId('local')]: true } }));
    expect(rows.at(-1)).toMatchObject({ parent_id: serverRowId('local'), level: 2, item: { type: 'loading' } });
  });

  it('shows the connection error under an expanded server that failed to connect', () => {
    const rows = buildRows(
      input({ expanded: { [serverRowId('local')]: true }, connections: { local: { status: 'failed', message: 'password authentication failed' } } }),
    );
    expect(rows.at(-1)).toMatchObject({ label: 'password authentication failed', item: { type: 'error', retry_id: serverRowId('local') } });
  });

  it('nests loaded catalog nodes, expanding only the ones marked expanded', () => {
    const orders = catalogNode('db:orders', 'orders');
    const postgres = catalogNode('db:postgres', 'postgres');
    const schema = catalogNode('db:orders/schema:1', 'public', false);
    const rows = buildRows(
      input({
        groups: [],
        servers: [server('local')],
        expanded: { [serverRowId('local')]: true, [nodeRowId('local', orders.key)]: true },
        children: {
          [childrenKey('local')]: { status: 'loaded', path: null, nodes: [orders, postgres] },
          [childrenKey('local', orders.key)]: { status: 'loaded', path: orders.children, nodes: [schema] },
        },
      }),
    );
    expect(rows.map((row) => [row.label, row.level, row.posinset, row.setsize, row.expandable])).toEqual([
      ['local', 1, 1, 1, true],
      ['orders', 2, 1, 2, true],
      ['public', 3, 1, 1, false],
      ['postgres', 2, 2, 2, true],
    ]);
  });
});

describe('chevron slots', () => {
  const column = (key: string): CatalogNode => ({ key, label: key, detail: null, icon: 'column', children: null });
  const loadedUnder = (nodes: Array<CatalogNode>) =>
    buildRows(
      input({
        groups: [],
        servers: [server('local')],
        expanded: { [serverRowId('local')]: true },
        children: { [childrenKey('local')]: { status: 'loaded', path: null, nodes } },
      }),
    ).slice(1);

  it('drops the chevron slot when no sibling can expand', () => {
    expect(loadedUnder([column('id'), column('name')]).map((row) => row.chevron_slot)).toEqual([false, false]);
  });

  it('keeps it for every sibling when any of them can expand, so icons stay aligned', () => {
    expect(loadedUnder([catalogNode('partitions', 'Partitions'), column('id')]).map((row) => row.chevron_slot)).toEqual([true, true]);
  });
});

describe('keyAction', () => {
  const rows = buildRows(input());

  it('moves up and down, and to the first and last rows', () => {
    expect(keyAction(rows, serverRowId('dev'), 'ArrowDown')).toEqual({ type: 'focus', id: serverRowId('prod') });
    expect(keyAction(rows, serverRowId('dev'), 'ArrowUp')).toEqual({ type: 'focus', id: groupRowId('g1') });
    expect(keyAction(rows, serverRowId('prod'), 'Home')).toEqual({ type: 'focus', id: groupRowId('g1') });
    expect(keyAction(rows, groupRowId('g1'), 'End')).toEqual({ type: 'focus', id: serverRowId('local') });
  });

  it('stays put past either end', () => {
    expect(keyAction(rows, serverRowId('local'), 'ArrowDown')).toBeNull();
    expect(keyAction(rows, groupRowId('g1'), 'ArrowUp')).toBeNull();
  });

  it('right expands a collapsed row, then moves into its first child', () => {
    expect(keyAction(rows, serverRowId('dev'), 'ArrowRight')).toEqual({ type: 'expand', id: serverRowId('dev') });
    expect(keyAction(rows, groupRowId('g1'), 'ArrowRight')).toEqual({ type: 'focus', id: serverRowId('dev') });
  });

  it('right does nothing on an open row with nothing inside it', () => {
    const empty_group = buildRows({ ...input(), groups: [{ id: 'empty', name: 'Empty' }], servers: [] });
    expect(keyAction(empty_group, groupRowId('empty'), 'ArrowRight')).toBeNull();
  });

  it('does nothing without rows', () => {
    expect(keyAction([], null, 'ArrowDown')).toBeNull();
  });

  it('left collapses an expanded row, otherwise moves to its parent', () => {
    expect(keyAction(rows, groupRowId('g1'), 'ArrowLeft')).toEqual({ type: 'collapse', id: groupRowId('g1') });
    expect(keyAction(rows, serverRowId('prod'), 'ArrowLeft')).toEqual({ type: 'focus', id: groupRowId('g1') });
    expect(keyAction(rows, serverRowId('local'), 'ArrowLeft')).toBeNull();
  });

  it('a letter jumps to the next row starting with it, wrapping around', () => {
    expect(keyAction(rows, groupRowId('g1'), 'p')).toEqual({ type: 'focus', id: serverRowId('prod') });
    expect(keyAction(rows, serverRowId('local'), 'O')).toEqual({ type: 'focus', id: groupRowId('g1') });
  });

  it('treats an unknown active row as the first row', () => {
    expect(keyAction(rows, 'gone', 'ArrowDown')).toEqual({ type: 'focus', id: serverRowId('dev') });
  });
});

describe('row layout', () => {
  it('wraps an error row to the lines its message needs at the sidebar width, and keeps other rows one line', () => {
    const base = { id: 'r', parent_id: null, setsize: 1, posinset: 1, expandable: false, expanded: false, chevron_slot: false };
    const error = (label: string, level = 1): TreeRow => ({ ...base, level, label, item: { type: 'error', message: label, retry_id: 'r' } });
    const plain: TreeRow = { ...base, level: 1, label: 'x'.repeat(300), item: { type: 'loading' } };

    expect(rowHeight(plain, 272)).toBe(24);
    expect(rowHeight(error('short'), 272)).toBe(24);
    expect(rowHeight(error('x'.repeat(60)), 272)).toBe(2 * 18 + 6);
    expect(rowHeight(error('x'.repeat(60)), 640)).toBe(24);
    expect(rowHeight(error('x'.repeat(20), 40), 272)).toBe(2 * 18 + 6);
  });

  it('lays rows out top to bottom and finds the row at any offset', () => {
    const rows = buildRows(input({ groups: [], servers: [server('a'), server('b')] }));
    const layout = rowLayout(rows, 272);

    expect(layout).toEqual({ tops: [0, 24], heights: [24, 24], total: 48 });
    expect([rowIndexAt(layout, 0), rowIndexAt(layout, 30), rowIndexAt(layout, 999)]).toEqual([0, 1, 1]);
    expect(rowIndexAt(rowLayout([], 272), 10)).toBe(0);
  });
});
