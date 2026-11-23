import { act, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Workspace } from '../shell/workspace';
import { useQueryTabStore } from '../store/query-tabs';
import { useServerStore } from '../store/servers';
import { commandsOf, mockCommands, server, stamp, unlocked } from '../testing/backend';
import { renderWithUser } from '../testing/render';

const tabs = () => useQueryTabStore.getState();
const connection = { server_id: 'orders-dev', database: 'orders' };
const file = { path: '/work/recent.sql', saved_text: 'SELECT 1', stamp };

function withServers() {
  useServerStore.setState({ store: unlocked, servers: [server()] });
}

describe('closing a tab with unsaved text', () => {
  it('marks the tab unsaved, and Cancel keeps it open', async () => {
    withServers();
    const id = tabs().openTab(connection, { title: 'recent.sql', text: 'SELECT 2', file });
    const { user } = renderWithUser(<Workspace />);

    expect(screen.getByRole('tab', { name: /^recent\.sql\s*, unsaved/ })).toBeTruthy();
    expect(screen.getByText('/work/recent.sql')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Close recent.sql' }));
    const dialog = within(screen.getByRole('dialog', { name: 'Save changes to recent.sql?' }));
    expect(dialog.getByText("Your changes are lost if you don't save them.")).toBeTruthy();
    await user.click(dialog.getByRole('button', { name: 'Cancel' }));

    expect(tabs().order).toEqual([id]);
  });

  it("closes without saving on Don't save, and says the open transaction rolls back too", async () => {
    withServers();
    const calls = mockCommands({ close_query_tab: () => null });
    const id = tabs().openTab(connection);
    tabs().setText(id, 'SELECT 1');
    useQueryTabStore.setState((state) => ({ tabs: { ...state.tabs, [id]: { ...state.tabs[id]!, transaction: 'open' } } }));
    const { user } = renderWithUser(<Workspace />);

    await user.click(screen.getByRole('button', { name: 'Close Untitled-1' }));
    expect(screen.getByText("Your changes are lost if you don't save them. Its open transaction is rolled back too.")).toBeTruthy();
    await user.click(screen.getByRole('button', { name: "Don't save" }));

    expect([commandsOf(calls), tabs().order]).toEqual([['close_query_tab'], []]);
  });

  it('saves and then closes on Save, and says a failed transaction rolls back too', async () => {
    withServers();
    const calls = mockCommands({ write_sql_file: () => ({ outcome: 'saved', stamp }), close_query_tab: () => null });
    const id = tabs().openTab(connection, { title: 'recent.sql', text: 'SELECT 2', file });
    useQueryTabStore.setState((state) => ({ tabs: { ...state.tabs, [id]: { ...state.tabs[id]!, transaction: 'failed' } } }));
    const { user } = renderWithUser(<Workspace />);

    await user.click(screen.getByRole('button', { name: 'Close recent.sql' }));
    expect(screen.getByText(/Its failed transaction is rolled back too\.$/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await act(async () => undefined);
    expect([commandsOf(calls), tabs().order]).toEqual([['write_sql_file', 'close_query_tab'], []]);
  });
});

describe('a file changed on disk', () => {
  it('asks before overwriting it, then saves over it and closes when the save came from closing', async () => {
    withServers();
    const answers = [{ outcome: 'changed_on_disk' }, { outcome: 'saved', stamp }];
    const calls = mockCommands({ write_sql_file: () => answers.shift(), close_query_tab: () => null });
    tabs().openTab(connection, { title: 'recent.sql', text: 'SELECT 2', file });
    const { user } = renderWithUser(<Workspace />);

    await user.click(screen.getByRole('button', { name: 'Close recent.sql' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    const dialog = within(await screen.findByRole('dialog', { name: 'recent.sql changed on disk' }));
    await user.click(dialog.getByRole('button', { name: 'Overwrite' }));

    await act(async () => undefined);
    expect(calls.map((call) => call.args)).toEqual([
      { path: '/work/recent.sql', text: 'SELECT 2', expected: stamp },
      { path: '/work/recent.sql', text: 'SELECT 2', expected: null },
      { tab_id: expect.any(String) },
    ]);
    expect(tabs().order).toEqual([]);
  });
});
