import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { commandsOf, mockCommands, unlocked } from './testing/backend';

describe('the app entry', () => {
  it('refuses to start without the #root element', async () => {
    vi.resetModules();
    await expect(import('./main')).rejects.toThrow('Missing #root element');
  });

  it('loads the saved servers, then the last tabs, then renders the workspace into #root', async () => {
    document.body.innerHTML = '<div id="root"></div>';
    const calls = mockCommands({
      store_status: () => unlocked,
      list_servers: () => ({ groups: [], servers: [] }),
      load_tab_drafts: () => ({ snapshot: { active_id: null, tabs: [] }, missing_files: [], set_aside: null }),
    });
    vi.resetModules();

    await import('./main');

    expect(await screen.findByText('No servers yet.')).toBeTruthy();
    expect(commandsOf(calls)).toEqual(['store_status', 'list_servers', 'load_tab_drafts']);
  });
});
