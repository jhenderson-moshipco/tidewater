import { describe, expect, it } from 'vitest';
import { commandsOf, deferred, failWith, group, mockCommands, server, serverInput, unlocked } from '../testing/backend';
import { useServerStore } from './servers';

const state = () => useServerStore.getState();
const empty_list = { groups: [], servers: [] };
const info = { server_id: 'orders-dev', database: 'orders', server_version: '17.2', encryption: 'TLSv1.3' };

describe('the server store', () => {
  it('loads nothing outside the Tauri app', async () => {
    await state().load();
    expect(state().store).toBeNull();
  });

  it('loads the saved servers once the store is unlocked', async () => {
    const calls = mockCommands({ store_status: () => unlocked, list_servers: () => ({ groups: [group()], servers: [server()] }) });

    await state().load();

    expect(commandsOf(calls)).toEqual(['store_status', 'list_servers']);
    expect([state().groups, state().servers]).toEqual([[group()], [server()]]);
  });

  it('a locked store shows no servers and is not asked for them', async () => {
    useServerStore.setState({ servers: [server()], groups: [group()] });
    const locked = { status: 'locked', has_saved_file: true, reason: 'The key is missing' } as const;
    const calls = mockCommands({ store_status: () => locked });

    await state().load();

    expect(commandsOf(calls)).toEqual(['store_status']);
    expect([state().store, state().groups, state().servers]).toEqual([locked, [], []]);
  });

  it('unlocking and starting fresh reload the servers', async () => {
    const calls = mockCommands({
      unlock_store: () => unlocked,
      start_fresh_store: () => unlocked,
      store_status: () => unlocked,
      list_servers: () => empty_list,
    });

    await state().unlock('correct horse battery');
    await state().startFresh();

    expect(commandsOf(calls)).toEqual(['unlock_store', 'store_status', 'list_servers', 'start_fresh_store', 'store_status', 'list_servers']);
    expect(calls[0].args).toEqual({ passphrase: 'correct horse battery' });
  });

  it('saving adds a new server and replaces an edited one in place', async () => {
    const edited = server({ name: 'orders renamed' });
    const answers = [server(), server({ id: 'billing', name: 'billing' }), edited];
    mockCommands({ save_server: () => answers.shift() });

    await state().saveServer(serverInput());
    await state().saveServer(serverInput({ name: 'billing' }));
    await state().saveServer(serverInput({ id: 'orders-dev', name: 'orders renamed' }));

    expect(state().servers.map((saved) => saved.name)).toEqual(['orders renamed', 'billing']);
  });

  it('deleting a server forgets its connection too', async () => {
    useServerStore.setState({ servers: [server(), server({ id: 'billing' })], connections: { 'orders-dev': { status: 'connected', info } } });
    mockCommands({ delete_server: () => null });

    await state().deleteServer('orders-dev');

    expect(state().servers.map((saved) => saved.id)).toEqual(['billing']);
    expect(state().connections).toEqual({});
  });

  it('saving adds a new group and renames an existing one', async () => {
    const answers = [group(), group({ id: 'billing', name: 'Billing' }), group({ name: 'Orders' })];
    mockCommands({ save_group: () => answers.shift() });

    await state().saveGroup({ id: null, name: 'Orders platform' });
    await state().saveGroup({ id: null, name: 'Billing' });
    await state().saveGroup({ id: 'orders-platform', name: 'Orders' });

    expect(state().groups.map((saved) => saved.name)).toEqual(['Orders', 'Billing']);
  });

  it('deleting a group keeps its servers without a group', async () => {
    useServerStore.setState({
      groups: [group(), group({ id: 'billing' })],
      servers: [server({ group_id: 'orders-platform' }), server({ id: 'invoices', group_id: 'billing' })],
    });
    mockCommands({ delete_group: () => null });

    await state().deleteGroup('orders-platform');

    expect(state().groups.map((kept) => kept.id)).toEqual(['billing']);
    expect(state().servers.map((kept) => kept.group_id)).toEqual([null, 'billing']);
  });

  it('connecting shows progress, then the session or the reason it failed', async () => {
    const pending = deferred<typeof info>();
    const answers = [() => pending.promise, () => failWith('connection', 'password authentication failed')];
    mockCommands({ connect_server: () => answers.shift()?.() });

    const connecting = state().connect('orders-dev');
    expect(state().connections['orders-dev']).toEqual({ status: 'connecting' });
    pending.resolve(info);
    await connecting;
    expect(state().connections['orders-dev']).toEqual({ status: 'connected', info });

    await state().connect('orders-dev');
    expect(state().connections['orders-dev']).toEqual({ status: 'failed', message: 'password authentication failed' });
  });

  it('disconnecting forgets the session', async () => {
    useServerStore.setState({ connections: { 'orders-dev': { status: 'connected', info } } });
    mockCommands({ disconnect_server: () => null });

    await state().disconnect('orders-dev');

    expect(state().connections).toEqual({});
  });
});
