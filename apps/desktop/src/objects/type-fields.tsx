import { IconX } from '@tabler/icons-react';
import type { DomainCheck, EnumValue, ObjectDefinition, TypeAttribute, TypeKind } from '../generated/objects';
import form from '../servers/servers.module.css';
import { useObjectEditorStore, type ObjectEditor } from '../store/object-editors';
import { CommentField, SchemaField, SelectField, TextField } from './fields';
import classes from './objects.module.css';

type TypeDraft = Extract<ObjectDefinition, { type: 'type' }>;

const kinds: ReadonlyArray<{ value: TypeKind; label: string }> = [
  { value: 'enum', label: 'Enum' },
  { value: 'composite', label: 'Composite' },
  { value: 'domain', label: 'Domain' },
  { value: 'range', label: 'Range' },
];

/** Changes the editor's type draft, reading it as it is now so quick edits don't overwrite each other. */
function updateType(editor_id: string, change: (definition: TypeDraft) => TypeDraft): void {
  const store = useObjectEditorStore.getState();
  store.change(editor_id, change((store.editors[editor_id] as ObjectEditor).draft as TypeDraft));
}

function replaced<T>(list: ReadonlyArray<T>, index: number, item: T): Array<T> {
  return list.map((current, position) => (position === index ? item : current));
}

function without<T>(list: ReadonlyArray<T>, index: number): Array<T> {
  return list.filter((_, position) => position !== index);
}

function RemoveButton({ model }: { model: { label: string; remove: () => void } }) {
  return (
    <button type="button" aria-label={`Remove ${model.label}`} title={`Remove ${model.label}`} className={form.iconButton} onClick={model.remove}>
      <IconX size={14} aria-hidden="true" />
    </button>
  );
}

function AddButton({ model }: { model: { label: string; add: () => void } }) {
  return (
    <button type="button" className={`${form.button} ${classes.addButton}`} onClick={model.add}>
      {model.label}
    </button>
  );
}

function EnumValues({ model }: { model: { editor_id: string; values: ReadonlyArray<EnumValue> } }) {
  const { editor_id } = model;
  const set = (index: number, label: string) =>
    updateType(editor_id, (definition) => ({ ...definition, values: replaced(definition.values, index, { ...(definition.values[index] as EnumValue), label }) }));

  return (
    <div className={`${classes.list} ${form.span6}`}>
      <span className={form.label}>Values, in order</span>
      <p className={form.hint}>Values already in the type can be renamed, but Postgres can't remove or reorder them.</p>
      {model.values.map((value, index) => (
        <div key={index} className={classes.listRow}>
          <input
            aria-label={`Value ${index + 1}`}
            className={`${form.input} ${form.mono}`}
            value={value.label}
            spellCheck={false}
            onChange={(event) => set(index, event.currentTarget.value)}
          />
          {value.original === null && (
            <RemoveButton
              model={{
                label: value.label || `value ${index + 1}`,
                remove: () => updateType(editor_id, (definition) => ({ ...definition, values: without(definition.values, index) })),
              }}
            />
          )}
        </div>
      ))}
      <AddButton
        model={{
          label: 'Add value',
          add: () => updateType(editor_id, (definition) => ({ ...definition, values: [...definition.values, { original: null, label: '' }] })),
        }}
      />
    </div>
  );
}

function Attributes({ model }: { model: { editor_id: string; attributes: ReadonlyArray<TypeAttribute> } }) {
  const { editor_id } = model;
  const set = (index: number, change: Partial<TypeAttribute>) =>
    updateType(editor_id, (definition) => ({
      ...definition,
      attributes: replaced(definition.attributes, index, { ...(definition.attributes[index] as TypeAttribute), ...change }),
    }));

  return (
    <div className={`${classes.list} ${form.span6}`}>
      <span className={form.label}>Attributes</span>
      {model.attributes.map((attribute, index) => {
        const label = attribute.name || `attribute ${index + 1}`;
        return (
          <div key={index} className={classes.listRow}>
            <input
              aria-label={`Name of attribute ${index + 1}`}
              className={`${form.input} ${form.mono}`}
              value={attribute.name}
              spellCheck={false}
              onChange={(event) => set(index, { name: event.currentTarget.value })}
            />
            <input
              aria-label={`Type of ${label}`}
              className={`${form.input} ${form.mono}`}
              value={attribute.data_type}
              spellCheck={false}
              onChange={(event) => set(index, { data_type: event.currentTarget.value })}
            />
            <RemoveButton
              model={{ label, remove: () => updateType(editor_id, (definition) => ({ ...definition, attributes: without(definition.attributes, index) })) }}
            />
          </div>
        );
      })}
      <AddButton
        model={{
          label: 'Add attribute',
          add: () =>
            updateType(editor_id, (definition) => ({ ...definition, attributes: [...definition.attributes, { original_name: null, name: '', data_type: '' }] })),
        }}
      />
    </div>
  );
}

