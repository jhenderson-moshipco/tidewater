import { isTauri } from '@tauri-apps/api/core';
import { LogicalPosition } from '@tauri-apps/api/dpi';
import { Menu } from '@tauri-apps/api/menu';
import { useDialogStore } from '../store/dialogs';
import { useServerStore } from '../store/servers';
import { useTreeStore } from '../store/tree';
import type { TreeRow } from './tree-rows';

type MenuEntry = { text: string; action: () => void; enabled?: boolean } | 'separator';

/** Opens the OS's own context menu, at `at` (window coordinates) or at the pointer. */
export async function showContextMenu(entries: Array<MenuEntry>, at?: { x: number; y: number }): Promise<void> {
  if (!isTauri() || entries.length === 0) return;
  const menu = await Menu.new({
    items: entries.map((entry) =>
      entry === 'separator' ? { item: 'Separator' as const } : { text: entry.text, enabled: entry.enabled ?? true, action: entry.action },
    ),
  });
  await menu.popup(at ? new LogicalPosition(at.x, at.y) : undefined);
}

export async function disconnectServer(server_id: string, name: string): Promise<void> {
  await useServerStore.getState().disconnect(server_id);
  useTreeStore.getState().forgetServer(server_id);
  useTreeStore.setState({ announcement: `Disconnected from ${name}` });
}

/** The context menu entries for a row; the same actions the keyboard shortcuts reach. */
export function rowMenu(row: TreeRow, rows: ReadonlyArray<TreeRow>): Array<MenuEntry> {
  const tree = useTreeStore.getState();
  const dialogs = useDialogStore.getState();
  const item = row.item;

  switch (item.type) {
    case 'group':
      return [
        { text: 'Rename…', action: () => dialogs.show({ kind: 'group', editing: item.group }) },
        { text: 'Delete Group…', action: () => dialogs.show({ kind: 'delete-group', group: item.group, server_count: item.server_count }) },
      ];
    case 'server': {
      const status = item.connection?.status;
      const connected = status === 'connected';
      const first: MenuEntry =
        status === 'connecting'
          ? { text: 'Cancel Connecting', action: () => void useServerStore.getState().cancelConnect(item.server.id) }
          : connected
            ? { text: 'Disconnect', action: () => void disconnectServer(item.server.id, item.server.name) }
            : { text: 'Connect', action: () => void tree.expandRow(row) };
      return [
        first,
        { text: 'Edit…', action: () => useDialogStore.getState().openConnection(item.server) },
        { text: 'Delete…', action: () => dialogs.show({ kind: 'delete-server', server: item.server }) },
        'separator',
        { text: 'Refresh', enabled: connected, action: () => void tree.refreshRow(row) },
      ];
    }
    case 'node':
      return [
        { text: 'Refresh', enabled: item.node.children !== null, action: () => void tree.refreshRow(row) },
        { text: 'Copy Name', action: () => void navigator.clipboard.writeText(item.node.label) },
      ];
    case 'error':
      return [{ text: 'Retry', action: () => void retryRow(row, rows) }];
    case 'loading':
      return [];
  }
}

/** Retries the load an error row reports by refreshing the row it belongs to; for a server that reconnects. */
export async function retryRow(row: TreeRow, rows: ReadonlyArray<TreeRow>): Promise<void> {
  const parent = rows.find((candidate) => candidate.id === row.parent_id);
  if (parent) await useTreeStore.getState().refreshRow(parent);
}
