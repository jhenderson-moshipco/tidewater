import { create } from 'zustand';
import * as api from '../api/query';
import { messageOf } from '../api/errors';
import type { DraftFile } from '../generated/drafts';
import type { RunResult, StatementResult, TransactionStatus } from '../generated/query';
import { runAnnouncement } from '../query/describe';
import type { TabConnection } from '../query/default-connection';
import { statementAt } from '../query/statements';
import { useDialogStore } from './dialogs';

export type RunMode = 'statement' | 'all';
export type ResultPanel = number | 'messages';

export type QueryTab = {
  id: string;
  title: string;
  connection: TabConnection | null;
  text: string;
  selection: { from: number; to: number };
  status: 'idle' | 'running' | 'fetching';
  /** When the current run or fetch started, in milliseconds since the epoch. */
  started_at: number | null;
  result: RunResult | null;
  /** Where the text that last ran starts in the editor, so its spans and error positions map back. */
  run_offset: number;
  panel: ResultPanel;
  transaction: TransactionStatus | null;
  /** Why the last run, fetch or save failed. */
  error: string | null;
  /** The .sql file the tab was opened from or saved to. */
  file: DraftFile | null;
};

/** What a new tab starts with besides its connection. */
export type TabContent = { title?: string; text?: string; file?: DraftFile | null; selection?: { from: number; to: number } };

/** Whether the tab holds text its file, or for an Untitled tab no file, doesn't have. */
export function isUnsaved(tab: QueryTab): boolean {
  return tab.file ? tab.text !== tab.file.saved_text : tab.text !== '';
}

type QueryTabState = {
  tabs: Readonly<Record<string, QueryTab>>;
  order: ReadonlyArray<string>;
  active_id: string | null;
  next_number: number;
  /** The latest sentence for the query area's status region. */
  announcement: string;
  /** Whether the tabs from the last launch are back, so the workspace can replace the startup screen. */
  restored: boolean;
  openTab: (connection: TabConnection | null, content?: TabContent) => string;
  /** Replaces every tab with tabs restored from the last launch. */
  restore: (tabs: ReadonlyArray<QueryTab>, active_id: string | null, announcement: string) => void;
  /** Records the file the tab now matches, renaming the tab after it. */
  setFile: (id: string, file: DraftFile, title: string) => void;
  announce: (announcement: string, tab?: { id: string; error: string }) => void;
  selectTab: (id: string) => void;
  setText: (id: string, text: string) => void;
  setSelection: (id: string, from: number, to: number) => void;
  setConnection: (id: string, connection: TabConnection) => void;
  showPanel: (id: string, panel: ResultPanel) => void;
  run: (id: string, mode: RunMode) => Promise<void>;
  fetchMore: (id: string) => Promise<void>;
  cancel: (id: string) => Promise<void>;
  /** Closes the tab, first asking when that would lose unsaved text or roll back a transaction the user began. */
  requestClose: (id: string) => void;
  closeTab: (id: string) => void;
  /** The Rust core closed the tab's idle results on its own. */
  resultsClosed: (id: string) => void;
};

/** Opens the panel of the first failed statement, or else the last statement's. */
function panelFor(statements: ReadonlyArray<StatementResult>): number {
  const failed = statements.findIndex((statement) => statement.outcome.kind === 'error');
  return failed === -1 ? statements.length - 1 : failed;
}

