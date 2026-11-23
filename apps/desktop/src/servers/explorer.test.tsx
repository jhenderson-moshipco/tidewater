import { act, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useDialogStore } from '../store/dialogs';
import { useServerStore } from '../store/servers';
import { useTreeStore } from '../store/tree';
import { commandsOf, failWith, group, mockCommands, server, unlocked } from '../testing/backend';
import { renderWithUser } from '../testing/render';
import { Explorer, ExplorerActions } from './explorer';

const dialog = () => useDialogStore.getState().open;

describe('the explorer', () => {
  it('shows nothing until it knows whether saved servers are locked', () => {
    const { container } = renderWithUser(<Explorer />);
    expect(container.childElementCount).toBe(0);
  });

  it('explains a locked store and offers to start fresh', async () => {
    useServerStore.setState({ store: { status: 'locked', has_saved_file: true, reason: 'The key is not in this keychain' } });
    const { user } = renderWithUser(<Explorer />);

    expect(screen.getByRole('heading', { name: 'Saved servers are locked' })).toBeTruthy();
    expect(screen.getByText('The key is not in this keychain')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Start fresh' }));

    expect(dialog()).toEqual({ kind: 'start-fresh' });
  });

  it('shows no reason when the store gives none', () => {
    useServerStore.setState({ store: { status: 'locked', has_saved_file: true, reason: null } });
    renderWithUser(<Explorer />);
    expect(screen.getByRole('heading', { name: 'Saved servers are locked' }).nextElementSibling?.tagName).toBe('BUTTON');
  });

  it('without a keychain, asks for a new passphrase and shows why one was refused', async () => {
    useServerStore.setState({ store: { status: 'needs_passphrase', has_saved_file: false, reason: null } });
    const answers = [() => failWith('invalid', 'Use at least 8 characters'), () => unlocked];
    const calls = mockCommands({ unlock_store: () => answers.shift()?.(), store_status: () => unlocked, list_servers: () => ({ groups: [], servers: [] }) });
    const { user } = renderWithUser(<Explorer />);
    expect(screen.getByText(/encrypted with a passphrase you choose/)).toBeTruthy();

    await user.type(screen.getByLabelText('Passphrase'), 'short');
    await user.click(screen.getByRole('button', { name: 'Set passphrase' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Use at least 8 characters');

    await user.clear(screen.getByLabelText('Passphrase'));
    await user.type(screen.getByLabelText('Passphrase'), 'correct horse battery');
    await user.click(screen.getByRole('button', { name: 'Set passphrase' }));

    expect(await screen.findByText('No servers yet.')).toBeTruthy();
    expect(commandsOf(calls)).toEqual(['unlock_store', 'unlock_store', 'store_status', 'list_servers']);
  });

  it('asks to unlock an existing passphrase file', () => {
    useServerStore.setState({ store: { status: 'needs_passphrase', has_saved_file: true, reason: null } });
    renderWithUser(<Explorer />);
    expect(screen.getByRole('form', { name: 'Unlock saved servers' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Unlock' })).toBeTruthy();
  });

  it('offers a first connection when there are no servers', async () => {
    useServerStore.setState({ store: unlocked });
    const { user } = renderWithUser(<Explorer />);

    await user.click(screen.getByRole('button', { name: 'New connection' }));

    expect(dialog()).toEqual({ kind: 'connection', editing: null });
  });

  it('shows the server tree once there are saved servers', () => {
    useServerStore.setState({ store: unlocked, groups: [group()], servers: [server({ group_id: 'orders-platform' })] });
    renderWithUser(<Explorer />);
    expect(screen.getAllByRole('treeitem').map((row) => row.textContent)).toEqual(['Orders platform1 server', 'orders-devDEVNot connected']);
  });
});

describe('the explorer actions', () => {
  it('are hidden until saved servers are unlocked, then open a new connection or group', async () => {
    const { user } = renderWithUser(<ExplorerActions />);
    expect(screen.queryByRole('button')).toBeNull();

    act(() => useServerStore.setState({ store: unlocked }));
    await user.click(screen.getByRole('button', { name: 'New connection' }));
    expect(dialog()).toEqual({ kind: 'connection', editing: null });
    await user.click(screen.getByRole('button', { name: 'New group' }));
    expect(dialog()).toEqual({ kind: 'group', editing: null });
  });

  it('show or hide system objects, saying which in the button state', async () => {
    useServerStore.setState({ store: unlocked });
    const { user } = renderWithUser(<ExplorerActions />);
    const toggle = screen.getByRole('button', { name: 'Show system objects' });

    await user.click(toggle);
    expect([toggle.getAttribute('aria-pressed'), useTreeStore.getState().show_system]).toEqual(['true', true]);
    await user.click(toggle);
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
  });
});
