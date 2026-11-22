import { act, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useDialogStore, type OpenDialog } from '../store/dialogs';
import { useServerStore } from '../store/servers';
import { commandsOf, failWith, group, mockCommands, server, unlocked } from '../testing/backend';
import { renderWithUser } from '../testing/render';
import { closeDialogOf } from './modal';
import { DialogHost } from './server-dialogs';

function openDialog(dialog: Exclude<OpenDialog, { kind: 'connection' }>) {
  const rendered = renderWithUser(<DialogHost />);
  act(() => useDialogStore.getState().show(dialog));
  return rendered;
}

const message = () => screen.getByRole('dialog').querySelector('p')?.textContent;

describe('the group dialog', () => {
  it('creates a group', async () => {
    const calls = mockCommands({ save_group: () => group() });
    const { user } = openDialog({ kind: 'group', editing: null });
    expect(screen.getByRole('dialog', { name: 'New group' })).toBeTruthy();

    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'Orders platform');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(calls[0].args).toEqual({ input: { id: null, name: 'Orders platform' } });
    expect(useServerStore.getState().groups).toEqual([group()]);
  });

  it('renames a group, starting from its name', async () => {
    const calls = mockCommands({ save_group: () => group({ name: 'Orders' }) });
    const { user } = openDialog({ kind: 'group', editing: group() });
    const name = screen.getByRole('textbox', { name: 'Name' }) as HTMLInputElement;
    expect(name.value).toBe('Orders platform');

    await user.clear(name);
    await user.type(name, 'Orders');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(calls[0].args).toEqual({ input: { id: 'orders-platform', name: 'Orders' } });
  });
});

describe('the confirmation dialogs', () => {
  it('delete a server, saying whether its password goes too', async () => {
    useServerStore.setState({ servers: [server()] });
    const calls = mockCommands({ delete_server: () => null });
    const { user } = openDialog({ kind: 'delete-server', server: server({ has_password: true }) });
    expect(message()).toBe('Its saved settings and password are removed.');

    await user.click(screen.getByRole('button', { name: 'Delete' }));

    expect(commandsOf(calls)).toEqual(['delete_server']);
    expect(useServerStore.getState().servers).toEqual([]);
    act(() => useDialogStore.getState().show({ kind: 'delete-server', server: server() }));
    expect(message()).toBe('Its saved settings are removed.');
  });

  it('delete a group, saying how many servers stay saved', async () => {
    const calls = mockCommands({ delete_group: () => null });
    const { user } = openDialog({ kind: 'delete-group', group: group(), server_count: 0 });
    expect(screen.getByRole('dialog', { name: 'Delete Orders platform?' })).toBeTruthy();
    expect(message()).toBe('The group is empty.');
    act(() => useDialogStore.getState().show({ kind: 'delete-group', group: group(), server_count: 1 }));
    expect(message()).toBe('Its 1 server stays saved, without a group.');
    act(() => useDialogStore.getState().show({ kind: 'delete-group', group: group(), server_count: 3 }));
    expect(message()).toBe('Its 3 servers stay saved, without a group.');

    await user.click(screen.getByRole('button', { name: 'Delete group' }));

    expect(commandsOf(calls)).toEqual(['delete_group']);
  });

  it('start fresh and reload the servers', async () => {
    const calls = mockCommands({ start_fresh_store: () => unlocked, store_status: () => unlocked, list_servers: () => ({ groups: [], servers: [] }) });
    const { user } = openDialog({ kind: 'start-fresh' });

    await user.click(screen.getByRole('button', { name: 'Start fresh' }));

    await vi.waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(commandsOf(calls)).toEqual(['start_fresh_store', 'store_status', 'list_servers']);
  });

  it('stay open with the reason when the action fails, and close on cancel', async () => {
    mockCommands({ delete_server: () => failWith('not_found', 'No saved server with id orders-dev') });
    const { user } = openDialog({ kind: 'delete-server', server: server() });

    await user.click(screen.getByRole('button', { name: 'Delete' }));
    expect((await screen.findByRole('alert')).textContent).toBe('No saved server with id orders-dev');
    expect((screen.getByRole('button', { name: 'Delete' }) as HTMLButtonElement).disabled).toBe(false);

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(useDialogStore.getState().open).toBeNull();
  });
});

describe('closeDialogOf', () => {
  it('does nothing for an element outside a dialog', () => {
    expect(() => closeDialogOf(document.createElement('button'))).not.toThrow();
  });
});
