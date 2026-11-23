import type { ObjectDefinition } from '../generated/objects';
import form from '../servers/servers.module.css';
import { useObjectEditorStore, type ObjectEditor } from '../store/object-editors';
import { CodeField } from './code-field';

type FieldModel = {
  editor_id: string;
  field: string;
  label: string;
  value: string;
  span: 2 | 3 | 4 | 6;
  mono?: boolean;
  hint?: string;
};

const spans = { 2: form.span2, 3: form.span3, 4: form.span4, 6: form.span6 } as const;

const patch = (editor_id: string, fields: Readonly<Record<string, string | boolean | null>>) =>
  useObjectEditorStore.getState().patch(editor_id, fields);

function TextField({ model }: { model: FieldModel }) {
  const hint_id = `${model.editor_id}-${model.field}-hint`;
  return (
    <label className={`${form.field} ${spans[model.span]}`}>
      <span className={form.label}>{model.label}</span>
      <input
        className={model.mono ? `${form.input} ${form.mono}` : form.input}
        value={model.value}
        spellCheck={false}
        aria-describedby={model.hint ? hint_id : undefined}
        onChange={(event) => patch(model.editor_id, { [model.field]: event.currentTarget.value })}
      />
      {model.hint && (
        <span id={hint_id} className={form.hint}>
          {model.hint}
        </span>
      )}
    </label>
  );
}

type SelectModel = Omit<FieldModel, 'mono' | 'hint'> & { options: ReadonlyArray<{ value: string; label: string }>; disabled?: boolean };

function SelectField({ model }: { model: SelectModel }) {
  return (
    <label className={`${form.field} ${spans[model.span]}`}>
      <span className={form.label}>{model.label}</span>
      <select
        className={form.input}
        value={model.value}
        disabled={model.disabled}
        onChange={(event) => patch(model.editor_id, { [model.field]: event.currentTarget.value })}
      >
        {model.options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function CommentField({ model }: { model: { editor_id: string; value: string | null } }) {
  return (
    <label className={`${form.field} ${form.span6}`}>
      <span className={form.label}>Comment</span>
      <input
        className={form.input}
        value={model.value ?? ''}
        onChange={(event) => patch(model.editor_id, { comment: event.currentTarget.value === '' ? null : event.currentTarget.value })}
      />
    </label>
  );
}

function SchemaField({ model }: { model: { editor: ObjectEditor; value: string } }) {
  const options = model.editor.schemas.map((schema) => ({ value: schema, label: schema }));
  return <SelectField model={{ editor_id: model.editor.id, field: 'schema', label: 'Schema', value: model.value, span: 2, options }} />;
}

const keywords = (...values: Array<string>) => values.map((value) => ({ value, label: value.toUpperCase() }));

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
export function DefinitionFields({ editor }: { editor: ObjectEditor }) {
  const draft = editor.draft as ObjectDefinition;
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
