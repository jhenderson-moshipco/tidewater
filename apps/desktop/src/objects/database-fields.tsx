import type { AvailableExtension, ObjectDefinition } from '../generated/objects';
import form from '../servers/servers.module.css';
import { useObjectEditorStore, type ObjectEditor } from '../store/object-editors';
import { CommentField, SelectField, TextField, patch } from './fields';

type DatabaseDraft = Extract<ObjectDefinition, { type: 'database' }>;
type ExtensionDraft = Extract<ObjectDefinition, { type: 'extension' }>;

/** A database's name, owner and connection limit, and on a new one its encoding, template and locale. */
export function DatabaseFields({ editor }: { editor: ObjectEditor }) {
  const draft = editor.draft as DatabaseDraft;
  const id = editor.id;
  const creating = editor.mode === 'create';
  const owners = [...(creating ? [{ value: '', label: 'The role Tidewater connects as' }] : []), ...editor.roles.map((role) => ({ value: role, label: role }))];
  const fixed = (field: 'encoding' | 'template' | 'collation' | 'ctype', label: string, hint: string) => (
    <TextField model={{ editor_id: id, field, label, value: draft[field], span: 3, mono: true, hint: creating ? hint : undefined, disabled: !creating }} />
  );

  return (
    <div className={form.grid}>
      <TextField model={{ editor_id: id, field: 'name', label: 'Name', value: draft.name, span: 3 }} />
      <SelectField model={{ editor_id: id, field: 'owner', label: 'Owner', value: draft.owner, span: 3, options: owners }} />
      {fixed('template', 'Template', 'Empty for template1.')}
      {fixed('encoding', 'Encoding', "Empty for the template's.")}
      {fixed('collation', 'Collation', "Empty for the template's.")}
      {fixed('ctype', 'Character type', "Empty for the template's.")}
      <label className={`${form.field} ${form.span3}`}>
        <span className={form.label}>Connection limit</span>
        <input
          className={`${form.input} ${form.mono}`}
          inputMode="numeric"
          aria-describedby={`${id}-limit-hint`}
          value={draft.connection_limit === -1 ? '' : String(draft.connection_limit)}
          placeholder="No limit"
          onChange={(event) => {
            const limit = Number.parseInt(event.currentTarget.value, 10);
            patch(id, { connection_limit: Number.isNaN(limit) ? -1 : limit });
          }}
        />
        <span id={`${id}-limit-hint`} className={form.hint}>
          Empty for no limit.
        </span>
      </label>
      {!creating && <p className={`${form.hint} ${form.span6}`}>Encoding, template and locale are set when a database is created.</p>}
      <CommentField model={{ editor_id: id, value: draft.comment }} />
    </div>
  );
}

type Choice = { value: string; label: string };

/** The extensions a new one can be, the versions and schemas it can have, and what the chosen one does. */
function extensionChoices(
  extensions: ReadonlyArray<AvailableExtension>,
  schema_names: ReadonlyArray<string>,
  name: string,
  creating: boolean,
): { names: Array<Choice>; versions: Array<Choice>; schemas: Array<Choice>; about: string } {
  const chosen = extensions.find((extension) => extension.name === name);
  const installable = extensions.filter((extension) => !extension.installed);
  return {
    names: [{ value: '', label: 'Pick an extension' }, ...installable.map((extension) => ({ value: extension.name, label: extension.name }))],
    versions: [
      ...(creating ? [{ value: '', label: chosen ? `Default, ${chosen.default_version}` : 'Default' }] : []),
      ...(chosen?.versions ?? []).map((version) => ({ value: version, label: version })),
    ],
    schemas: [...(creating ? [{ value: '', label: "The extension's choice" }] : []), ...schema_names.map((schema) => ({ value: schema, label: schema }))],
    about: chosen?.comment ?? '',
  };
}

/** Which extension to install, at which version and in which schema; an installed one can move to another version or schema. */
export function ExtensionFields({ editor }: { editor: ObjectEditor }) {
  const draft = editor.draft as ExtensionDraft;
  const id = editor.id;
  const creating = editor.mode === 'create';
  const { names, versions, schemas, about } = extensionChoices(editor.extensions, editor.schemas, draft.name, creating);

  return (
    <div className={form.grid}>
      {creating ? (
        <label className={`${form.field} ${form.span2}`}>
          <span className={form.label}>Extension</span>
          <select
            className={form.input}
            value={draft.name}
            aria-describedby={`${id}-extension-hint`}
            onChange={(event) => patch(id, { name: event.currentTarget.value, version: '' })}
          >
            {names.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <TextField model={{ editor_id: id, field: 'name', label: 'Extension', value: draft.name, span: 2, disabled: true }} />
      )}
      <SelectField model={{ editor_id: id, field: 'version', label: 'Version', value: draft.version, span: 2, options: versions }} />
      <SelectField model={{ editor_id: id, field: 'schema', label: 'Schema', value: draft.schema, span: 2, options: schemas }} />
      <p id={`${id}-extension-hint`} className={`${form.hint} ${form.span6}`}>
        {about}
      </p>
      {creating && (
        <label className={`${form.check} ${form.span6}`}>
          <input
            type="checkbox"
            checked={editor.options.cascade}
            onChange={(event) => useObjectEditorStore.getState().setOptions(id, { cascade: event.currentTarget.checked })}
          />
          Also install the extensions it needs (CASCADE)
        </label>
      )}
      <CommentField model={{ editor_id: id, value: draft.comment }} />
    </div>
  );
}
