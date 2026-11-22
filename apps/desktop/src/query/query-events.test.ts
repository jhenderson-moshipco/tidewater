import { emit } from '@tauri-apps/api/event';
import { describe, expect, it, vi } from 'vitest';
import { useQueryTabStore } from '../store/query-tabs';
import { mockCommands, rowsOutcome, runResult, statement } from '../testing/backend';
import { listenToQueryEvents, results_closed_event } from './query-events';

describe('query events', () => {
  it('are not listened for outside the Tauri app', () => {
    expect(() => listenToQueryEvents()).not.toThrow();
  });

  it("turn off a tab's fetch more when the Rust core closes its idle results", async () => {
    mockCommands({ run_query: () => runResult([statement(rowsOutcome([['1']], { has_more: true }))]) });
    const id = useQueryTabStore.getState().openTab({ server_id: 'orders-dev', database: 'orders' });
    useQueryTabStore.getState().setText(id, 'SELECT 1');
    await useQueryTabStore.getState().run(id, 'all');
    listenToQueryEvents();

    await vi.waitFor(async () => {
      await emit(results_closed_event, id);
      expect(useQueryTabStore.getState().tabs[id]?.result?.statements[0]?.outcome).toMatchObject({ has_more: false });
    });
  });
});
