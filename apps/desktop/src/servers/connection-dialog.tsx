import { IconCheck, IconMinus, IconX } from '@tabler/icons-react';
import type { ChangeEvent, ClipboardEvent, FocusEvent, FormEvent, MouseEvent } from 'react';
import { messageOf } from '../api/errors';
import * as api from '../api/servers';
import type { ProbeResult } from '../generated/connections';
import type { ServerSummary } from '../generated/servers';
import { useDialogStore } from '../store/dialogs';
import { useServerStore } from '../store/servers';
import { formOf, inputOf } from '../utils/forms';
import {
  applyParsed,
  environments,
  listOf,
  outcome_labels,
  probe_step_labels,
  readConnectionForm,
  tls_modes,
} from './connection-form';
import { Modal, closeDialogOf } from './modal';
import classes from './servers.module.css';

const outcome_icons = { passed: IconCheck, failed: IconX, skipped: IconMinus } as const;

/** One sentence for the always-present status region, so screen readers hear the outcome without reading the list. */
function statusText(busy: 'testing' | 'saving' | null, probe: Array<ProbeResult> | null, notice: string | null): string {
  if (busy === 'testing') return 'Testing connection…';
  if (busy === 'saving') return 'Saving…';
  if (probe) {
    const failed = probe.find((result) => result.outcome === 'failed');
    return failed ? `Connection test failed at ${probe_step_labels[failed.step]}: ${failed.detail}` : 'Connection test passed';
  }
  return notice ?? '';
}

async function fillFromUrl(input: HTMLInputElement, text: string): Promise<void> {
  const form = formOf(input);
  const dialogs = useDialogStore.getState();
  if (text.trim() === '' || input.dataset.parsed === text) return;
  input.dataset.parsed = text;
  try {
    const filled = applyParsed(form, await api.parseConnection(text));
    dialogs.setError(null);
    dialogs.setNotice(filled.length > 0 ? `Filled ${listOf(filled)} from the URL` : null);
  } catch (error) {
    dialogs.setError(messageOf(error));
  }
}

function pasteUrl(event: ClipboardEvent<HTMLInputElement>): void {
  void fillFromUrl(event.currentTarget, event.clipboardData.getData('text'));
}

function blurUrl(event: FocusEvent<HTMLInputElement>): void {
  void fillFromUrl(event.currentTarget, event.currentTarget.value);
}

/** Production servers start read-only with a 15 second statement timeout; the user can still change both. */
function changeEnvironment(event: ChangeEvent<HTMLInputElement>): void {
  const form = formOf(event.currentTarget);
  if (event.currentTarget.value !== 'prod') return;
  inputOf(form, 'read_only').checked = true;
  const timeout = inputOf(form, 'statement_timeout_s');
  if (timeout.value === '') timeout.value = '15';
}

async function runTest(event: MouseEvent<HTMLButtonElement>, editing: ServerSummary | null): Promise<void> {
  const form = formOf(event.currentTarget);
  const dialogs = useDialogStore.getState();
  dialogs.setBusy('testing');
  dialogs.setError(null);
  dialogs.setProbe(null);
  try {
    dialogs.setProbe(await api.testConnection(readConnectionForm(form, editing)));
  } catch (error) {
    dialogs.setError(messageOf(error));
  } finally {
    useDialogStore.getState().setBusy(null);
  }
}

async function save(event: FormEvent<HTMLFormElement>, editing: ServerSummary | null): Promise<void> {
  event.preventDefault();
  const form = event.currentTarget;
  const dialogs = useDialogStore.getState();
  const servers = useServerStore.getState();
  dialogs.setBusy('saving');
  dialogs.setError(null);
  try {
    const saved = await servers.saveServer(readConnectionForm(form, editing));
    closeDialogOf(form);
    if (!editing) void servers.connect(saved.id);
  } catch (error) {
    useDialogStore.getState().setError(messageOf(error));
    useDialogStore.getState().setBusy(null);
  }
}