function DomainFields({ model }: { model: { editor_id: string; draft: TypeDraft; creating: boolean } }) {
  const { editor_id, draft } = model;
  const set = (index: number, change: Partial<DomainCheck>) =>
    updateType(editor_id, (definition) => ({ ...definition, checks: replaced(definition.checks, index, { ...(definition.checks[index] as DomainCheck), ...change }) }));

  return (
    <>
      <TextField model={{ editor_id, field: 'base_type', label: 'Base type', value: draft.base_type, span: 3, mono: true, disabled: !model.creating }} />
      <TextField model={{ editor_id, field: 'default', label: 'Default', value: draft.default, span: 3, mono: true }} />
      <label className={`${form.check} ${form.span6}`}>
        <input type="checkbox" checked={draft.not_null} onChange={(event) => updateType(editor_id, (definition) => ({ ...definition, not_null: event.currentTarget.checked }))} />
        NOT NULL
      </label>
      <div className={`${classes.list} ${form.span6}`}>
        <span className={form.label}>Checks</span>
        <p className={form.hint}>Each check names the value being checked VALUE, as in VALUE &gt; 0.</p>
        {draft.checks.map((check, index) => {
          const label = check.name || `check ${index + 1}`;
          return (
            <div key={index} className={classes.listRow}>
              <input
                aria-label={`Name of check ${index + 1}`}
                className={`${form.input} ${form.mono}`}
                value={check.name}
                placeholder={check.original_name === null ? 'Named by Postgres' : undefined}
                spellCheck={false}
                onChange={(event) => set(index, { name: event.currentTarget.value })}
              />
              <input
                aria-label={`Expression of ${label}`}
                className={`${form.input} ${form.mono}`}
                value={check.expression}
                spellCheck={false}
                onChange={(event) => set(index, { expression: event.currentTarget.value })}
              />
              <RemoveButton model={{ label, remove: () => updateType(editor_id, (definition) => ({ ...definition, checks: without(definition.checks, index) })) }} />
            </div>
          );
        })}
        <AddButton
          model={{
            label: 'Add check',
            add: () => updateType(editor_id, (definition) => ({ ...definition, checks: [...definition.checks, { original_name: null, name: '', expression: '' }] })),
          }}
        />
      </div>
    </>
  );
}

/** An enum's values, a composite's attributes, a domain's base type and checks, or a range's subtype. */
export function TypeFields({ editor }: { editor: ObjectEditor }) {
  const draft = editor.draft as TypeDraft;
  const creating = editor.mode === 'create';
  const id = editor.id;

  return (
    <div className={form.grid}>
      <SelectField model={{ editor_id: id, field: 'kind', label: 'Kind', value: draft.kind, span: 2, options: kinds, disabled: !creating }} />
      <SchemaField model={{ editor, value: draft.schema }} />
      <TextField model={{ editor_id: id, field: 'name', label: 'Name', value: draft.name, span: 2 }} />
      {draft.kind === 'enum' && <EnumValues model={{ editor_id: id, values: draft.values }} />}
      {draft.kind === 'composite' && <Attributes model={{ editor_id: id, attributes: draft.attributes }} />}
      {draft.kind === 'domain' && <DomainFields model={{ editor_id: id, draft, creating }} />}
      {draft.kind === 'range' && (
        <TextField model={{ editor_id: id, field: 'base_type', label: 'Subtype', value: draft.base_type, span: 6, mono: true, disabled: !creating }} />
      )}
      <CommentField model={{ editor_id: id, value: draft.comment }} />
    </div>
  );
}
