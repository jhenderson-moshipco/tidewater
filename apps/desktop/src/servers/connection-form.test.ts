import { describe, expect, it } from 'vitest';
import type { Environment } from '../generated/servers';
import { server } from '../testing/backend';
import { applyParsed, environmentLabel, listOf, readConnectionForm, readDraft } from './connection-form';

function formWith(html: string): HTMLFormElement {
  const form = document.createElement('form');
  form.innerHTML = html;
  document.body.append(form);
  return form;
}

const all_fields = `
  <input name="url"><input name="name"><select name="group_id"><option value=""></option><option value="orders">Orders</option></select>
  <input name="environment" type="radio" value="dev" checked><input name="environment" type="radio" value="prod">
  <input name="host" value="localhost"><input name="port" value="5432"><input name="database" value="postgres">
  <input name="user" value="postgres"><input name="password" type="password">
  <select name="tls"><option value="prefer" selected>Prefer</option><option value="require">Require</option></select>
  <input name="clear_password" type="checkbox"><input name="read_only" type="checkbox"><input name="statement_timeout_s">
`;

function field(form: HTMLFormElement, name: string): HTMLInputElement | HTMLSelectElement {
  return form.elements.namedItem(name) as HTMLInputElement | HTMLSelectElement;
}

describe('environmentLabel', () => {
  it('shows the badge text, falling back to the raw value', () => {
    expect(environmentLabel('prod')).toBe('PROD');
    expect(environmentLabel('qa' as Environment)).toBe('qa');
  });
});

describe('readDraft', () => {
  it('uses the defaults for fields the form leaves out or values it does not know', () => {
    const draft = readDraft(formWith('<input name="environment" value="qa"><input name="port" value="not a port">'));
    expect(draft).toEqual({
      url: '',
      name: '',
      group_id: '',
      environment: 'dev',
      host: '',
      port: '',
      database: '',
      user: '',
      password: '',
      tls: 'prefer',
      read_only: false,
      statement_timeout_s: '',
    });
  });
});

describe('applyParsed', () => {
  it('fills the fields the connection string set and names the server after its database and host', () => {
    const form = formWith(all_fields);

    const filled = applyParsed(form, { host: 'db.internal', port: 6432, database: 'orders', user: 'app', password: 's3cret', tls: 'require' });

    expect(filled).toEqual(['host', 'port', 'database', 'user', 'password', 'TLS', 'name']);
    expect(['host', 'port', 'tls', 'name'].map((name) => field(form, name).value)).toEqual(['db.internal', '6432', 'require', 'orders@db.internal']);
  });

  it('keeps a name the user typed and skips values the string left out', () => {
    const form = formWith(all_fields);
    field(form, 'name').value = 'orders-prod';

    expect(applyParsed(form, { host: 'db.internal', port: null, database: null, user: null, password: null, tls: null })).toEqual(['host']);
    expect([field(form, 'name').value, field(form, 'port').value]).toEqual(['orders-prod', '5432']);
  });

  it('skips fields the form does not have', () => {
    const form = formWith('<input name="host">');
    expect(applyParsed(form, { host: 'db.internal', port: 6432, database: null, user: null, password: null, tls: null })).toEqual(['host']);
  });
});

describe('listOf', () => {
  it('joins words the way a sentence lists them', () => {
    expect(listOf([])).toBe('');
    expect(listOf(['host'])).toBe('host');
    expect(listOf(['host', 'port'])).toBe('host and port');
    expect(listOf(['host', 'port', 'user'])).toBe('host, port and user');
  });
});

describe('readConnectionForm', () => {
  it('trims text, keeps the port whole and sends the timeout in milliseconds', () => {
    const form = formWith(all_fields);
    field(form, 'name').value = '  orders-dev ';
    field(form, 'group_id').value = 'orders';
    field(form, 'port').value = '6432.9';
    field(form, 'statement_timeout_s').value = '1.5';
    (field(form, 'read_only') as HTMLInputElement).checked = true;

    expect(readConnectionForm(form, null)).toEqual({
      id: null,
      name: 'orders-dev',
      group_id: 'orders',
      environment: 'dev',
      host: 'localhost',
      port: 6432,
      database: 'postgres',
      user: 'postgres',
      password: { action: 'clear' },
      tls: 'prefer',
      session: { read_only: true, statement_timeout_ms: 1500, results_timeout_ms: 300_000 },
    });
  });

  it("keeps an edited server's results timeout, which has no field in the form", () => {
    const form = formWith(all_fields);
    const editing = server({ session: { read_only: false, statement_timeout_ms: null, results_timeout_ms: 60_000 } });
    expect(readConnectionForm(form, editing).session.results_timeout_ms).toBe(60_000);
  });

  it('sends port 0 for an empty port, so the Rust core rejects it', () => {
    const form = formWith(all_fields);
    field(form, 'port').value = '';
    expect(readConnectionForm(form, null).port).toBe(0);
  });

  it('sets a typed password, keeps a blank one when editing, and clears it when asked', () => {
    const form = formWith(all_fields);
    const editing = server({ has_password: true });
    expect(readConnectionForm(form, editing).password).toEqual({ action: 'keep' });
    expect(readConnectionForm(form, editing).id).toBe('orders-dev');

    (field(form, 'clear_password') as HTMLInputElement).checked = true;
    expect(readConnectionForm(form, editing).password).toEqual({ action: 'clear' });

    field(form, 'password').value = 'n3w';
    expect(readConnectionForm(form, editing).password).toEqual({ action: 'set', value: 'n3w' });
  });
});
