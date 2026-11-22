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
  setActive: (id: string) => void;
  expandRow: (row: TreeRow) => Promise<void>;
  collapseRow: (row: TreeRow) => void;
  refreshRow: (row: TreeRow) => Promise<void>;
  toggleSystem: () => void;
  forgetServer: (server_id: string) => void;
};

function without<T>(record: Readonly<Record<string, T>>, drop: (key: string) => boolean): Record<string, T> {
  return Object.fromEntries(Object.entries(record).filter(([key]) => !drop(key)));
}

export const useTreeStore = create<TreeState>()(
  persist(
    (set, get) => {
      const load = async (server_id: string, node_key: string, path: CatalogPath | null) => {
        const key = childrenKey(server_id, node_key);
        set((state) => ({ children: { ...state.children, [key]: { status: 'loading', path } } }));
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

      const openServer = async (server_id: string) => {
        const servers = useServerStore.getState();
        if (servers.connections[server_id]?.status !== 'connected') {
          await servers.connect(server_id);
          const connection = useServerStore.getState().connections[server_id];
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

      return {
        expanded: {},
        children: {},
        active_id: null,
        show_system: false,
        announcement: '',

        setActive: (id) => set({ active_id: id }),

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
            children: without(state.children, (key) => key.startsWith(childrenKey(server_id))),
            expanded: without(state.expanded, (key) => key === serverRowId(server_id) || key.startsWith(`${serverRowId(server_id)}|`)),
          })),
      };
    },
    {
      name: 'tidewater-tree',
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ show_system: state.show_system }),
    },
  ),
);
