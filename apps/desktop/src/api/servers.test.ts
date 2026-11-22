import type { InvokeArgs } from '@tauri-apps/api/core';
import { describe, expect, it } from 'vitest';
import { mockCommands, serverInput } from '../testing/backend';
import { catalogChildren } from './catalog';
import * as api from './servers';

const input = serverInput();

const commands: Array<[string, () => Promise<unknown>, InvokeArgs]> = [
  ['store_status', () => api.storeStatus(), {}],
  ['unlock_store', () => api.unlockStore('correct horse battery'), { passphrase: 'correct horse battery' }],
  ['start_fresh_store', () => api.startFreshStore(), {}],
  ['list_servers', () => api.listServers(), {}],
  ['save_server', () => api.saveServer(input), { input }],
  ['delete_server', () => api.deleteServer('orders-dev'), { id: 'orders-dev' }],
  ['save_group', () => api.saveGroup({ id: null, name: 'Orders' }), { input: { id: null, name: 'Orders' } }],
  ['delete_group', () => api.deleteGroup('orders'), { id: 'orders' }],
  ['parse_connection', () => api.parseConnection('postgres://h/db'), { input: 'postgres://h/db' }],
  ['test_connection', () => api.testConnection(input), { input }],
  ['connect_server', () => api.connectServer('orders-dev'), { id: 'orders-dev' }],
  ['disconnect_server', () => api.disconnectServer('orders-dev'), { id: 'orders-dev' }],
  ['list_connections', () => api.listConnections(), {}],
  ['catalog_children', () => catalogChildren('orders-dev', null, true), { server_id: 'orders-dev', path: null, show_system: true }],
];

describe('the Rust command wrappers', () => {
  it.each(commands)('%s is called by its Rust name with its arguments', async (command, call, args) => {
    const calls = mockCommands({ [command]: () => null });
    await call();
    expect(calls).toEqual([{ command, args }]);
  });
});
