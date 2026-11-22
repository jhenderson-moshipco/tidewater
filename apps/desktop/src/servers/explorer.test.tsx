import { act, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useDialogStore } from '../store/dialogs';
import { useServerStore } from '../store/servers';
import { commandsOf, failWith, group, mockCommands, server, unlocked } from '../testing/backend';
import { renderWithUser } from '../testing/render';
import { Explorer, ExplorerActions } from './explorer';

const dialog = () => useDialogStore.getState().open;
const info = { server_id: 'orders-dev', server_version: '17.2', encryption: null };

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

  it('shows a renamed group with its servers still under it', () => {
    useServerStore.setState({ store: unlocked, groups: [group()], servers: [server({ group_id: 'orders-platform' })] });
    renderWithUser(<Explorer />);

    act(() => useServerStore.setState({ groups: [group({ name: 'Orders' })] }));

    expect(within(screen.getByRole('list', { name: 'Orders' })).getByText('orders-dev')).toBeTruthy();
  });

  it('lists servers under their groups and collapses a group', async () => {
    useServerStore.setState({
      store: unlocked,
      groups: [group(), group({ id: 'billing', name: 'Billing' })],
      servers: [server({ group_id: 'orders-platform' }), server({ id: 'scratch', name: 'scratch', environment: 'local' })],
    });
    const { user } = renderWithUser(<Explorer />);
    const orders = screen.getByRole('button', { name: 'Orders platform 1 server' });
    expect(screen.getByRole('button', { name: 'Billing 0 servers' })).toBeTruthy();
    expect(within(screen.getByRole('list', { name: 'Orders platform' })).getByText('orders-dev')).toBeTruthy();
    expect(screen.getByText('LOCAL')).toBeTruthy();

    await user.click(orders);

    expect(orders.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('list', { name: 'Orders platform' })).toBeNull();
    await user.click(orders);
    expect(screen.getByRole('list', { name: 'Orders platform' })).toBeTruthy();
  });

  it('opens the rename and delete dialogs for a group', async () => {
    useServerStore.setState({ store: unlocked, groups: [group()], servers: [server({ group_id: 'orders-platform' })] });
    const { user } = renderWithUser(<Explorer />);

    await user.click(screen.getByRole('button', { name: 'Rename Orders platform' }));
    expect(dialog()).toEqual({ kind: 'group', editing: group() });
    await user.click(screen.getByRole('button', { name: 'Delete Orders platform' }));
    expect(dialog()).toEqual({ kind: 'delete-group', group: group(), server_count: 1 });
  });

  it('opens the edit and delete dialogs for a server', async () => {
    useServerStore.setState({ store: unlocked, servers: [server()] });
    const { user } = renderWithUser(<Explorer />);

    await user.click(screen.getByRole('button', { name: 'Edit orders-dev' }));
    expect(dialog()).toMatchObject({ kind: 'connection', editing: server() });
    await user.click(screen.getByRole('button', { name: 'Delete orders-dev' }));
    expect(dialog()).toEqual({ kind: 'delete-server', server: server() });
  });

  it('connects a server, shows why a connection failed, and disconnects', async () => {
    useServerStore.setState({ store: unlocked, servers: [server()] });
    const answers = [() => failWith('connection', 'password authentication failed'), () => info];
    mockCommands({ connect_server: () => answers.shift()?.(), disconnect_server: () => null });
    const { user } = renderWithUser(<Explorer />);

    await user.click(screen.getByRole('button', { name: 'Connect orders-dev' }));
    expect((await screen.findByRole('alert')).textContent).toBe('password authentication failed');
    expect(screen.getByText(', connection failed')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Connect orders-dev' }));
    await user.click(await screen.findByRole('button', { name: 'Disconnect orders-dev' }));

    expect(await screen.findByRole('button', { name: 'Connect orders-dev' })).toBeTruthy();
    expect(screen.getByText(', not connected')).toBeTruthy();
  });

  it('disables the button while a server is connecting', () => {
    useServerStore.setState({ store: unlocked, servers: [server()], connections: { 'orders-dev': { status: 'connecting' } } });
    renderWithUser(<Explorer />);
    expect((screen.getByRole('button', { name: 'Disconnect orders-dev' }) as HTMLButtonElement).disabled).toBe(true);
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
});
