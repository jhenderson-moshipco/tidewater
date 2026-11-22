import { describe, expect, it } from 'vitest';
import { fieldText, formOf, inputOf } from './forms';

function formWith(html: string): HTMLFormElement {
  const form = document.createElement('form');
  form.innerHTML = html;
  document.body.append(form);
  return form;
}

describe('form helpers', () => {
  it('find the form around a control and the inputs inside it', () => {
    const form = formWith('<input name="host" value="db.internal"><button>Test</button>');
    expect(formOf(form.querySelector('button') as HTMLButtonElement)).toBe(form);
    expect(inputOf(form, 'host').value).toBe('db.internal');
  });

  it('throw when the markup is missing the form or the input', () => {
    const form = formWith('<select name="tls"></select>');
    expect(() => formOf(document.createElement('input'))).toThrow('The control is not inside a form');
    expect(() => inputOf(form, 'tls')).toThrow('The form has no tls input');
    expect(() => inputOf(form, 'host')).toThrow('The form has no host input');
  });

  it('read submitted text, treating a missing field as empty', () => {
    const data = new FormData(formWith('<input name="name" value="orders-dev">'));
    expect(fieldText(data, 'name')).toBe('orders-dev');
    expect(fieldText(data, 'missing')).toBe('');
  });
});
