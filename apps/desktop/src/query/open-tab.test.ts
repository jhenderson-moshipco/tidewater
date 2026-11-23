import { describe, expect, it } from 'vitest';
import { useDialogStore } from '../store/dialogs';
import { useQueryTabStore } from '../store/query-tabs';
import { useServerStore } from '../store/servers';
import { useTreeStore } from '../store/tree';
import { server } from '../testing/backend';
import { openNewTab } from './open-tab';

const tabs = () => useQueryTabStore.getState();
const active = () => tabs().tabs[tabs().active_id as string];

describe('openNewTab', () => {
  it("starts on the explorer's selection over the active tab's connection", () => {
    useServerStore.setState({ servers: [server({ id: 'orders-dev', database: 'orders' })] });
    tabs().openTab({ server_id: 'elsewhere', database: 'x' });
    useTreeStore.setState({ active_id: 'server:orders-dev' });

    openNewTab();

    expect(active()?.connection).toEqual({ server_id: 'orders-dev', database: 'orders' });
  });

  it("starts on the active tab's connection without an explorer selection", () => {
    tabs().openTab({ server_id: 'orders-dev', database: 'billing' });
    openNewTab();
    expect(active()?.connection).toEqual({ server_id: 'orders-dev', database: 'billing' });
  });

  it('asks for a connection when there is nothing to start on', () => {
    openNewTab();
    expect(useDialogStore.getState().open).toEqual({ kind: 'pick-connection', tab_id: tabs().active_id, then_run: null });
  });

  it("asks for a connection when the active tab hasn't chosen one", () => {
    tabs().openTab(null);
    useDialogStore.setState({ open: null });
    openNewTab();
    expect(useDialogStore.getState().open).toMatchObject({ kind: 'pick-connection' });
  });
});
