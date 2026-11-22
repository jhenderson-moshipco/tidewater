import { describe, expect, it } from 'vitest';
import { server } from '../testing/backend';
import { empty_draft, useDialogStore } from './dialogs';

const state = () => useDialogStore.getState();

describe('the dialog store', () => {
  it('a new connection starts from the defaults and clears the last attempt', () => {
    state().setProbe([{ step: 'dns', outcome: 'failed', detail: 'Couldn\'t resolve db', elapsed_ms: 3 }]);
    state().setError('Saving failed');

    state().openConnection(null);

    expect(state().open).toEqual({ kind: 'connection', editing: null });
    expect(state().draft).toEqual(empty_draft);
    expect([state().probe, state().error, state().draft_version]).toEqual([null, null, 1]);
  });

  it('editing starts from the saved server, in seconds and without its password', () => {
    const saved = server({ group_id: 'orders', session: { read_only: true, statement_timeout_ms: 15_000, results_timeout_ms: 300_000 }, has_password: true });

    state().openConnection(saved);

    expect(state().draft).toMatchObject({ group_id: 'orders', read_only: true, statement_timeout_s: 15, password: '' });
    state().openConnection(server());
    expect(state().draft).toMatchObject({ group_id: '', statement_timeout_s: '' });
    expect(state().draft_version).toBe(2);
  });

  it('showing another dialog clears the last error, and closing clears everything', () => {
    state().setBusy('saving');
    state().setError('Saving failed');
    state().setNotice('Filled host');

    state().show({ kind: 'start-fresh' });
    expect([state().open, state().busy, state().error, state().notice]).toEqual([{ kind: 'start-fresh' }, null, null, null]);

    state().setProbe([]);
    state().close();
    expect([state().open, state().probe]).toEqual([null, null]);
  });
});
