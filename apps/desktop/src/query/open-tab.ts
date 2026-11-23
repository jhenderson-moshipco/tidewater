import { useDialogStore } from '../store/dialogs';
import { useQueryTabStore } from '../store/query-tabs';
import { useServerStore } from '../store/servers';
import { useTreeStore } from '../store/tree';
import { explorerConnection } from './default-connection';

/** Opens a query tab on the explorer's selection, else the active tab's connection, else asks for one. */
export function openNewTab(): void {
  const tree = useTreeStore.getState();
  const tabs = useQueryTabStore.getState();
  const selected = explorerConnection({ active_id: tree.active_id, servers: useServerStore.getState().servers, children: tree.children });
  const connection = selected ?? (tabs.active_id ? tabs.tabs[tabs.active_id]?.connection : null) ?? null;
  const id = tabs.openTab(connection);
  if (!connection) useDialogStore.getState().show({ kind: 'pick-connection', tab_id: id, then_run: null });
}
