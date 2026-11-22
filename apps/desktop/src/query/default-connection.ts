import type { ServerSummary } from '../generated/servers';
import type { LoadedChildren } from '../servers/tree-rows';

export type TabConnection = { server_id: string; database: string };

type ExplorerSelection = {
  active_id: string | null;
  servers: ReadonlyArray<ServerSummary>;
  children: Readonly<Record<string, LoadedChildren>>;
};

function databaseOf(children: ExplorerSelection['children'], server_id: string, node_key: string): string | undefined {
  for (const [key, loaded] of Object.entries(children)) {
    if (!key.startsWith(`${server_id}|`) || loaded.status !== 'loaded') continue;
    const node = loaded.nodes.find((candidate) => candidate.key === node_key);
    if (node) return loaded.path?.database ?? node.children?.database;
  }
  return undefined;
}

/** The server and database of the explorer's active row, or `null` when no server row or object is active. */
export function explorerConnection(selection: ExplorerSelection): TabConnection | null {
  if (!selection.active_id?.startsWith('server:')) return null;
  const [server_part, node_key] = selection.active_id.slice('server:'.length).split('|') as [string, string | undefined];
  const server = selection.servers.find((candidate) => candidate.id === server_part);
  if (!server) return null;
  const database = node_key === undefined ? server.database : databaseOf(selection.children, server.id, node_key);
  return { server_id: server.id, database: database ?? server.database };
}
