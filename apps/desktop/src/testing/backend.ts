import { mockIPC } from '@tauri-apps/api/mocks';
import type { InvokeArgs } from '@tauri-apps/api/core';
import type { CatalogNode, CatalogPath } from '../generated/catalog';
import type { CommandError } from '../generated/errors';
import type { QueryError, RunResult, StatementOutcome, StatementResult } from '../generated/query';
import type { ServerGroup, ServerInput, ServerSummary } from '../generated/servers';
import type { StoreStatusView } from '../generated/store';

export type Call = { command: string; args: InvokeArgs | undefined };
type Handler = (args: Record<string, unknown>) => unknown;

/**
 * Answers the Rust commands the test names and records every call. Any other command fails the test.
 * Event mocking is on, so `emit` from `@tauri-apps/api/event` reaches `listen` handlers.
 */
export function mockCommands(handlers: Readonly<Record<string, Handler>>): Array<Call> {
  const calls: Array<Call> = [];
  (globalThis as { isTauri?: boolean }).isTauri = true;
  mockIPC(
    (command, args) => {
      calls.push({ command, args });
      const handler = handlers[command];
      if (!handler) throw new Error(`The test doesn't expect ${command}`);
      return handler((args ?? {}) as Record<string, unknown>);
    },
    { shouldMockEvents: true },
  );
  return calls;
}

export function commandsOf(calls: ReadonlyArray<Call>): Array<string> {
  return calls.map((call) => call.command);
}

/** A rejected command, shaped like the CommandError the Rust core returns. */
export function failWith(kind: CommandError['kind'], message: string): never {
  throw { kind, message } satisfies CommandError;
}

export const unlocked: StoreStatusView = { status: 'unlocked', has_saved_file: true, reason: null };

export function server(overrides: Partial<ServerSummary> = {}): ServerSummary {
  return {
    id: 'orders-dev',
    name: 'orders-dev',
    group_id: null,
    environment: 'dev',
    host: 'localhost',
    port: 5432,
    database: 'orders',
    user: 'app',
    has_password: false,
    tls: 'prefer',
    session: { read_only: false, statement_timeout_ms: null, results_timeout_ms: 300_000 },
    ...overrides,
  };
}

export function serverInput(overrides: Partial<ServerInput> = {}): ServerInput {
  return {
    id: null,
    name: 'orders-dev',
    group_id: null,
    environment: 'dev',
    host: 'localhost',
    port: 5432,
    database: 'orders',
    user: 'app',
    password: { action: 'clear' },
    tls: 'prefer',
    session: { read_only: false, statement_timeout_ms: null, results_timeout_ms: 300_000 },
    ...overrides,
  };
}

export function group(overrides: Partial<ServerGroup> = {}): ServerGroup {
  return { id: 'orders-platform', name: 'Orders platform', ...overrides };
}

/** A promise the test settles by hand, to see the UI while a command is still running. */
export function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

export function catalogNode(key: string, label: string, children: CatalogPath | null = null, detail: string | null = null): CatalogNode {
  return { key, label, detail, icon: children?.level === 'database' ? 'database' : 'table', children };
}

export function rowsOutcome(rows: Array<Array<string | null>>, overrides: Partial<Extract<StatementOutcome, { kind: 'rows' }>> = {}): StatementOutcome {
  return { kind: 'rows', columns: [{ name: 'n', type_name: 'int4' }], rows, has_more: false, total_rows: rows.length, ...overrides };
}

export function statement(outcome: StatementOutcome, overrides: Partial<StatementResult> = {}): StatementResult {
  return { span: { from: 0, to: 8 }, elapsed_ms: 12.4, notices: [], outcome, ...overrides };
}

export function runResult(statements: Array<StatementResult>, overrides: Partial<RunResult> = {}): RunResult {
  return { statements, transaction: 'idle', session_replaced: false, ...overrides };
}

export function queryError(overrides: Partial<QueryError> = {}): QueryError {
  return { message: 'syntax error at or near "SELEC"', code: '42601', detail: null, hint: null, position: null, ...overrides };
}
