import type { CatalogNode, CatalogPath } from '../generated/catalog';
import type { ServerGroup, ServerSummary } from '../generated/servers';
import type { ConnectionState } from '../store/servers';

export type LoadedChildren =
  | { status: 'loading'; path: CatalogPath | null }
  | { status: 'loaded'; path: CatalogPath | null; nodes: Array<CatalogNode> }
  | { status: 'failed'; path: CatalogPath | null; message: string };

export type RowItem =
  | { type: 'group'; group: ServerGroup; server_count: number }
  | { type: 'server'; server: ServerSummary; connection: ConnectionState | undefined }
  | { type: 'node'; server_id: string; node: CatalogNode }
  | { type: 'loading' }
  | { type: 'error'; message: string; retry_id: string };

export type TreeRow = {
  id: string;
  parent_id: string | null;
  level: number;
  setsize: number;
  posinset: number;
  label: string;
  expandable: boolean;
  expanded: boolean;
  /** Whether the row keeps room for a chevron: false only when none of its siblings can expand. */
  chevron_slot: boolean;
  item: RowItem;
};

export type TreeInput = {
  groups: ReadonlyArray<ServerGroup>;
  servers: ReadonlyArray<ServerSummary>;
  connections: Readonly<Record<string, ConnectionState>>;
  collapsed_groups: Readonly<Record<string, true>>;
  expanded: Readonly<Record<string, true>>;
  children: Readonly<Record<string, LoadedChildren>>;
};

export function groupRowId(group_id: string): string {
  return `group:${group_id}`;
}

export function serverRowId(server_id: string): string {
  return `server:${server_id}`;
}

/** The cache key for a server's children, or a catalog node's children when `node_key` is given. */
export function childrenKey(server_id: string, node_key = ''): string {
  return `${server_id}|${node_key}`;
}

export function nodeRowId(server_id: string, node_key: string): string {
  return `server:${server_id}|${node_key}`;
}

type Draft = Omit<TreeRow, 'setsize' | 'posinset' | 'chevron_slot'>;

function appendSiblings(rows: Array<TreeRow>, siblings: Array<{ row: Draft; descendants: Array<TreeRow> }>): void {
  const chevron_slot = siblings.some((sibling) => sibling.row.expandable);
  siblings.forEach((sibling, index) => {
    rows.push({ ...sibling.row, setsize: siblings.length, posinset: index + 1, chevron_slot });
    rows.push(...sibling.descendants);
  });
}

function catalogRows(input: TreeInput, server_id: string, node_key: string, parent_id: string, level: number): Array<TreeRow> {
  const loaded = input.children[childrenKey(server_id, node_key)];
  const rows: Array<TreeRow> = [];
  if (!loaded || loaded.status === 'loading') {
    appendSiblings(rows, [{ row: { id: `${parent_id}|loading`, parent_id, level, label: 'Loading…', expandable: false, expanded: false, item: { type: 'loading' } }, descendants: [] }]);
    return rows;
  }
  if (loaded.status === 'failed') {
    const row: Draft = {
      id: `${parent_id}|error`,
      parent_id,
      level,
      label: loaded.message,
      expandable: false,
      expanded: false,
      item: { type: 'error', message: loaded.message, retry_id: parent_id },
    };
    appendSiblings(rows, [{ row, descendants: [] }]);
    return rows;
  }
  appendSiblings(
    rows,
    loaded.nodes.map((node) => {
      const id = nodeRowId(server_id, node.key);
      const expandable = node.children !== null;
      const expanded = expandable && input.expanded[id] === true;
      return {
        row: { id, parent_id, level, label: node.label, expandable, expanded, item: { type: 'node', server_id, node } },
        descendants: expanded ? catalogRows(input, server_id, node.key, id, level + 1) : [],
      };
    }),
  );
  return rows;
}

function serverEntry(input: TreeInput, server: ServerSummary, parent_id: string | null, level: number) {
  const id = serverRowId(server.id);
  const connection = input.connections[server.id];
  const expanded = input.expanded[id] === true;
  let descendants: Array<TreeRow> = [];
  if (expanded && connection?.status === 'failed') {
    const row: Draft = {
      id: `${id}|error`,
      parent_id: id,
      level: level + 1,
      label: connection.message,
      expandable: false,
      expanded: false,
      item: { type: 'error', message: connection.message, retry_id: id },
    };
    appendSiblings(descendants, [{ row, descendants: [] }]);
  } else if (expanded) {
    descendants = catalogRows(input, server.id, '', id, level + 1);
  }
  const row: Draft = { id, parent_id, level, label: server.name, expandable: true, expanded, item: { type: 'server', server, connection } };
  return { row, descendants };
}

/** Flattens groups, servers and loaded catalog nodes into the rows the tree shows, in order. */
export function buildRows(input: TreeInput): Array<TreeRow> {
  const top: Array<{ row: Draft; descendants: Array<TreeRow> }> = [];
  for (const group of input.groups) {
    const id = groupRowId(group.id);
    const members = input.servers.filter((server) => server.group_id === group.id);
    const expanded = input.collapsed_groups[group.id] !== true;
    const descendants: Array<TreeRow> = [];
    if (expanded) appendSiblings(descendants, members.map((server) => serverEntry(input, server, id, 2)));
    top.push({
      row: { id, parent_id: null, level: 1, label: group.name, expandable: true, expanded, item: { type: 'group', group, server_count: members.length } },
      descendants,
    });
  }
  for (const server of input.servers.filter((candidate) => candidate.group_id === null)) {
    top.push(serverEntry(input, server, null, 1));
  }
  const rows: Array<TreeRow> = [];
  appendSiblings(rows, top);
  return rows;
}

export type TreeAction = { type: 'focus' | 'expand' | 'collapse'; row: TreeRow };

/** What a key press does to the tree, following the WAI-ARIA tree pattern. Returns null for keys the tree ignores. */
export function keyAction(rows: ReadonlyArray<TreeRow>, active_id: string | null, key: string): TreeAction | null {
  if (rows.length === 0) return null;
  const index = Math.max(0, rows.findIndex((row) => row.id === active_id));
  const row = rows[index];
  const focus = (target: TreeRow | undefined): TreeAction | null => (target ? { type: 'focus', row: target } : null);

  switch (key) {
    case 'ArrowDown':
      return focus(rows[index + 1]);
    case 'ArrowUp':
      return focus(rows[index - 1]);
    case 'Home':
      return focus(rows[0]);
    case 'End':
      return focus(rows[rows.length - 1]);
    case 'ArrowRight':
      if (row.expandable && !row.expanded) return { type: 'expand', row };
      if (row.expanded && rows[index + 1]?.parent_id === row.id) return focus(rows[index + 1]);
      return null;
    case 'ArrowLeft':
      if (row.expanded) return { type: 'collapse', row };
      return focus(rows.find((candidate) => candidate.id === row.parent_id));
  }

  if (key.length === 1 && key.trim() !== '') {
    const letter = key.toLowerCase();
    const ordered = [...rows.slice(index + 1), ...rows.slice(0, index + 1)];
    return focus(ordered.find((candidate) => candidate.label.toLowerCase().startsWith(letter)));
  }
  return null;
}
