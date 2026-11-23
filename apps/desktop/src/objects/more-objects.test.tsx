import { act, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { ObjectDefinition } from '../generated/objects';
import { Workspace } from '../shell/workspace';
import { useObjectEditorStore, type EditorRequest, type ObjectEditor } from '../store/object-editors';
import { useServerStore } from '../store/servers';
import {
  availableExtension,
  changePlan,
  commandsOf,
  databaseDefinition,
  mockCommands,
  objectRef,
  server,
  typeDefinition,
  unlocked,
} from '../testing/backend';
import { renderWithUser } from '../testing/render';

const editor = () => Object.values(useObjectEditorStore.getState().editors)[0] as ObjectEditor;
const draft = () => editor().draft as ObjectDefinition & Record<string, unknown>;
const textbox = (name: string | RegExp) => screen.getByRole('textbox', { name }) as HTMLInputElement;
const combobox = (name: string | RegExp) => screen.getByRole('combobox', { name }) as HTMLSelectElement;

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

async function openEditor(open: EditorRequest, definition: ObjectDefinition = typeDefinition(), handlers: Record<string, () => unknown> = {}) {
  const calls = mockCommands({
    list_schemas: () => ['public', 'sales'],
    list_roles: () => ['app', 'reporting'],
    available_extensions: () => [availableExtension(), availableExtension({ name: 'hstore', installed: true, comment: null, versions: ['1.8'] })],
    object_definition: () => definition,
    plan_object_change: () => changePlan(),
    apply_object_change: () => ({ outcome: 'applied' }),
    catalog_children: () => [],
    ...handlers,
  });
  useServerStore.setState({ store: unlocked, servers: [server()] });
  const rendered = renderWithUser(<Workspace />);
  act(() => void useObjectEditorStore.getState().open(open));
  await waitFor(() => expect(screen.queryByText('Loading…')).toBeNull());
  return { ...rendered, calls };
}

describe('the type designer', () => {
  it('adds and renames enum values, removing only new ones, and keeps the kind of an existing type', async () => {
    const { user } = await openEditor(request('type'));
    expect(combobox('Kind').disabled).toBe(true);
    expect(screen.queryByRole('button', { name: 'Remove sad' })).toBeNull();

    await user.type(textbox('Value 1'), 'der');
    await user.click(screen.getByRole('button', { name: 'Add value' }));
    await user.type(textbox('Value 3'), 'great');
    await user.click(screen.getByRole('button', { name: 'Add value' }));
    await user.click(screen.getByRole('button', { name: 'Remove value 4' }));

    expect(draft().values).toEqual([
      { original: 'sad', label: 'sadder' },
      { original: 'ok', label: 'ok' },
      { original: null, label: 'great' },
    ]);
    await user.click(screen.getByRole('button', { name: 'Remove great' }));
    expect(draft().values).toHaveLength(2);
  });

  it('builds a new composite type from attributes, after switching its kind', async () => {
    const { user } = await openEditor(request('type', 'create'));

    await user.selectOptions(combobox('Kind'), 'composite');
    await user.type(textbox('Name'), 'address');
    await user.click(screen.getByRole('button', { name: 'Add attribute' }));
    await user.type(textbox('Name of attribute 1'), 'street');
    await user.type(textbox('Type of street'), 'text');
    await user.click(screen.getByRole('button', { name: 'Add attribute' }));
    await user.click(screen.getByRole('button', { name: 'Remove attribute 2' }));
    await user.click(screen.getByRole('button', { name: 'Add attribute' }));
    await user.type(textbox('Type of attribute 2'), 'int');

    expect(draft()).toMatchObject({
      kind: 'composite',
      name: 'address',
      attributes: [
        { original_name: null, name: 'street', data_type: 'text' },
        { original_name: null, name: '', data_type: 'int' },
      ],
    });
  });

  it("edits a domain's default, NOT NULL and checks, but not its base type once it exists", async () => {
    const domain = typeDefinition({
      kind: 'domain',
      name: 'quantity',
      values: [],
      base_type: 'integer',
      checks: [{ original_name: 'positive', name: 'positive', expression: '(VALUE > 0)' }],
    });
    const { user } = await openEditor(request('type'), domain);
    expect(textbox('Base type').disabled).toBe(true);

    await user.type(textbox('Default'), '1');
    await user.click(screen.getByRole('checkbox', { name: 'NOT NULL' }));
    await user.type(textbox('Name of check 1'), '_amount');
    await user.click(screen.getByRole('button', { name: 'Add check' }));
    await user.type(textbox('Expression of check 2'), 'VALUE < 100');
    await user.type(textbox('Name of check 2'), 'small');

    expect(draft()).toMatchObject({
      default: '1',
      not_null: true,
      checks: [
        { original_name: 'positive', name: 'positive_amount', expression: '(VALUE > 0)' },
        { original_name: null, name: 'small', expression: 'VALUE < 100' },
      ],
    });
    await user.click(screen.getByRole('button', { name: 'Remove small' }));
    expect(draft().checks).toHaveLength(1);
  });

  it('asks a new range for its subtype, which an existing range keeps', async () => {
    const { user } = await openEditor(request('type', 'create'));
    await user.selectOptions(combobox('Kind'), 'range');
    await user.type(textbox('Subtype'), 'numeric');
    expect(draft()).toMatchObject({ kind: 'range', base_type: 'numeric' });
    await user.selectOptions(combobox('Kind'), 'domain');
    expect(textbox('Base type').disabled).toBe(false);
  });

  it('keeps an existing range on its subtype', async () => {
    await openEditor(request('type'), typeDefinition({ kind: 'range', values: [], base_type: 'numeric' }));
    expect(textbox('Subtype').disabled).toBe(true);
  });
});

describe('the database designer', () => {
  it('creates a database owned by the connecting role unless another is picked, with its template, encoding and locale', async () => {
    const { user, calls } = await openEditor(request('database', 'create'));
    expect(commandsOf(calls)).toEqual(['list_roles']);
    expect(combobox('Owner').value).toBe('');

    await user.type(textbox('Name'), 'shop');
    await user.selectOptions(combobox('Owner'), 'reporting');
    await user.type(textbox(/^Template/), 'template0');
    await user.type(textbox(/^Encoding/), 'UTF8');
    await user.type(textbox(/^Collation/), 'C');
    await user.type(textbox(/^Character type/), 'C');
    const limit = textbox(/^Connection limit/);
    expect(limit.value).toBe('');
    await user.type(limit, '20');

    expect(draft()).toMatchObject({ name: 'shop', owner: 'reporting', template: 'template0', encoding: 'UTF8', collation: 'C', ctype: 'C', connection_limit: 20 });
    await user.clear(limit);
    expect(draft().connection_limit).toBe(-1);
  });

  it('keeps an existing database on the encoding, template and locale it was created with', async () => {
    await openEditor(request('database'), databaseDefinition());
    expect(textbox(/^Encoding/).disabled).toBe(true);
    expect(screen.getByText('Encoding, template and locale are set when a database is created.')).toBeTruthy();
    expect(within(combobox('Owner')).queryByRole('option', { name: 'The role Tidewater connects as' })).toBeNull();
  });

  it('drops a database with FORCE when asked, closing Tidewater sessions on it and refreshing the server listing', async () => {
    const plan = changePlan({ statements: [], after_commit: ['DROP DATABASE shop WITH (FORCE)'], closes_database: 'shop' });
    const { user, calls } = await openEditor({ ...request('database', 'drop'), database: 'postgres' }, databaseDefinition(), { plan_object_change: () => plan });
    await screen.findByText('DROP DATABASE shop WITH (FORCE);');
    expect(screen.queryByRole('checkbox', { name: /CASCADE/ })).toBeNull();

    await user.click(screen.getByRole('checkbox', { name: 'Disconnect other sessions first (FORCE)' }));
    expect(editor().options.force).toBe(true);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Drop' }).hasAttribute('disabled')).toBe(false));
    await user.click(screen.getByRole('button', { name: 'Drop' }));

    await waitFor(() => expect(screen.getByText('Database shop dropped.')).toBeTruthy());
    expect(calls.find((call) => call.command === 'apply_object_change')?.args).toMatchObject({ database: 'postgres', closes_database: 'shop' });
    expect(calls.at(-1)).toEqual({ command: 'catalog_children', args: { server_id: 'orders-dev', path: null, show_system: false } });
  });
});

describe('the extension designer', () => {
  it('installs an extension the server offers, at its default version unless one is picked, with what it needs', async () => {
    const { user } = await openEditor(request('extension', 'create'));
    const extension = combobox('Extension');
    expect(within(extension).queryByRole('option', { name: 'hstore' })).toBeNull();
    expect(within(combobox('Version')).getAllByRole('option').map((option) => option.textContent)).toEqual(['Default']);

    await user.selectOptions(extension, 'citext');
    expect(screen.getByText('case-insensitive text')).toBeTruthy();
    expect(within(combobox('Version')).getAllByRole('option').map((option) => option.textContent)).toEqual(['Default, 1.6', '1.5', '1.6']);
    await user.selectOptions(combobox('Version'), '1.5');
    await user.selectOptions(combobox('Schema'), 'sales');
    await user.click(screen.getByRole('checkbox', { name: 'Also install the extensions it needs (CASCADE)' }));

    expect(draft()).toMatchObject({ name: 'citext', version: '1.5', schema: 'sales' });
    expect(editor().options.cascade).toBe(true);
  });

  it('moves an installed extension to another version or schema, but keeps its name', async () => {
    const installed: ObjectDefinition = { type: 'extension', name: 'hstore', schema: 'public', version: '1.8', comment: null };
    const { user } = await openEditor(request('extension'), installed);
    expect(textbox('Extension').disabled).toBe(true);
    expect(within(combobox('Version')).getAllByRole('option').map((option) => option.textContent)).toEqual(['1.8']);

    await user.selectOptions(combobox('Schema'), 'sales');

    expect(draft().schema).toBe('sales');
    expect(screen.queryByRole('checkbox', { name: /CASCADE/ })).toBeNull();
  });
});
