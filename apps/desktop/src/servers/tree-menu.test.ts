import { describe, expect, it, vi } from 'vitest';
import type { TreeRow } from './tree-rows';
import { useDialogStore } from '../store/dialogs';
import { useServerStore } from '../store/servers';
import { useTreeStore } from '../store/tree';
import { catalogNode, commandsOf, group, mockCommands, server } from '../testing/backend';
import { disconnectServer, retryRow, rowMenu, showContextMenu } from './tree-menu';

const info = { server_id: 'orders-dev', database: 'orders', server_version: '17.2', encryption: null };

function row(item: TreeRow['item'], parent_id: string | null = null): TreeRow {
  return { id: 'row', parent_id, level: 1, setsize: 1, posinset: 1, label: 'row', expandable: false, expanded: false, chevron_slot: false, item };
}

type Entry = ReturnType<typeof rowMenu>[number];
const texts = (entries: Array<Entry>) => entries.map((entry) => (entry === 'separator' ? '—' : `${entry.text}${entry.enabled === false ? ' (off)' : ''}`));

function run(entries: Array<Entry>, text: string): void {
  const entry = entries.find((candidate) => candidate !== 'separator' && candidate.text === text);
  if (!entry || entry === 'separator') throw new Error(`No ${text} entry`);
  entry.action();
}

describe('showContextMenu', () => {
  it('does nothing outside the Tauri app or without entries', async () => {
    await showContextMenu([{ text: 'Refresh', action: () => undefined }]);
    const calls = mockCommands({});
    await showContextMenu([]);
    expect(calls).toEqual([]);
  });

  it('builds a native menu with separators and disabled entries, at the pointer or a given point', async () => {
    const calls = mockCommands({ 'plugin:menu|new': () => [1, 'menu'], 'plugin:menu|popup': () => null });

    await showContextMenu([{ text: 'Connect', action: () => undefined }, 'separator', { text: 'Refresh', enabled: false, action: () => undefined }]);
    await showContextMenu([{ text: 'Connect', action: () => undefined }], { x: 30, y: 40 });

    expect(commandsOf(calls)).toEqual(['plugin:menu|new', 'plugin:menu|popup', 'plugin:menu|new', 'plugin:menu|popup']);
    expect(calls[0].args).toMatchObject({
      kind: 'Menu',
      options: { items: [{ text: 'Connect', enabled: true }, { item: 'Separator' }, { text: 'Refresh', enabled: false }] },
    });
    expect(calls[1].args).toMatchObject({ at: null });
    expect(JSON.parse(JSON.stringify(calls[3].args))).toMatchObject({ at: { Logical: { x: 30, y: 40 } } });
  });
});

describe('rowMenu', () => {
  it('offers to rename or delete a group', () => {
    const entries = rowMenu(row({ type: 'group', group: group(), server_count: 2 }), []);
    expect(texts(entries)).toEqual(['Rename…', 'Delete Group…']);

    run(entries, 'Rename…');
    expect(useDialogStore.getState().open).toEqual({ kind: 'group', editing: group() });
    run(entries, 'Delete Group…');
    expect(useDialogStore.getState().open).toEqual({ kind: 'delete-group', group: group(), server_count: 2 });
  });

  it('offers to connect, edit or delete a closed server, with refresh off', () => {
    const expandRow = vi.fn(async () => undefined);
    useTreeStore.setState({ expandRow });
    const closed = row({ type: 'server', server: server(), connection: undefined });
    const entries = rowMenu(closed, []);
    expect(texts(entries)).toEqual(['Connect', 'Edit…', 'Delete…', '—', 'Refresh (off)']);

    run(entries, 'Connect');
    expect(expandRow).toHaveBeenCalledWith(closed);
    run(entries, 'Edit…');
    expect(useDialogStore.getState().open).toMatchObject({ kind: 'connection', editing: server() });
    run(entries, 'Delete…');
    expect(useDialogStore.getState().open).toEqual({ kind: 'delete-server', server: server() });
  });

  it('offers to disconnect or refresh a connected server', async () => {
    const refreshRow = vi.fn(async () => undefined);
    useTreeStore.setState({ refreshRow });
    const calls = mockCommands({ disconnect_server: () => null });
    const open = row({ type: 'server', server: server(), connection: { status: 'connected', info } });
    const entries = rowMenu(open, []);
    expect(texts(entries)).toEqual(['Disconnect', 'Edit…', 'Delete…', '—', 'Refresh']);

    run(entries, 'Refresh');
    expect(refreshRow).toHaveBeenCalledWith(open);
    run(entries, 'Disconnect');
    await vi.waitFor(() => expect(useTreeStore.getState().announcement).toBe('Disconnected from orders-dev'));
    expect(commandsOf(calls)).toEqual(['disconnect_server']);
  });

  it('offers to refresh a node that has children and to copy its name', () => {
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
    const refreshRow = vi.fn(async () => undefined);
    useTreeStore.setState({ refreshRow });
    const leaf = rowMenu(row({ type: 'node', server_id: 'orders-dev', node: catalogNode('col:id', 'id') }), []);
    const folder = rowMenu(row({ type: 'node', server_id: 'orders-dev', node: catalogNode('db:orders', 'orders', { level: 'database', database: 'orders' }) }), []);
    expect([texts(leaf), texts(folder)]).toEqual([['Refresh (off)', 'Copy Name'], ['Refresh', 'Copy Name']]);


    run(leaf, 'Copy Name');
    run(folder, 'Refresh');

    expect(writeText).toHaveBeenCalledWith('id');
    expect(refreshRow).toHaveBeenCalledTimes(1);
  });

  it('offers to retry an error and nothing for a loading row', async () => {
    const refreshRow = vi.fn(async () => undefined);
    useTreeStore.setState({ refreshRow });
    const parent = row({ type: 'loading' });
    const error = row({ type: 'error', message: 'connection closed', retry_id: 'row' }, 'row');
    const entries = rowMenu(error, [parent, error]);
    expect(texts(entries)).toEqual(['Retry']);
    expect(rowMenu(parent, [])).toEqual([]);

    run(entries, 'Retry');

    await vi.waitFor(() => expect(refreshRow).toHaveBeenCalledWith(parent));
  });
});

describe('retryRow', () => {
  it('does nothing when the row it belongs to is gone', async () => {
    const refreshRow = vi.fn(async () => undefined);
    useTreeStore.setState({ refreshRow });
    await retryRow(row({ type: 'error', message: 'gone', retry_id: 'missing' }, 'missing'), []);
    expect(refreshRow).not.toHaveBeenCalled();
  });
});

describe('disconnectServer', () => {
  it('closes the session, forgets its listings and announces it', async () => {
    useServerStore.setState({ connections: { 'orders-dev': { status: 'connected', info } } });
    useTreeStore.setState({ children: { 'orders-dev|': { status: 'loading', path: null } } });
    mockCommands({ disconnect_server: () => null });

    await disconnectServer('orders-dev', 'orders-dev');

    expect([useServerStore.getState().connections, useTreeStore.getState().children]).toEqual([{}, {}]);
  });
});
