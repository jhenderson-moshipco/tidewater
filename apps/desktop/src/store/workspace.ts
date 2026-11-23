import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

export type WorkspaceView = 'explorer' | 'search' | 'files' | 'history' | 'performance';
/** Where an object editor opens unless the user picks the other place. */
export type EditorHost = 'dialog' | 'tab';

export const sidebar_widths = { min: 200, max: 640, initial: 272 } as const;
export const results_heights = { min: 120, max: 800, initial: 320 } as const;

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
  results_height: number;
  setResultsHeight: (height: number) => void;
  object_editor_host: EditorHost;
  setObjectEditorHost: (host: EditorHost) => void;
};

export function clampSidebarWidth(width: number): number {
  return Math.min(sidebar_widths.max, Math.max(sidebar_widths.min, Math.round(width)));
}

export function clampResultsHeight(height: number): number {
  return Math.min(results_heights.max, Math.max(results_heights.min, Math.round(height)));
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
      results_height: results_heights.initial,
      setResultsHeight: (height) => set({ results_height: clampResultsHeight(height) }),
      object_editor_host: 'dialog',
      setObjectEditorHost: (host) => set({ object_editor_host: host }),
    }),
    {
      name: 'tidewater-workspace',
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        sidebar_width: state.sidebar_width,
        results_height: state.results_height,
        object_editor_host: state.object_editor_host,
      }),
    },
  ),
);
