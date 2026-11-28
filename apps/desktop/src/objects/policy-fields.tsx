import { IconX } from '@tabler/icons-react';
import type { ObjectDefinition, PolicyCommand, PolicyDefinition } from '../generated/objects';
import form from '../servers/servers.module.css';
import type { ObjectEditor } from '../store/object-editors';
import { replaced, updateDraft, without } from './fields';
import classes from './objects.module.css';

type TableDraft = Extract<ObjectDefinition, { type: 'table' }>;

const commands: ReadonlyArray<{ value: PolicyCommand; label: string }> = [
  { value: 'all', label: 'ALL' },
  { value: 'select', label: 'SELECT' },
  { value: 'insert', label: 'INSERT' },
  { value: 'update', label: 'UPDATE' },
  { value: 'delete', label: 'DELETE' },
];

function setPolicy(editor_id: string, index: number, change: Partial<PolicyDefinition>): void {
  updateDraft<TableDraft>(editor_id, (table) => ({ ...table, policies: replaced(table.policies, index, { ...(table.policies[index] as PolicyDefinition), ...change }) }));
}

function PolicyCard({ model }: { model: { editor_id: string; policy: PolicyDefinition; index: number } }) {
  const { editor_id, policy, index } = model;
  const label = policy.name || `policy ${index + 1}`;
  const heading = `${editor_id}-policy-${index}`;
  const expression = (field: 'using' | 'with_check', title: string, hint: string) => (
    <label className={`${form.field} ${form.span6}`}>
      <span className={form.label}>{title}</span>
      <input
        className={`${form.input} ${form.mono}`}
        value={policy[field]}
        placeholder={hint}
        spellCheck={false}
        onChange={(event) => setPolicy(editor_id, index, { [field]: event.currentTarget.value })}
      />
    </label>
  );

  return (
    <div role="group" aria-labelledby={heading} className={classes.card}>
      <div className={classes.cardHeader}>
        <h4 id={heading} className={classes.cardTitle}>
          {label}
        </h4>
        <button
          type="button"
          aria-label={`Remove ${label}`}
          title={`Remove ${label}`}
          className={form.iconButton}
          onClick={() => updateDraft<TableDraft>(editor_id, (table) => ({ ...table, policies: without(table.policies, index) }))}
        >
          <IconX size={14} aria-hidden="true" />
        </button>
      </div>
      <div className={form.grid}>
        <label className={`${form.field} ${form.span2}`}>
          <span className={form.label}>Name</span>
          <input className={form.input} value={policy.name} spellCheck={false} onChange={(event) => setPolicy(editor_id, index, { name: event.currentTarget.value })} />
        </label>
        <label className={`${form.field} ${form.span2}`}>
          <span className={form.label}>For</span>
          <select className={form.input} value={policy.command} onChange={(event) => setPolicy(editor_id, index, { command: event.currentTarget.value as PolicyCommand })}>
            {commands.map((command) => (
              <option key={command.value} value={command.value}>
                {command.label}
              </option>
            ))}
          </select>
        </label>
        <label className={`${form.field} ${form.span2}`}>
          <span className={form.label}>Kind</span>
          <select
            className={form.input}
            value={policy.permissive ? 'permissive' : 'restrictive'}
            onChange={(event) => setPolicy(editor_id, index, { permissive: event.currentTarget.value === 'permissive' })}
          >
            <option value="permissive">Permissive, widens access</option>
            <option value="restrictive">Restrictive, narrows access</option>
          </select>
        </label>
        <label className={`${form.field} ${form.span6}`}>
          <span className={form.label}>Roles, separated by commas</span>
          <input
            className={`${form.input} ${form.mono}`}
            value={policy.roles.join(',')}
            placeholder="Every role"
            spellCheck={false}
            onChange={(event) => setPolicy(editor_id, index, { roles: event.currentTarget.value.split(',') })}
          />
        </label>
        {expression('using', 'Rows it lets through (USING)', 'owner_id = current_user')}
        {expression('with_check', 'Rows it accepts on insert or update (WITH CHECK)', 'Same as USING')}
      </div>
    </div>
  );
}

/** Whether row-level security is on for the table, and the policies that decide which rows each role sees. */
export function PolicyFields({ editor }: { editor: ObjectEditor }) {
  const table = editor.draft as TableDraft;
  const id = editor.id;
  const flag = (field: 'row_security' | 'force_row_security', text: string) => (
    <label className={form.check}>
      <input type="checkbox" checked={table[field]} onChange={(event) => updateDraft<TableDraft>(id, (current) => ({ ...current, [field]: event.currentTarget.checked }))} />
      {text}
    </label>
  );

  return (
    <>
      {flag('row_security', 'Row-level security: rows are filtered by these policies')}
      {flag('force_row_security', "Apply the policies to the table's owner too (FORCE)")}
      {table.policies.length === 0 && <p className={classes.muted}>No policies.</p>}
      {table.policies.map((policy, index) => (
        <PolicyCard key={policy.original_name ?? `new-${index}`} model={{ editor_id: id, policy, index }} />
      ))}
      <button
        type="button"
        className={`${form.button} ${classes.addButton}`}
        onClick={() =>
          updateDraft<TableDraft>(id, (current) => ({
            ...current,
            policies: [...current.policies, { original_name: null, name: '', command: 'all', permissive: true, roles: [], using: '', with_check: '' }],
          }))
        }
      >
        Add policy
      </button>
    </>
  );
}
