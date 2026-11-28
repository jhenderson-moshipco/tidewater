import type { ObjectDefinition, ObjectExtras } from '../generated/objects';
import form from '../servers/servers.module.css';
import { useObjectEditorStore, type ObjectEditor } from '../store/object-editors';
import { CodeField } from './code-field';
import { CommentField, SchemaField, SelectField, TextField, keywords, patch } from './fields';
import { DatabaseFields, ExtensionFields } from './database-fields';
import classes from './objects.module.css';
import { PrivilegesFields } from './privileges-fields';
import { Sections, type SectionItem } from './sections';
import { TableFields } from './table-fields';
import { TriggerFields } from './trigger-fields';
import { TypeFields } from './type-fields';

function SequenceFields({ model }: { model: { editor: ObjectEditor; draft: Extract<ObjectDefinition, { type: 'sequence' }> } }) {
  const { editor, draft } = model;
  const text = (field: keyof typeof draft & string, label: string, hint?: string) => (
    <TextField model={{ editor_id: editor.id, field, label, value: String(draft[field]), span: 2, mono: true, hint }} />
  );
  return (
    <>
      <SchemaField model={{ editor, value: draft.schema }} />
      <TextField model={{ editor_id: editor.id, field: 'name', label: 'Name', value: draft.name, span: 4 }} />
      <SelectField
        model={{ editor_id: editor.id, field: 'data_type', label: 'Data type', value: draft.data_type, span: 2, options: keywords('smallint', 'integer', 'bigint') }}
      />
      {text('increment', 'Increment')}
      {text('start', 'Start')}
      {text('min_value', 'Minimum', "Empty for the data type's lowest.")}
      {text('max_value', 'Maximum', "Empty for the data type's highest.")}
      {text('cache', 'Cache')}
      <label className={`${form.check} ${form.span6}`}>
        <input type="checkbox" checked={draft.cycle} onChange={(event) => patch(editor.id, { cycle: event.currentTarget.checked })} />
        Start over when it passes the maximum (CYCLE)
      </label>
    </>
  );
}

function QueryFields({ model }: { model: { editor: ObjectEditor; draft: Extract<ObjectDefinition, { type: 'view' | 'materialized_view' }> } }) {
  const { editor, draft } = model;
  return (
    <>
      <SchemaField model={{ editor, value: draft.schema }} />
      <TextField model={{ editor_id: editor.id, field: 'name', label: 'Name', value: draft.name, span: 4 }} />
      <div className={`${form.field} ${form.span6}`}>
        <span className={form.label}>Query</span>
        <CodeField model={{ editor_id: editor.id, field: 'query', label: 'Query' }} />
      </div>
      {draft.type === 'materialized_view' && (
        <label className={`${form.check} ${form.span6}`}>
          <input
            type="checkbox"
            checked={editor.options.with_data}
            onChange={(event) => useObjectEditorStore.getState().setOptions(editor.id, { with_data: event.currentTarget.checked })}
          />
          Fill it with the query's rows when it's created (WITH DATA)
        </label>
      )}
    </>
  );
}

const kinds = [
  { value: 'function', label: 'Function' },
  { value: 'procedure', label: 'Procedure' },
];

