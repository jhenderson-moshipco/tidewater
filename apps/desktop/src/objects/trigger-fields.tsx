import { IconX } from '@tabler/icons-react';
import type { ObjectExtras, TriggerDefinition, TriggerEvent, TriggerTiming } from '../generated/objects';
import form from '../servers/servers.module.css';
import type { ObjectEditor } from '../store/object-editors';
import { replaced, updateExtras, without } from './fields';
import classes from './objects.module.css';

const new_function = '(new function)';

const timings: ReadonlyArray<{ value: TriggerTiming; label: string }> = [
  { value: 'before', label: 'BEFORE' },
  { value: 'after', label: 'AFTER' },
  { value: 'instead_of', label: 'INSTEAD OF' },
];

const all_events: ReadonlyArray<{ value: TriggerEvent; label: string }> = [
  { value: 'insert', label: 'INSERT' },
  { value: 'update', label: 'UPDATE' },
  { value: 'delete', label: 'DELETE' },
  { value: 'truncate', label: 'TRUNCATE' },
];

function setTrigger(editor_id: string, index: number, change: Partial<TriggerDefinition>): void {
  updateExtras(editor_id, (extras) => ({ ...extras, triggers: replaced(extras.triggers, index, { ...(extras.triggers[index] as TriggerDefinition), ...change }) }));
}

type CardModel = { editor_id: string; trigger: TriggerDefinition; index: number; on_view: boolean; functions: ReadonlyArray<string> };

