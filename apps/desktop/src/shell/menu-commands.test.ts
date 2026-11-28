import { emit } from '@tauri-apps/api/event';
import { describe, expect, it, vi } from 'vitest';
import { useDialogStore } from '../store/dialogs';
import { useQueryTabStore } from '../store/query-tabs';
import { useTreeStore } from '../store/tree';
import { useWorkspaceStore } from '../store/workspace';
import { commandsOf, mockCommands, runResult } from '../testing/backend';
import { listenToMenuCommands } from './menu-commands';

const workspace = () => useWorkspaceStore.getState();

describe('menu commands', () => {
  it('are not listened for outside the Tauri app', () => {
    expect(() => listenToMenuCommands()).not.toThrow();
  });

  it('switch views, toggle the sidebar and open a new connection', async () => {
    mockCommands({ key_storage: () => 'file' });
    listenToMenuCommands();
    await vi.waitFor(async () => {
      await emit('menu', 'view_search');
      expect(workspace().active_view).toBe('search');
    });

    await emit('menu', 'toggle_sidebar');
    expect(workspace().sidebar_open).toBe(false);
    await emit('menu', 'view_history');
    expect([workspace().active_view, workspace().sidebar_open]).toEqual(['history', true]);
    await emit('menu', 'settings');
    expect(workspace().active_view).toBe('history');
    await emit('menu', 'new_connection');
    expect(useDialogStore.getState().open).toEqual({ kind: 'connection', editing: null });
    await emit('menu', 'toggle_system_objects');
    expect(useTreeStore.getState().show_system).toBe(true);
    await emit('menu', 'open_settings');
    expect(useDialogStore.getState().open).toEqual({ kind: 'settings' });
  });

  it('open a query tab, and run or cancel on the active tab only when there is one', async () => {
    const calls = mockCommands({ split_statements: () => [{ from: 0, to: 8 }], run_query: () => runResult([]), cancel_query: () => null });
    listenToMenuCommands();
    await vi.waitFor(async () => {
      await emit('menu', 'new_query_tab');
      expect(useQueryTabStore.getState().order).toHaveLength(1);
    });
    const tabs = useQueryTabStore.getState();
    const id = tabs.active_id as string;
    tabs.setConnection(id, { server_id: 'orders-dev', database: 'orders' });
    tabs.setText(id, 'SELECT 1');

    await emit('menu', 'run_statement');
    await vi.waitFor(() => expect(useQueryTabStore.getState().tabs[id]?.result).not.toBeNull());
    await emit('menu', 'run_all');
    await vi.waitFor(() => expect(commandsOf(calls)).toEqual(['split_statements', 'run_query', 'run_query']));
    await emit('menu', 'cancel_query');
    await vi.waitFor(() => expect(commandsOf(calls)).toHaveLength(4));

    useQueryTabStore.setState({ active_id: null });
    const tab_commands = ['run_statement', 'run_all', 'cancel_query', 'save_query', 'save_query_as', 'close_tab'];
    for (const command of [...tab_commands, 'begin_transaction', 'commit_transaction', 'rollback_transaction', 'find', 'format_sql']) {
      await emit('menu', command);
    }
    expect([commandsOf(calls).length, useQueryTabStore.getState().order]).toEqual([4, [id]]);
  });

  it('open a .sql file, and save or save as the active tab', async () => {
    const calls = mockCommands({ 'plugin:dialog|open': () => null, 'plugin:dialog|save': () => null });
    listenToMenuCommands();
    await vi.waitFor(async () => {
      await emit('menu', 'open_sql_file');
      expect(commandsOf(calls)).toEqual(['plugin:dialog|open']);
    });
    useQueryTabStore.getState().openTab(null);

    await emit('menu', 'save_query');
    await emit('menu', 'save_query_as');

    await vi.waitFor(() => expect(commandsOf(calls)).toEqual(['plugin:dialog|open', 'plugin:dialog|save', 'plugin:dialog|save']));
  });

  it('begin, commit and roll back the active tab, and close it', async () => {
    const calls = mockCommands({ transaction_control: () => ({ transaction: 'idle', results_closed: false, notices: [] }), close_query_tab: () => null });
    listenToMenuCommands();
    const tabs = useQueryTabStore.getState();
    const id = tabs.openTab({ server_id: 'orders-dev', database: 'orders' });

    await vi.waitFor(async () => {
      await emit('menu', 'begin_transaction');
      expect(commandsOf(calls)).toHaveLength(1);
    });
    await emit('menu', 'commit_transaction');
    await vi.waitFor(() => expect(commandsOf(calls)).toHaveLength(2));
    await emit('menu', 'rollback_transaction');
    await vi.waitFor(() => expect(calls.map((call) => (call.args as { action: string }).action)).toEqual(['begin', 'commit', 'rollback']));
    await emit('menu', 'close_tab');

    await vi.waitFor(() => expect(useQueryTabStore.getState().tabs[id]).toBeUndefined());
  });
});
