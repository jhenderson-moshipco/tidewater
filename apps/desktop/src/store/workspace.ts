import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

export type WorkspaceView = 'explorer' | 'search' | 'files' | 'history' | 'performance';

export const sidebar_widths = { min: 200, max: 640, initial: 272 } as const;

type WorkspaceState = {
  active_view: WorkspaceView;
  sidebar_open: boolean;
  sidebar_width: number;
  /** opens the view or closes the sidebar when shown */
  selectView: (view: WorkspaceView) => void;
  /** shows the current vies */
  showView: (view: WorkspaceView) => void;
  toggleSidebar: () => void;
  setSidebarWidth: (width: number) => void;
};

export function clampSidebarWidth(width: number): number {
  return Math.min(sidebar_widths.max, Math.max(sidebar_widths.min, Math.round(width)));
}

export const useWorkspaceStore = create<WorkspaceState>()(
  persist(
    (set) => ({
      active_view: 'explorer',
      sidebar_open: true,
      sidebar_width: sidebar_widths.initial,
      selectView: (view) =>
        set((state) => ({
          active_view: view,
          sidebar_open: state.active_view === view ? !state.sidebar_open : true,
        })),
      showView: (view) => set({ active_view: view, sidebar_open: true }),
      toggleSidebar: () => set((state) => ({ sidebar_open: !state.sidebar_open })),
      setSidebarWidth: (width) => set({ sidebar_width: clampSidebarWidth(width) }),
    }),
    {
      name: 'tidewater-workspace',
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ sidebar_width: state.sidebar_width }),
    },
  ),
);