function FunctionFields({ model }: { model: CardModel }) {
  const { editor_id, trigger, index } = model;
  const functions = model.functions.includes(trigger.function) || trigger.new_function ? model.functions : [trigger.function, ...model.functions];
  return (
    <>
      <label className={`${form.field} ${form.span3}`}>
        <span className={form.label}>Function</span>
        <select
          className={form.input}
          value={trigger.new_function ? new_function : trigger.function}
          onChange={(event) => {
            const value = event.currentTarget.value;
            setTrigger(editor_id, index, value === new_function ? { new_function: true, function: '' } : { new_function: false, function: value });
          }}
        >
          {functions.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
          <option value={new_function}>Write a new function</option>
        </select>
      </label>
      <label className={`${form.field} ${form.span3}`}>
        <span className={form.label}>Arguments</span>
        <input
          className={`${form.input} ${form.mono}`}
          value={trigger.arguments}
          spellCheck={false}
          onChange={(event) => setTrigger(editor_id, index, { arguments: event.currentTarget.value })}
        />
      </label>
      {trigger.new_function && (
        <>
          <label className={`${form.field} ${form.span6}`}>
            <span className={form.label}>New function's name</span>
            <input
              className={`${form.input} ${form.mono}`}
              value={trigger.function}
              placeholder="public.touch_updated_at"
              spellCheck={false}
              onChange={(event) => setTrigger(editor_id, index, { function: event.currentTarget.value })}
            />
          </label>
          <label className={`${form.field} ${form.span6}`}>
            <span className={form.label}>New function's body, in PL/pgSQL</span>
            <textarea
              className={`${form.input} ${form.mono} ${classes.body}`}
              value={trigger.body}
              rows={8}
              spellCheck={false}
              onChange={(event) => setTrigger(editor_id, index, { body: event.currentTarget.value })}
            />
          </label>
        </>
      )}
    </>
  );
}

function TriggerCard({ model }: { model: CardModel }) {
  const { editor_id, trigger, index, on_view } = model;
  const label = trigger.name || `trigger ${index + 1}`;
  const events = on_view ? all_events.filter((event) => event.value !== 'truncate') : all_events;
  const heading = `${editor_id}-trigger-${index}`;

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
          onClick={() => updateExtras(editor_id, (extras) => ({ ...extras, triggers: without(extras.triggers, index) }))}
        >
          <IconX size={14} aria-hidden="true" />
        </button>
      </div>
      <div className={form.grid}>
        <label className={`${form.field} ${form.span2}`}>
          <span className={form.label}>Name</span>
          <input
            className={`${form.input} ${form.mono}`}
            value={trigger.name}
            spellCheck={false}
            onChange={(event) => setTrigger(editor_id, index, { name: event.currentTarget.value })}
          />
        </label>
        <label className={`${form.field} ${form.span2}`}>
          <span className={form.label}>Fires</span>
          <select className={form.input} value={trigger.timing} onChange={(event) => setTrigger(editor_id, index, { timing: event.currentTarget.value as TriggerTiming })}>
            {timings.map((timing) => (
              <option key={timing.value} value={timing.value}>
                {timing.label}
              </option>
            ))}
          </select>
        </label>
        <label className={`${form.field} ${form.span2}`}>
          <span className={form.label}>Once per</span>
          <select
            className={form.input}
            value={trigger.for_each_row ? 'row' : 'statement'}
            onChange={(event) => setTrigger(editor_id, index, { for_each_row: event.currentTarget.value === 'row' })}
          >
            <option value="row">Row</option>
            <option value="statement">Statement</option>
          </select>
        </label>
        <fieldset className={`${form.fieldset} ${form.span6}`}>
          <legend>Events</legend>
          {events.map((event) => (
            <label key={event.value} className={form.choice}>
              <input
                type="checkbox"
                checked={trigger.events.includes(event.value)}
                onChange={(change) =>
                  setTrigger(editor_id, index, {
                    events: change.currentTarget.checked ? [...trigger.events, event.value] : trigger.events.filter((value) => value !== event.value),
                  })
                }
              />
              {event.label}
            </label>
          ))}
        </fieldset>
        {!on_view && trigger.events.includes('update') && (
          <label className={`${form.field} ${form.span6}`}>
            <span className={form.label}>Only when UPDATE sets these columns</span>
            <input
              className={`${form.input} ${form.mono}`}
              value={trigger.update_columns.join(',')}
              placeholder="Any column"
              spellCheck={false}
              onChange={(event) => setTrigger(editor_id, index, { update_columns: event.currentTarget.value.split(',') })}
            />
          </label>
        )}
        <label className={`${form.field} ${form.span6}`}>
          <span className={form.label}>When</span>
          <input
            className={`${form.input} ${form.mono}`}
            value={trigger.when}
            placeholder="NEW.total IS DISTINCT FROM OLD.total"
            spellCheck={false}
            onChange={(event) => setTrigger(editor_id, index, { when: event.currentTarget.value })}
          />
        </label>
        <FunctionFields model={model} />
        {!on_view && (
          <label className={`${form.check} ${form.span6}`}>
            <input type="checkbox" checked={trigger.enabled} onChange={(event) => setTrigger(editor_id, index, { enabled: event.currentTarget.checked })} />
            Enabled
          </label>
        )}
      </div>
    </div>
  );
}

/** A table's or view's triggers, each calling a trigger function that exists or one written here. */
export function TriggerFields({ editor }: { editor: ObjectEditor }) {
  const extras = editor.extras as ObjectExtras;
  const on_view = editor.object_type === 'view';
  const functions = editor.trigger_functions;

  return (
    <>
      {extras.triggers.length === 0 && <p className={classes.muted}>No triggers.</p>}
      {extras.triggers.map((trigger, index) => (
        <TriggerCard key={trigger.original_name ?? `new-${index}`} model={{ editor_id: editor.id, trigger, index, on_view, functions }} />
      ))}
      <button
        type="button"
        className={`${form.button} ${classes.addButton}`}
        onClick={() =>
          updateExtras(editor.id, (current) => ({
            ...current,
            triggers: [
              ...current.triggers,
              {
                original_name: null,
                name: '',
                timing: on_view ? 'instead_of' : 'before',
                events: ['insert'],
                update_columns: [],
                for_each_row: true,
                when: '',
                function: functions[0] ?? '',
                arguments: '',
                new_function: functions.length === 0,
                body: 'BEGIN\n  RETURN NEW;\nEND',
                enabled: true,
              },
            ],
          }))
        }
      >
        Add trigger
      </button>
    </>
  );
}
