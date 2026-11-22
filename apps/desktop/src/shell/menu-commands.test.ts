import { emit } from '@tauri-apps/api/event';
import { describe, expect, it, vi } from 'vitest';
import { useDialogStore } from '../store/dialogs';
import { useWorkspaceStore } from '../store/workspace';
import { mockCommands } from '../testing/backend';
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
    await emit('menu', 'open_settings');
    expect(useDialogStore.getState().open).toEqual({ kind: 'settings' });
  });
});
