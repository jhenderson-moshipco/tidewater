import { act, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useDialogStore } from '../store/dialogs';
import { useServerStore } from '../store/servers';
import { unlocked } from '../testing/backend';
import { renderWithUser } from '../testing/render';
import { Workspace } from './workspace';

const info = { server_id: 'orders-dev', database: 'orders', server_version: '17.2', encryption: null };

describe('the workspace', () => {
  it('opens a view from the activity bar, and pressing it again closes the sidebar', async () => {
    const { user } = renderWithUser(<Workspace />);
    const search = screen.getByRole('button', { name: 'Search' });

    await user.click(search);
    expect(screen.getByRole('heading', { name: 'Search' })).toBeTruthy();
    expect(screen.getByText('Connect to a server to search its objects.')).toBeTruthy();
    expect(search.getAttribute('aria-pressed')).toBe('true');

    await user.click(search);
    expect(screen.queryByRole('complementary')).toBeNull();
    expect(search.getAttribute('aria-pressed')).toBe('false');
  });

  it('counts connected servers in the status bar', () => {
    renderWithUser(<Workspace />);
    const status = () => within(screen.getByRole('contentinfo')).getByRole('status').textContent;
    expect(status()).toBe('No connection');

    act(() => useServerStore.setState({ connections: { a: { status: 'connected', info }, b: { status: 'connecting', started: 0 } } }));
    expect(status()).toBe('1 connection');

    act(() => useServerStore.setState({ connections: { a: { status: 'connected', info }, b: { status: 'connected', info } } }));
    expect(status()).toBe('2 connections');
  });

  it('offers a new connection in the main area only once saved servers are unlocked', async () => {
    const { user } = renderWithUser(<Workspace />);
    const main = within(screen.getByRole('main'));
    expect(main.queryByRole('button', { name: 'New connection' })).toBeNull();

    act(() => useServerStore.setState({ store: unlocked }));
    await user.click(main.getByRole('button', { name: 'New connection' }));

    expect(useDialogStore.getState().open).toEqual({ kind: 'connection', editing: null });
  });
});
