import { isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { openNewTab } from '../query/open-tab';
import { openSqlFile, saveTab } from '../query/tab-files';
import { useDialogStore } from '../store/dialogs';
import { useQueryTabStore } from '../store/query-tabs';
import { useTreeStore } from '../store/tree';
import { useSettingsStore } from '../store/settings';
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
  if (id === 'toggle_system_objects') {
    useTreeStore.getState().toggleSystem();
    return;
  }
  if (id === 'new_connection') {
    useDialogStore.getState().openConnection(null);
    return;
  }
  if (id === 'open_settings') {
    void useSettingsStore.getState().open();
    return;
  }
  if (id === 'toggle_sidebar') {
    workspace.toggleSidebar();
    return;
  }
  if (id === 'new_query_tab') {
    openNewTab();
    return;
  }
  if (id === 'open_sql_file') {
    void openSqlFile();
    return;
  }
  const tabs = useQueryTabStore.getState();
  const active = tabs.active_id;
  if (active && id === 'run_statement') return void tabs.run(active, 'statement');
  if (active && id === 'run_all') return void tabs.run(active, 'all');
  if (active && id === 'cancel_query') return void tabs.cancel(active);
  if (active && id === 'save_query') return void saveTab(active);
  if (active && id === 'save_query_as') return void saveTab(active, { as: true });
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
