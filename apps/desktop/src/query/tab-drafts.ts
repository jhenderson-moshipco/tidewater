import { isTauri } from '@tauri-apps/api/core';
import * as files from '../api/files';
import { messageOf } from '../api/errors';
import type { DraftSnapshot, TabDraft } from '../generated/drafts';
import { useQueryTabStore, type QueryTab } from '../store/query-tabs';
import { useServerStore } from '../store/servers';

/** How long typing pauses before the open tabs are written to disk. */
export const save_delay_ms = 500;

type TabState = Pick<ReturnType<typeof useQueryTabStore.getState>, 'tabs' | 'order' | 'active_id'>;

export function draftSnapshot(state: TabState): DraftSnapshot {
  const tabs = state.order.map((id) => state.tabs[id] as QueryTab);
  return {
    active_id: state.active_id,
    tabs: tabs.map((tab) => ({
      id: tab.id,
      title: tab.title,
      connection: tab.connection,
      text: tab.text,
      selection_from: tab.selection.from,
      selection_to: tab.selection.to,
      file: tab.file,
    })),
  };
}

function tabFrom(draft: TabDraft, connection: TabDraft['connection']): QueryTab {
  return {
    id: draft.id,
    title: draft.title,
    connection,
    text: draft.text,
    selection: { from: draft.selection_from, to: draft.selection_to },
    status: 'idle',
    result: null,
    run_offset: 0,
    panel: 0,
    transaction: null,
    error: null,
    file: draft.file,
  };
}

function list(titles: ReadonlyArray<string>): string {
  return titles.length === 1 ? (titles[0] as string) : `${titles.slice(0, -1).join(', ')} and ${titles[titles.length - 1]}`;
}

/** Brings back the tabs open at the last quit. Runs once at startup, after the saved servers load. */
export async function restoreTabs(): Promise<void> {
  const tabs = useQueryTabStore.getState();
  if (!isTauri()) {
    tabs.restore([], null, '');
    return;
  }
  try {
    const restored = await files.loadTabDrafts();
    const servers = useServerStore.getState();
    const known = servers.store?.status === 'unlocked' ? new Set(servers.servers.map((server) => server.id)) : null;
    const without_server: Array<string> = [];
    const restored_tabs = restored.snapshot.tabs.map((draft) => {
      const gone = known !== null && draft.connection !== null && !known.has(draft.connection.server_id);
      if (gone) without_server.push(draft.title);
      return tabFrom(draft, gone ? null : draft.connection);
    });
    const notes = [
      restored.set_aside && `The saved tabs couldn't be read, so they were set aside as ${restored.set_aside}.`,
      restored.missing_files.length > 0 && `The file for ${list(restored.missing_files)} is gone, so saving asks where to save.`,
      without_server.length > 0 && `The server for ${list(without_server)} was removed, so running asks for a connection.`,
    ].filter(Boolean);
    tabs.restore(restored_tabs, restored.snapshot.active_id, notes.join(' '));
  } catch (error) {
    tabs.restore([], null, `The saved tabs couldn't be restored: ${messageOf(error)}`);
  }
}

/** Writes the open tabs to disk a moment after each change, so a quit or crash loses none of their text. */
export function startSavingDrafts(): void {
  if (!isTauri()) return;
  let last = JSON.stringify(draftSnapshot(useQueryTabStore.getState()));
  let timer: number | undefined;
  useQueryTabStore.subscribe(() => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      const snapshot = draftSnapshot(useQueryTabStore.getState());
      const json = JSON.stringify(snapshot);
      if (json === last) return;
      last = json;
      files.saveTabDrafts(snapshot).catch((error: unknown) => useQueryTabStore.getState().announce(messageOf(error)));
    }, save_delay_ms);
  });
}
