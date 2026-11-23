import { describe, expect, it } from 'vitest';
import { useDialogStore } from '../store/dialogs';
import { useQueryTabStore } from '../store/query-tabs';
import { commandsOf, failWith, mockCommands, stamp } from '../testing/backend';
import { fileName, openSqlFile, saveTab, withSqlExtension } from './tab-files';

const tabs = () => useQueryTabStore.getState();
const connection = { server_id: 'orders-dev', database: 'orders' };
const opened = { path: '/work/recent.sql', name: 'recent.sql', text: 'SELECT 1', stamp };

function tabOnFile(text = 'SELECT 2') {
  const id = tabs().openTab(connection, { title: 'recent.sql', text, file: { path: '/work/recent.sql', saved_text: 'SELECT 1', stamp } });
  return id;
}

describe('file names', () => {
  it('takes the last part of a Unix or Windows path', () => {
    expect([fileName('/work/a.sql'), fileName('C:\\\\work\\\\b.sql')]).toEqual(['a.sql', 'b.sql']);
  });

  it('adds .sql only to a file name without an extension', () => {
    expect([withSqlExtension('/work/report'), withSqlExtension('/work/report.txt'), withSqlExtension('/work.d/report')]).toEqual([
      '/work/report.sql',
      '/work/report.txt',
      '/work.d/report.sql',
    ]);
  });
});

describe('opening a .sql file', () => {
  it('opens the picked file in a tab named after it, with no unsaved changes', async () => {
    mockCommands({ 'plugin:dialog|open': () => '/work/recent.sql', read_sql_file: () => opened });

    await openSqlFile();

    const tab = tabs().tabs[tabs().active_id as string];
    expect(tab).toMatchObject({ title: 'recent.sql', text: 'SELECT 1', file: { path: '/work/recent.sql', saved_text: 'SELECT 1', stamp } });
    expect([tabs().next_number, tabs().announcement]).toEqual([1, 'Opened recent.sql.']);
  });

  it('switches to the tab that already has the file open instead of opening it twice', async () => {
    const calls = mockCommands({ 'plugin:dialog|open': () => '/work/recent.sql' });
    const id = tabOnFile();
    tabs().openTab(null);

    await openSqlFile();

    expect([tabs().active_id, commandsOf(calls)]).toEqual([id, ['plugin:dialog|open']]);
  });

  it('does nothing when the dialog is cancelled, and announces a file that could not be read', async () => {
    let answer: string | null = null;
    mockCommands({ 'plugin:dialog|open': () => answer, read_sql_file: () => failWith('invalid', "dump.bin isn't UTF-8 text") });

    await openSqlFile();
    expect(tabs().order).toEqual([]);
    answer = '/work/dump.bin';
    await openSqlFile();

    expect([tabs().order, tabs().announcement]).toEqual([[], "dump.bin isn't UTF-8 text"]);
  });
});

describe('saving a tab', () => {
  it('writes a tab with a file back to it, checking no other program changed it, and marks it saved', async () => {
    const calls = mockCommands({ write_sql_file: () => ({ outcome: 'saved', stamp: { modified_ms: 2_000, size: 8 } }) });
    const id = tabOnFile();

    await saveTab(id);

    expect(calls).toEqual([{ command: 'write_sql_file', args: { path: '/work/recent.sql', text: 'SELECT 2', expected: stamp } }]);
    expect(tabs().tabs[id]?.file).toEqual({ path: '/work/recent.sql', saved_text: 'SELECT 2', stamp: { modified_ms: 2_000, size: 8 } });
    expect(tabs().announcement).toBe('Saved recent.sql.');
  });

  it('asks where to save an Untitled tab, adds .sql and renames the tab after the file', async () => {
    const calls = mockCommands({ 'plugin:dialog|save': () => '/work/monthly', write_sql_file: () => ({ outcome: 'saved', stamp }) });
    const id = tabs().openTab(connection);
    tabs().setText(id, 'SELECT 3');

    await saveTab(id);

    expect(calls[0]?.args).toMatchObject({ options: { defaultPath: 'Untitled-1.sql' } });
    expect(calls[1]?.args).toEqual({ path: '/work/monthly.sql', text: 'SELECT 3', expected: null });
    expect(tabs().tabs[id]?.title).toBe('monthly.sql');
  });

  it('Save As asks where even with a file, starting from it, and keeps a path the user typed as it is', async () => {
    const calls = mockCommands({ 'plugin:dialog|save': () => '/work/recent.sql', write_sql_file: () => ({ outcome: 'saved', stamp }) });
    const id = tabOnFile();

    await saveTab(id, { as: true });

    expect(calls[0]?.args).toMatchObject({ options: { defaultPath: '/work/recent.sql' } });
    expect(calls[1]?.args).toEqual({ path: '/work/recent.sql', text: 'SELECT 2', expected: stamp });
  });

  it('writes nothing when the Save dialog is cancelled, or for a tab that is gone', async () => {
    const calls = mockCommands({ 'plugin:dialog|save': () => null });
    await saveTab(tabs().openTab(null), { as: true });
    await saveTab('gone');
    expect(commandsOf(calls)).toEqual(['plugin:dialog|save']);
  });

  it('asks before overwriting a file another program changed, carrying a close through', async () => {
    mockCommands({ write_sql_file: () => ({ outcome: 'changed_on_disk' }) });
    const id = tabOnFile();

    await saveTab(id, { then_close: true });

    expect(useDialogStore.getState().open).toEqual({ kind: 'overwrite-file', tab_id: id, title: 'recent.sql', then_close: true });
    expect(tabs().tabs[id]?.file?.saved_text).toBe('SELECT 1');
  });

  it('overwrites without the check when told to, then closes the tab when asked', async () => {
    const calls = mockCommands({ write_sql_file: () => ({ outcome: 'saved', stamp }), close_query_tab: () => null });
    const id = tabOnFile();

    await saveTab(id, { overwrite: true, then_close: true });

    expect(calls[0]?.args).toMatchObject({ expected: null });
    expect(tabs().tabs[id]).toBeUndefined();
  });

  it('shows why a save failed on the tab and announces it', async () => {
    mockCommands({ write_sql_file: () => failWith('storage', 'recent.sql couldn’t be saved: denied') });
    const id = tabOnFile();

    await saveTab(id);

    expect([tabs().tabs[id]?.error, tabs().announcement]).toEqual(['recent.sql couldn’t be saved: denied', 'recent.sql couldn’t be saved: denied']);
  });
});