export const useQueryTabStore = create<QueryTabState>()((set, get) => {
  const update = (id: string, change: Partial<QueryTab>) =>
    set((state) => {
      const tab = state.tabs[id];
      return tab ? { tabs: { ...state.tabs, [id]: { ...tab, ...change } } } : {};
    });

  /** The text a run sends and where it starts in the editor, or `null` when there is no statement at the cursor. */
  const textToRun = async (tab: QueryTab, mode: RunMode): Promise<{ sql: string; offset: number } | null> => {
    const { from, to } = tab.selection;
    if (mode === 'all') return { sql: tab.text, offset: 0 };
    if (from !== to) return { sql: tab.text.slice(from, to), offset: from };
    const span = statementAt(await api.splitStatements(tab.text), to);
    return span && { sql: tab.text.slice(span.from, span.to), offset: span.from };
  };

  return {
    tabs: {},
    order: [],
    active_id: null,
    next_number: 1,
    announcement: '',
    restored: false,

    openTab: (connection, content = {}) => {
      const { next_number } = get();
      const id = `query-${crypto.randomUUID()}`;
      const tab: QueryTab = {
        id,
        title: content.title ?? `Untitled-${next_number}`,
        connection,
        text: content.text ?? '',
        selection: content.selection ?? { from: 0, to: 0 },
        status: 'idle',
        started_at: null,
        result: null,
        run_offset: 0,
        panel: 0,
        transaction: null,
        error: null,
        file: content.file ?? null,
      };
      const numbered = content.title === undefined;
      set((state) => ({
        tabs: { ...state.tabs, [id]: tab },
        order: [...state.order, id],
        active_id: id,
        next_number: numbered ? next_number + 1 : next_number,
      }));
      return id;
    },

    restore: (tabs, active_id, announcement) => {
      const numbers = tabs.map((tab) => Number(/^Untitled-(\d+)$/.exec(tab.title)?.[1] ?? 0));
      set({
        tabs: Object.fromEntries(tabs.map((tab) => [tab.id, tab])),
        order: tabs.map((tab) => tab.id),
        active_id: tabs.some((tab) => tab.id === active_id) ? active_id : (tabs[0]?.id ?? null),
        next_number: Math.max(0, ...numbers) + 1,
        announcement,
        restored: true,
      });
    },

    setFile: (id, file, title) => update(id, { file, title, error: null }),

    announce: (announcement, tab) => {
      if (tab) update(tab.id, { error: tab.error });
      set({ announcement });
    },

    selectTab: (id) => set({ active_id: id }),
    setText: (id, text) => update(id, { text }),
    setSelection: (id, from, to) => update(id, { selection: { from, to } }),
    setConnection: (id, connection) => update(id, { connection }),
    showPanel: (id, panel) => update(id, { panel }),

    run: async (id, mode) => {
      const tab = get().tabs[id];
      if (!tab || tab.status !== 'idle') return;
      if (!tab.connection) {
        useDialogStore.getState().show({ kind: 'pick-connection', tab_id: id, then_run: mode });
        return;
      }
      const { server_id, database } = tab.connection;
      update(id, { status: 'running', started_at: Date.now(), error: null });
      set({ announcement: 'Running…' });
      try {
        const target = await textToRun(tab, mode);
        if (!target) {
          update(id, { status: 'idle', started_at: null });
          set({ announcement: 'There is no statement to run.' });
          return;
        }
        const result = await api.runQuery(id, server_id, database, target.sql);
        update(id, { status: 'idle', started_at: null, result, run_offset: target.offset, panel: panelFor(result.statements), transaction: result.transaction });
        set({ announcement: runAnnouncement(result) });
      } catch (error) {
        const message = messageOf(error);
        update(id, { status: 'idle', started_at: null, error: message });
        set({ announcement: message });
      }
    },

    fetchMore: async (id) => {
      const tab = get().tabs[id];
      const last = tab?.result?.statements[tab.result.statements.length - 1];
      if (!tab?.result || tab.status !== 'idle' || last?.outcome.kind !== 'rows') return;
      update(id, { status: 'fetching', started_at: Date.now(), error: null });
      try {
        const batch = await api.fetchMoreRows(id);
        const rows = [...last.outcome.rows, ...batch.rows];
        const statement: StatementResult = {
          ...last,
          notices: [...last.notices, ...batch.notices],
          outcome: { ...last.outcome, rows, has_more: batch.has_more, total_rows: batch.has_more ? null : rows.length },
        };
        const result = { ...tab.result, statements: [...tab.result.statements.slice(0, -1), statement] };
        update(id, { status: 'idle', started_at: null, result, transaction: batch.transaction });
        const more = batch.has_more ? ', more available' : '';
        set({ announcement: `${batch.rows.length.toLocaleString()} more rows, ${rows.length.toLocaleString()} in all${more}.` });
      } catch (error) {
        const message = messageOf(error);
        update(id, { status: 'idle', started_at: null, error: message });
        set({ announcement: message });
      }
    },

    cancel: async (id) => {
      try {
        await api.cancelQuery(id);
      } catch (error) {
        const message = messageOf(error);
        update(id, { error: message });
        set({ announcement: message });
      }
    },

    requestClose: (id) => {
      const tab = get().tabs[id];
      const transaction = tab?.transaction === 'open' || tab?.transaction === 'failed' ? tab.transaction : null;
      if (tab && isUnsaved(tab)) {
        useDialogStore.getState().show({ kind: 'unsaved-tab', tab_id: id, title: tab.title, transaction });
        return;
      }
      if (tab?.transaction === 'open' || tab?.transaction === 'failed') {
        useDialogStore.getState().show({ kind: 'close-tab', tab_id: id, title: tab.title, transaction: tab.transaction });
        return;
      }
      get().closeTab(id);
    },

    closeTab: (id) => {
      void api.closeQueryTab(id);
      set((state) => {
        const index = state.order.indexOf(id);
        const order = state.order.filter((candidate) => candidate !== id);
        const tabs = { ...state.tabs };
        delete tabs[id];
        const neighbour = order[Math.min(index, order.length - 1)] ?? null;
        return { tabs, order, active_id: state.active_id === id ? neighbour : state.active_id };
      });
    },

    resultsClosed: (id) => {
      const tab = get().tabs[id];
      const last = tab?.result?.statements[tab.result.statements.length - 1];
      if (!tab?.result || last?.outcome.kind !== 'rows' || !last.outcome.has_more) return;
      const statement: StatementResult = { ...last, outcome: { ...last.outcome, has_more: false } };
      const result = { ...tab.result, statements: [...tab.result.statements.slice(0, -1), statement] };
      update(id, { result, transaction: tab.transaction === 'holding_results' ? 'idle' : tab.transaction });
      set({ announcement: `${tab.title}: results closed after being left idle. Run the statement again to see more rows.` });
    },
  };
});
