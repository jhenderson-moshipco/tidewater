import { IconPlus, IconPointFilled, IconX } from '@tabler/icons-react';
import { useState, type KeyboardEvent } from 'react';
import type {
  ColumnDefinition,
  ConstraintDefinition,
  ConstraintKind,
  Identity,
  IndexDefinition,
  ObjectDefinition,
  ReferentialAction,
  TableDefinition,
} from '../generated/objects';
import form from '../servers/servers.module.css';
import { useObjectEditorStore, type ObjectEditor } from '../store/object-editors';
import { useServerStore } from '../store/servers';
import { blankColumn } from './describe';
import classes from './objects.module.css';

type Section = 'columns' | 'constraints' | 'indexes';

const sections: ReadonlyArray<{ section: Section; label: string }> = [
  { section: 'columns', label: 'Columns' },
  { section: 'constraints', label: 'Constraints' },
  { section: 'indexes', label: 'Indexes' },
];

const common_types = [
  'bigint',
  'integer',
  'smallint',
  'numeric',
  'real',
  'double precision',
  'boolean',
  'text',
  'varchar(255)',
  'uuid',
  'date',
  'timestamptz',
  'timestamp',
  'interval',
  'jsonb',
  'bytea',
];

const identities: ReadonlyArray<{ value: Identity; label: string }> = [
  { value: 'none', label: 'None' },
  { value: 'always', label: 'ALWAYS' },
  { value: 'by_default', label: 'BY DEFAULT' },
];

const constraint_kinds: ReadonlyArray<{ value: ConstraintKind; label: string }> = [
  { value: 'primary_key', label: 'Primary key' },
  { value: 'unique', label: 'Unique' },
  { value: 'foreign_key', label: 'Foreign key' },
  { value: 'check', label: 'Check' },
  { value: 'other', label: 'Other, written as SQL' },
];

const actions: ReadonlyArray<{ value: ReferentialAction; label: string }> = [
  { value: 'no_action', label: 'NO ACTION' },
  { value: 'restrict', label: 'RESTRICT' },
  { value: 'cascade', label: 'CASCADE' },
  { value: 'set_null', label: 'SET NULL' },
  { value: 'set_default', label: 'SET DEFAULT' },
];

const methods = ['btree', 'hash', 'gist', 'spgist', 'gin', 'brin'];

type TableDraft = Extract<ObjectDefinition, { type: 'table' }>;

/** Changes the editor's table draft, reading it as it is now so quick edits don't overwrite each other. */
function updateTable(editor_id: string, change: (table: TableDraft) => TableDraft): void {
  const store = useObjectEditorStore.getState();
  const table = (store.editors[editor_id] as ObjectEditor).draft as TableDraft;
  store.change(editor_id, change(table));
}

function replaced<T>(list: ReadonlyArray<T>, index: number, item: T): Array<T> {
  return list.map((current, position) => (position === index ? item : current));
}

function without<T>(list: ReadonlyArray<T>, index: number): Array<T> {
  return list.filter((_, position) => position !== index);
}

/** A name as SQL spells it, quoted unless it is plain lowercase. */
function sqlName(name: string): string {
  return /^[a-z_][a-z0-9_$]*$/.test(name) ? name : `"${name.replaceAll('"', '""')}"`;
}

function columnLabel(column: ColumnDefinition, index: number): string {
  return column.name || `column ${index + 1}`;
}

function focusLast(selector: string): void {
  requestAnimationFrame(() => [...document.querySelectorAll<HTMLElement>(selector)].at(-1)?.focus());
}

function setColumn(editor_id: string, index: number, change: Partial<ColumnDefinition>): void {
  updateTable(editor_id, (table) => ({
    ...table,
    columns: replaced(table.columns, index, { ...(table.columns[index] as ColumnDefinition), ...change }),
  }));
}

/** Renames a column, and follows the rename in the constraints that list it. */
function renameColumn(editor_id: string, index: number, name: string): void {
  updateTable(editor_id, (table) => {
    const old_name = (table.columns[index] as ColumnDefinition).name;
    const constraints = table.constraints.map((constraint) => ({
      ...constraint,
      columns: constraint.columns.map((column) => (old_name !== '' && column === old_name ? name : column)),
    }));
    return { ...table, columns: replaced(table.columns, index, { ...(table.columns[index] as ColumnDefinition), name }), constraints };
  });
}

