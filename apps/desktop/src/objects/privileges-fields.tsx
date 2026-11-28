import { IconX } from '@tabler/icons-react';
import { useState } from 'react';
import type { Grant, ObjectExtras } from '../generated/objects';
import form from '../servers/servers.module.css';
import type { ObjectEditor } from '../store/object-editors';
import { updateExtras } from './fields';
import classes from './objects.module.css';

function setGrant(editor_id: string, grantee: string, privilege: string, grant: Grant | null): void {
  updateExtras(editor_id, (extras) => {
    const others = extras.grants.filter((candidate) => candidate.grantee !== grantee || candidate.privilege !== privilege);
    return { ...extras, grants: grant ? [...others, grant] : others };
  });
}

function GrantCell({ model }: { model: { editor_id: string; grantee: string; privilege: string; grant: Grant | undefined } }) {
  const { editor_id, grantee, privilege, grant } = model;
  return (
    <td className={classes.grantCell}>
      <input
        type="checkbox"
        aria-label={`${privilege} for ${grantee}`}
        checked={grant !== undefined}
        onChange={(event) => setGrant(editor_id, grantee, privilege, event.currentTarget.checked ? { grantee, privilege, grantable: false } : null)}
      />
      {grant && (
        <label className={classes.grantOption}>
          <input
            type="checkbox"
            aria-label={`${privilege} for ${grantee}, with grant option`}
            checked={grant.grantable}
            onChange={(event) => setGrant(editor_id, grantee, privilege, { ...grant, grantable: event.currentTarget.checked })}
          />
          <span aria-hidden="true">grant</span>
        </label>
      )}
    </td>
  );
}

/** The owner's row: every privilege ticked and locked, since owning the object brings them. */
function ownerCells(owner: string, privileges: ReadonlyArray<string>) {
  return privileges.map((privilege) => (
    <td key={privilege} className={classes.grantCell}>
      <input type="checkbox" aria-label={`${privilege} for ${owner}, the owner`} checked disabled />
    </td>
  ));
}

/**
 * The roles that hold privileges on the object, by the privileges its kind has. The owner's row is shown locked, as
 * its privileges come with owning it. Ticking "grant" beside a privilege lets that role grant it on.
 */
export function PrivilegesFields({ editor }: { editor: ObjectEditor }) {
  const [added, setAdded] = useState<ReadonlyArray<string>>([]);
  const [picked, setPicked] = useState('');
  const extras = editor.extras as ObjectExtras;
  const id = editor.id;
  const grantees = [...new Set([...extras.grants.map((grant) => grant.grantee), ...added])];
  const addable = ['PUBLIC', ...editor.roles].filter((role) => role !== editor.owner && !grantees.includes(role));
  const choice = addable.includes(picked) ? picked : (addable[0] as string);

  return (
    <>
      <div className={classes.gridFrame}>
        <table className={classes.grid}>
          <thead>
            <tr>
              <th>Role</th>
              {editor.privileges.map((privilege) => (
                <th key={privilege} className={classes.center}>
                  {privilege}
                </th>
              ))}
              <th className={classes.removeColumn}>
                <span className="visually-hidden">Revoke all</span>
              </th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className={form.mono}>
                {editor.owner} <span className={classes.muted}>owner</span>
              </td>
              {ownerCells(editor.owner, editor.privileges)}
              <td />
            </tr>
            {grantees.map((grantee) => (
              <tr key={grantee}>
                <td className={form.mono}>{grantee}</td>
                {editor.privileges.map((privilege) => (
                  <GrantCell
                    key={privilege}
                    model={{ editor_id: id, grantee, privilege, grant: extras.grants.find((grant) => grant.grantee === grantee && grant.privilege === privilege) }}
                  />
                ))}
                <td>
                  <button
                    type="button"
                    aria-label={`Revoke all from ${grantee}`}
                    title={`Revoke all from ${grantee}`}
                    className={form.iconButton}
                    onClick={() => {
                      setAdded((current) => current.filter((role) => role !== grantee));
                      updateExtras(id, (current) => ({ ...current, grants: current.grants.filter((grant) => grant.grantee !== grantee) }));
                    }}
                  >
                    <IconX size={14} aria-hidden="true" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {addable.length > 0 && (
        <div className={classes.listRow}>
          <select aria-label="Role to add" className={form.input} value={choice} onChange={(event) => setPicked(event.currentTarget.value)}>
            {addable.map((role) => (
              <option key={role} value={role}>
                {role}
              </option>
            ))}
          </select>
          <button type="button" className={`${form.button} ${classes.addButton}`} onClick={() => setAdded((current) => [...current, choice])}>
            Add role
          </button>
        </div>
      )}
    </>
  );
}
