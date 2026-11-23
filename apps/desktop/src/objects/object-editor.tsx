import { IconAlertTriangle, IconX } from '@tabler/icons-react';
import type { SyntheticEvent } from 'react';
import type { ChangePlan } from '../generated/objects';
import { environmentLabel } from '../servers/connection-form';
import form from '../servers/servers.module.css';
import { canReview, confirmationName, editorTitle, useObjectEditorStore, type ObjectEditor } from '../store/object-editors';
import { useServerStore } from '../store/servers';
import { planStatements } from './describe';
import { DefinitionFields } from './object-fields';
import classes from './objects.module.css';

const editors = () => useObjectEditorStore.getState();

function statementCount(count: number): string {
  return count === 1 ? '1 statement' : `${count} statements`;
}

/** A short line on where the SQL preview stands, read out as it changes. */
function planStatus(editor: ObjectEditor): string {
  if (editor.plan_error) return editor.plan_error;
  if (editor.planning) return 'Working out the SQL…';
  const count = editor.plan ? planStatements(editor.plan).length : 0;
  return count === 0 ? 'No changes yet.' : `${statementCount(count)} to run.`;
}

function Warnings({ plan }: { plan: ChangePlan }) {
  if (plan.warnings.length === 0) return null;
  return (
    <ul className={classes.warnings}>
      {plan.warnings.map((warning) => (
        <li key={warning.title} className={classes.warning}>
          <IconAlertTriangle size={14} aria-hidden="true" className={classes.warningIcon} />
          <span>
            <strong>{warning.title}.</strong> {warning.detail}
          </span>
        </li>
      ))}
    </ul>
  );
}

function Dependents({ editor }: { editor: ObjectEditor }) {
  const dependents = editor.plan?.dependents ?? [];
  if (dependents.length === 0 && editor.mode !== 'drop') return null;
  return (
    <div className={classes.dependents}>
      {dependents.length > 0 ? (
        <>
          <p>These depend on it. The change fails while they do, unless CASCADE drops them too:</p>
          <ul className={classes.dependentList}>
            {dependents.map((dependent) => (
              <li key={dependent}>{dependent}</li>
            ))}
          </ul>
        </>
      ) : (
        <p className={classes.muted}>Nothing else depends on it.</p>
      )}
      <label className={form.check}>
        <input
          type="checkbox"
          checked={editor.options.cascade}
          onChange={(event) => editors().setOptions(editor.id, { cascade: event.currentTarget.checked })}
        />
        Drop the objects that depend on it too (CASCADE)
      </label>
    </div>
  );
}

function sqlText(statements: ReadonlyArray<string>): string {
  return statements.map((statement) => `${statement};`).join('\n\n');
}

function Preview({ editor }: { editor: ObjectEditor }) {
  const statements = editor.plan?.statements ?? [];
  const after_commit = editor.plan?.after_commit ?? [];
  return (
    <section aria-labelledby={`${editor.id}-preview`} className={classes.preview} data-stale={editor.planning}>
      <h3 id={`${editor.id}-preview`} className={classes.sectionTitle}>
        SQL to run
      </h3>
      <p role="status" className={editor.plan_error ? classes.planError : classes.muted}>
        {planStatus(editor)}
      </p>
      {statements.length > 0 && <pre className={classes.sql}>{sqlText(statements)}</pre>}
      {after_commit.length > 0 && (
        <>
          <p className={classes.muted}>Then, each on its own once that commits:</p>
          <pre className={classes.sql}>{sqlText(after_commit)}</pre>
        </>
      )}
      {editor.plan && <Warnings plan={editor.plan} />}
      <Dependents editor={editor} />
    </section>
  );
}

function Failure({ editor }: { editor: ObjectEditor }) {
  if (editor.apply_error) {
    return (
      <p role="alert" className={form.error}>
        {editor.apply_error}
      </p>
    );
  }
  const failure = editor.failure;
  if (!failure) return null;
  const number = failure.statement_index + 1;
  return (
    <div role="alert" className={form.error}>
      <p>
        {failure.committed
          ? `The change committed, but statement ${number}, after the commit, failed, and those after it didn't run: ${failure.message}`
          : `Statement ${number} failed, so nothing was changed: ${failure.message}`}
      </p>
      {failure.detail && <p>Detail: {failure.detail}</p>}
      {failure.hint && <p>Hint: {failure.hint}</p>}
    </div>
  );
}

/** The numbered statements of a review, counting on from `first`, with the one that failed marked. */
function statementList(statements: ReadonlyArray<string>, first: number, failed: number | undefined) {
  return (
    <ol start={first + 1} className={classes.statements}>
      {statements.map((statement, index) => (
        <li key={index} data-failed={failed === first + index}>
          <pre className={classes.sql}>{statement};</pre>
        </li>
      ))}
    </ol>
  );
}

