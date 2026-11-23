import { isTauri } from '@tauri-apps/api/core';
import { LogicalPosition } from '@tauri-apps/api/dpi';
import { Menu } from '@tauri-apps/api/menu';
import { capitalized, type_labels } from '../objects/describe';
import { createFromRow, creatableObject, dropRow, editRow, editableObject } from '../objects/open-editor';
import { useDialogStore } from '../store/dialogs';
import { useServerStore } from '../store/servers';
import { useTreeStore } from '../store/tree';
import { useWorkspaceStore } from '../store/workspace';
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

function titleCase(text: string): string {
  return text.split(' ').map(capitalized).join(' ');
}

/** A node's entries for editing, dropping or creating objects, each also offered in the place Settings doesn't pick. */
function editorEntries(row: TreeRow, rows: ReadonlyArray<TreeRow>): Array<MenuEntry> {
  const other = useWorkspaceStore.getState().object_editor_host === 'dialog' ? 'tab' : 'dialog';
  const in_other = other === 'tab' ? 'in Tab' : 'in Dialog';
  const entries: Array<MenuEntry> = [];
  if (editableObject(row)) {
    entries.push(
      { text: 'Edit…', action: () => editRow(row) },
      { text: `Edit ${in_other}`, action: () => editRow(row, other) },
      { text: 'Drop…', action: () => dropRow(row) },
    );
  }
  const created = creatableObject(row, rows);
  if (created) {
    const type = titleCase(type_labels[created.object_type]);
    entries.push(
      { text: `New ${type}…`, action: () => createFromRow(row, rows) },
      { text: `New ${type} ${in_other}`, action: () => createFromRow(row, rows, other) },
    );
  }
  return entries.length > 0 ? [...entries, 'separator'] : entries;
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
        ...editorEntries(row, rows),
        { text: 'Refresh', enabled: connected, action: () => void tree.refreshRow(row) },
      ];
    }
    case 'node':
      return [
        ...editorEntries(row, rows),
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
