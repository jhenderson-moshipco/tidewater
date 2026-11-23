import { cleanup } from '@testing-library/react';
import { clearMocks } from '@tauri-apps/api/mocks';
import { afterEach } from 'vitest';
import { useDialogStore } from '../store/dialogs';
import { useExplorerStore } from '../store/explorer';
import { useQueryTabStore } from '../store/query-tabs';
import { useServerStore } from '../store/servers';
import { useTreeStore } from '../store/tree';
import { useSettingsStore } from '../store/settings';
import { useWorkspaceStore } from '../store/workspace';

afterEach(() => {
  cleanup();
  clearMocks();
  sessionStorage.clear();
  localStorage.clear();
  Reflect.deleteProperty(globalThis, 'isTauri');
  useDialogStore.setState(useDialogStore.getInitialState(), true);
  useExplorerStore.setState(useExplorerStore.getInitialState(), true);
  useServerStore.setState(useServerStore.getInitialState(), true);
  useSettingsStore.setState(useSettingsStore.getInitialState(), true);
  useWorkspaceStore.setState(useWorkspaceStore.getInitialState(), true);
  useTreeStore.setState(useTreeStore.getInitialState(), true);
  useQueryTabStore.setState(useQueryTabStore.getInitialState(), true);
});
