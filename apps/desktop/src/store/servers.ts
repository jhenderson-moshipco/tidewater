import { isTauri } from '@tauri-apps/api/core';
import { create } from 'zustand';
import * as api from '../api/servers';
import { isCommandError, messageOf } from '../api/errors';
import type { ConnectionInfo } from '../generated/connections';
import type { GroupInput, ServerGroup, ServerInput, ServerSummary } from '../generated/servers';
import type { StoreStatusView } from '../generated/store';

export type ConnectionState =
  | { status: 'connecting'; started: number }
  | { status: 'connected'; info: ConnectionInfo }
  | { status: 'failed'; message: string };

type ServerState = {
  store: StoreStatusView | null;
  groups: Array<ServerGroup>;
  servers: Array<ServerSummary>;
  connections: Readonly<Record<string, ConnectionState>>;
  /** Whether the startup load has finished, so the workspace can replace the startup screen. */
  booted: boolean;
  /** The latest sentence for the explorer's status region. */
  announcement: string;
  /** Reads the lock state and, when unlocked, the saved servers. Called once at startup. */
  load: () => Promise<void>;
  unlock: (passphrase: string) => Promise<void>;
  startFresh: () => Promise<void>;
  saveServer: (input: ServerInput) => Promise<ServerSummary>;
  deleteServer: (id: string) => Promise<void>;
  saveGroup: (input: GroupInput) => Promise<ServerGroup>;
  deleteGroup: (id: string) => Promise<void>;
  connect: (id: string) => Promise<void>;
  /** Stops a connect that is still in progress. */
  cancelConnect: (id: string) => Promise<void>;
  disconnect: (id: string) => Promise<void>;
};

function withoutKey<T>(record: Readonly<Record<string, T>>, key: string): Record<string, T> {
  const next = { ...record };
  delete next[key];
  return next;
}

export const useServerStore = create<ServerState>()((set, get) => {
  const refresh = async () => {
    const store = await api.storeStatus();
    if (store.status !== 'unlocked') {
      set({ store, groups: [], servers: [] });
      return;
    }
    const list = await api.listServers();
    set({ store, groups: list.groups, servers: list.servers });
  };

  return {
    store: null,
    groups: [],
    servers: [],
    connections: {},
    booted: false,
    announcement: '',

    load: async () => {
      try {
        if (isTauri()) await refresh();
      } finally {
        set({ booted: true });
      }
    },

    unlock: async (passphrase) => {
      await api.unlockStore(passphrase);
      await refresh();
    },

    startFresh: async () => {
      await api.startFreshStore();
      await refresh();
    },

    saveServer: async (input) => {
      const saved = await api.saveServer(input);
      const servers = get().servers;
      const exists = servers.some((server) => server.id === saved.id);
      set({ servers: exists ? servers.map((server) => (server.id === saved.id ? saved : server)) : [...servers, saved] });
      return saved;
    },

    deleteServer: async (id) => {
      await api.deleteServer(id);
      set((state) => ({
        servers: state.servers.filter((server) => server.id !== id),
        connections: withoutKey(state.connections, id),
      }));
    },

    saveGroup: async (input) => {
      const saved = await api.saveGroup(input);
      const groups = get().groups;
      const exists = groups.some((group) => group.id === saved.id);
      set({ groups: exists ? groups.map((group) => (group.id === saved.id ? saved : group)) : [...groups, saved] });
      return saved;
    },

    deleteGroup: async (id) => {
      await api.deleteGroup(id);
      set((state) => ({
        groups: state.groups.filter((group) => group.id !== id),
        servers: state.servers.map((server) => (server.group_id === id ? { ...server, group_id: null } : server)),
      }));
    },

    connect: async (id) => {
      set((state) => ({ connections: { ...state.connections, [id]: { status: 'connecting', started: Date.now() } } }));
      const name = get().servers.find((server) => server.id === id)?.name ?? 'the server';
      try {
        const info = await api.connectServer(id);
        set((state) => ({ connections: { ...state.connections, [id]: { status: 'connected', info } }, announcement: `Connected to ${name}.` }));
      } catch (error) {
        if (isCommandError(error) && error.kind === 'cancelled') {
          set((state) => ({ connections: withoutKey(state.connections, id), announcement: `Stopped connecting to ${name}.` }));
          return;
        }
        set((state) => ({ connections: { ...state.connections, [id]: { status: 'failed', message: messageOf(error) } } }));
      }
    },

    cancelConnect: (id) => api.cancelConnect(id),

    disconnect: async (id) => {
      await api.disconnectServer(id);
      set((state) => ({ connections: withoutKey(state.connections, id) }));
    },
  };
});
