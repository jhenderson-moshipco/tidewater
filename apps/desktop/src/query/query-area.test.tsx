import { EditorView, runScopeHandlers } from '@codemirror/view';
import { act, fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Workspace } from '../shell/workspace';
import { useDialogStore } from '../store/dialogs';
import { useQueryTabStore } from '../store/query-tabs';
import { useServerStore } from '../store/servers';
import { useTreeStore } from '../store/tree';
import {
  commandsOf,
  deferred,
  failWith,
  mockCommands,
  queryError,
  rowsOutcome,
  runResult,
  server,
  statement,
  unlocked,
} from '../testing/backend';
import { renderWithUser } from '../testing/render';
import { revealInEditor } from './sql-editor';

const tabs = () => useQueryTabStore.getState();
const orders_dev = server({ id: 'orders-dev', name: 'orders-dev', database: 'orders' });
const orders_prod = server({ id: 'orders-prod', name: 'orders-prod', environment: 'prod', database: 'shop' });
const connection = { server_id: 'orders-dev', database: 'orders' };

function withServers() {
  useServerStore.setState({ store: unlocked, servers: [orders_dev, orders_prod] });
}

function openTab(text = '', opened_on: typeof connection | null = connection) {
  const id = tabs().openTab(opened_on);
  tabs().setText(id, text);
  return id;
}

function editorOf(title: string): EditorView {
  return EditorView.findFromDOM(screen.getByRole('textbox', { name: `SQL editor, ${title}` })) as EditorView;
}

function press(view: EditorView, key: string, modifiers: KeyboardEventInit = {}) {
  return act(() => runScopeHandlers(view, new KeyboardEvent('keydown', { key, ctrlKey: true, ...modifiers }), 'editor'));
}

