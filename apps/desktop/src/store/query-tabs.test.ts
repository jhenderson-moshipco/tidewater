import { describe, expect, it } from 'vitest';
import type { RowBatch } from '../generated/query';
import { commandsOf, deferred, failWith, mockCommands, queryError, rowsOutcome, runResult, statement } from '../testing/backend';
import { useDialogStore } from './dialogs';
import { useQueryTabStore } from './query-tabs';

const tabs = () => useQueryTabStore.getState();
const tab = (id: string) => tabs().tabs[id];
const connection = { server_id: 'orders-dev', database: 'orders' };

function openWith(text: string, from = 0, to = from) {
  const id = tabs().openTab(connection);
  tabs().setText(id, text);
  tabs().setSelection(id, from, to);
  return id;
}

function batch(overrides: Partial<RowBatch> = {}): RowBatch {
  return { rows: [['3']], has_more: false, elapsed_ms: 4, notices: [], transaction: 'idle', ...overrides };
}

describe('the query tab store', () => {
  it('opens numbered tabs, makes the newest active and switches between them', () => {
    const first = tabs().openTab(connection);
    const second = tabs().openTab(null);

    expect([tab(first)?.title, tab(second)?.title, tabs().active_id]).toEqual(['Untitled-1', 'Untitled-2', second]);
    tabs().selectTab(first);
    expect(tabs().active_id).toBe(first);
  });

  it('changes text, selection, connection and panel, and ignores a tab that is gone', () => {
    const id = tabs().openTab(null);
    tabs().setText(id, 'SELECT 1');
    tabs().setSelection(id, 2, 5);
    tabs().setConnection(id, connection);
    tabs().showPanel(id, 'messages');
    tabs().setText('gone', 'ignored');

    expect(tab(id)).toMatchObject({ text: 'SELECT 1', selection: { from: 2, to: 5 }, connection, panel: 'messages' });
    expect(tab('gone')).toBeUndefined();
  });

  it('runs the statement at the cursor and opens the last result', async () => {
    const result = runResult([statement(rowsOutcome([['1']]))], { transaction: 'holding_results' });
    const calls = mockCommands({ split_statements: () => [{ from: 0, to: 8 }, { from: 10, to: 18 }], run_query: () => result });
    const id = openWith('SELECT 1; SELECT 2', 14);

    await tabs().run(id, 'statement');

    expect(calls[1]?.args).toEqual({ tab_id: id, server_id: 'orders-dev', database: 'orders', sql: 'SELECT 2' });
    expect(tab(id)).toMatchObject({ status: 'idle', result, run_offset: 10, panel: 0, transaction: 'holding_results' });
    expect(tabs().announcement).toBe('1 row.');
  });

  it('runs the selected text as it is, without splitting it, starting at the selection', async () => {
    const calls = mockCommands({ run_query: () => runResult([statement({ kind: 'command', rows_affected: 0 })]) });
    const id = openWith('SELECT 1; SELECT 2', 10, 18);

    await tabs().run(id, 'statement');

    expect(commandsOf(calls)).toEqual(['run_query']);
    expect([calls[0]?.args, tab(id)?.run_offset]).toEqual([{ tab_id: id, server_id: 'orders-dev', database: 'orders', sql: 'SELECT 2' }, 10]);
  });

  it('runs all the text for Run all, and opens the first failed statement', async () => {
    const result = runResult([statement(rowsOutcome([['1']])), statement({ kind: 'error', error: queryError() }), statement({ kind: 'skipped' })]);
    const calls = mockCommands({ run_query: () => result });
    const id = openWith('SELECT 1; SELEC 2; SELECT 3', 3);

    await tabs().run(id, 'all');

    expect(calls[0]?.args).toMatchObject({ sql: 'SELECT 1; SELEC 2; SELECT 3' });
    expect([tab(id)?.panel, tab(id)?.run_offset]).toEqual([1, 0]);
  });

  it('says there is nothing to run when the text holds no statement', async () => {
    const calls = mockCommands({ split_statements: () => [] });
    const id = openWith('-- a note');

    await tabs().run(id, 'statement');

    expect(commandsOf(calls)).toEqual(['split_statements']);
    expect([tab(id)?.status, tabs().announcement]).toEqual(['idle', 'There is no statement to run.']);
  });

  it('asks for a connection first on a tab without one, carrying the run through the picker', async () => {
    const calls = mockCommands({});
    const id = tabs().openTab(null);

    await tabs().run(id, 'all');

    expect(calls).toEqual([]);
    expect(useDialogStore.getState().open).toEqual({ kind: 'pick-connection', tab_id: id, then_run: 'all' });
  });

  it('ignores a run while the tab is already running, and a run on a tab that is gone', async () => {
    const pending = deferred<unknown>();
    const calls = mockCommands({ run_query: () => pending.promise });
    const id = openWith('SELECT 1', 0, 8);

    const first = tabs().run(id, 'statement');
    expect(tab(id)?.status).toBe('running');
    await tabs().run(id, 'statement');
    await tabs().run('gone', 'statement');
    pending.resolve(runResult([statement({ kind: 'command', rows_affected: 0 })]));
    await first;

    expect(commandsOf(calls)).toEqual(['run_query']);
  });

  it('shows and announces why a run failed before any statement ran', async () => {
    mockCommands({ run_query: () => failWith('connection', 'error connecting to server') });
    const id = openWith('SELECT 1', 0, 8);

    await tabs().run(id, 'statement');

    expect([tab(id)?.status, tab(id)?.error, tabs().announcement]).toEqual(['idle', 'error connecting to server', 'error connecting to server']);
  });

  it('appends fetched rows and their notices to the last result until no more follow', async () => {
    const notice = { severity: 'NOTICE', code: '00000', message: 'hello', detail: null, hint: null };
    const first = statement(rowsOutcome([['1'], ['2']], { has_more: true, total_rows: null }));
    let more: RowBatch = batch({ rows: [['3']], has_more: true, notices: [notice], transaction: 'holding_results' });
    mockCommands({ run_query: () => runResult([first], { transaction: 'holding_results' }), fetch_more_rows: () => more });
    const id = openWith('SELECT g', 0, 8);
    await tabs().run(id, 'statement');

    await tabs().fetchMore(id);
    expect(tabs().announcement).toBe('1 more rows, 3 in all, more available.');
    more = batch({ rows: [['4']] });
    await tabs().fetchMore(id);

    const last = tab(id)?.result?.statements[0];
    expect(last?.outcome).toEqual(rowsOutcome([['1'], ['2'], ['3'], ['4']], { has_more: false, total_rows: 4 }));
    expect([last?.notices, tab(id)?.transaction, tabs().announcement]).toEqual([[notice], 'idle', '1 more rows, 4 in all.']);
  });

  it("doesn't fetch without rows to add to, and shows why a fetch failed", async () => {
    const calls = mockCommands({
      run_query: () => runResult([statement({ kind: 'command', rows_affected: 0 })]),
      fetch_more_rows: () => failWith('invalid', 'These results are closed.'),
    });
    const id = openWith('SELECT 1', 0, 8);
    await tabs().fetchMore(id);
    await tabs().fetchMore('gone');
    await tabs().run(id, 'statement');
    await tabs().fetchMore(id);
    expect(commandsOf(calls)).toEqual(['run_query']);

    tabs().showPanel(id, 0);
    useQueryTabStore.setState((state) => ({
      tabs: { ...state.tabs, [id]: { ...state.tabs[id]!, result: runResult([statement(rowsOutcome([['1']], { has_more: true }))]) } },
    }));
    await tabs().fetchMore(id);
    expect([tab(id)?.status, tab(id)?.error]).toEqual(['idle', 'These results are closed.']);
  });

  it('cancels through the Rust core and shows a cancel that failed', async () => {
    let fail = false;
    const calls = mockCommands({ cancel_query: () => (fail ? failWith('connection', 'cancel refused') : null) });
    const id = openWith('SELECT 1');

    await tabs().cancel(id);
    fail = true;
    await tabs().cancel(id);

    expect(calls[0]?.args).toEqual({ tab_id: id });
    expect([tab(id)?.error, tabs().announcement]).toEqual(['cancel refused', 'cancel refused']);
  });

  it('asks before closing a tab whose own transaction is open or failed, and closes others at once', () => {
    const calls = mockCommands({ close_query_tab: () => null });
    const open = tabs().openTab(connection);
    const failed = tabs().openTab(connection);
    const holding = tabs().openTab(connection);
    useQueryTabStore.setState((state) => ({
      tabs: {
        ...state.tabs,
        [open]: { ...state.tabs[open]!, transaction: 'open' },
        [failed]: { ...state.tabs[failed]!, transaction: 'failed' },
        [holding]: { ...state.tabs[holding]!, transaction: 'holding_results' },
      },
    }));

    tabs().requestClose(open);
    expect(useDialogStore.getState().open).toEqual({ kind: 'close-tab', tab_id: open, title: 'Untitled-1', transaction: 'open' });
    tabs().requestClose(failed);
    expect(useDialogStore.getState().open).toMatchObject({ kind: 'close-tab', tab_id: failed, transaction: 'failed' });
    tabs().requestClose(holding);

    expect([commandsOf(calls), tabs().order]).toEqual([['close_query_tab'], [open, failed]]);
  });

  it('activates the next tab, or the previous one at the end, when the active tab closes', () => {
    mockCommands({ close_query_tab: () => null });
    const [a, b, c] = [tabs().openTab(null), tabs().openTab(null), tabs().openTab(null)];

    tabs().selectTab(b);
    tabs().closeTab(b);
    expect(tabs().active_id).toBe(c);
    tabs().closeTab(c);
    expect(tabs().active_id).toBe(a);
    tabs().openTab(null);
    tabs().closeTab(a);
    tabs().closeTab(tabs().order[0]!);
    expect([tabs().order, tabs().active_id]).toEqual([[], null]);
  });

  it('keeps the active tab when another one closes', () => {
    mockCommands({ close_query_tab: () => null });
    const a = tabs().openTab(null);
    const b = tabs().openTab(null);

    tabs().closeTab(a);

    expect(tabs().active_id).toBe(b);
  });

  it('turns off fetch more when the Rust core closes idle results, and leaves other tabs alone', async () => {
    mockCommands({ run_query: () => runResult([statement(rowsOutcome([['1']], { has_more: true }))], { transaction: 'holding_results' }) });
    const id = openWith('SELECT 1', 0, 8);
    tabs().resultsClosed(id);
    await tabs().run(id, 'statement');

    tabs().resultsClosed(id);
    expect([tab(id)?.result?.statements[0]?.outcome, tab(id)?.transaction]).toEqual([rowsOutcome([['1']], { has_more: false }), 'idle']);
    expect(tabs().announcement).toBe('Untitled-1: results closed after being left idle. Run the statement again to see more rows.');

    useQueryTabStore.setState({ announcement: '' });
    tabs().resultsClosed(id);
    tabs().resultsClosed('gone');
    expect(tabs().announcement).toBe('');
  });

  it("keeps the user's own open transaction when its idle results close", async () => {
    mockCommands({ run_query: () => runResult([statement(rowsOutcome([['1']], { has_more: true }))], { transaction: 'open' }) });
    const id = openWith('SELECT 1', 0, 8);
    await tabs().run(id, 'statement');

    tabs().resultsClosed(id);

    expect(tab(id)?.transaction).toBe('open');
  });
});
