import { EditorView } from '@codemirror/view';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { ObjectDefinition } from '../generated/objects';
import { Workspace } from '../shell/workspace';
import { useObjectEditorStore, type EditorRequest, type ObjectEditor } from '../store/object-editors';
import { useServerStore } from '../store/servers';
import {
  changePlan,
  commandsOf,
  failWith,
  mockCommands,
  objectRef,
  routineDefinition,
  server,
  unlocked,
  viewDefinition,
  editor_basics,
} from '../testing/backend';
import { renderWithUser } from '../testing/render';

const store = () => useObjectEditorStore.getState();
const editors = () => Object.values(store().editors);
const draftOf = () => (editors()[0] as ObjectEditor).draft as ObjectDefinition & Record<string, unknown>;

const edit_view: EditorRequest = {
  mode: 'edit',
  server_id: 'orders-dev',
  database: 'orders',
  object_type: 'view',
  object: objectRef(),
  schema: null,
  label: 'open_orders',
};

function backend(handlers: Partial<Record<string, (args: Record<string, unknown>) => unknown>> = {}) {
  return mockCommands({
    ...editor_basics,
    list_schemas: () => ['public', 'sales'],
    object_definition: () => viewDefinition(),
    plan_object_change: () => changePlan(),
    apply_object_change: () => ({ outcome: 'applied' }),
    catalog_children: () => [],
    ...handlers,
  });
}

/** Renders the workspace with an editor open, once its definition has loaded. */
async function openEditor(request: EditorRequest = edit_view) {
  useServerStore.setState({ store: unlocked, servers: [server(), server({ id: 'orders-prod', name: 'orders-prod', environment: 'prod' })] });
  const rendered = renderWithUser(<Workspace />);
  act(() => void store().open(request));
  await waitFor(() => expect(screen.queryByText('Loading…')).toBeNull());
  return rendered;
}

function codeEditor(name: string): EditorView {
  return EditorView.findFromDOM(screen.getByRole('textbox', { name })) as EditorView;
}

const preview = () => screen.getByRole('region', { name: 'SQL to run' });

