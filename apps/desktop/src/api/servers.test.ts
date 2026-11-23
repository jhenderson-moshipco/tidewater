import type { InvokeArgs } from '@tauri-apps/api/core';
import { describe, expect, it } from 'vitest';
import { mockCommands, serverInput } from '../testing/backend';
import { catalogChildren } from './catalog';
import * as files from './files';
import * as query from './query';
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
  ['cancel_connect', () => api.cancelConnect('orders-dev'), { id: 'orders-dev' }],
  ['disconnect_server', () => api.disconnectServer('orders-dev'), { id: 'orders-dev' }],
  ['key_storage', () => api.keyStorage(), {}],
  ['set_key_storage', () => api.setKeyStorage('keychain'), { storage: 'keychain' }],
  ['list_connections', () => api.listConnections(), {}],
  ['catalog_children', () => catalogChildren('orders-dev', null, true), { server_id: 'orders-dev', path: null, show_system: true }],
  ['split_statements', () => query.splitStatements('SELECT 1'), { sql: 'SELECT 1' }],
  [
    'run_query',
    () => query.runQuery('tab-1', 'orders-dev', 'orders', 'SELECT 1'),
    { tab_id: 'tab-1', server_id: 'orders-dev', database: 'orders', sql: 'SELECT 1' },
  ],
  ['fetch_more_rows', () => query.fetchMoreRows('tab-1'), { tab_id: 'tab-1' }],
  ['cancel_query', () => query.cancelQuery('tab-1'), { tab_id: 'tab-1' }],
  ['close_query_tab', () => query.closeQueryTab('tab-1'), { tab_id: 'tab-1' }],
  ['read_sql_file', () => files.readSqlFile('/q.sql'), { path: '/q.sql' }],
  ['write_sql_file', () => files.writeSqlFile('/q.sql', 'SELECT 1', null), { path: '/q.sql', text: 'SELECT 1', expected: null }],
  ['load_tab_drafts', () => files.loadTabDrafts(), {}],
  ['save_tab_drafts', () => files.saveTabDrafts({ active_id: null, tabs: [] }), { snapshot: { active_id: null, tabs: [] } }],
  [
    'plugin:dialog|open',
    () => files.pickSqlFile(),
    { options: { multiple: false, directory: false, filters: [{ name: 'SQL', extensions: ['sql'] }, { name: 'All files', extensions: ['*'] }] } },
  ],
  [
    'plugin:dialog|save',
    () => files.pickSavePath('Untitled-1.sql'),
    { options: { defaultPath: 'Untitled-1.sql', filters: [{ name: 'SQL', extensions: ['sql'] }, { name: 'All files', extensions: ['*'] }] } },
  ],
];

describe('the Rust command wrappers', () => {
  it.each(commands)('%s is called by its Rust name with its arguments', async (command, call, args) => {
    const calls = mockCommands({ [command]: () => null });
    await call();
    expect(calls).toEqual([{ command, args }]);
  });
});