function Review({ editor }: { editor: ObjectEditor }) {
  const plan = editor.plan;
  const confirm_name = confirmationName(editor);
  const verb = editor.mode === 'drop' ? 'drop' : 'apply';
  const confirmed = confirm_name === null || editor.confirm_name === confirm_name;
  const submit = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    void editors().apply(editor.id);
  };

  return (
    <form className={classes.review} onSubmit={submit}>
      <p role="status" className={classes.muted}>
        {editor.planning ? 'Working out the SQL…' : plan && `${statementCount(plan.statements.length)}, run in one transaction. If one fails, none of them is kept.`}
      </p>
      {editor.plan_error && <p className={classes.planError}>{editor.plan_error}</p>}
      {plan && statementList(plan.statements, 0, editor.failure?.statement_index)}
      {plan && plan.after_commit.length > 0 && (
        <>
          <p className={classes.muted}>Then, each on its own once the transaction commits:</p>
          {statementList(plan.after_commit, plan.statements.length, editor.failure?.statement_index)}
        </>
      )}
      {plan && <Warnings plan={plan} />}
      <Dependents editor={editor} />
      {confirm_name !== null && (
        <label className={form.field}>
          <span className={form.label}>
            This is a PROD server. Type {confirm_name} to {verb}.
          </span>
          <input
            className={`${form.input} ${form.mono}`}
            value={editor.confirm_name}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => editors().setConfirmName(editor.id, event.currentTarget.value)}
          />
        </label>
      )}
      <Failure editor={editor} />
      <div className={classes.actions}>
        <span className={form.spacer} />
        {editor.mode === 'drop' ? (
          <button type="button" className={form.button} onClick={() => editors().closeEditor(editor.id)}>
            Cancel
          </button>
        ) : (
          <button type="button" className={form.button} onClick={() => editors().backToEditing(editor.id)}>
            Back to editing
          </button>
        )}
        <button
          type="submit"
          className={`${form.button} ${editor.mode === 'drop' ? form.danger : form.primary}`}
          disabled={!canReview(editor) || !confirmed}
        >
          {editor.applying ? 'Applying…' : editor.mode === 'drop' ? 'Drop' : 'Apply'}
        </button>
      </div>
    </form>
  );
}

function CloseConfirm({ editor }: { editor: ObjectEditor }) {
  return (
    <div role="group" aria-labelledby={`${editor.id}-discard`} className={classes.closeConfirm}>
      <p id={`${editor.id}-discard`}>Your changes haven't been applied. Discard them?</p>
      <span className={form.spacer} />
      <button type="button" className={form.button} autoFocus onClick={() => editors().keepEditing(editor.id)}>
        Keep editing
      </button>
      <button type="button" className={`${form.button} ${form.danger}`} onClick={() => editors().closeEditor(editor.id)}>
        Discard
      </button>
    </div>
  );
}

function Body({ editor }: { editor: ObjectEditor }) {
  if (editor.loading) return <p className={classes.muted}>Loading…</p>;
  if (editor.load_error) {
    return (
      <div className={classes.loadError}>
        <p role="alert" className={form.error}>
          {editor.load_error}
        </p>
        <button type="button" className={form.button} onClick={() => void editors().load(editor.id)}>
          Try again
        </button>
      </div>
    );
  }
  if (editor.step === 'review') return <Review editor={editor} />;
  return (
    <div className={classes.columns}>
      <div className={classes.fields}>
        <DefinitionFields editor={editor} />
      </div>
      <Preview editor={editor} />
    </div>
  );
}

function Header({ editor, title_id }: { editor: ObjectEditor; title_id: string }) {
  const environment = useServerStore((state) => state.servers.find((server) => server.id === editor.server_id)?.environment);
  const ready = !editor.loading && !editor.load_error;
  const editing = editor.step === 'edit' && editor.mode !== 'drop';

  return (
    <header className={classes.header}>
      <h2 id={title_id} className={classes.title}>
        {editorTitle(editor)}
      </h2>
      {environment && (
        <span className={form.badge} data-environment={environment}>
          {environmentLabel(environment)}
        </span>
      )}
      <span className={form.spacer} />
      {editor.host === 'dialog' && editor.mode !== 'drop' && (
        <button
          type="button"
          className={form.button}
          onClick={() => {
            editors().openInTab(editor.id);
            requestAnimationFrame(() => document.getElementById(`${editor.id}-tab`)?.focus());
          }}
        >
          Open in tab
        </button>
      )}
      {editing && ready && (
        <>
          <button type="button" className={form.button} disabled={!canReview(editor)} onClick={() => editors().copyToTab(editor.id)}>
            Copy to tab
          </button>
          <button type="button" className={`${form.button} ${form.primary}`} disabled={!canReview(editor)} onClick={() => editors().review(editor.id)}>
            Review and apply
          </button>
        </>
      )}
      {editor.host === 'dialog' && (
        <button type="button" aria-label="Close" title="Close (Esc)" className={form.iconButton} onClick={() => editors().requestClose(editor.id)}>
          <IconX size={16} aria-hidden="true" />
        </button>
      )}
    </header>
  );
}

/** An object's editor, the same in a dialog or a tab: its fields, the SQL they need, then a review before it runs. */
export function ObjectEditorView({ model }: { model: { editor_id: string; title_id: string } }) {
  const editor = useObjectEditorStore((state) => state.editors[model.editor_id]) as ObjectEditor;

  return (
    <div className={classes.editor} data-host={editor.host} data-type={editor.object_type}>
      <Header editor={editor} title_id={model.title_id} />
      {editor.confirming_close && <CloseConfirm editor={editor} />}
      <Body editor={editor} />
    </div>
  );
}

/** The editor in a modal dialog. Escape asks before discarding changes, as closing its tab does. */
export function ObjectEditorDialog({ editor_id }: { editor_id: string }) {
  const title_id = `${editor_id}-title`;
  const show = (element: HTMLDialogElement | null) => {
    if (element && !element.open) element.showModal();
  };
  const cancel = (event: SyntheticEvent<HTMLDialogElement>) => {
    event.preventDefault();
    editors().requestClose(editor_id);
  };

  return (
    <dialog ref={show} aria-labelledby={title_id} className={`${form.modal} ${classes.dialog}`} onCancel={cancel}>
      <ObjectEditorView model={{ editor_id, title_id }} />
    </dialog>
  );
}
