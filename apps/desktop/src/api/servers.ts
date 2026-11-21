import { invoke } from '@tauri-apps/api/core';
import type { ConnectionInfo, ParsedConnection, ProbeResult } from '../generated/connections';
import type { GroupInput, ServerGroup, ServerInput, ServerListView, ServerSummary } from '../generated/servers';
import type { StoreStatusView } from '../generated/store';

export const storeStatus = () => invoke<StoreStatusView>('store_status');
export const unlockStore = (passphrase: string) => invoke<StoreStatusView>('unlock_store', { passphrase });
export const startFreshStore = () => invoke<StoreStatusView>('start_fresh_store');
export const listServers = () => invoke<ServerListView>('list_servers');
export const saveServer = (input: ServerInput) => invoke<ServerSummary>('save_server', { input });
export const deleteServer = (id: string) => invoke<void>('delete_server', { id });
export const saveGroup = (input: GroupInput) => invoke<ServerGroup>('save_group', { input });
export const deleteGroup = (id: string) => invoke<void>('delete_group', { id });
export const parseConnection = (input: string) => invoke<ParsedConnection>('parse_connection', { input });
export const testConnection = (input: ServerInput) => invoke<Array<ProbeResult>>('test_connection', { input });
export const connectServer = (id: string) => invoke<ConnectionInfo>('connect_server', { id });
export const disconnectServer = (id: string) => invoke<void>('disconnect_server', { id });
export const listConnections = () => invoke<Array<ConnectionInfo>>('list_connections');