describe('the empty editor area', () => {
  it('offers a new query once servers are saved, opening it on the explorer selection', async () => {
    withServers();
    useTreeStore.setState({ active_id: 'server:orders-prod' });
    const { user } = renderWithUser(<Workspace />);
    expect(screen.getByText('No query tab open.')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'New query' }));

    expect(screen.getByRole('tab', { name: 'Untitled-1 PROD' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('button', { name: 'Connection: orders-prod, database shop. Change connection' })).toBeTruthy();
  });

  it('says there are no connections before any server is saved', () => {
    useServerStore.setState({ store: unlocked });
    renderWithUser(<Workspace />);
    expect(screen.getByText('No connections yet.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'New query' })).toBeNull();
  });
});

describe('the connection picker', () => {
  it("opens for a new tab with no connection to start on and fills the chosen server's database", async () => {
    withServers();
    const { user } = renderWithUser(<Workspace />);
    await user.click(screen.getByRole('button', { name: 'New query' }));
    const picker = within(screen.getByRole('dialog', { name: 'Choose a connection' }));

    await user.selectOptions(picker.getByRole('combobox', { name: 'Server' }), 'orders-prod');
    expect((picker.getByRole('textbox', { name: 'Database' }) as HTMLInputElement).value).toBe('shop');
    await user.click(picker.getByRole('button', { name: 'Use connection' }));

    expect(tabs().tabs[tabs().active_id as string]?.connection).toEqual({ server_id: 'orders-prod', database: 'shop' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it("starts on the tab's current connection, and Cancel changes nothing", async () => {
    withServers();
    const id = openTab('', { server_id: 'orders-prod', database: 'archive' });
    const { user } = renderWithUser(<Workspace />);

    await user.click(screen.getByRole('button', { name: 'Connection: orders-prod, database archive. Change connection' }));
    const picker = within(screen.getByRole('dialog', { name: 'Choose a connection' }));
    expect((picker.getByRole('textbox', { name: 'Database' }) as HTMLInputElement).value).toBe('archive');
    await user.click(picker.getByRole('button', { name: 'Cancel' }));

    expect(tabs().tabs[id]?.connection).toEqual({ server_id: 'orders-prod', database: 'archive' });
  });

  it('runs what was asked once a connection is chosen for a tab that had none', async () => {
    withServers();
    const calls = mockCommands({ run_query: () => runResult([statement({ kind: 'command', rows_affected: 0 })]) });
    openTab('VACUUM', null);
    const { user } = renderWithUser(<Workspace />);

    await user.click(screen.getByRole('button', { name: 'Run all' }));
    await user.click(screen.getByRole('button', { name: 'Use and run' }));

    expect(calls).toEqual([{ command: 'run_query', args: { tab_id: tabs().active_id, server_id: 'orders-dev', database: 'orders', sql: 'VACUUM' } }]);
  });

  it('points to New connection when no server is saved', async () => {
    useServerStore.setState({ store: unlocked });
    openTab('', null);
    const { user } = renderWithUser(<Workspace />);

    await user.click(screen.getByRole('button', { name: 'Choose a connection' }));
    const picker = within(screen.getByRole('dialog', { name: 'Choose a connection' }));
    expect(picker.getByText('No saved servers yet. Add one with New connection.')).toBeTruthy();
    await user.click(picker.getByRole('button', { name: 'Close' }));

    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('the query tab strip', () => {
  it('moves between tabs with the arrow keys, Home and End, wrapping at the ends', async () => {
    withServers();
    const [a, b] = [openTab(), openTab()];
    const { user } = renderWithUser(<Workspace />);
    const tab = (title: string) => screen.getByRole('tab', { name: new RegExp(`^${title}`) });

    tab('Untitled-2').focus();
    await user.keyboard('{ArrowRight}');
    expect([tabs().active_id, document.activeElement]).toEqual([a, tab('Untitled-1')]);
    await user.keyboard('{ArrowLeft}');
    expect(tabs().active_id).toBe(b);
    await user.keyboard('{Home}');
    expect(tabs().active_id).toBe(a);
    await user.keyboard('{End}x');
    expect(tabs().active_id).toBe(b);
    await user.click(tab('Untitled-1'));
    expect(tabs().active_id).toBe(a);
  });

  it('closes a tab with Delete or its close button, and opens another with the plus button', async () => {
    withServers();
    const calls = mockCommands({ close_query_tab: () => null });
    openTab();
    openTab();
    const { user } = renderWithUser(<Workspace />);

    screen.getByRole('tab', { name: /^Untitled-2/ }).focus();
    await user.keyboard('{Delete}');
    await user.click(screen.getByRole('button', { name: 'Close Untitled-1' }));
    expect(screen.queryByRole('tablist', { name: 'Query tabs' })).toBeNull();
    expect(commandsOf(calls)).toEqual(['close_query_tab', 'close_query_tab']);

    openTab();
    act(() => tabs().selectTab(tabs().order[0] as string));
    await user.click(screen.getByRole('button', { name: 'New query tab' }));
    expect(tabs().order).toHaveLength(2);
  });

  it('confirms before closing a tab with an open transaction, then rolls it back by closing', async () => {
    withServers();
    const calls = mockCommands({ close_query_tab: () => null });
    const id = openTab();
    useQueryTabStore.setState((state) => ({ tabs: { ...state.tabs, [id]: { ...state.tabs[id]!, transaction: 'open' } } }));
    const { user } = renderWithUser(<Workspace />);

    await user.click(screen.getByRole('button', { name: 'Close Untitled-1' }));
    const dialog = within(screen.getByRole('dialog', { name: 'Close Untitled-1?' }));
    expect(dialog.getByText('Its open transaction is rolled back.')).toBeTruthy();
    await user.click(dialog.getByRole('button', { name: 'Roll back and close' }));

    expect([commandsOf(calls), tabs().order]).toEqual([['close_query_tab'], []]);
  });

  it('says a failed transaction is rolled back when closing its tab', () => {
    withServers();
    renderWithUser(<Workspace />);
    act(() => useDialogStore.getState().show({ kind: 'close-tab', tab_id: 'a', title: 'Untitled-1', transaction: 'failed' }));
    expect(screen.getByText('Its failed transaction is rolled back.')).toBeTruthy();
  });
});

describe('the query toolbar and status bar', () => {
  it("shows the server's limits and the tab's connection, transaction and cursor", () => {
    useServerStore.setState({
      store: unlocked,
      servers: [server({ id: 'orders-dev', name: 'orders-dev', session: { read_only: true, statement_timeout_ms: 15_000, results_timeout_ms: 300_000 } })],
    });
    openTab('SELECT 1');
    renderWithUser(<Workspace />);

    expect(screen.getByText('Read-only · timeout 15 s')).toBeTruthy();
    expect(screen.getByText('orders-dev · orders · no open transaction')).toBeTruthy();
    expect(screen.getByText('Ln 1, Col 1')).toBeTruthy();
  });

  it('shows neither limits nor connection details for a tab whose server is gone', () => {
    useServerStore.setState({ store: unlocked, servers: [server({ id: 'other' })] });
    openTab('SELECT 1');
    renderWithUser(<Workspace />);

    expect(screen.getByRole('button', { name: 'Choose a connection' })).toBeTruthy();
    expect(screen.queryByText(/no open transaction/)).toBeNull();
    expect(screen.queryByText(/timeout/)).toBeNull();
  });

  it('runs the statement at the cursor, and offers Cancel only while it runs', async () => {
    withServers();
    const pending = deferred<unknown>();
    const calls = mockCommands({ split_statements: () => [{ from: 0, to: 8 }], run_query: () => pending.promise, cancel_query: () => null });
    openTab('SELECT 1');
    const { user } = renderWithUser(<Workspace />);
    const cancel = screen.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement;
    expect(cancel.disabled).toBe(true);

    await user.click(screen.getByRole('button', { name: /^Run ⌘↵/ }));
    expect((screen.getByRole('button', { name: /^Run ⌘↵/ }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(cancel);
    await act(async () => pending.resolve(runResult([statement({ kind: 'command', rows_affected: 0 })])));

    expect(commandsOf(calls)).toEqual(['split_statements', 'run_query', 'cancel_query']);
    expect(screen.getByText('0 rows affected.')).toBeTruthy();
  });
});

describe('the results panel', () => {
  it('invites a run, then shows why a run failed', async () => {
    withServers();
    mockCommands({ run_query: () => failWith('connection', 'error connecting to server') });
    openTab('SELECT 1');
    const { user } = renderWithUser(<Workspace />);
    expect(screen.getByText('Results shown here')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Run all' }));

    expect(screen.getByRole('alert').textContent).toBe('error connecting to server');
  });

  it('shows each statement in its own result tab, with rows, commands, errors and skipped statements', async () => {
    withServers();
    const result = runResult([
      statement(rowsOutcome([['1'], [null]])),
      statement({ kind: 'command', rows_affected: 2 }),
      statement({ kind: 'error', error: queryError({ detail: 'near here', hint: 'check spelling', position: 14 }) }),
      statement({ kind: 'skipped' }),
    ]);
    mockCommands({ run_query: () => result });
    openTab('SELECT 1;\nSELEC 2;');
    const { user } = renderWithUser(<Workspace />);
    await user.click(screen.getByRole('button', { name: 'Run all' }));
    const tab = (name: string) => screen.getByRole('tab', { name: new RegExp(`^${name}`) });

    expect(tab('Results 3').getAttribute('aria-selected')).toBe('true');
    const panel = within(screen.getByRole('tabpanel', { name: /^Results 3/ }));
    expect(panel.getByText('syntax error at or near "SELEC"')).toBeTruthy();
    expect(panel.getByText('Detail: near here')).toBeTruthy();
    expect(panel.getByText('Hint: check spelling')).toBeTruthy();
    await user.click(panel.getByRole('button', { name: 'Go to line 2, column 5' }));
    expect(tabs().tabs[tabs().active_id as string]?.selection).toEqual({ from: 14, to: 14 });

    await user.click(tab('Results 1'));
    const grid = screen.getByRole('grid', { name: 'Results 1' });
    expect(within(grid).getAllByRole('gridcell').map((cell) => cell.textContent)).toEqual(['1', 'NULL']);
    expect(screen.getByText('12 ms')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Fetch next 500' })).toBeNull();
    await user.click(tab('Results 2'));
    expect(screen.getByText('2 rows affected · 12 ms')).toBeTruthy();
    await user.click(tab('Results 4'));
    expect(screen.getByText('Not run, because an earlier statement failed.')).toBeTruthy();
  });

  it('offers no go-to button for an error without a position', async () => {
    withServers();
    mockCommands({ run_query: () => runResult([statement({ kind: 'error', error: queryError({ code: null, message: 'division by zero' }) })]) });
    openTab('SELECT 1 / 0');
    const { user } = renderWithUser(<Workspace />);

    await user.click(screen.getByRole('button', { name: 'Run all' }));

    expect(screen.getByText('division by zero')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Go to/ })).toBeNull();
  });

  it('moves between result tabs with the arrow keys, Home and End, and lists the messages', async () => {
    withServers();
    const notices = [
      { severity: 'NOTICE', code: '00000', message: 'hello', detail: 'd', hint: 'h' },
      { severity: 'WARNING', code: '01000', message: 'careful', detail: null, hint: null },
    ];
    mockCommands({ run_query: () => runResult([statement(rowsOutcome([['1']]), { notices }), statement(rowsOutcome([['2']]))]) });
    openTab('SELECT 1; SELECT 2');
    const { user } = renderWithUser(<Workspace />);
    await user.click(screen.getByRole('button', { name: 'Run all' }));
    const id = tabs().active_id as string;

    screen.getByRole('tab', { name: /^Results 2/ }).focus();
    await user.keyboard('{ArrowRight}');
    expect(tabs().tabs[id]?.panel).toBe('messages');
    expect(screen.getByText('hello')).toBeTruthy();
    expect(screen.getByText('Detail: d', { exact: false })).toBeTruthy();
    expect(screen.getByText('Hint: h', { exact: false })).toBeTruthy();
    await user.keyboard('{ArrowRight}');
    expect(tabs().tabs[id]?.panel).toBe(0);
    await user.keyboard('{ArrowLeft}');
    expect(tabs().tabs[id]?.panel).toBe('messages');
    await user.keyboard('{Home}');
    expect(tabs().tabs[id]?.panel).toBe(0);
    await user.keyboard('{End}x');
    expect(tabs().tabs[id]?.panel).toBe('messages');
  });

  it('says there are no messages, and falls back to the first tab for a panel that no longer exists', async () => {
    withServers();
    mockCommands({ run_query: () => runResult([statement(rowsOutcome([['1']]))]) });
    openTab('SELECT 1');
    const { user } = renderWithUser(<Workspace />);
    await user.click(screen.getByRole('button', { name: 'Run all' }));

    await user.click(screen.getByRole('tab', { name: /^Messages/ }));
    expect(screen.getByText('No messages.')).toBeTruthy();
    act(() => tabs().showPanel(tabs().active_id as string, 7));
    expect(screen.getByRole('tab', { name: /^Results 1/ }).getAttribute('aria-selected')).toBe('true');
  });

  it('fetches the next batch from the last result, and shows a fetch that failed above it', async () => {
    withServers();
    mockCommands({
      run_query: () => runResult([statement(rowsOutcome([['1']], { has_more: true, total_rows: null }))], { transaction: 'holding_results' }),
      fetch_more_rows: () => failWith('invalid', 'These results are closed.'),
    });
    openTab('SELECT 1');
    const { user } = renderWithUser(<Workspace />);
    await user.click(screen.getByRole('button', { name: 'Run all' }));
    expect(screen.getByText('orders-dev · orders · holding results open')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Fetch next 500' }));

    expect(screen.getByRole('alert').textContent).toBe('These results are closed.');
  });
});

describe('the SQL editor', () => {
  it('writes edits and the cursor to the tab, and runs or cancels from its keys', async () => {
    withServers();
    const calls = mockCommands({ split_statements: () => [{ from: 0, to: 8 }], run_query: () => runResult([]), cancel_query: () => null });
    const id = openTab('SELECT 1');
    renderWithUser(<Workspace />);
    const view = editorOf('Untitled-1');

    act(() => view.dispatch({ changes: { from: 8, insert: ';' }, selection: { anchor: 9 } }));
    expect(tabs().tabs[id]).toMatchObject({ text: 'SELECT 1;', selection: { from: 9, to: 9 } });
    await press(view, 'Enter');
    await press(view, 'Enter', { shiftKey: true });
    await press(view, '.');

    expect(commandsOf(calls)).toEqual(['split_statements', 'run_query', 'run_query', 'cancel_query']);
  });

  it("keeps each tab's text and undo history across a tab switch, and forgets a closed tab's", () => {
    withServers();
    mockCommands({ close_query_tab: () => null });
    const first = openTab('SELECT 1');
    renderWithUser(<Workspace />);
    act(() => editorOf('Untitled-1').dispatch({ changes: { from: 0, insert: '-- note\n' } }));

    const second = openTab('');
    act(() => tabs().selectTab(first));
    expect(editorOf('Untitled-1').state.doc.toString()).toBe('-- note\nSELECT 1');
    act(() => tabs().closeTab(first));
    revealInEditor(first, 0);

    expect(tabs().active_id).toBe(second);
  });

  it('keeps the go-to position inside the text when the text has since got shorter', () => {
    withServers();
    const id = openTab('SELECT 1');
    renderWithUser(<Workspace />);

    act(() => revealInEditor(id, 99));

    expect(tabs().tabs[id]?.selection).toEqual({ from: 8, to: 8 });
  });
});

describe('the results grid inside the panel', () => {
  it('reads a cell value in full even when it is wider than its column', async () => {
    withServers();
    const long = 'x'.repeat(80);
    mockCommands({ run_query: () => runResult([statement(rowsOutcome([[long]]))]) });
    openTab('SELECT 1');
    const { user } = renderWithUser(<Workspace />);
    await user.click(screen.getByRole('button', { name: 'Run all' }));

    fireEvent.click(screen.getByRole('gridcell'));

    expect(screen.getByRole('gridcell').textContent).toBe(long);
  });
});