function RoutineFields({ model }: { model: { editor: ObjectEditor; draft: Extract<ObjectDefinition, { type: 'routine' }> } }) {
  const { editor, draft } = model;
  const id = editor.id;
  return (
    <>
      <label className={`${form.field} ${form.span2}`}>
        <span className={form.label}>Kind</span>
        <select
          className={form.input}
          value={draft.procedure ? 'procedure' : 'function'}
          disabled={editor.mode !== 'create'}
          onChange={(event) => {
            const procedure = event.currentTarget.value === 'procedure';
            patch(id, { procedure, returns: procedure ? '' : 'void' });
          }}
        >
          {kinds.map((kind) => (
            <option key={kind.value} value={kind.value}>
              {kind.label}
            </option>
          ))}
        </select>
      </label>
      <SchemaField model={{ editor, value: draft.schema }} />
      <TextField model={{ editor_id: id, field: 'name', label: 'Name', value: draft.name, span: 2 }} />
      <TextField
        model={{ editor_id: id, field: 'arguments', label: 'Arguments', value: draft.arguments, span: 6, mono: true, hint: 'As SQL writes them, such as p_id bigint, p_pct numeric DEFAULT 10' }}
      />
      {!draft.procedure && <TextField model={{ editor_id: id, field: 'returns', label: 'Returns', value: draft.returns, span: 2, mono: true }} />}
      <TextField model={{ editor_id: id, field: 'language', label: 'Language', value: draft.language, span: 2, mono: true }} />
      {!draft.procedure && (
        <SelectField
          model={{ editor_id: id, field: 'volatility', label: 'Volatility', value: draft.volatility, span: 2, options: keywords('volatile', 'stable', 'immutable') }}
        />
      )}
      <label className={`${form.field} ${form.span2}`}>
        <span className={form.label}>Security</span>
        <select
          className={form.input}
          value={draft.security_definer ? 'definer' : 'invoker'}
          onChange={(event) => patch(id, { security_definer: event.currentTarget.value === 'definer' })}
        >
          <option value="invoker">INVOKER</option>
          <option value="definer">DEFINER</option>
        </select>
      </label>
      {!draft.procedure && (
        <SelectField
          model={{ editor_id: id, field: 'parallel', label: 'Parallel', value: draft.parallel, span: 2, options: keywords('unsafe', 'restricted', 'safe') }}
        />
      )}
      <div className={`${form.field} ${form.span6}`}>
        <span className={form.label}>Body</span>
        <CodeField model={{ editor_id: id, field: 'body', label: 'Body' }} />
      </div>
    </>
  );
}

/** The fields for the draft's kind of object; each change goes straight to the editor's draft. */
function DefinitionBody({ editor }: { editor: ObjectEditor }) {
  const draft = editor.draft as ObjectDefinition;
  if (draft.type === 'type') return <TypeFields editor={editor} />;
  if (draft.type === 'database') return <DatabaseFields editor={editor} />;
  if (draft.type === 'extension') return <ExtensionFields editor={editor} />;
  return (
    <div className={form.grid}>
      {draft.type === 'schema' && <TextField model={{ editor_id: editor.id, field: 'name', label: 'Name', value: draft.name, span: 3 }} />}
      {draft.type === 'sequence' && <SequenceFields model={{ editor, draft }} />}
      {(draft.type === 'view' || draft.type === 'materialized_view') && <QueryFields model={{ editor, draft }} />}
      {draft.type === 'routine' && <RoutineFields model={{ editor, draft }} />}
      <CommentField model={{ editor_id: editor.id, value: draft.comment }} />
    </div>
  );
}

/**
 * The editor's fields: a table's sections, or the definition beside a view's triggers and the object's privileges,
 * when its kind has those.
 */
export function DefinitionFields({ editor }: { editor: ObjectEditor }) {
  if (editor.object_type === 'table') return <TableFields editor={editor} />;
  const body = <DefinitionBody editor={editor} />;
  const triggers: Array<SectionItem> =
    editor.object_type === 'view'
      ? [{ key: 'triggers', label: 'Triggers', count: (editor.extras as ObjectExtras).triggers.length, content: <TriggerFields editor={editor} /> }]
      : [];
  const privileges: Array<SectionItem> = editor.privileges.length > 0 ? [{ key: 'privileges', label: 'Privileges', content: <PrivilegesFields editor={editor} /> }] : [];
  if (triggers.length + privileges.length === 0) return body;
  return (
    <div className={classes.table}>
      <Sections model={{ id: editor.id, label: 'Sections', items: [{ key: 'definition', label: 'Definition', content: body }, ...triggers, ...privileges] }} />
    </div>
  );
}
