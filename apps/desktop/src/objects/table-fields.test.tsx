import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { ObjectDefinition, TableDefinition } from '../generated/objects';
import { Workspace } from '../shell/workspace';
import { useObjectEditorStore, type EditorRequest, type ObjectEditor } from '../store/object-editors';
import { useServerStore } from '../store/servers';
import { changePlan, mockCommands, objectRef, server, tableDefinition, unlocked } from '../testing/backend';
import { renderWithUser } from '../testing/render';

const draft = () => (Object.values(useObjectEditorStore.getState().editors)[0] as ObjectEditor).draft as TableDefinition;

const edit_table: EditorRequest = {
  mode: 'edit',
  server_id: 'orders-dev',
  database: 'orders',
  object_type: 'table',
  object: objectRef({ object_type: 'table' }),
  schema: null,
  label: 'order_items',
};
const create_table: EditorRequest = { ...edit_table, mode: 'create', object: null, schema: 'public', label: '' };

async function openTable(request: EditorRequest = edit_table, definition: ObjectDefinition = tableDefinition(), environment: 'dev' | 'prod' = 'dev') {
  mockCommands({
    list_schemas: () => ['public', 'sales'],
    object_definition: () => definition,
    plan_object_change: () => changePlan(),
  });
  useServerStore.setState({ store: unlocked, servers: [server({ environment })] });
  const rendered = renderWithUser(<Workspace />);
  act(() => void useObjectEditorStore.getState().open(request));
  await waitFor(() => expect(screen.queryByText('Loading…')).toBeNull());
  return rendered;
}

const textbox = (name: string | RegExp) => screen.getByRole('textbox', { name }) as HTMLInputElement;
const section = (name: RegExp) => screen.getByRole('tab', { name });

describe('the columns of a table', () => {
  it('designs a new table from one blank column: types offered, identity making it NOT NULL, and columns added and removed', async () => {
    const { user } = await openTable(create_table);
    expect(screen.getByRole('dialog', { name: 'New table' })).toBeTruthy();

    await user.type(textbox('Name'), 'notes');
    await user.type(textbox('Name of column 1'), 'id');
    await user.type(screen.getByRole('combobox', { name: 'Type of id' }), 'bigint');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Identity of id' }), 'by_default');
    expect((screen.getByRole('checkbox', { name: 'id not null' }) as HTMLInputElement).checked).toBe(true);
    await user.selectOptions(screen.getByRole('combobox', { name: 'Identity of id' }), 'none');
    await user.click(screen.getByRole('checkbox', { name: 'id not null' }));
    await user.click(screen.getByRole('button', { name: 'Add column' }));
    await waitFor(() => expect(document.activeElement).toBe(textbox('Name of column 2')));
    await user.type(textbox('Name of column 2'), 'body');
    await user.type(textbox('Default of body'), "''");
    await user.type(textbox('Comment on body'), 'x');
    await user.clear(textbox('Comment on body'));
    await user.type(textbox('Comment on body'), 'text');
    await user.type(textbox('Comment'), 'scratch');
    await user.clear(textbox('Comment'));
    await user.selectOptions(screen.getByRole('combobox', { name: 'Schema' }), 'sales');

    expect(draft()).toMatchObject({
      schema: 'sales',
      name: 'notes',
      comment: null,
      columns: [
        { number: null, name: 'id', data_type: 'bigint', identity: 'none', not_null: false },
        { number: null, name: 'body', default: "''", comment: 'text' },
      ],
    });
    expect(screen.getAllByText('new')).toHaveLength(2);

    await user.click(screen.getByRole('button', { name: 'Remove body' }));
    await user.click(screen.getByRole('button', { name: 'Add column' }));
    await user.click(screen.getByRole('button', { name: 'Remove column 2' }));
    expect(draft().columns.map((column) => column.name)).toEqual(['id']);
    await user.click(section(/^Indexes/));
    await user.click(screen.getByRole('button', { name: 'Add index' }));
    expect(screen.queryByRole('checkbox', { name: /concurrently/ })).toBeNull();
  });

  it('quotes a column name in its USING cast when SQL needs it quoted', async () => {
    const { user } = await openTable();
    await user.clear(textbox('Name of column 2'));
    await user.type(textbox('Name of column 2'), 'Qty');

    await user.type(screen.getByRole('combobox', { name: 'Type of Qty' }), '8');

    expect(draft().columns[1]?.using).toBe('"Qty"::integer8');
  });

  it("fills USING with a cast that follows an existing column's new type until rewritten, and drops it once the type is back", async () => {
    const { user } = await openTable();
    const type = screen.getByRole('combobox', { name: 'Type of quantity' }) as HTMLInputElement;
    const using = () => screen.queryByRole('textbox', { name: 'USING, to turn each quantity value into ' + type.value }) as HTMLInputElement | null;

    await user.clear(type);
    await user.type(type, 'bigint');
    expect(using()?.value).toBe('quantity::bigint');
    await user.clear(using() as HTMLInputElement);
    await user.type(using() as HTMLInputElement, 'round(quantity)');
    await user.type(type, '2');
    expect(using()?.value).toBe('round(quantity)');

    await user.clear(type);
    await user.type(type, 'integer');

    expect([using(), draft().columns[1]?.using]).toEqual([null, '']);
  });

  it('renames a column in the constraints that list it, and shows a generated column in place of its default', async () => {
    const { user } = await openTable();

    await user.type(textbox('Name of column 1'), '2');
    await user.type(textbox('Name of column 2'), 's');

    expect(draft().constraints[0]?.columns).toEqual(['id2']);
    expect(screen.getByText('generated: (quantity * 2)')).toBeTruthy();
    expect(screen.queryByRole('textbox', { name: 'Default of total' })).toBeNull();
    expect(screen.queryByText('new')).toBeNull();
    expect(screen.getAllByText('changed')).toHaveLength(2);
  });

  it('notes how a partitioned table splits its rows', async () => {
    await openTable(edit_table, tableDefinition({ partition_key: 'RANGE (created_at)' }));
    expect(screen.getByText('Partitioned by RANGE (created_at)')).toBeTruthy();
  });
});

