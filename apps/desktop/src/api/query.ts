import { invoke } from '@tauri-apps/api/core';
import type { RowBatch, RunResult, StatementSpan } from '../generated/query';

export const splitStatements = (sql: string) => invoke<Array<StatementSpan>>('split_statements', { sql });
export const runQuery = (tab_id: string, server_id: string, database: string, sql: string) =>
  invoke<RunResult>('run_query', { tab_id, server_id, database, sql });
export const fetchMoreRows = (tab_id: string) => invoke<RowBatch>('fetch_more_rows', { tab_id });
export const cancelQuery = (tab_id: string) => invoke<void>('cancel_query', { tab_id });
export const closeQueryTab = (tab_id: string) => invoke<void>('close_query_tab', { tab_id });