describe('an object editor in a dialog', () => {
  it('previews the SQL for an edit, then reviews and applies it in one transaction and closes', async () => {
    const calls = backend();
    const { user } = await openEditor();
    const dialog = screen.getByRole('dialog', { name: 'public.open_orders' });
    expect(within(preview()).getByText('No changes yet.')).toBeTruthy();

    act(() => codeEditor('Query').dispatch({ changes: { from: 9, insert: ', total' } }));
    await waitFor(() => expect(within(preview()).getByText('1 statement to run.')).toBeTruthy());
    expect(draftOf().query).toBe('SELECT id, total FROM orders');
    expect(within(preview()).getByText(`${changePlan().statements[0]};`)).toBeTruthy();

    await user.click(within(dialog).getByRole('button', { name: 'Review and apply' }));
    expect(screen.getByText('1 statement, run in one transaction. If one fails, none of them is kept.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Back to editing' }));
    await user.click(within(dialog).getByRole('button', { name: 'Review and apply' }));
    await user.click(screen.getByRole('button', { name: 'Apply' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(commandsOf(calls)).toContain('apply_object_change');
    expect(screen.getByText('Changes to public.open_orders applied.')).toBeTruthy();
  });

  it('asks before Escape discards changes, and keeps editing when asked to', async () => {
    backend();
    const { user } = await openEditor();
    const dialog = screen.getByRole('dialog');
    await user.type(screen.getByRole('textbox', { name: 'Name' }), 's');

    fireEvent(dialog, new Event('cancel', { cancelable: true }));
    const ask = screen.getByRole('group', { name: "Your changes haven't been applied. Discard them?" });
    await user.click(within(ask).getByRole('button', { name: 'Keep editing' }));
    expect(screen.queryByRole('group')).toBeNull();

    fireEvent(dialog, new Event('cancel', { cancelable: true }));
    await user.click(screen.getByRole('button', { name: 'Discard' }));

    expect([screen.queryByRole('dialog'), editors()]).toEqual([null, []]);
  });

  it('closes from its close button, asking first when that would discard changes', async () => {
    backend();
    const { user } = await openEditor();
    await user.type(screen.getByRole('textbox', { name: 'Name' }), 's');

    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.getByRole('group', { name: "Your changes haven't been applied. Discard them?" })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Discard' }));

    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('closes on Escape at once when nothing has changed', async () => {
    backend();
    await openEditor();

    fireEvent(screen.getByRole('dialog'), new Event('cancel', { cancelable: true }));

    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('moves into a tab with its changes, marked unsaved, and closing the tab asks first', async () => {
    backend();
    const { user } = await openEditor();
    await user.type(screen.getByRole('textbox', { name: 'Name' }), '_v2');

    await user.click(screen.getByRole('button', { name: 'Open in tab' }));

    expect(screen.queryByRole('dialog')).toBeNull();
    const tab = screen.getByRole('tab', { name: /^public\.open_orders , unsaved/ });
    expect(tab.getAttribute('aria-selected')).toBe('true');
    expect((screen.getByRole('textbox', { name: 'Name' }) as HTMLInputElement).value).toBe('open_orders_v2');
    expect(screen.queryByRole('button', { name: 'Open in tab' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Close' })).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Close public.open_orders' }));
    expect(screen.getByRole('group', { name: "Your changes haven't been applied. Discard them?" })).toBeTruthy();
    fireEvent.keyDown(tab, { key: 'Delete' });
    await user.click(screen.getByRole('button', { name: 'Discard' }));
    expect(screen.queryByRole('tab')).toBeNull();
  });

  it('copies the SQL into a new query tab without running it', async () => {
    const calls = backend();
    const { user } = await openEditor({ ...edit_view, host: 'tab' });
    await user.type(screen.getByRole('textbox', { name: 'Name' }), 's');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Copy to tab' }).hasAttribute('disabled')).toBe(false));

    await user.click(screen.getByRole('button', { name: 'Copy to tab' }));

    expect(screen.getByRole('tab', { name: /^Untitled-1/ }).getAttribute('aria-selected')).toBe('true');
    expect(commandsOf(calls)).not.toContain('apply_object_change');
  });
});

describe('reviewing a change', () => {
  async function reviewed(request: EditorRequest) {
    const rendered = await openEditor(request);
    await rendered.user.type(screen.getByRole('textbox', { name: 'Name' }), 's');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Review and apply' }).hasAttribute('disabled')).toBe(false));
    await rendered.user.click(screen.getByRole('button', { name: 'Review and apply' }));
    return rendered;
  }

  it('applies a change on a PROD server only after its name is typed', async () => {
    backend();
    const { user } = await reviewed({ ...edit_view, server_id: 'orders-prod' });
    const apply = screen.getByRole('button', { name: 'Apply' });
    expect(apply.hasAttribute('disabled')).toBe(true);

    await user.type(screen.getByRole('textbox', { name: 'This is a PROD server. Type orders-prod to apply.' }), 'orders-prod');

    expect(apply.hasAttribute('disabled')).toBe(false);
  });

  it('shows which statement failed, with its detail and hint, and marks it in the list', async () => {
    const failure = { statement_index: 0, message: 'cannot drop columns from view', detail: 'It has 2 columns.', hint: 'Recreate it.' };
    backend({ apply_object_change: () => ({ outcome: 'failed', failure }) });
    const { user } = await reviewed(edit_view);

    await user.click(screen.getByRole('button', { name: 'Apply' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe(
      'Statement 1 failed, so nothing was changed: cannot drop columns from viewDetail: It has 2 columns.Hint: Recreate it.',
    );
    expect(screen.getByRole('listitem').getAttribute('data-failed')).toBe('true');
  });

  it('shows why the change could not be sent, and a failure with no detail', async () => {
    let sent = 0;
    backend({
      apply_object_change: () =>
        ++sent === 1 ? failWith('connection', 'connection refused') : { outcome: 'failed', failure: { statement_index: 0, message: 'nope', detail: null, hint: null } },
    });
    const { user } = await reviewed(edit_view);

    await user.click(screen.getByRole('button', { name: 'Apply' }));
    expect((await screen.findByRole('alert')).textContent).toBe('connection refused');
    await user.click(screen.getByRole('button', { name: 'Apply' }));

    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Statement 1 failed, so nothing was changed: nope'));
  });

  it('lists warnings and the objects a recreate would drop, offering CASCADE', async () => {
    backend({
      plan_object_change: () =>
        changePlan({
          statements: ['DROP VIEW public.open_orders', 'CREATE VIEW public.open_orders AS SELECT id FROM orders'],
          warnings: [{ title: 'Recreates the view', detail: 'Its columns changed.' }],
          dependents: ['view public.totals'],
        }),
    });
    const { user } = await reviewed(edit_view);

    expect(screen.getByText('2 statements, run in one transaction. If one fails, none of them is kept.')).toBeTruthy();
    expect(screen.getByText('Recreates the view.').parentElement?.textContent).toBe('Recreates the view. Its columns changed.');
    expect(screen.getByText('view public.totals')).toBeTruthy();
    await user.click(screen.getByRole('checkbox', { name: 'Drop the objects that depend on it too (CASCADE)' }));
    expect((editors()[0] as ObjectEditor).options.cascade).toBe(true);
    expect(screen.getByText('Working out the SQL…')).toBeTruthy();
  });

  it('shows a plan error in place of the statements', async () => {
    let planned = 0;
    backend({ plan_object_change: () => (++planned === 1 ? changePlan({ dependents: ['view public.totals'] }) : failWith('invalid', 'Name is required.')) });
    const { user } = await reviewed(edit_view);

    await user.click(screen.getByRole('checkbox', { name: 'Drop the objects that depend on it too (CASCADE)' }));

    await waitFor(() => expect(screen.getByText('Name is required.')).toBeTruthy());
  });
});

describe('statements after the commit', () => {
  it('lists the statements that run after the commit apart, numbered on, and says when one of them failed after the rest committed', async () => {
    const plan = changePlan({ statements: ['ALTER TABLE public.t ADD COLUMN n integer'], after_commit: ['CREATE INDEX CONCURRENTLY ON public.t USING btree (n)'] });
    const failure = { statement_index: 1, committed: true, message: 'could not create index', detail: null, hint: null };
    backend({ plan_object_change: () => plan, apply_object_change: () => ({ outcome: 'failed', failure }) });
    const { user } = await openEditor({ ...edit_view, server_id: 'orders-prod' });
    await user.type(screen.getByRole('textbox', { name: 'Name' }), 's');

    await waitFor(() => expect(within(preview()).getByText('2 statements to run.')).toBeTruthy());
    expect(within(preview()).getByText('Then, each on its own once that commits:')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Review and apply' }));
    const lists = screen.getAllByRole('list');
    expect([lists[1]?.getAttribute('start'), lists.length]).toEqual(['2', 2]);
    await user.type(screen.getByRole('textbox', { name: 'This is a PROD server. Type orders-prod to apply.' }), 'orders-prod');
    await user.click(screen.getByRole('button', { name: 'Apply' }));

    expect((await screen.findByRole('alert')).textContent).toBe(
      "The change committed, but statement 2, after the commit, failed, and those after it didn't run: could not create index",
    );
  });
});

describe('dropping an object', () => {
  it('lists the SQL and says nothing depends on it, and Cancel closes', async () => {
    backend({ plan_object_change: () => changePlan({ statements: ['DROP VIEW public.open_orders'] }) });
    const { user } = await openEditor({ ...edit_view, mode: 'drop' });

    expect(await screen.findByText('DROP VIEW public.open_orders;')).toBeTruthy();
    expect(screen.getByRole('dialog', { name: 'Drop public.open_orders?' })).toBeTruthy();
    expect(screen.getByText('Nothing else depends on it.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Open in tab' })).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('drops it and says so', async () => {
    const calls = backend({ plan_object_change: () => changePlan({ statements: ['DROP VIEW public.open_orders'] }) });
    const { user } = await openEditor({ ...edit_view, mode: 'drop' });
    await screen.findByText('DROP VIEW public.open_orders;');

    await user.click(screen.getByRole('button', { name: 'Drop' }));

    await waitFor(() => expect(screen.getByText('View public.open_orders dropped.')).toBeTruthy());
    expect(calls.find((call) => call.command === 'apply_object_change')?.args).toMatchObject({ statements: ['DROP VIEW public.open_orders'] });
  });
});

describe('loading an editor', () => {
  it('shows why the definition could not be read and tries again', async () => {
    let tries = 0;
    backend({ object_definition: () => (++tries === 1 ? failWith('not_found', 'This object no longer exists.') : viewDefinition()) });
    const { user } = await openEditor({ ...edit_view, server_id: 'removed' });
    expect(screen.getByRole('alert').textContent).toBe('This object no longer exists.');

    await user.click(screen.getByRole('button', { name: 'Try again' }));

    expect(await screen.findByRole('textbox', { name: 'Name' })).toBeTruthy();
  });
});

describe('the designers', () => {
  const create = (object_type: EditorRequest['object_type']): EditorRequest => ({ ...edit_view, mode: 'create', object_type, object: null, schema: 'public', label: '' });

  it('edits a schema by name and comment, clearing an empty comment to none', async () => {
    backend();
    const { user } = await openEditor(create('schema'));
    expect(screen.getByRole('dialog', { name: 'New schema' })).toBeTruthy();

    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'sales');
    await user.type(screen.getByRole('textbox', { name: 'Comment' }), 'x');
    expect(draftOf().comment).toBe('x');
    await user.clear(screen.getByRole('textbox', { name: 'Comment' }));

    expect(draftOf()).toEqual({ type: 'schema', name: 'sales', comment: null });
  });

  it('edits each sequence setting, explaining empty limits', async () => {
    backend();
    const { user } = await openEditor(create('sequence'));

    await user.selectOptions(screen.getByRole('combobox', { name: 'Schema' }), 'sales');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Data type' }), 'integer');
    await user.clear(screen.getByRole('textbox', { name: 'Increment' }));
    await user.type(screen.getByRole('textbox', { name: 'Increment' }), '5');
    await user.type(screen.getByRole('textbox', { name: "Minimum Empty for the data type's lowest." }), '10');
    await user.click(screen.getByRole('checkbox', { name: 'Start over when it passes the maximum (CYCLE)' }));

    expect(draftOf()).toMatchObject({ schema: 'sales', data_type: 'integer', increment: '5', min_value: '10', cycle: true });
    expect(screen.getByRole('textbox', { name: "Maximum Empty for the data type's highest." })).toBeTruthy();
  });

  it('says in the preview why a new view cannot be planned yet, and moving the cursor changes nothing', async () => {
    const calls = backend({ plan_object_change: () => failWith('invalid', 'Name is required.') });
    await openEditor(create('view'));

    act(() => codeEditor('Query').dispatch({ selection: { anchor: 0 } }));
    expect(commandsOf(calls)).not.toContain('plan_object_change');
    act(() => codeEditor('Query').dispatch({ changes: { from: 0, insert: 'SELECT 1' } }));

    await waitFor(() => expect(within(preview()).getByRole('status').textContent).toBe('Name is required.'));
  });

  it('fills a new materialized view WITH DATA unless that is turned off', async () => {
    backend();
    const { user } = await openEditor(create('materialized_view'));
    const with_data = screen.getByRole('checkbox', { name: "Fill it with the query's rows when it's created (WITH DATA)" }) as HTMLInputElement;
    expect(with_data.checked).toBe(true);

    await user.click(with_data);

    expect((editors()[0] as ObjectEditor).options.with_data).toBe(false);
  });

  it('edits a function, and a new routine switched to a procedure drops the fields a procedure lacks', async () => {
    backend();
    const { user } = await openEditor(create('function'));
    await user.selectOptions(screen.getByRole('combobox', { name: 'Volatility' }), 'stable');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Parallel' }), 'safe');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Security' }), 'definer');
    await user.clear(screen.getByRole('textbox', { name: 'Returns' }));
    await user.type(screen.getByRole('textbox', { name: 'Returns' }), 'numeric');
    act(() => codeEditor('Body').dispatch({ changes: { from: 6, insert: '  RETURN 1;' } }));
    expect(draftOf()).toMatchObject({ volatility: 'stable', parallel: 'safe', security_definer: true, returns: 'numeric', body: 'BEGIN\n  RETURN 1;\nEND' });

    await user.selectOptions(screen.getByRole('combobox', { name: 'Kind' }), 'procedure');
    expect(draftOf()).toMatchObject({ procedure: true, returns: '' });
    expect(screen.queryByRole('textbox', { name: 'Returns' })).toBeNull();
    expect(screen.queryByRole('combobox', { name: 'Volatility' })).toBeNull();
    expect(screen.getByRole('dialog', { name: 'New procedure' })).toBeTruthy();

    await user.selectOptions(screen.getByRole('combobox', { name: 'Kind' }), 'function');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Security' }), 'invoker');
    expect(draftOf()).toMatchObject({ procedure: false, returns: 'void', security_definer: false });
  });

  it("can't change an existing routine's kind, and shows its arguments and comment", async () => {
    backend({ object_definition: () => routineDefinition() });
    await openEditor({ ...edit_view, object_type: 'function', object: objectRef({ object_type: 'function' }) });

    expect(screen.getByRole('combobox', { name: 'Kind' }).hasAttribute('disabled')).toBe(true);
    expect((screen.getByRole('textbox', { name: /^Arguments/ }) as HTMLInputElement).value).toBe('p_id bigint, p_pct numeric DEFAULT 10');
    expect((screen.getByRole('textbox', { name: 'Comment' }) as HTMLInputElement).value).toBe('Takes a percentage off');
  });
});

