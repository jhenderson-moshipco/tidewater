import type { ParsedConnection, ProbeStep, StepOutcome } from '../generated/connections';
import type { Environment, PasswordChange, ServerInput, ServerSummary, TlsMode } from '../generated/servers';
import type { ConnectionDraft } from '../store/dialogs';
import { fieldText } from '../utils/forms';

export const environments: ReadonlyArray<{ value: Environment; label: string }> = [
  { value: 'dev', label: 'DEV' },
  { value: 'staging', label: 'STAGING' },
  { value: 'prod', label: 'PROD' },
  { value: 'local', label: 'LOCAL' },
];

export const tls_modes: ReadonlyArray<{ value: TlsMode; label: string }> = [
  { value: 'disable', label: 'Disable' },
  { value: 'prefer', label: 'Prefer' },
  { value: 'require', label: 'Require' },
  { value: 'verify-ca', label: 'Verify CA' },
  { value: 'verify-full', label: 'Verify full' },
];

export const probe_step_labels: Readonly<Record<ProbeStep, string>> = {
  dns: 'DNS',
  tcp: 'TCP',
  tls: 'TLS',
  auth: 'Sign-in',
  database: 'Database',
};

export const outcome_labels: Readonly<Record<StepOutcome, string>> = {
  passed: 'passed',
  failed: 'failed',
  skipped: 'skipped',
};

/** Matches the Rust core's default for a new server. */
export const default_results_timeout_ms = 5 * 60 * 1000;

export function environmentLabel(environment: Environment): string {
  return environments.find((option) => option.value === environment)?.label ?? environment;
}

function pick<T extends string>(value: string, options: ReadonlyArray<{ value: T }>, fallback: T): T {
  return options.find((option) => option.value === value)?.value ?? fallback;
}

function wholeNumber(value: string): number | '' {
  if (value.trim() === '') return '';
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : '';
}

/** Reads the form's current values, so a pasted URL can be merged without losing what was typed. */
export function readDraft(form: HTMLFormElement): ConnectionDraft {
  const data = new FormData(form);
  const text = (name: string) => fieldText(data, name);
  return {
    url: text('url'),
    name: text('name'),
    group_id: text('group_id'),
    environment: pick(text('environment'), environments, 'dev'),
    host: text('host'),
    port: wholeNumber(text('port')),
    database: text('database'),
    user: text('user'),
    password: text('password'),
    tls: pick(text('tls'), tls_modes, 'prefer'),
    read_only: data.get('read_only') === 'on',
    statement_timeout_s: wholeNumber(text('statement_timeout_s')),
    results_timeout_min: wholeNumber(text('results_timeout_min')),
  };
}

function setField(form: HTMLFormElement, name: string, value: string | number | null): boolean {
  const field = form.elements.namedItem(name);
  if (value === null || !(field instanceof HTMLInputElement || field instanceof HTMLSelectElement)) return false;
  field.value = String(value);
  return true;
}

/** Writes a parsed connection string into the open form's fields and returns the labels of the fields it filled. */
export function applyParsed(form: HTMLFormElement, parsed: ParsedConnection): Array<string> {
  const filled: Array<string> = [];
  if (setField(form, 'host', parsed.host)) filled.push('host');
  if (setField(form, 'port', parsed.port)) filled.push('port');
  if (setField(form, 'database', parsed.database)) filled.push('database');
  if (setField(form, 'user', parsed.user)) filled.push('user');
  if (setField(form, 'password', parsed.password)) filled.push('password');
  if (setField(form, 'tls', parsed.tls)) filled.push('TLS');
  const draft = readDraft(form);
  if (draft.name.trim() === '' && setField(form, 'name', `${draft.database}@${draft.host}`)) filled.push('name');
  return filled;
}

export function listOf(words: Array<string>): string {
  if (words.length <= 1) return words.join('');
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

/** Builds the save or test request. A blank password keeps the saved one unless "clear" is ticked. */
export function readConnectionForm(form: HTMLFormElement, editing: ServerSummary | null): ServerInput {
  const draft = readDraft(form);
  const clear_password = new FormData(form).get('clear_password') === 'on';
  let password: PasswordChange = { action: 'clear' };
  if (draft.password !== '') password = { action: 'set', value: draft.password };
  else if (editing && !clear_password) password = { action: 'keep' };

  return {
    id: editing?.id ?? null,
    name: draft.name.trim(),
    group_id: draft.group_id === '' ? null : draft.group_id,
    environment: draft.environment,
    host: draft.host.trim(),
    port: draft.port === '' ? 0 : Math.trunc(draft.port),
    database: draft.database.trim(),
    user: draft.user.trim(),
    password,
    tls: draft.tls,
    session: {
      read_only: draft.read_only,
      statement_timeout_ms: draft.statement_timeout_s === '' ? null : Math.round(draft.statement_timeout_s * 1000),
      results_timeout_ms: draft.results_timeout_min === '' ? default_results_timeout_ms : Math.round(draft.results_timeout_min * 60_000),
    },
  };
}
