import { act, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ProbeResult } from '../generated/connections';
import type { ServerSummary } from '../generated/servers';
import { useDialogStore } from '../store/dialogs';
import { useServerStore } from '../store/servers';
import { commandsOf, deferred, failWith, group, mockCommands, server } from '../testing/backend';
import { renderWithUser } from '../testing/render';
import { DialogHost } from './server-dialogs';

const info = { server_id: 'orders-dev', server_version: '17.2', encryption: null };

function openDialog(editing: ServerSummary | null) {
  useServerStore.setState({ groups: [group()] });
  const rendered = renderWithUser(<DialogHost />);
  act(() => useDialogStore.getState().openConnection(editing));
  return rendered;
}

const textbox = (name: string) => screen.getByRole('textbox', { name }) as HTMLInputElement;
const status = () => screen.getAllByRole('status')[0].textContent;

function steps(failing?: ProbeResult['step']): Array<ProbeResult> {
  return (['dns', 'tcp', 'tls', 'auth', 'database'] as const).map((step) => ({
    step,
    outcome: step === failing ? 'failed' : 'passed',
    detail: step === failing ? 'password authentication failed' : 'ok',
    elapsed_ms: 2,
  }));
}

describe('the connection dialog', () => {
  it('saves a new connection with its group and connects to it', async () => {
    const calls = mockCommands({ save_server: () => server({ group_id: 'orders-platform' }), connect_server: () => info });
    const { user } = openDialog(null);
    expect(screen.getByRole('dialog', { name: 'New connection' })).toBeTruthy();

    await user.type(textbox('Name'), 'orders-dev');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Group' }), 'Orders platform');
    await user.click(screen.getByRole('button', { name: 'Save and connect' }));

    await vi.waitFor(() => expect(commandsOf(calls)).toEqual(['save_server', 'connect_server']));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(calls[0].args).toMatchObject({ input: { name: 'orders-dev', group_id: 'orders-platform', password: { action: 'clear' } } });
  });

  it('edits a server, keeping its saved password unless asked to remove it', async () => {
    const saved = server({ has_password: true });
    const calls = mockCommands({ save_server: () => saved });
    const { user } = openDialog(saved);
    expect(screen.getByRole('dialog', { name: 'Edit orders-dev' })).toBeTruthy();
    expect(screen.getByLabelText('Password').getAttribute('aria-describedby')).toBe('connection-password-hint');

    await user.click(screen.getByRole('checkbox', { name: 'Remove the saved password' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(commandsOf(calls)).toEqual(['save_server']);
    expect(calls[0].args).toMatchObject({ input: { id: 'orders-dev', password: { action: 'clear' } } });
  });

  it('has no password hint for a server without a saved password', () => {
    openDialog(server());
    expect(screen.getByLabelText('Password').getAttribute('aria-describedby')).toBeNull();
    expect(screen.queryByRole('checkbox', { name: 'Remove the saved password' })).toBeNull();
  });

  it('fills the fields from a pasted URL, announces them, and reads the URL only once', async () => {
    const parsed = { host: 'db.internal', port: 6432, database: 'orders', user: 'app', password: null, tls: 'require' } as const;
    const calls = mockCommands({ parse_connection: () => parsed });
    const { user } = openDialog(null);

    await user.click(textbox('Connection URL'));
    await user.paste('postgres://app@db.internal:6432/orders?sslmode=require');
    await user.tab();

    expect(textbox('Host').value).toBe('db.internal');
    expect(textbox('Name').value).toBe('orders@db.internal');
    expect(status()).toBe('Filled host, port, database, user, TLS and name from the URL');
    expect(commandsOf(calls)).toEqual(['parse_connection']);
  });

  it('announces nothing when a URL fills no fields, and ignores an empty URL', async () => {
    const calls = mockCommands({ parse_connection: () => ({ host: null, port: null, database: null, user: null, password: null, tls: null }) });
    const { user } = openDialog(null);
    await user.type(textbox('Name'), 'orders-dev');

    await user.click(textbox('Connection URL'));
    await user.tab();
    await user.type(textbox('Connection URL'), 'postgres://');
    await user.tab();

    expect(commandsOf(calls)).toEqual(['parse_connection']);
    expect(status()).toBe('');
  });

  it('shows why a URL could not be read', async () => {
    mockCommands({ parse_connection: () => failWith('invalid', 'Not a valid connection URL: invalid port number') });
    const { user } = openDialog(null);

    await user.type(textbox('Connection URL'), 'postgres://h:99999/db');
    await user.tab();

    expect((await screen.findByRole('alert')).textContent).toBe('Not a valid connection URL: invalid port number');
  });

  it('makes production sessions read-only with a 15 second timeout, keeping a timeout already set', async () => {
    const { user } = openDialog(null);
    const read_only = screen.getByRole('checkbox', { name: 'Read-only sessions' }) as HTMLInputElement;
    const timeout = screen.getByRole('spinbutton', { name: 'Statement timeout (seconds)' }) as HTMLInputElement;

    await user.click(screen.getByRole('radio', { name: 'STAGING' }));
    expect([read_only.checked, timeout.value]).toEqual([false, '']);

    await user.click(screen.getByRole('radio', { name: 'PROD' }));
    expect([read_only.checked, timeout.value]).toEqual([true, '15']);

    await user.click(screen.getByRole('radio', { name: 'DEV' }));
    await user.clear(timeout);
    await user.type(timeout, '30');
    await user.click(screen.getByRole('radio', { name: 'PROD' }));
    expect(timeout.value).toBe('30');
  });

  it('runs a connection test, showing progress and then each step with a summary', async () => {
    const answers = [deferred<Array<ProbeResult>>(), deferred<Array<ProbeResult>>()];
    const pending = [...answers];
    mockCommands({ test_connection: () => pending.shift()?.promise });
    const { user } = openDialog(null);
    const test = screen.getByRole('button', { name: 'Test' }) as HTMLButtonElement;

    await user.click(test);
    expect(status()).toBe('Testing connection…');
    expect(test.disabled).toBe(true);
    expect(screen.getByText('Testing…')).toBeTruthy();

    await act(async () => answers[0].resolve(steps()));
    expect(status()).toBe('Connection test passed');
    expect(screen.getByRole('list', { name: 'Connection test' }).children).toHaveLength(5);

    await user.click(test);
    await act(async () => answers[1].resolve(steps('auth')));
    expect(status()).toBe('Connection test failed at Sign-in: password authentication failed');
    expect(screen.getByText('Sign-in failed')).toBeTruthy();
  });

  it('shows why a connection test could not run', async () => {
    mockCommands({ test_connection: () => failWith('store_locked', 'Saved servers are locked') });
    const { user } = openDialog(server());

    await user.click(screen.getByRole('button', { name: 'Test' }));

    expect((await screen.findByRole('alert')).textContent).toBe('Saved servers are locked');
    expect((screen.getByRole('button', { name: 'Test' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('keeps the dialog open with the reason when saving fails', async () => {
    const saving = deferred<void>();
    mockCommands({ save_server: () => saving.promise.then(() => failWith('invalid', 'Port must be between 1 and 65535')) });
    const { user } = openDialog(null);
    await user.type(textbox('Name'), 'orders-dev');

    await user.click(screen.getByRole('button', { name: 'Save and connect' }));
    expect(status()).toBe('Saving…');
    await act(async () => saving.resolve());

    expect((await screen.findByRole('alert')).textContent).toBe('Port must be between 1 and 65535');
    expect(screen.getByRole('dialog', { name: 'New connection' })).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Save and connect' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('closes without saving on cancel', async () => {
    const calls = mockCommands({});
    const { user } = openDialog(null);

    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(useDialogStore.getState().open).toBeNull();
    expect(calls).toEqual([]);
  });
});
