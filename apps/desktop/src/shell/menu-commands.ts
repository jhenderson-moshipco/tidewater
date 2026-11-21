import { isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useWorkspaceStore, type WorkspaceView } from '../store/workspace';

const menu_views: Readonly<Record<string, WorkspaceView>> = {
  view_explorer: 'explorer',
  view_search: 'search',
  view_files: 'files',
  view_history: 'history',
  view_performance: 'performance',
};

/**
 * id that allows the client to consume the events defined in Rust.
 * @param id 
 * @returns 
 */
function applyMenuCommand(id: string): void {
  const workspace = useWorkspaceStore.getState();
  if (id === 'toggle_sidebar') {
    workspace.toggleSidebar();
    return;
  }
  const view = menu_views[id];
  if (view) workspace.showView(view);
}

/**
 * Menu command subscription. Rust forwards `menu` events.
 * This is defined one time.
 * @returns 
 */
export function listenToMenuCommands(): void {
  /** check of tauri is loaded before trying to listen */
  if (!isTauri()) return;
  void listen<string>('menu', (event) => applyMenuCommand(event.payload));
}
