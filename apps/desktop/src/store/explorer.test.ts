import { describe, expect, it } from 'vitest';
import { useExplorerStore } from './explorer';

describe('the explorer store', () => {
  it('toggling a group collapses it, toggling again expands it, and the state lasts for the session', () => {
    useExplorerStore.getState().toggleGroup('orders');
    expect(useExplorerStore.getState().collapsed_groups).toEqual({ orders: true });
    expect(JSON.parse(sessionStorage.getItem('tidewater-explorer') ?? '{}').state.collapsed_groups).toEqual({ orders: true });

    useExplorerStore.getState().toggleGroup('orders');

    expect(useExplorerStore.getState().collapsed_groups).toEqual({});
  });
});
