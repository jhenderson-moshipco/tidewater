import { describe, expect, it } from 'vitest';
import { clampSidebarWidth, useWorkspaceStore } from './workspace';

const state = () => useWorkspaceStore.getState();

describe('the workspace store', () => {
  it('selecting another view shows it, and selecting the shown view again closes the sidebar', () => {
    state().selectView('history');
    expect([state().active_view, state().sidebar_open]).toEqual(['history', true]);

    state().selectView('history');
    expect([state().active_view, state().sidebar_open]).toEqual(['history', false]);

    state().selectView('history');
    expect(state().sidebar_open).toBe(true);
  });

  it('showing a view always opens the sidebar', () => {
    state().toggleSidebar();
    expect(state().sidebar_open).toBe(false);

    state().showView('performance');

    expect([state().active_view, state().sidebar_open]).toEqual(['performance', true]);
  });

  it('keeps the sidebar between 200 and 640 pixels, in whole pixels, and remembers it', () => {
    expect([clampSidebarWidth(120), clampSidebarWidth(900), clampSidebarWidth(300.6)]).toEqual([200, 640, 301]);

    state().setSidebarWidth(333.2);

    expect(JSON.parse(localStorage.getItem('tidewater-workspace') ?? '{}').state).toEqual({ sidebar_width: 333 });
  });
});
