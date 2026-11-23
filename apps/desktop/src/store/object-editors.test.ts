import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ObjectDefinition } from '../generated/objects';
import {
  changePlan,
  commandsOf,
  deferred,
  failWith,
  mockCommands,
  objectRef,
  server,
  unlocked,
  viewDefinition,
} from '../testing/backend';
import { useDialogStore } from './dialogs';
import {
  canReview,
  editorTitle,
  isDirty,
  plan_delay_ms,
  useObjectEditorStore,
  type EditorRequest,
  type ObjectEditor,
} from './object-editors';
import { useQueryTabStore } from './query-tabs';
import { useServerStore } from './servers';
import { useTreeStore } from './tree';
import { useWorkspaceStore } from './workspace';

const store = () => useObjectEditorStore.getState();
const editor = (id: string) => store().editors[id] as ObjectEditor;
const view_ref = objectRef();

const edit_view: EditorRequest = {
  mode: 'edit',
  server_id: 'orders-dev',
  database: 'orders',
  object_type: 'view',
  object: view_ref,
  schema: null,
  label: 'open_orders',
};

const create_view: EditorRequest = { ...edit_view, mode: 'create', object: null, schema: 'sales', label: '' };
const drop_view: EditorRequest = { ...edit_view, mode: 'drop' };

/** Answers the commands an editor needs, with `plan` deciding each plan's reply. */
function backend(plan: (args: Record<string, unknown>) => unknown = () => changePlan(), definition: ObjectDefinition = viewDefinition()) {
  return mockCommands({
    list_schemas: () => ['public', 'sales'],
    object_definition: () => definition,
    plan_object_change: plan,
    apply_object_change: () => ({ outcome: 'applied' }),
  });
}

async function opened(request: EditorRequest): Promise<string> {
  const id = store().open(request);
  await vi.waitFor(() => expect(editor(id).loading).toBe(false));
  return id;
}

