/** The form that holds `control`. Throws when the control is outside a form, which is a bug in the markup. */
export function formOf(control: HTMLInputElement | HTMLButtonElement): HTMLFormElement {
  if (!control.form) throw new Error('The control is not inside a form');
  return control.form;
}

/** The form's input named `name`. Throws when there is none, which is a bug in the markup. */
export function inputOf(form: HTMLFormElement, name: string): HTMLInputElement {
  const field = form.elements.namedItem(name);
  if (!(field instanceof HTMLInputElement)) throw new Error(`The form has no ${name} input`);
  return field;
}

/** The text a form submitted for `name`, or an empty string when it sent nothing. */
export function fieldText(data: FormData, name: string): string {
  return String(data.get(name) ?? '');
}
