import { cleanup } from '@testing-library/react';
import { clearMocks } from '@tauri-apps/api/mocks';
import { afterEach } from 'vitest';
import { useDialogStore } from '../store/dialogs';
import { useExplorerStore } from '../store/explorer';
import { useServerStore } from '../store/servers';
import { useWorkspaceStore } from '../store/workspace';

afterEach(() => {
  cleanup();
  clearMocks();
  sessionStorage.clear();
  Reflect.deleteProperty(globalThis, 'isTauri');
  useDialogStore.setState(useDialogStore.getInitialState(), true);
  useExplorerStore.setState(useExplorerStore.getInitialState(), true);
  useServerStore.setState(useServerStore.getInitialState(), true);
  useWorkspaceStore.setState(useWorkspaceStore.getInitialState(), true);
});
