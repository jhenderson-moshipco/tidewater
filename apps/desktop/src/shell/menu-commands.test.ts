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
    mockCommands({});
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
    for (const command of ['run_statement', 'run_all', 'cancel_query']) await emit('menu', command);
    expect(commandsOf(calls)).toHaveLength(4);
  });
});
