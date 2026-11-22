import { create } from 'zustand';
import * as api from '../api/servers';
import { messageOf } from '../api/errors';
import type { KeyStorage } from '../generated/settings';
import { useDialogStore } from './dialogs';

type SettingsState = {
  /** Where the key for saved servers is kept, or `null` until the Rust core has said. */
  key_storage: KeyStorage | null;
  busy: boolean;
  error: string | null;
  /** A short sentence for screen readers once a setting has changed. */
  notice: string;
  /** Opens the Settings dialog and reads the current settings into it. */
  open: () => Promise<void>;
  setKeyStorage: (storage: KeyStorage) => Promise<void>;
};

const storage_notices: Readonly<Record<KeyStorage, string>> = {
  file: 'The key is now kept in a file only your user account can read.',
  keychain: 'The key is now kept in the system keychain.',
};

export const useSettingsStore = create<SettingsState>()((set) => ({
  key_storage: null,
  busy: false,
  error: null,
  notice: '',

  open: async () => {
    set({ key_storage: null, busy: false, error: null, notice: '' });
    useDialogStore.getState().show({ kind: 'settings' });
    try {
      set({ key_storage: await api.keyStorage() });
    } catch (error) {
      set({ error: messageOf(error) });
    }
  },

  setKeyStorage: async (storage) => {
    set({ busy: true, error: null, notice: '' });
    try {
      await api.setKeyStorage(storage);
      set({ key_storage: storage, busy: false, notice: storage_notices[storage] });
    } catch (error) {
      set({ busy: false, error: messageOf(error) });
    }
  },
}));
