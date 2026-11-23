import { buildRows, type TreeRow } from '../servers/tree-rows';
import { useExplorerStore } from '../store/explorer';
import { useServerStore } from '../store/servers';
import { useTreeStore } from '../store/tree';

/** The rows the tree shows for the current store state. */
export function currentRows(): Array<TreeRow> {
  const servers = useServerStore.getState();
  const tree = useTreeStore.getState();
  return buildRows({
    groups: servers.groups,
    servers: servers.servers,
    connections: servers.connections,
    collapsed_groups: useExplorerStore.getState().collapsed_groups,
    expanded: tree.expanded,
    children: tree.children,
  });
}

/** The row with `id`, failing the test when the tree doesn't show it. */
export function rowWithId(id: string): TreeRow {
  const row = currentRows().find((candidate) => candidate.id === id);
  if (!row) throw new Error(`The tree has no row ${id}`);
  return row;
}
