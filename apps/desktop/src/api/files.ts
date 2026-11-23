import { invoke } from '@tauri-apps/api/core';
import { open, save } from '@tauri-apps/plugin-dialog';
import type { DraftSnapshot, RestoredTabs } from '../generated/drafts';
import type { FileStamp, OpenedFile, SaveOutcome } from '../generated/files';

const filters = [
  { name: 'SQL', extensions: ['sql'] },
  { name: 'All files', extensions: ['*'] },
];

export const readSqlFile = (path: string) => invoke<OpenedFile>('read_sql_file', { path });
export const writeSqlFile = (path: string, text: string, expected: FileStamp | null) =>
  invoke<SaveOutcome>('write_sql_file', { path, text, expected });
export const loadTabDrafts = () => invoke<RestoredTabs>('load_tab_drafts');
export const saveTabDrafts = (snapshot: DraftSnapshot) => invoke<void>('save_tab_drafts', { snapshot });

/** The file the user picks in the system's Open dialog, or `null` when they cancel. */
export const pickSqlFile = () => open({ multiple: false, directory: false, filters });

/** Where the user chooses to save in the system's Save dialog, or `null` when they cancel. */
export const pickSavePath = (default_path: string) => save({ defaultPath: default_path, filters });
