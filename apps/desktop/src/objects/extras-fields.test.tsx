import { act, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { ExtrasRead, ObjectDefinition, TableDefinition, TriggerDefinition } from '../generated/objects';
import { Workspace } from '../shell/workspace';
import { isDirty, useObjectEditorStore, type EditorRequest, type ObjectEditor } from '../store/object-editors';
import { useServerStore } from '../store/servers';
import { changePlan, extrasRead, mockCommands, objectRef, server, tableDefinition, unlocked, viewDefinition } from '../testing/backend';
import { renderWithUser } from '../testing/render';

const editor = () => Object.values(useObjectEditorStore.getState().editors)[0] as ObjectEditor;
const extras = () => editor().extras as NonNullable<ObjectEditor['extras']>;
const textbox = (name: string | RegExp) => screen.getByRole('textbox', { name }) as HTMLInputElement;
const combobox = (name: string | RegExp) => screen.getByRole('combobox', { name }) as HTMLSelectElement;
const checkbox = (name: string | RegExp) => screen.getByRole('checkbox', { name }) as HTMLInputElement;

function request(object_type: EditorRequest['object_type'], mode: EditorRequest['mode'] = 'edit'): EditorRequest {
  return {
    mode,
    server_id: 'orders-dev',
    database: 'orders',
    object_type,
    object: mode === 'create' ? null : objectRef({ object_type }),
    schema: mode === 'create' ? 'public' : null,
    label: 'object',
  };
}

function existingTrigger(overrides: Partial<TriggerDefinition> = {}): TriggerDefinition {
  return {
    original_name: 'stamp',
    name: 'stamp',
    timing: 'before',
    events: ['update'],
    update_columns: [],
    for_each_row: true,
    when: '',
    function: 'audit.stamp',
    arguments: '',
    new_function: false,
    body: '',
    enabled: true,
    ...overrides,
  };
}

async function openEditor(open: EditorRequest, definition: ObjectDefinition, read: ExtrasRead, functions: Array<string> = ['touch']) {
  const calls = mockCommands({
    list_schemas: () => ['public'],
    list_roles: () => ['app', 'reporting', 'audit'],
    list_trigger_functions: () => functions,
    available_extensions: () => [],
    object_extras: () => read,
    object_definition: () => definition,
    plan_object_change: () => changePlan(),
  });
  useServerStore.setState({ store: unlocked, servers: [server()] });
  const rendered = renderWithUser(<Workspace />);
  act(() => void useObjectEditorStore.getState().open(open));
  await waitFor(() => expect(screen.queryByText('Loading…')).toBeNull());
  return { ...rendered, calls };
}

describe('the privileges section', () => {
  it('grants and revokes privileges and their grant option, adds and removes roles, and never changes the owner', async () => {
    const read = extrasRead({ extras: { grants: [{ grantee: 'PUBLIC', privilege: 'SELECT', grantable: false }], triggers: [] } });
    const { user, calls } = await openEditor(request('view'), viewDefinition(), read);
    await user.click(screen.getByRole('tab', { name: 'Privileges' }));
    expect([checkbox('SELECT for app, the owner').checked, checkbox('SELECT for app, the owner').disabled]).toEqual([true, true]);

    await user.click(checkbox('INSERT for PUBLIC'));
    await user.click(checkbox('INSERT for PUBLIC, with grant option'));
    await user.click(checkbox('SELECT for PUBLIC'));
    expect(within(combobox('Role to add')).getAllByRole('option').map((option) => option.textContent)).toEqual(['reporting', 'audit']);
    await user.selectOptions(combobox('Role to add'), 'audit');
    await user.click(screen.getByRole('button', { name: 'Add role' }));
    await user.click(checkbox('SELECT for audit'));
    await user.click(screen.getByRole('button', { name: 'Add role' }));

    expect(extras().grants).toEqual([
      { grantee: 'PUBLIC', privilege: 'INSERT', grantable: true },
      { grantee: 'audit', privilege: 'SELECT', grantable: false },
    ]);
    expect(isDirty(editor())).toBe(true);
    expect(screen.queryByRole('combobox', { name: 'Role to add' })).toBeNull();
    await waitFor(() => expect(calls.at(-1)?.args).toMatchObject({ extras: { original: read.extras, changed: extras() } }));

    await user.click(screen.getByRole('button', { name: 'Revoke all from audit' }));
    await user.click(screen.getByRole('button', { name: 'Revoke all from reporting' }));
    expect(extras().grants.map((grant) => grant.grantee)).toEqual(['PUBLIC']);
    expect(within(combobox('Role to add')).getAllByRole('option').map((option) => option.textContent)).toEqual(['reporting', 'audit']);
  });

  it('shows no sections for an object whose kind has no privileges', async () => {
    await openEditor(request('extension'), { type: 'extension', name: 'citext', schema: 'public', version: '1.6', comment: null }, extrasRead({ privileges: [] }));
    expect(textbox('Extension').value).toBe('citext');
    expect(screen.queryByRole('tablist')).toBeNull();
  });
});

describe('the triggers section', () => {
  it('adds an INSTEAD OF trigger to a view, with no TRUNCATE, column list or switch to turn it off', async () => {
    const { user } = await openEditor(request('view'), viewDefinition(), extrasRead());
    await user.click(screen.getByRole('tab', { name: 'Triggers 0' }));
    expect(screen.getByText('No triggers.')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Add trigger' }));
    const card = within(screen.getByRole('group', { name: 'trigger 1' }));
    await user.type(card.getByRole('textbox', { name: 'Name' }), 'write_through');
    await user.click(screen.getByRole('checkbox', { name: 'UPDATE' }));
    await user.click(screen.getByRole('checkbox', { name: 'INSERT' }));
    await user.selectOptions(combobox('Once per'), 'statement');
    await user.selectOptions(combobox('Fires'), 'after');
    await user.type(textbox('When'), 'true');
    await user.type(textbox('Arguments'), "'x'");

    expect(extras().triggers[0]).toMatchObject({
      name: 'write_through',
      timing: 'after',
      events: ['update'],
      for_each_row: false,
      when: 'true',
      function: 'touch',
      arguments: "'x'",
      new_function: false,
    });
    expect(screen.queryByRole('checkbox', { name: 'TRUNCATE' })).toBeNull();
    expect(screen.queryByRole('textbox', { name: 'Only when UPDATE sets these columns' })).toBeNull();
    expect(screen.queryByRole('checkbox', { name: 'Enabled' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Remove write_through' }));
    expect(extras().triggers).toEqual([]);
  });

  it("writes a new trigger function in place, and lists an existing trigger's function even when it isn't in the list", async () => {
    const read = extrasRead({ extras: { grants: [], triggers: [existingTrigger()] } });
    const { user } = await openEditor(request('table'), tableDefinition(), read);
    await user.click(screen.getByRole('tab', { name: 'Triggers 1' }));
    expect(within(combobox('Function')).getAllByRole('option').map((option) => option.textContent)).toEqual(['audit.stamp', 'touch', 'Write a new function']);

    await user.type(textbox('Only when UPDATE sets these columns'), 'quantity,total');
    await user.click(checkbox('Enabled'));
    await user.selectOptions(combobox('Function'), 'Write a new function');
    await user.type(textbox("New function's name"), 'public.stamp_again');
    await user.clear(textbox("New function's body, in PL/pgSQL"));
    await user.type(textbox("New function's body, in PL/pgSQL"), 'BEGIN RETURN NEW; END');

    expect(extras().triggers[0]).toMatchObject({
      update_columns: ['quantity', 'total'],
      enabled: false,
      new_function: true,
      function: 'public.stamp_again',
      body: 'BEGIN RETURN NEW; END',
    });
    await user.selectOptions(combobox('Function'), 'touch');
    expect(extras().triggers[0]).toMatchObject({ new_function: false, function: 'touch' });
  });

  it('starts a new trigger on a table BEFORE INSERT, with a new function when the database has none', async () => {
    const { user } = await openEditor(request('table'), tableDefinition(), extrasRead(), []);
    await user.click(screen.getByRole('tab', { name: 'Triggers 0' }));

    await user.click(screen.getByRole('button', { name: 'Add trigger' }));

    expect(extras().triggers[0]).toMatchObject({ timing: 'before', events: ['insert'], function: '', new_function: true, enabled: true });
    expect(checkbox('TRUNCATE')).toBeTruthy();
  });
});

describe('the policies section', () => {
  it('turns row-level security on and adds a restrictive policy for some roles', async () => {
    const { user } = await openEditor(request('table'), tableDefinition(), extrasRead());
    await user.click(screen.getByRole('tab', { name: 'Policies 0' }));
    expect(screen.getByText('No policies.')).toBeTruthy();

    await user.click(checkbox('Row-level security: rows are filtered by these policies'));
    await user.click(checkbox("Apply the policies to the table's owner too (FORCE)"));
    await user.click(screen.getByRole('button', { name: 'Add policy' }));
    await user.type(within(screen.getByRole('group', { name: 'policy 1' })).getByRole('textbox', { name: 'Name' }), 'own_rows');
    await user.selectOptions(combobox('For'), 'select');
    await user.selectOptions(combobox('Kind'), 'restrictive');
    await user.type(textbox('Roles, separated by commas'), 'app,reporting');
    await user.type(textbox('Rows it lets through (USING)'), 'id > 0');
    await user.type(textbox('Rows it accepts on insert or update (WITH CHECK)'), 'true');

    const table = editor().draft as TableDefinition;
    expect([table.row_security, table.force_row_security]).toEqual([true, true]);
    expect(table.policies).toEqual([
      { original_name: null, name: 'own_rows', command: 'select', permissive: false, roles: ['app', 'reporting'], using: 'id > 0', with_check: 'true' },
    ]);
    await user.click(screen.getByRole('button', { name: 'Add policy' }));
    await user.type(within(screen.getByRole('group', { name: 'policy 2' })).getByRole('textbox', { name: 'Name' }), 'second');
    expect((editor().draft as TableDefinition).policies.map((policy) => policy.name)).toEqual(['own_rows', 'second']);
    await user.selectOptions(within(screen.getByRole('group', { name: 'own_rows' })).getByRole('combobox', { name: 'Kind' }), 'permissive');
    await user.click(screen.getByRole('button', { name: 'Remove own_rows' }));
    expect((editor().draft as TableDefinition).policies.map((policy) => policy.name)).toEqual(['second']);
  });
});
