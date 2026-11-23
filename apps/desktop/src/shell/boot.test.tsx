import { act, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useQueryTabStore } from '../store/query-tabs';
import { useServerStore } from '../store/servers';
import { renderWithUser } from '../testing/render';
import { App } from './boot';

describe('the app', () => {
  it('shows the startup screen until the saved servers and the last tabs are back, then the workspace', () => {
    renderWithUser(<App />);
    expect(screen.getByRole('status').textContent).toBe('Starting…');
    expect(screen.queryByRole('main')).toBeNull();

    act(() => useServerStore.setState({ booted: true }));
    expect(screen.queryByRole('main')).toBeNull();
    act(() => useQueryTabStore.setState({ restored: true }));

    expect(screen.getByRole('main')).toBeTruthy();
  });
});
