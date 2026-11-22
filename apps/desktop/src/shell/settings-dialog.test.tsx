import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useSettingsStore } from '../store/settings';
import { deferred, failWith, mockCommands } from '../testing/backend';
import { renderWithUser } from '../testing/render';
import { DialogHost } from '../servers/server-dialogs';

const checkbox = () => screen.getByRole('checkbox', { name: 'Keep the encryption key in the system keychain' }) as HTMLInputElement;

describe('the Settings dialog', () => {
  it('starts with the keychain off, waits for the setting, and moves the key when it is turned on and off', async () => {
    const storage = deferred<string>();
    const calls = mockCommands({ key_storage: () => storage.promise, set_key_storage: () => null });
    const { user } = renderWithUser(<DialogHost />);

    const opening = useSettingsStore.getState().open();
    const dialog = within(await screen.findByRole('dialog', { name: 'Settings' }));
    expect(checkbox().disabled).toBe(true);
    storage.resolve('file');
    await opening;
    expect([checkbox().checked, checkbox().disabled]).toEqual([false, false]);

    await user.click(checkbox());
    expect(checkbox().checked).toBe(true);
    expect(dialog.getByText('The key is now kept in the system keychain.')).toBeTruthy();
    await user.click(checkbox());
    expect(dialog.getByText('The key is now kept in a file only your user account can read.')).toBeTruthy();

    expect(calls.slice(1)).toEqual([
      { command: 'set_key_storage', args: { storage: 'keychain' } },
      { command: 'set_key_storage', args: { storage: 'file' } },
    ]);
    await user.click(dialog.getByRole('button', { name: 'Done' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('shows why the key could not be moved and leaves the setting as it was', async () => {
    mockCommands({ key_storage: () => 'file', set_key_storage: () => failWith('storage', 'The key couldn’t be saved: denied') });
    const { user } = renderWithUser(<DialogHost />);
    await useSettingsStore.getState().open();

    await user.click(checkbox());

    expect(screen.getByRole('alert').textContent).toBe('The key couldn’t be saved: denied');
    expect(checkbox().checked).toBe(false);
  });

  it('shows why the settings could not be read', async () => {
    mockCommands({ key_storage: () => failWith('storage', 'unreadable') });
    renderWithUser(<DialogHost />);
    await useSettingsStore.getState().open();
    expect(screen.getByRole('alert').textContent).toBe('unreadable');
  });
});
