import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { messageOf } from '../api/errors';
import { catalogChildren } from '../api/catalog';
import type { CatalogPath } from '../generated/catalog';
import { childrenKey, nodeRowId, serverRowId, type LoadedChildren, type TreeRow } from '../servers/tree-rows';
import { useExplorerStore } from './explorer';
import { useServerStore } from './servers';

type TreeState = {
  expanded: Readonly<Record<string, true>>;
  children: Readonly<Record<string, LoadedChildren>>;
  active_id: string | null;
  show_system: boolean;
  /** The latest sentence for the tree's status region. */
  announcement: string;
  /** Servers connected through the tree, kept so the next launch reconnects them. */
  open_servers: ReadonlyArray<string>;
  setActive: (id: string) => void;
  /** Reconnects the servers that were open at the last quit and reopens their expanded rows. */
  reopen: () => Promise<void>;
  expandRow: (row: TreeRow) => Promise<void>;
  collapseRow: (row: TreeRow) => void;
  refreshRow: (row: TreeRow) => Promise<void>;
  /** Reloads every listing shown under a database in place, as after a change to its objects. */
  refreshDatabase: (server_id: string, database: string) => Promise<void>;
  toggleSystem: () => void;
  forgetServer: (server_id: string) => void;
};

function without<T>(record: Readonly<Record<string, T>>, drop: (key: string) => boolean): Record<string, T> {
  return Object.fromEntries(Object.entries(record).filter(([key]) => !drop(key)));
}