export function ConnectionDialog({ editing }: { editing: ServerSummary | null }) {
  const draft = useDialogStore((state) => state.draft);
  const draft_version = useDialogStore((state) => state.draft_version);
  const probe = useDialogStore((state) => state.probe);
  const busy = useDialogStore((state) => state.busy);
  const error = useDialogStore((state) => state.error);
  const notice = useDialogStore((state) => state.notice);
  const groups = useServerStore((state) => state.groups);

  return (
    <Modal model={{ title: editing ? `Edit ${editing.name}` : 'New connection', title_id: 'connection-dialog-title' }}>
      <form key={draft_version} onSubmit={(event) => void save(event, editing)}>
        <div className={classes.modalBody}>
          <label className={classes.field}>
            <span className={classes.label}>Connection URL</span>
            <input
              name="url"
              className={`${classes.input} ${classes.mono}`}
              defaultValue={draft.url}
              placeholder="postgres://user@host:5432/database"
              autoComplete="off"
              spellCheck={false}
              onPaste={pasteUrl}
              onBlur={blurUrl}
            />
          </label>

          <div className={classes.grid}>
            <label className={`${classes.field} ${classes.span3}`}>
              <span className={classes.label}>Name</span>
              <input name="name" className={classes.input} defaultValue={draft.name} required />
            </label>
            <label className={`${classes.field} ${classes.span3}`}>
              <span className={classes.label}>Group</span>
              <select name="group_id" className={classes.input} defaultValue={draft.group_id}>
                <option value="">No group</option>
                {groups.map((group) => (
                  <option key={group.id} value={group.id}>
                    {group.name}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <fieldset className={classes.fieldset}>
            <legend>Environment</legend>
            {environments.map((option) => (
              <label key={option.value} className={classes.choice}>
                <input
                  type="radio"
                  name="environment"
                  value={option.value}
                  defaultChecked={draft.environment === option.value}
                  onChange={changeEnvironment}
                />
                {option.label}
              </label>
            ))}
          </fieldset>

          <fieldset className={classes.section}>
            <legend className={classes.sectionTitle}>Server</legend>
            <div className={classes.grid}>
              <label className={`${classes.field} ${classes.span4}`}>
                <span className={classes.label}>Host</span>
                <input name="host" className={classes.input} defaultValue={draft.host} required spellCheck={false} />
              </label>
              <label className={`${classes.field} ${classes.span2}`}>
                <span className={classes.label}>Port</span>
                <input name="port" type="number" min={1} max={65535} className={classes.input} defaultValue={draft.port} required />
              </label>
              <label className={`${classes.field} ${classes.span3}`}>
                <span className={classes.label}>Database</span>
                <input name="database" className={classes.input} defaultValue={draft.database} required spellCheck={false} />
              </label>
              <label className={`${classes.field} ${classes.span3}`}>
                <span className={classes.label}>TLS</span>
                <select name="tls" className={classes.input} defaultValue={draft.tls}>
                  {tls_modes.map((mode) => (
                    <option key={mode.value} value={mode.value}>
                      {mode.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </fieldset>

          <fieldset className={classes.section}>
            <legend className={classes.sectionTitle}>Sign in</legend>
            <div className={classes.grid}>
              <label className={`${classes.field} ${classes.span3}`}>
                <span className={classes.label}>User</span>
                <input name="user" className={classes.input} defaultValue={draft.user} required spellCheck={false} />
              </label>
              <div className={`${classes.field} ${classes.span3}`}>
                <label htmlFor="connection-password" className={classes.label}>
                  Password
                </label>
                <input
                  id="connection-password"
                  name="password"
                  type="password"
                  className={classes.input}
                  defaultValue={draft.password}
                  aria-describedby={editing?.has_password ? 'connection-password-hint' : undefined}
                  autoComplete="off"
                />
                {editing?.has_password && (
                  <span id="connection-password-hint" className={classes.hint}>
                    Leave blank to keep the saved one
                  </span>
                )}
              </div>
              {editing?.has_password && (
                <label className={`${classes.check} ${classes.span6}`}>
                  <input type="checkbox" name="clear_password" />
                  Remove the saved password
                </label>
              )}
            </div>
          </fieldset>

          <fieldset className={classes.section}>
            <legend className={classes.sectionTitle}>Session</legend>
            <div className={classes.grid}>
              <label className={`${classes.field} ${classes.span3}`}>
                <span className={classes.label}>Statement timeout (seconds)</span>
                <input name="statement_timeout_s" type="number" min={0} step="any" className={classes.input} defaultValue={draft.statement_timeout_s} />
              </label>
              <label className={`${classes.check} ${classes.span3} ${classes.alignEnd}`}>
                <input type="checkbox" name="read_only" defaultChecked={draft.read_only} />
                Read-only sessions
              </label>
            </div>
          </fieldset>

          <p role="status" className="visually-hidden">
            {statusText(busy, probe, notice)}
          </p>

          <ul aria-label="Connection test" className={classes.probe} hidden={!probe && busy !== 'testing'}>
            {busy === 'testing' && <li className={classes.muted}>Testing…</li>}
            {probe?.map((result) => {
              const OutcomeIcon = outcome_icons[result.outcome];
              return (
                <li key={result.step} className={classes.probeStep} data-outcome={result.outcome}>
                  <OutcomeIcon size={14} stroke={2.5} className={classes[result.outcome]} aria-hidden />
                  <span>
                    {probe_step_labels[result.step]} {outcome_labels[result.outcome]}
                  </span>
                  <span className={classes.probeDetail}>{result.detail}</span>
                </li>
              );
            })}
          </ul>

          {error && (
            <p role="alert" className={classes.error}>
              {error}
            </p>
          )}
        </div>

        <div className={classes.modalFooter}>
          <button type="button" className={classes.button} disabled={busy !== null} onClick={(event) => void runTest(event, editing)}>
            Test
          </button>
          <span className={classes.spacer} />
          <button type="button" className={classes.button} onClick={(event) => closeDialogOf(event.currentTarget)}>
            Cancel
          </button>
          <button type="submit" className={`${classes.button} ${classes.primary}`} disabled={busy !== null}>
            {editing ? 'Save' : 'Save and connect'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
