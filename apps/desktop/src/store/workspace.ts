import { create } from 'zustand';

export type WorkspaceView = 'explorer' | 'search' | 'files' | 'history' | 'performance';

type WorkspaceState = {
  active_view: WorkspaceView;
  sidebar_open: boolean;
  /** opens the view or closes the sidebar when shown */
  selectView: (view: WorkspaceView) => void;
  /** shows the current vies */
  showView: (view: WorkspaceView) => void;
  toggleSidebar: () => void;
};

export const useWorkspaceStore = create<WorkspaceState>()((set) => ({
  active_view: 'explorer',
  sidebar_open: true,
  selectView: (view) =>
    set((state) => ({
      active_view: view,
      sidebar_open: state.active_view === view ? !state.sidebar_open : true,
    })),
  showView: (view) => set({ active_view: view, sidebar_open: true }),
  toggleSidebar: () => set((state) => ({ sidebar_open: !state.sidebar_open })),
}));
