import type { ObjectDefinition, ObjectExtras } from '../generated/objects';
import form from '../servers/servers.module.css';
import { useObjectEditorStore, type ObjectEditor } from '../store/object-editors';

export type FieldModel = {
  editor_id: string;
  field: string;
  label: string;
  value: string;
  span: 2 | 3 | 4 | 6;
  mono?: boolean;
  hint?: string;
  disabled?: boolean;
};

const spans = { 2: form.span2, 3: form.span3, 4: form.span4, 6: form.span6 } as const;

/** Changes some of an editor's draft fields, by their names in the definition. */
export const patch = (editor_id: string, fields: Readonly<Record<string, string | number | boolean | null>>) =>
  useObjectEditorStore.getState().patch(editor_id, fields);

export function TextField({ model }: { model: FieldModel }) {
  const hint_id = `${model.editor_id}-${model.field}-hint`;
  return (
    <label className={`${form.field} ${spans[model.span]}`}>
      <span className={form.label}>{model.label}</span>
      <input
        className={model.mono ? `${form.input} ${form.mono}` : form.input}
        value={model.value}
        spellCheck={false}
        disabled={model.disabled}
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

type SelectModel = Omit<FieldModel, 'mono' | 'hint'> & { options: ReadonlyArray<{ value: string; label: string }> };

export function SelectField({ model }: { model: SelectModel }) {
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

export function CommentField({ model }: { model: { editor_id: string; value: string | null } }) {
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

export function SchemaField({ model }: { model: { editor: ObjectEditor; value: string } }) {
  const options = model.editor.schemas.map((schema) => ({ value: schema, label: schema }));
  return <SelectField model={{ editor_id: model.editor.id, field: 'schema', label: 'Schema', value: model.value, span: 2, options }} />;
}

export const keywords = (...values: Array<string>) => values.map((value) => ({ value, label: value.toUpperCase() }));

/** Changes the editor's draft with `change`, reading it as it is now so quick edits don't overwrite each other. */
export function updateDraft<T extends ObjectDefinition>(editor_id: string, change: (draft: T) => T): void {
  const store = useObjectEditorStore.getState();
  store.change(editor_id, change((store.editors[editor_id] as ObjectEditor).draft as T));
}

/** Changes the editor's grants and triggers with `change`, reading them as they are now. */
export function updateExtras(editor_id: string, change: (extras: ObjectExtras) => ObjectExtras): void {
  const store = useObjectEditorStore.getState();
  store.changeExtras(editor_id, change((store.editors[editor_id] as ObjectEditor).extras as ObjectExtras));
}

export function replaced<T>(list: ReadonlyArray<T>, index: number, item: T): Array<T> {
  return list.map((current, position) => (position === index ? item : current));
}

export function without<T>(list: ReadonlyArray<T>, index: number): Array<T> {
  return list.filter((_, position) => position !== index);
}