describe('the sections of a table', () => {
  it('moves between columns, constraints and indexes with the arrow keys, Home and End', async () => {
    await openTable();
    const columns = section(/^Columns/);
    expect(columns.textContent).toBe('Columns 3');

    fireEvent.keyDown(columns, { key: 'ArrowRight' });
    expect(section(/^Constraints/).getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(section(/^Constraints/));
    fireEvent.keyDown(section(/^Constraints/), { key: 'End' });
    expect(section(/^Indexes/).getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(section(/^Indexes/), { key: 'ArrowRight' });
    fireEvent.keyDown(section(/^Columns/), { key: 'ArrowLeft' });
    fireEvent.keyDown(section(/^Indexes/), { key: 'Home' });
    fireEvent.keyDown(section(/^Columns/), { key: 'a' });

    expect(screen.getByRole('tabpanel', { name: 'Columns 3' })).toBeTruthy();
  });
});

describe('the constraints of a table', () => {
  it('adds a unique constraint beside the primary key, picking its columns in key order', async () => {
    const { user } = await openTable();
    await user.click(section(/^Constraints/));

    await user.click(screen.getByRole('button', { name: 'Add constraint' }));
    const card = within(screen.getByRole('group', { name: 'new unique' }));
    await user.click(card.getByRole('checkbox', { name: 'quantity' }));
    await user.click(card.getByRole('checkbox', { name: 'id' }));
    await user.click(card.getByRole('checkbox', { name: 'quantity' }));
    await user.click(card.getByRole('checkbox', { name: 'quantity' }));
    await user.type(card.getByRole('textbox', { name: 'Name' }), 'one_each');

    expect(draft().constraints[1]).toMatchObject({ original_name: null, name: 'one_each', kind: 'unique', columns: ['id', 'quantity'] });
  });

  it('starts with a primary key when the table has none, and builds a foreign key, a check and an SQL definition', async () => {
    const { user } = await openTable(edit_table, tableDefinition({ constraints: [] }));
    await user.click(section(/^Constraints/));
    expect(screen.getByText('No constraints.')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Add constraint' }));
    const card = () => within(screen.getAllByRole('group')[0] as HTMLElement);
    expect(card().getByRole('combobox', { name: 'Kind' })).toHaveProperty('value', 'primary_key');
    await user.selectOptions(card().getByRole('combobox', { name: 'Kind' }), 'foreign_key');
    await user.click(card().getByRole('checkbox', { name: 'quantity' }));
    await user.type(card().getByRole('textbox', { name: 'Table new foreign key references' }), 'orders');
    await user.type(card().getByRole('textbox', { name: /^Referenced columns/ }), 'id, line');
    await user.selectOptions(card().getByRole('combobox', { name: 'On delete' }), 'cascade');
    await user.selectOptions(card().getByRole('combobox', { name: 'On update' }), 'restrict');
    await user.click(card().getByRole('checkbox', { name: "Don't check existing rows (NOT VALID)" }));
    expect(draft().constraints[0]).toMatchObject({
      kind: 'foreign_key',
      columns: ['quantity'],
      references: 'orders',
      referenced_columns: ['id', ' line'],
      on_delete: 'cascade',
      on_update: 'restrict',
      not_valid: true,
    });

    await user.selectOptions(card().getByRole('combobox', { name: 'Kind' }), 'check');
    await user.type(card().getByRole('textbox', { name: 'Expression' }), 'quantity > 0');
    await user.selectOptions(card().getByRole('combobox', { name: 'Kind' }), 'other');
    expect(card().getByRole('textbox', { name: 'Definition' })).toHaveProperty('value', 'quantity > 0');
    expect(card().queryByRole('checkbox', { name: /NOT VALID/ })).toBeNull();

    await user.click(card().getByRole('button', { name: 'Remove new other, written as sql' }));
    expect(draft().constraints).toEqual([]);
  });
});

describe('the indexes of a table', () => {
  it('builds a new index concurrently by default on a PROD server, and offers it for a changed index only', async () => {
    const { user } = await openTable(edit_table, tableDefinition(), 'prod');
    await user.click(section(/^Indexes/));
    const existing = () => within(screen.getByRole('group', { name: 'by_quantity' }));
    expect(existing().queryByRole('checkbox', { name: /concurrently/ })).toBeNull();

    await user.type(existing().getByRole('textbox', { name: 'Columns and expressions' }), ' DESC');
    await user.type(existing().getByRole('textbox', { name: 'Other clauses' }), 'WHERE quantity > 0');
    await user.click(existing().getByRole('checkbox', { name: 'Unique' }));
    await user.selectOptions(existing().getByRole('combobox', { name: 'Method' }), 'hash');
    await user.click(existing().getByRole('checkbox', { name: /concurrently/ }));
    await user.click(screen.getByRole('button', { name: 'Add index' }));
    const added = within(screen.getByRole('group', { name: 'new index' }));
    await user.type(added.getByRole('textbox', { name: 'Name' }), 'by_total');

    expect(draft().indexes).toMatchObject([
      { keys: 'quantity DESC', clauses: 'WHERE quantity > 0', unique: true, method: 'hash', concurrently: true },
      { original_name: null, name: 'by_total', concurrently: true },
    ]);
    await user.click(screen.getByRole('button', { name: 'Remove by_total' }));
    await user.click(screen.getByRole('button', { name: 'Remove by_quantity' }));
    expect(screen.getByText('No indexes besides those of the primary key and unique constraints.')).toBeTruthy();
  });

  it('builds a new index in the transaction by default on other servers', async () => {
    const { user } = await openTable();
    await user.click(section(/^Indexes/));

    await user.click(screen.getByRole('button', { name: 'Add index' }));

    expect((screen.getByRole('checkbox', { name: /concurrently/ }) as HTMLInputElement).checked).toBe(false);
  });
});
