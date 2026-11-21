import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

type ExplorerState = {
  collapsed_groups: Readonly<Record<string, true>>;
  toggleGroup: (id: string) => void;
};

export const useExplorerStore = create<ExplorerState>()(
  persist(
    (set) => ({
      collapsed_groups: {},
      toggleGroup: (id) =>
        set((state) => {
          const next = { ...state.collapsed_groups };
          if (next[id]) delete next[id];
          else next[id] = true;
          return { collapsed_groups: next };
        }),
    }),
    { name: 'tidewater-explorer', storage: createJSONStorage(() => sessionStorage) },
  ),
);