/**
 * Changes a column's type. An existing column whose type changes gets a USING cast to the new type, which the user
 * can rewrite; it follows the type until they do, and goes when the type is back to the original.
 */
function retypeColumn(editor_id: string, index: number, data_type: string, original: ColumnDefinition | undefined): void {
  updateTable(editor_id, (table) => {
    const column = table.columns[index] as ColumnDefinition;
    const cast = (type: string) => `${sqlName(column.name)}::${type}`;
    const following = column.using === '' || column.using === cast(column.data_type);
    const using = !original || data_type === original.data_type ? '' : following ? cast(data_type) : column.using;
    return { ...table, columns: replaced(table.columns, index, { ...column, data_type, using }) };
  });
}

/** Whether a column is new, differs from the column it was, or is as it was. */
function columnState(column: ColumnDefinition, original: ColumnDefinition | undefined): 'new' | 'changed' | 'unchanged' {
  if (!original) return 'new';
  const fields = (definition: ColumnDefinition) =>
    [definition.name, definition.data_type, definition.not_null, definition.default, definition.identity, definition.comment].join('\u0000');
  return fields(column) === fields(original) ? 'unchanged' : 'changed';
}

function ColumnRow({ model }: { model: { editor_id: string; column: ColumnDefinition; index: number; original: ColumnDefinition | undefined } }) {
  const { editor_id: id, column, index, original } = model;
  const label = columnLabel(column, index);
  const retyped = original !== undefined && original.data_type !== column.data_type;
  const state = columnState(column, original);

  return (
    <>
      <tr data-state={state}>
        <td className={classes.mark}>
          {state === 'new' && <IconPlus size={12} aria-hidden="true" />}
          {state === 'changed' && <IconPointFilled size={12} aria-hidden="true" />}
          {state !== 'unchanged' && <span className="visually-hidden">{state}</span>}
        </td>
        <td>
          <input
            aria-label={`Name of column ${index + 1}`}
            data-column-name=""
            className={`${form.input} ${form.mono}`}
            value={column.name}
            spellCheck={false}
            onChange={(event) => renameColumn(id, index, event.currentTarget.value)}
          />
        </td>
        <td>
          <input
            aria-label={`Type of ${label}`}
            list={`${id}-types`}
            className={`${form.input} ${form.mono}`}
            value={column.data_type}
            spellCheck={false}
            onChange={(event) => retypeColumn(id, index, event.currentTarget.value, original)}
          />
        </td>
        <td className={classes.center}>
          <input
            type="checkbox"
            aria-label={`${label} not null`}
            checked={column.not_null}
            onChange={(event) => setColumn(id, index, { not_null: event.currentTarget.checked })}
          />
        </td>
        <td>
          {column.generated ? (
            <span className={`${classes.muted} ${form.mono}`}>generated: {column.generated}</span>
          ) : (
            <input
              aria-label={`Default of ${label}`}
              className={`${form.input} ${form.mono}`}
              value={column.default}
              spellCheck={false}
              onChange={(event) => setColumn(id, index, { default: event.currentTarget.value })}
            />
          )}
        </td>
        <td>
          <select
            aria-label={`Identity of ${label}`}
            className={form.input}
            value={column.identity}
            onChange={(event) => {
              const identity = event.currentTarget.value as Identity;
              setColumn(id, index, identity === 'none' ? { identity } : { identity, not_null: true });
            }}
          >
            {identities.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </td>
        <td>
          <input
            aria-label={`Comment on ${label}`}
            className={form.input}
            value={column.comment ?? ''}
            onChange={(event) => setColumn(id, index, { comment: event.currentTarget.value === '' ? null : event.currentTarget.value })}
          />
        </td>
        <td>
          <button
            type="button"
            aria-label={`Remove ${label}`}
            title={`Remove ${label}`}
            className={form.iconButton}
            onClick={() => updateTable(id, (table) => ({ ...table, columns: without(table.columns, index) }))}
          >
            <IconX size={14} aria-hidden="true" />
          </button>
        </td>
      </tr>
      {retyped && (
        <tr className={classes.usingRow}>
          <td />
          <td colSpan={7}>
            <label className={classes.using}>
              <span className={form.label}>
                USING, to turn each {label} value into {column.data_type}
              </span>
              <input
                className={`${form.input} ${form.mono}`}
                value={column.using}
                spellCheck={false}
                onChange={(event) => setColumn(id, index, { using: event.currentTarget.value })}
              />
            </label>
          </td>
        </tr>
      )}
    </>
  );
}

function Columns({ model }: { model: { editor: ObjectEditor; table: TableDraft } }) {
  const { editor, table } = model;
  const originals = editor.original ? (editor.original as TableDefinition).columns : [];

  return (
    <>
      <div className={classes.gridFrame}>
        <table className={classes.grid}>
          <colgroup>
            <col className={classes.markColumn} />
            <col className={classes.nameColumn} />
            <col className={classes.typeColumn} />
            <col className={classes.checkColumn} />
            <col />
            <col className={classes.identityColumn} />
            <col />
            <col className={classes.removeColumn} />
          </colgroup>
          <thead>
            <tr>
              <th>
                <span className="visually-hidden">Change</span>
              </th>
              <th>Name</th>
              <th>Type</th>
              <th className={classes.center}>Not null</th>
              <th>Default</th>
              <th>Identity</th>
              <th>Comment</th>
              <th>
                <span className="visually-hidden">Remove</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {table.columns.map((column, index) => (
              <ColumnRow
                key={column.number ?? `new-${index}`}
                model={{
                  editor_id: editor.id,
                  column,
                  index,
                  original: originals.find((candidate) => candidate.number !== null && candidate.number === column.number),
                }}
              />
            ))}
          </tbody>
        </table>
      </div>
      <datalist id={`${editor.id}-types`}>
        {common_types.map((type) => (
          <option key={type} value={type} />
        ))}
      </datalist>
      <button
        type="button"
        className={`${form.button} ${classes.addButton}`}
        onClick={() => {
          updateTable(editor.id, (current) => ({ ...current, columns: [...current.columns, blankColumn()] }));
          focusLast('[data-column-name]');
        }}
      >
        Add column
      </button>
    </>
  );
}

function setConstraint(editor_id: string, index: number, change: Partial<ConstraintDefinition>): void {
  updateTable(editor_id, (table) => ({
    ...table,
    constraints: replaced(table.constraints, index, { ...(table.constraints[index] as ConstraintDefinition), ...change }),
  }));
}

function ConstraintColumns({
  model,
}: {
  model: { editor_id: string; constraint: ConstraintDefinition; index: number; names: ReadonlyArray<string> };
}) {
  const { constraint } = model;
  return (
    <fieldset className={`${form.fieldset} ${form.span6}`}>
      <legend>Columns, in key order</legend>
      {model.names.map((name) => (
        <label key={name} className={form.choice}>
          <input
            type="checkbox"
            checked={constraint.columns.includes(name)}
            onChange={(event) =>
              setConstraint(model.editor_id, model.index, {
                columns: event.currentTarget.checked ? [...constraint.columns, name] : constraint.columns.filter((column) => column !== name),
              })
            }
          />
          {name}
        </label>
      ))}
    </fieldset>
  );
}

function ForeignKeyFields({ model }: { model: { editor_id: string; constraint: ConstraintDefinition; index: number; label: string } }) {
  const { editor_id, constraint, index, label } = model;
  const action = (field: 'on_delete' | 'on_update', text: string) => (
    <label className={`${form.field} ${form.span2}`}>
      <span className={form.label}>{text}</span>
      <select
        className={form.input}
        value={constraint[field]}
        onChange={(event) => setConstraint(editor_id, index, { [field]: event.currentTarget.value as ReferentialAction })}
      >
        {actions.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
  return (
    <>
      <label className={`${form.field} ${form.span2}`}>
        <span className={form.label}>References</span>
        <input
          aria-label={`Table ${label} references`}
          className={`${form.input} ${form.mono}`}
          value={constraint.references}
          spellCheck={false}
          onChange={(event) => setConstraint(editor_id, index, { references: event.currentTarget.value })}
        />
      </label>
      <label className={`${form.field} ${form.span2}`}>
        <span className={form.label}>Referenced columns</span>
        <input
          aria-describedby={`${editor_id}-referenced-hint`}
          className={`${form.input} ${form.mono}`}
          value={constraint.referenced_columns.join(',')}
          spellCheck={false}
          onChange={(event) => setConstraint(editor_id, index, { referenced_columns: event.currentTarget.value.split(',') })}
        />
      </label>
      {action('on_delete', 'On delete')}
      {action('on_update', 'On update')}
    </>
  );
}

function ConstraintCard({
  model,
}: {
  model: { editor: ObjectEditor; constraint: ConstraintDefinition; index: number; names: ReadonlyArray<string> };
}) {
  const { editor, constraint, index } = model;
  const id = editor.id;
  const kind_label = (constraint_kinds.find((kind) => kind.value === constraint.kind) as (typeof constraint_kinds)[number]).label;
  const label = constraint.name || `new ${kind_label.toLowerCase()}`;
  const keyed = constraint.kind === 'primary_key' || constraint.kind === 'unique' || constraint.kind === 'foreign_key';
  const skippable = constraint.kind === 'foreign_key' || constraint.kind === 'check';

  return (
    <div role="group" aria-labelledby={`${id}-constraint-${index}`} className={classes.card}>
      <div className={classes.cardHeader}>
        <h4 id={`${id}-constraint-${index}`} className={classes.cardTitle}>
          {label}
        </h4>
        <button
          type="button"
          aria-label={`Remove ${label}`}
          title={`Remove ${label}`}
          className={form.iconButton}
          onClick={() => updateTable(id, (table) => ({ ...table, constraints: without(table.constraints, index) }))}
        >
          <IconX size={14} aria-hidden="true" />
        </button>
      </div>
      <div className={form.grid}>
        <label className={`${form.field} ${form.span3}`}>
          <span className={form.label}>Name</span>
          <input
            className={`${form.input} ${form.mono}`}
            value={constraint.name}
            placeholder={constraint.original_name === null ? 'Named by Postgres' : undefined}
            spellCheck={false}
            onChange={(event) => setConstraint(id, index, { name: event.currentTarget.value })}
          />
        </label>
        <label className={`${form.field} ${form.span3}`}>
          <span className={form.label}>Kind</span>
          <select
            className={form.input}
            value={constraint.kind}
            onChange={(event) => setConstraint(id, index, { kind: event.currentTarget.value as ConstraintKind })}
          >
            {constraint_kinds.map((kind) => (
              <option key={kind.value} value={kind.value}>
                {kind.label}
              </option>
            ))}
          </select>
        </label>
        {keyed && <ConstraintColumns model={{ editor_id: id, constraint, index, names: model.names }} />}
        {constraint.kind === 'foreign_key' && <ForeignKeyFields model={{ editor_id: id, constraint, index, label }} />}
        {(constraint.kind === 'check' || constraint.kind === 'other') && (
          <label className={`${form.field} ${form.span6}`}>
            <span className={form.label}>{constraint.kind === 'check' ? 'Expression' : 'Definition'}</span>
            <input
              className={`${form.input} ${form.mono}`}
              value={constraint.expression}
              spellCheck={false}
              onChange={(event) => setConstraint(id, index, { expression: event.currentTarget.value })}
            />
          </label>
        )}
        {skippable && (
          <label className={`${form.check} ${form.span6}`}>
            <input
              type="checkbox"
              checked={constraint.not_valid}
              onChange={(event) => setConstraint(id, index, { not_valid: event.currentTarget.checked })}
            />
            Don't check existing rows (NOT VALID)
          </label>
        )}
      </div>
    </div>
  );
}

function Constraints({ model }: { model: { editor: ObjectEditor; table: TableDraft } }) {
  const { editor, table } = model;
  const names = table.columns.map((column) => column.name).filter((name) => name !== '');

  return (
    <>
      <p id={`${editor.id}-referenced-hint`} className={form.hint}>
        Referenced columns are separated by commas. Leave them empty to reference the other table's primary key.
      </p>
      {table.constraints.length === 0 && <p className={classes.muted}>No constraints.</p>}
      {table.constraints.map((constraint, index) => (
        <ConstraintCard key={constraint.original_name ?? `new-${index}`} model={{ editor, constraint, index, names }} />
      ))}
      <button
        type="button"
        className={`${form.button} ${classes.addButton}`}
        onClick={() =>
          updateTable(editor.id, (current) => {
            const kind: ConstraintKind = current.constraints.some((constraint) => constraint.kind === 'primary_key') ? 'unique' : 'primary_key';
            const constraint: ConstraintDefinition = {
              original_name: null,
              name: '',
              kind,
              columns: [],
              references: '',
              referenced_columns: [],
              on_update: 'no_action',
              on_delete: 'no_action',
              expression: '',
              not_valid: false,
            };
            return { ...current, constraints: [...current.constraints, constraint] };
          })
        }
      >
        Add constraint
      </button>
    </>
  );
}

function setIndex(editor_id: string, index: number, change: Partial<IndexDefinition>): void {
  updateTable(editor_id, (table) => ({
    ...table,
    indexes: replaced(table.indexes, index, { ...(table.indexes[index] as IndexDefinition), ...change }),
  }));
}

/** Whether applying builds the index: it is new, or differs from the index it was. */
function builds(index: IndexDefinition, original: IndexDefinition | undefined): boolean {
  if (!original) return true;
  return (
    index.unique !== original.unique ||
    index.method !== original.method ||
    index.keys !== original.keys ||
    index.clauses.trim() !== original.clauses.trim()
  );
}

function IndexCard({
  model,
}: {
  model: { editor_id: string; editing: boolean; index: IndexDefinition; position: number; original: IndexDefinition | undefined };
}) {
  const { editor_id: id, index, position, original } = model;
  const label = index.name || 'new index';
  const text = (field: 'name' | 'keys' | 'clauses', title: string, span: string, placeholder?: string) => (
    <label className={`${form.field} ${span}`}>
      <span className={form.label}>{title}</span>
      <input
        className={`${form.input} ${form.mono}`}
        value={index[field]}
        placeholder={placeholder}
        spellCheck={false}
        onChange={(event) => setIndex(id, position, { [field]: event.currentTarget.value })}
      />
    </label>
  );

  return (
    <div role="group" aria-labelledby={`${id}-index-${position}`} className={classes.card}>
      <div className={classes.cardHeader}>
        <h4 id={`${id}-index-${position}`} className={classes.cardTitle}>
          {label}
        </h4>
        <button
          type="button"
          aria-label={`Remove ${label}`}
          title={`Remove ${label}`}
          className={form.iconButton}
          onClick={() => updateTable(id, (table) => ({ ...table, indexes: without(table.indexes, position) }))}
        >
          <IconX size={14} aria-hidden="true" />
        </button>
      </div>
      <div className={form.grid}>
        {text('name', 'Name', form.span3, index.original_name === null ? 'Named by Postgres' : undefined)}
        <label className={`${form.field} ${form.span3}`}>
          <span className={form.label}>Method</span>
          <select className={form.input} value={index.method} onChange={(event) => setIndex(id, position, { method: event.currentTarget.value })}>
            {methods.map((method) => (
              <option key={method} value={method}>
                {method}
              </option>
            ))}
          </select>
        </label>
        {text('keys', 'Columns and expressions', form.span6, 'lower(email), created_at DESC')}
        {text('clauses', 'Other clauses', form.span6, 'INCLUDE (…) or WHERE …')}
        <label className={`${form.check} ${form.span6}`}>
          <input type="checkbox" checked={index.unique} onChange={(event) => setIndex(id, position, { unique: event.currentTarget.checked })} />
          Unique
        </label>
        {model.editing && builds(index, original) && (
          <label className={`${form.check} ${form.span6}`}>
            <input
              type="checkbox"
              checked={index.concurrently}
              onChange={(event) => setIndex(id, position, { concurrently: event.currentTarget.checked })}
            />
            Build it concurrently, on its own after the rest commits, so writes don't wait
          </label>
        )}
      </div>
    </div>
  );
}

function Indexes({ model }: { model: { editor: ObjectEditor; table: TableDraft } }) {
  const { editor, table } = model;
  const originals = editor.original ? (editor.original as TableDefinition).indexes : [];
  const prod = useServerStore((state) => state.servers.find((server) => server.id === editor.server_id)?.environment === 'prod');

  return (
    <>
      {table.indexes.length === 0 && <p className={classes.muted}>No indexes besides those of the primary key and unique constraints.</p>}
      {table.indexes.map((index, position) => (
        <IndexCard
          key={index.original_name ?? `new-${position}`}
          model={{
            editor_id: editor.id,
            editing: editor.mode === 'edit',
            index,
            position,
            original: originals.find((candidate) => candidate.original_name === index.original_name),
          }}
        />
      ))}
      <button
        type="button"
        className={`${form.button} ${classes.addButton}`}
        onClick={() =>
          updateTable(editor.id, (current) => ({
            ...current,
            indexes: [
              ...current.indexes,
              { original_name: null, name: '', unique: false, method: 'btree', keys: '', clauses: '', concurrently: prod },
            ],
          }))
        }
      >
        Add index
      </button>
    </>
  );
}

function moveAmong(event: KeyboardEvent<HTMLButtonElement>, index: number, show: (section: Section) => void): void {
  const keys: Readonly<Record<string, number>> = { ArrowRight: index + 1, ArrowLeft: index - 1, Home: 0, End: sections.length - 1 };
  const target = keys[event.key];
  if (target === undefined) return;
  event.preventDefault();
  const next = (target + sections.length) % sections.length;
  show((sections[next] as (typeof sections)[number]).section);
  event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
}

/** A table's name and comment, then its columns, constraints and indexes, one section at a time. */
export function TableFields({ editor }: { editor: ObjectEditor }) {
  const [shown, setShown] = useState<Section>('columns');
  const table = editor.draft as TableDraft;
  const counts: Readonly<Record<Section, number>> = {
    columns: table.columns.length,
    constraints: table.constraints.length,
    indexes: table.indexes.length,
  };
  const tab_id = (section: Section) => `${editor.id}-section-${section}`;

  return (
    <div className={classes.table}>
      <div className={form.grid}>
        <label className={`${form.field} ${form.span2}`}>
          <span className={form.label}>Schema</span>
          <select
            className={form.input}
            value={table.schema}
            onChange={(event) => useObjectEditorStore.getState().patch(editor.id, { schema: event.currentTarget.value })}
          >
            {editor.schemas.map((schema) => (
              <option key={schema} value={schema}>
                {schema}
              </option>
            ))}
          </select>
        </label>
        <label className={`${form.field} ${form.span4}`}>
          <span className={form.label}>Name</span>
          <input
            className={form.input}
            value={table.name}
            spellCheck={false}
            onChange={(event) => useObjectEditorStore.getState().patch(editor.id, { name: event.currentTarget.value })}
          />
        </label>
        <label className={`${form.field} ${form.span6}`}>
          <span className={form.label}>Comment</span>
          <input
            className={form.input}
            value={table.comment ?? ''}
            onChange={(event) =>
              useObjectEditorStore.getState().patch(editor.id, { comment: event.currentTarget.value === '' ? null : event.currentTarget.value })
            }
          />
        </label>
        {table.partition_key && <p className={`${form.hint} ${form.span6}`}>Partitioned by {table.partition_key}</p>}
      </div>
      <div role="tablist" aria-label="Table sections" className={classes.sections}>
        {sections.map((option, index) => (
          <button
            key={option.section}
            type="button"
            role="tab"
            id={tab_id(option.section)}
            aria-selected={option.section === shown}
            aria-controls={`${editor.id}-section-panel`}
            tabIndex={option.section === shown ? 0 : -1}
            className={classes.section}
            onClick={() => setShown(option.section)}
            onKeyDown={(event) => moveAmong(event, index, setShown)}
          >
            {option.label} <span className={classes.muted}>{counts[option.section]}</span>
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`${editor.id}-section-panel`} aria-labelledby={tab_id(shown)} className={classes.sectionPanel}>
        {shown === 'columns' && <Columns model={{ editor, table }} />}
        {shown === 'constraints' && <Constraints model={{ editor, table }} />}
        {shown === 'indexes' && <Indexes model={{ editor, table }} />}
      </div>
    </div>
  );
}