export const useTreeStore = create<TreeState>()(
  persist(
    (set, get) => {
      /** Loads a node's children; `in_place` keeps the current ones on screen until the new ones arrive. */
      const load = async (server_id: string, node_key: string, path: CatalogPath | null, in_place = false) => {
        const key = childrenKey(server_id, node_key);
        if (!in_place) set((state) => ({ children: { ...state.children, [key]: { status: 'loading', path } } }));
        try {
          const nodes = await catalogChildren(server_id, path, get().show_system);
          set((state) => ({ children: { ...state.children, [key]: { status: 'loaded', path, nodes } } }));
        } catch (error) {
          const message = messageOf(error);
          set((state) => ({ children: { ...state.children, [key]: { status: 'failed', path, message } }, announcement: message }));
        }
      };

      const expandSavedDatabase = async (server_id: string) => {
        const server = useServerStore.getState().servers.find((candidate) => candidate.id === server_id);
        const loaded = get().children[childrenKey(server_id)];
        if (!server || loaded?.status !== 'loaded') return;
        const saved = loaded.nodes.find((node) => node.children?.level === 'database' && node.children.database === server.database);
        if (!saved) return;
        set((state) => ({ expanded: { ...state.expanded, [nodeRowId(server_id, saved.key)]: true } }));
        await load(server_id, saved.key, saved.children);
      };

      const markOpen = (server_id: string, open: boolean) =>
        set((state) => {
          const others = state.open_servers.filter((id) => id !== server_id);
          return { open_servers: open ? [...others, server_id] : others };
        });

      /** Connects the server, keeping it in the reconnect list only once it is connected. */
      const connectServer = async (server_id: string) => {
        await useServerStore.getState().connect(server_id);
        const connection = useServerStore.getState().connections[server_id];
        markOpen(server_id, connection?.status === 'connected');
        return connection;
      };

      const openServer = async (server_id: string) => {
        if (useServerStore.getState().connections[server_id]?.status !== 'connected') {
          const connection = await connectServer(server_id);
          const name = useServerStore.getState().servers.find((server) => server.id === server_id)?.name ?? 'server';
          if (connection?.status === 'failed') {
            set({ announcement: connection.message });
            return;
          }
          if (connection?.status !== 'connected') {
            set((state) => ({
              expanded: without(state.expanded, (key) => key === serverRowId(server_id)),
              announcement: `Stopped connecting to ${name}`,
            }));
            return;
          }
          set({ announcement: `Connected to ${name}` });
        }
        if (get().children[childrenKey(server_id)]?.status !== 'loaded') {
          await load(server_id, '', null);
          await expandSavedDatabase(server_id);
        }
      };

      /** The catalog node with this key among the server's loaded listings. */
      const nodeOf = (server_id: string, node_key: string) =>
        Object.entries(get().children)
          .filter(([key]) => key.startsWith(childrenKey(server_id)))
          .flatMap(([, loaded]) => (loaded.status === 'loaded' ? loaded.nodes : []))
          .find((node) => node.key === node_key);

      /** Loads each expanded row under the server whose listing isn't loaded, level by level. */
      const reopenRows = async (server_id: string) => {
        const prefix = `${serverRowId(server_id)}|`;
        for (let opened = true; opened; ) {
          opened = false;
          for (const key of Object.keys(get().expanded).filter((candidate) => candidate.startsWith(prefix))) {
            const node_key = key.slice(prefix.length);
            const node = nodeOf(server_id, node_key);
            if (get().children[childrenKey(server_id, node_key)] || !node?.children) continue;
            await load(server_id, node_key, node.children);
            opened = true;
          }
        }
      };

      return {
        expanded: {},
        children: {},
        active_id: null,
        show_system: false,
        announcement: '',
        open_servers: [],

        setActive: (id) => set({ active_id: id }),

        reopen: async () => {
          const servers = useServerStore.getState();
          if (servers.store?.status !== 'unlocked') return;
          const known = new Set(servers.servers.map((server) => server.id));
          const ids = get().open_servers.filter((id) => known.has(id));
          const kept = (key: string) => !key.startsWith('server:') || ids.some((id) => key === serverRowId(id) || key.startsWith(`${serverRowId(id)}|`));
          set((state) => ({ open_servers: ids, expanded: without(state.expanded, (key) => !kept(key)) }));
          await Promise.all(
            ids.map(async (id) => {
              if (!get().expanded[serverRowId(id)]) {
                await connectServer(id);
                return;
              }
              await openServer(id);
              await reopenRows(id);
            }),
          );
        },

        expandRow: async (row) => {
          const item = row.item;
          if (item.type === 'group') {
            if (!row.expanded) useExplorerStore.getState().toggleGroup(item.group.id);
            return;
          }
          if (item.type !== 'server' && item.type !== 'node') return;
          set((state) => ({ expanded: { ...state.expanded, [row.id]: true } }));
          if (item.type === 'server') {
            await openServer(item.server.id);
            return;
          }
          if (get().children[childrenKey(item.server_id, item.node.key)]?.status !== 'loaded') {
            await load(item.server_id, item.node.key, item.node.children);
          }
        },

        collapseRow: (row) => {
          if (row.item.type === 'group') {
            if (row.expanded) useExplorerStore.getState().toggleGroup(row.item.group.id);
            return;
          }
          set((state) => ({ expanded: without(state.expanded, (key) => key === row.id) }));
        },

        refreshRow: async (row) => {
          const item = row.item;
          if (item.type === 'server') {
            set((state) => ({ children: without(state.children, (key) => key.startsWith(childrenKey(item.server.id))) }));
            if (row.expanded) await openServer(item.server.id);
            return;
          }
          if (item.type === 'node' && item.node.children) {
            const key = childrenKey(item.server_id, item.node.key);
            set((state) => ({ children: without(state.children, (candidate) => candidate === key || candidate.startsWith(`${key}/`)) }));
            if (row.expanded) await load(item.server_id, item.node.key, item.node.children);
          }
        },

        refreshDatabase: async (server_id, database) => {
          const database_key = childrenKey(server_id, `db:${database}`);
          const listings = Object.entries(get().children).filter(
            ([key, loaded]) => (key === database_key || key.startsWith(`${database_key}/`)) && loaded.status !== 'loading',
          );
          await Promise.all(listings.map(([key, loaded]) => load(server_id, key.slice(server_id.length + 1), loaded.path, true)));
        },

        toggleSystem: () => {
          const show_system = !get().show_system;
          set({ show_system, announcement: show_system ? 'Showing system objects' : 'Hiding system objects' });
          for (const [key, loaded] of Object.entries(get().children)) {
            if (loaded.path?.level !== 'database') continue;
            const [server_id, node_key] = key.split('|');
            void load(server_id, node_key, loaded.path);
          }
        },

        forgetServer: (server_id) =>
          set((state) => ({
            open_servers: state.open_servers.filter((id) => id !== server_id),
            children: without(state.children, (key) => key.startsWith(childrenKey(server_id))),
            expanded: without(state.expanded, (key) => key === serverRowId(server_id) || key.startsWith(`${serverRowId(server_id)}|`)),
          })),
      };
    },
    {
      name: 'tidewater-tree',
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ show_system: state.show_system, expanded: state.expanded, open_servers: state.open_servers }),
    },
  ),
);
