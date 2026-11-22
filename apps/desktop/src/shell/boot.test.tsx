import { act, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useServerStore } from '../store/servers';
import { renderWithUser } from '../testing/render';
import { App } from './boot';

describe('the app', () => {
  it('shows the startup screen until the saved servers have loaded, then the workspace', () => {
    renderWithUser(<App />);
    expect(screen.getByRole('status').textContent).toBe('Starting…');
    expect(screen.queryByRole('main')).toBeNull();

    act(() => useServerStore.setState({ booted: true }));

    expect(screen.getByRole('main')).toBeTruthy();
  });
});
