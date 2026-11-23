import { isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useQueryTabStore } from '../store/query-tabs';

/** The Rust core's event for a tab whose idle results closed on their own. */
export const results_closed_event = 'query-results-closed';

/** Registered once at startup, so the tabs hear when the Rust core closes their idle results. */
export function listenToQueryEvents(): void {
  if (!isTauri()) return;
  void listen<string>(results_closed_event, (event) => useQueryTabStore.getState().resultsClosed(event.payload));
}
