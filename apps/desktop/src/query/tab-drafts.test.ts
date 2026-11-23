import { describe, expect, it, vi } from 'vitest';
import { useQueryTabStore } from '../store/query-tabs';
import { useServerStore } from '../store/servers';
import { commandsOf, draft, failWith, mockCommands, server, stamp, unlocked } from '../testing/backend';
import { draftSnapshot, restoreTabs, save_delay_ms, startSavingDrafts } from './tab-drafts';

const tabs = () => useQueryTabStore.getState();
const nothing_set_aside = { missing_files: [], set_aside: null };

describe('restoring tabs', () => {
  it('restores nothing outside the Tauri app, and the startup screen can still finish', async () => {
    await restoreTabs();
    expect([tabs().order, tabs().restored]).toEqual([[], true]);
  });

  it('brings back each tab with its text, connection, file and cursor, and the tab that was in front', async () => {
    useServerStore.setState({ store: unlocked, servers: [server()] });
    const on_file = draft({ id: 'query-b', title: 'recent.sql', file: { path: '/work/recent.sql', saved_text: 'SELECT', stamp } });
    mockCommands({ load_tab_drafts: () => ({ snapshot: { active_id: 'query-b', tabs: [draft(), on_file] }, ...nothing_set_aside }) });

    await restoreTabs();

    expect(tabs().order).toEqual(['query-a', 'query-b']);
    expect(tabs().tabs['query-b']).toMatchObject({ title: 'recent.sql', text: 'SELECT 1', selection: { from: 3, to: 3 }, file: on_file.file, status: 'idle' });
    expect([tabs().active_id, tabs().next_number, tabs().announcement]).toEqual(['query-b', 2, '']);
  });

  it('keeps tabs whose server or file is gone, without the connection, and says why', async () => {
    useServerStore.setState({ store: unlocked, servers: [] });
    const restored = { snapshot: { active_id: 'gone', tabs: [draft({ title: 'Untitled-4' }), draft({ id: 'query-b', title: 'b.sql' })] }, missing_files: ['x.sql', 'y.sql'], set_aside: null };
    mockCommands({ load_tab_drafts: () => restored });

    await restoreTabs();

    expect([tabs().tabs['query-a']?.connection, tabs().active_id, tabs().next_number]).toEqual([null, 'query-a', 5]);
    expect(tabs().announcement).toBe(
      'The file for x.sql and y.sql is gone, so saving asks where to save. The server for Untitled-4 and b.sql was removed, so running asks for a connection.',
    );
  });

  it('names a single tab on its own when only one file is gone', async () => {
    mockCommands({ load_tab_drafts: () => ({ snapshot: { active_id: null, tabs: [] }, missing_files: ['x.sql'], set_aside: null }) });
    await restoreTabs();
    expect(tabs().announcement).toBe('The file for x.sql is gone, so saving asks where to save.');
  });

  it("keeps every connection while saved servers are locked, since it can't tell which are gone", async () => {
    useServerStore.setState({ store: { status: 'needs_passphrase', has_saved_file: true, reason: null } });
    mockCommands({ load_tab_drafts: () => ({ snapshot: { active_id: null, tabs: [draft({ connection: null }), draft({ id: 'query-b' })] }, ...nothing_set_aside }) });

    await restoreTabs();

    expect(tabs().tabs['query-b']?.connection).toEqual({ server_id: 'orders-dev', database: 'orders' });
  });

  it('says where an unreadable drafts file was set aside, and why restoring failed', async () => {
    let answer = () => ({ snapshot: { active_id: null, tabs: [] }, missing_files: [], set_aside: '/data/tabs.unreadable-2026.json' });
    mockCommands({ load_tab_drafts: () => answer() });
    await restoreTabs();
    expect(tabs().announcement).toBe("The saved tabs couldn't be read, so they were set aside as /data/tabs.unreadable-2026.json.");

    answer = () => failWith('storage', 'denied');
    await restoreTabs();
    expect([tabs().announcement, tabs().restored]).toEqual(["The saved tabs couldn't be restored: denied", true]);
  });
});

describe('saving drafts', () => {
  it('turns the tabs into a snapshot in their order', () => {
    const id = tabs().openTab({ server_id: 'orders-dev', database: 'orders' }, { text: 'SELECT 1', selection: { from: 1, to: 4 } });
    expect(draftSnapshot(tabs())).toEqual({ active_id: id, tabs: [draft({ id, selection_from: 1, selection_to: 4 })] });
  });

  it('is not started outside the Tauri app', () => {
    expect(() => startSavingDrafts()).not.toThrow();
  });

  it('writes the tabs once typing pauses, skips writes that change nothing, and announces a failed write', async () => {
    vi.useFakeTimers();
    let fail = false;
    const calls = mockCommands({ save_tab_drafts: () => (fail ? failWith('storage', 'disk full') : null) });
    const id = tabs().openTab(null);
    startSavingDrafts();

    tabs().setText(id, 'S');
    tabs().setText(id, 'SE');
    vi.advanceTimersByTime(save_delay_ms);
    tabs().showPanel(id, 0);
    vi.advanceTimersByTime(save_delay_ms);
    expect(commandsOf(calls)).toEqual(['save_tab_drafts']);
    expect(calls[0]?.args).toMatchObject({ snapshot: { tabs: [{ text: 'SE' }] } });

    fail = true;
    tabs().setText(id, 'SEL');
    vi.advanceTimersByTime(save_delay_ms);
    vi.useRealTimers();
    await vi.waitFor(() => expect(tabs().announcement).toBe('disk full'));
  });
});
