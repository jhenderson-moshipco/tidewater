import * as files from '../api/files';
import { messageOf } from '../api/errors';
import { useDialogStore } from '../store/dialogs';
import { useQueryTabStore } from '../store/query-tabs';
import { openNewTab } from './open-tab';

/** The last part of a path, on any operating system. */
export function fileName(path: string): string {
  return path.split(/[\\/]/).pop() as string;
}

/** Adds `.sql` to a path whose file name has no extension. */
export function withSqlExtension(path: string): string {
  return fileName(path).includes('.') ? path : `${path}.sql`;
}

/** Opens a .sql file in a new tab, or switches to the tab that already has it open. */
export async function openSqlFile(): Promise<void> {
  const tabs = useQueryTabStore.getState();
  try {
    const path = await files.pickSqlFile();
    if (!path) return;
    const open = tabs.order.find((id) => tabs.tabs[id]?.file?.path === path);
    if (open) {
      tabs.selectTab(open);
      return;
    }
    const opened = await files.readSqlFile(path);
    openNewTab({ title: opened.name, text: opened.text, file: { path: opened.path, saved_text: opened.text, stamp: opened.stamp } });
    useQueryTabStore.getState().announce(`Opened ${opened.name}.`);
  } catch (error) {
    useQueryTabStore.getState().announce(messageOf(error));
  }
}

type SaveOptions = {
  /** Asks where to save even when the tab has a file. */
  as?: boolean;
  /** Writes even if another program changed the file. */
  overwrite?: boolean;
  /** Closes the tab once its text is saved. */
  then_close?: boolean;
};

/** Saves the tab's text to its file, asking where for an Untitled tab or Save As, and asking before overwriting outside changes. */
export async function saveTab(tab_id: string, options: SaveOptions = {}): Promise<void> {
  const tabs = useQueryTabStore.getState();
  const tab = tabs.tabs[tab_id];
  if (!tab) return;
  try {
    const chosen = tab.file && !options.as ? tab.file.path : await files.pickSavePath(tab.file?.path ?? `${tab.title}.sql`);
    if (!chosen) return;
    const path = chosen === tab.file?.path ? chosen : withSqlExtension(chosen);
    const expected = path === tab.file?.path && !options.overwrite ? tab.file.stamp : null;
    const outcome = await files.writeSqlFile(path, tab.text, expected);
    if (outcome.outcome === 'changed_on_disk') {
      useDialogStore.getState().show({ kind: 'overwrite-file', tab_id, title: tab.title, then_close: options.then_close === true });
      return;
    }
    const name = fileName(path);
    tabs.setFile(tab_id, { path, saved_text: tab.text, stamp: outcome.stamp }, name);
    tabs.announce(`Saved ${name}.`);
    if (options.then_close) tabs.closeTab(tab_id);
  } catch (error) {
    const message = messageOf(error);
    tabs.announce(message, { id: tab_id, error: message });
  }
}