async function planned(): Promise<void> {
  await vi.advanceTimersByTimeAsync(plan_delay_ms);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  useServerStore.setState({ store: unlocked, servers: [server(), server({ id: 'orders-prod', name: 'orders-prod', environment: 'prod' })] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('opening an object editor', () => {
  it('opens in a dialog by default, reading the definition and the schemas it can move to', async () => {
    const calls = backend();
    const id = await opened(edit_view);

    expect(useDialogStore.getState().open).toEqual({ kind: 'object-editor', editor_id: id });
    expect(editor(id)).toMatchObject({ host: 'dialog', schemas: ['public', 'sales'], original: viewDefinition(), draft: viewDefinition() });
    expect(calls.find((call) => call.command === 'object_definition')?.args).toEqual({ server_id: 'orders-dev', object: view_ref });
    expect(editorTitle(editor(id))).toBe('public.open_orders');
  });

  it('opens in a tab when Settings picks tabs, and a second Edit of the same object switches to that tab', async () => {
    backend();
    useWorkspaceStore.getState().setObjectEditorHost('tab');
    const id = await opened(edit_view);
    const query_tab = useQueryTabStore.getState().openTab(null);

    const again = store().open(edit_view);

    expect([again, useQueryTabStore.getState().order, useQueryTabStore.getState().active_id]).toEqual([id, [id, query_tab], id]);
    expect(useDialogStore.getState().open).toBeNull();
  });

  it('starts a new object blank in the schema it was created from, titled by its kind', async () => {
    const calls = backend();
    const id = await opened({ ...create_view, host: 'tab' });

    expect(editor(id).draft).toEqual({ type: 'view', schema: 'sales', name: '', query: '', comment: null });
    expect([editorTitle(editor(id)), isDirty(editor(id))]).toEqual(['New view', false]);
    expect(commandsOf(calls)).toEqual(['list_schemas']);
  });

  it('starts a new schema with no schema of its own to go in, and lists none to pick from', async () => {
    const calls = backend();
    const id = await opened({ ...create_view, object_type: 'schema', schema: null });

    expect([editor(id).draft, editor(id).schemas, calls]).toEqual([{ type: 'schema', name: '', comment: null }, [], []]);
  });

  it('shows why the definition could not be read, and reads it again on retry', async () => {
    let fail = true;
    mockCommands({
      list_schemas: () => ['public'],
      object_definition: () => (fail ? failWith('not_found', 'This object no longer exists.') : viewDefinition()),
    });
    const id = await opened(edit_view);
    expect(editor(id).load_error).toBe('This object no longer exists.');

    fail = false;
    await store().load(id);

    expect(editor(id)).toMatchObject({ load_error: null, draft: viewDefinition() });
  });
});

describe('the SQL preview', () => {
  it('works out the SQL once typing pauses, sending the original and the changed definition', async () => {
    const calls = backend();
    const id = await opened(edit_view);
    const changed = viewDefinition({ query: 'SELECT id, total FROM orders' });

    store().change(id, changed);
    expect(editor(id).planning).toBe(true);
    await planned();

    expect(calls.at(-1)?.args).toEqual({
      server_id: 'orders-dev',
      database: 'orders',
      object: view_ref,
      original: viewDefinition(),
      changed,
      options: { cascade: false, with_data: true, force: false },
    });
    expect(editor(id)).toMatchObject({ planning: false, plan: changePlan(), plan_error: null });
    expect(canReview(editor(id))).toBe(true);
  });

  it('plans nothing once the draft is back to how it started, so there is nothing to review', async () => {
    const calls = backend();
    const id = await opened(edit_view);
    store().patch(id, { name: 'renamed' });
    await planned();

    store().patch(id, { name: 'open_orders' });
    await planned();

    expect(commandsOf(calls).filter((command) => command === 'plan_object_change')).toHaveLength(1);
    expect([editor(id).plan, canReview(editor(id))]).toEqual([null, false]);
  });

  it('keeps only the newest plan when an older one answers after it', async () => {
    const first = deferred<unknown>();
    let calls = 0;
    backend(() => (++calls === 1 ? first.promise : changePlan({ statements: ['ALTER VIEW public.open_orders RENAME TO newest'] })));
    const id = await opened(edit_view);
    store().patch(id, { name: 'older' });
    await planned();
    store().patch(id, { name: 'newest' });
    await planned();

    first.resolve(changePlan({ statements: ['ALTER VIEW public.open_orders RENAME TO older'] }));
    await vi.waitFor(() => expect(calls).toBe(2));

    expect(editor(id).plan?.statements).toEqual(['ALTER VIEW public.open_orders RENAME TO newest']);
  });

  it('shows why a draft cannot be planned, such as a missing name', async () => {
    backend(() => failWith('invalid', 'Name is required.'));
    const id = await opened(create_view);

    store().patch(id, { query: 'SELECT 1' });
    await planned();

    expect(editor(id)).toMatchObject({ plan: null, plan_error: 'Name is required.', planning: false });
  });

  it('ignores a stale error when a newer plan has already answered', async () => {
    const first = deferred<unknown>();
    let calls = 0;
    backend(() => (++calls === 1 ? first.promise.then(() => failWith('invalid', 'stale')) : changePlan()));
    const id = await opened(edit_view);
    store().patch(id, { name: 'a' });
    await planned();
    store().patch(id, { name: 'b' });
    await planned();

    first.resolve(null);
    await vi.waitFor(() => expect(calls).toBe(2));

    expect(editor(id).plan_error).toBeNull();
  });

  it('plans again after an option such as WITH DATA changes', async () => {
    const calls = backend();
    const id = await opened({ ...create_view, object_type: 'materialized_view' });
    store().patch(id, { name: 'totals', query: 'SELECT 1' });

    store().setOptions(id, { with_data: false });
    await planned();

    expect(calls.at(-1)?.args).toMatchObject({ options: { cascade: false, with_data: false, force: false } });
    store().setOptions('gone', { cascade: true });
  });

  it('follows a new routine switching to a procedure, for its title and its plan', async () => {
    backend();
    const id = await opened({ ...create_view, object_type: 'function' });

    store().patch(id, { procedure: true, returns: '' });

    expect([editor(id).object_type, editorTitle(editor(id))]).toEqual(['procedure', 'New procedure']);
  });
});

describe('dropping an object', () => {
  it('plans the drop as soon as the definition loads, and again at once when CASCADE is ticked', async () => {
    const calls = backend((args) => changePlan({ statements: [`DROP VIEW public.open_orders${(args.options as { cascade: boolean }).cascade ? ' CASCADE' : ''}`], dependents: ['view public.totals'] }));
    const id = await opened(drop_view);
    await vi.waitFor(() => expect(editor(id).plan).not.toBeNull());

    expect([editor(id).step, editorTitle(editor(id)), calls.at(-1)?.args]).toMatchObject(['review', 'Drop public.open_orders?', { changed: null }]);

    store().setOptions(id, { cascade: true });
    await vi.waitFor(() => expect(editor(id).plan?.statements).toEqual(['DROP VIEW public.open_orders CASCADE']));
    expect(isDirty(editor(id))).toBe(false);
  });

  it('always asks in a dialog, even when Settings picks tabs', async () => {
    backend();
    useWorkspaceStore.getState().setObjectEditorHost('tab');

    const id = await opened(drop_view);

    expect([editor(id).host, useQueryTabStore.getState().order]).toEqual(['dialog', []]);
  });
});

describe('reviewing and applying', () => {
  async function changedView(request: EditorRequest = edit_view): Promise<string> {
    const id = await opened(request);
    store().patch(id, { query: 'SELECT id, total FROM orders' });
    await planned();
    return id;
  }

  it('reviews only a current plan with statements, and goes back to editing', async () => {
    backend();
    const id = await opened(edit_view);
    store().review(id);
    expect(editor(id).step).toBe('edit');

    store().patch(id, { name: 'renamed' });
    store().review(id);
    expect(editor(id).step).toBe('edit');
    await planned();
    store().review(id);
    expect(editor(id).step).toBe('review');

    store().backToEditing(id);
    expect(editor(id).step).toBe('edit');
    store().review('gone');
  });

  it('applies the plan, closes the editor, refreshes the database in the tree and announces it', async () => {
    const calls = backend();
    const refreshDatabase = vi.fn(async () => undefined);
    useTreeStore.setState({ refreshDatabase });
    const id = await changedView();

    await store().apply(id);

    expect(calls.at(-1)?.args).toEqual({ server_id: 'orders-dev', database: 'orders', statements: changePlan().statements, after_commit: [], closes_database: null });
    expect([store().editors[id], useDialogStore.getState().open, store().announcement]).toEqual([
      undefined,
      null,
      'Changes to public.open_orders applied.',
    ]);
    expect(refreshDatabase).toHaveBeenCalledWith('orders-dev', 'orders');
  });

  it('names what it created or dropped once that is applied', async () => {
    backend();
    useTreeStore.setState({ refreshDatabase: async () => undefined });
    const created = await opened(create_view);
    store().patch(created, { name: 'recent', query: 'SELECT 1' });
    await planned();
    await store().apply(created);
    expect(store().announcement).toBe('View sales.recent created.');

    const dropped = await opened(drop_view);
    await vi.waitFor(() => expect(editor(dropped).plan).not.toBeNull());
    await store().apply(dropped);
    expect(store().announcement).toBe('View public.open_orders dropped.');
  });

  it('applies a change on a PROD server only once its name is typed exactly', async () => {
    const calls = backend();
    useTreeStore.setState({ refreshDatabase: async () => undefined });
    const id = await changedView({ ...edit_view, server_id: 'orders-prod' });

    store().setConfirmName(id, 'orders-pro');
    await store().apply(id);
    expect(commandsOf(calls)).not.toContain('apply_object_change');

    store().setConfirmName(id, 'orders-prod');
    await store().apply(id);
    expect(commandsOf(calls)).toContain('apply_object_change');
  });

  it('keeps the editor open with the statement that failed, which rolled every statement back', async () => {
    const failure = { statement_index: 1, message: 'column "total" does not exist', detail: null, hint: null };
    mockCommands({
      list_schemas: () => ['public'],
      object_definition: () => viewDefinition(),
      plan_object_change: () => changePlan(),
      apply_object_change: () => ({ outcome: 'failed', failure }),
    });
    const id = await changedView();

    await store().apply(id);

    expect(editor(id)).toMatchObject({ applying: false, failure });
    store().patch(id, { name: 'fixed' });
    expect(editor(id).failure).toBeNull();
  });

  it('starts again from the object as it now is when a statement after the commit fails, keeping the failure', async () => {
    const failure = { statement_index: 1, committed: true, message: 'could not create index', detail: null, hint: null };
    let reads = 0;
    mockCommands({
      list_schemas: () => ['public'],
      object_definition: () => (++reads === 1 ? viewDefinition() : reads === 2 ? viewDefinition({ query: 'SELECT id, total FROM orders' }) : failWith('connection', 'connection refused')),
      plan_object_change: () => changePlan(),
      apply_object_change: () => ({ outcome: 'failed', failure }),
    });
    const refreshDatabase = vi.fn(async () => undefined);
    useTreeStore.setState({ refreshDatabase });
    const id = await changedView();

    await store().apply(id);

    expect(editor(id)).toMatchObject({ failure, plan: null, applying: false, draft: viewDefinition({ query: 'SELECT id, total FROM orders' }) });
    expect([isDirty(editor(id)), refreshDatabase.mock.calls.length]).toEqual([false, 1]);
    store().patch(id, { name: 'again' });
    await planned();
    await store().apply(id);
    expect(editor(id).apply_error).toBe('connection refused');
  });

  it('keeps a new object\'s editor open with the failure when a statement after the commit fails, as there is nothing to read back', async () => {
    const failure = { statement_index: 1, committed: true, message: 'comment failed', detail: null, hint: null };
    const plan = changePlan({ statements: [], after_commit: ['CREATE DATABASE shop', "COMMENT ON DATABASE shop IS 'x'"] });
    const calls = mockCommands({ list_roles: () => ['app'], plan_object_change: () => plan, apply_object_change: () => ({ outcome: 'failed', failure }) });
    const refreshServer = vi.fn(async () => undefined);
    useTreeStore.setState({ refreshServer });
    const id = await opened({ ...create_view, object_type: 'database', schema: null });
    store().patch(id, { name: 'shop' });
    await planned();

    await store().apply(id);

    expect(editor(id)).toMatchObject({ failure, plan: null, applying: false });
    expect(commandsOf(calls)).not.toContain('object_definition');
    expect(refreshServer).toHaveBeenCalledWith('orders-dev', null);
  });

  it('shows why the change could not be sent at all, such as a lost connection', async () => {
    mockCommands({
      list_schemas: () => ['public'],
      object_definition: () => viewDefinition(),
      plan_object_change: () => changePlan(),
      apply_object_change: () => failWith('connection', 'connection refused'),
    });
    const id = await changedView();

    await store().apply(id);

    expect(editor(id)).toMatchObject({ applying: false, apply_error: 'connection refused' });
    await store().apply('gone');
  });

  it('copies the statements into a new query tab on the same connection without running them', async () => {
    const calls = backend();
    const id = await changedView();

    store().copyToTab(id);

    const tabs = useQueryTabStore.getState();
    const tab = tabs.tabs[tabs.active_id as string];
    expect(tab).toMatchObject({ connection: { server_id: 'orders-dev', database: 'orders' }, text: `${changePlan().statements[0]};\n` });
    expect(store().announcement).toBe(`The SQL is in ${tab?.title}. Nothing has run.`);
    expect(commandsOf(calls)).not.toContain('apply_object_change');
    store().copyToTab('gone');
  });
});

describe('moving and closing an editor', () => {
  it('moves a dialog editor into a tab with its changes kept', async () => {
    backend();
    const id = await opened(edit_view);
    store().patch(id, { name: 'renamed' });

    store().openInTab(id);
    store().openInTab(id);

    expect([editor(id).host, (editor(id).draft as { name: string }).name]).toEqual(['tab', 'renamed']);
    expect([useDialogStore.getState().open, useQueryTabStore.getState().order]).toEqual([null, [id]]);
  });

  it('closes an editor without changes at once, but asks first when closing would lose changes', async () => {
    backend();
    const clean = await opened({ ...edit_view, host: 'tab' });
    store().requestClose(clean);
    expect([store().editors[clean], useQueryTabStore.getState().order]).toEqual([undefined, []]);

    const changed = await opened({ ...edit_view, host: 'tab' });
    useQueryTabStore.getState().openTab(null);
    store().patch(changed, { name: 'renamed' });
    store().requestClose(changed);
    expect([editor(changed).confirming_close, useQueryTabStore.getState().active_id]).toEqual([true, changed]);

    store().keepEditing(changed);
    expect(editor(changed).confirming_close).toBe(false);
    store().requestClose('gone');
    store().closeEditor('gone');
  });

  it('leaves another dialog open when an editor that was in a dialog closes after it', async () => {
    backend();
    const id = await opened(edit_view);
    useDialogStore.getState().show({ kind: 'settings' });

    store().closeEditor(id);

    expect(useDialogStore.getState().open).toEqual({ kind: 'settings' });
  });

  it('ignores changes sent to an editor that has closed', () => {
    for (const change of [
      () => store().patch('gone', { name: 'x' }),
      () => store().setConfirmName('gone', 'x'),
      () => store().backToEditing('gone'),
      () => store().keepEditing('gone'),
    ]) {
      change();
    }
    expect(store().editors).toEqual({});
  });

  it('gives focus back to what opened a dialog editor once it closes', async () => {
    backend();
    const opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();
    const id = await opened(edit_view);
    opener.blur();

    store().closeEditor(id);
    await vi.waitFor(() => expect(document.activeElement).toBe(opener));
    opener.remove();
  });

  it('moves focus to the sidebar when what opened the editor is gone', async () => {
    backend();
    const heading = document.createElement('h2');
    heading.id = 'sidebar-title';
    heading.tabIndex = -1;
    const opener = document.createElement('button');
    document.body.append(heading, opener);
    opener.focus();
    const id = await opened(edit_view);
    opener.remove();

    store().closeEditor(id);

    await vi.waitFor(() => expect(document.activeElement).toBe(heading));
    heading.remove();
  });
});
