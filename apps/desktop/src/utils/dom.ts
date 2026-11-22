/** The element that contains `element`. Throws when it has none, which is a bug in the markup. */
export function parentOf(element: HTMLElement): HTMLElement {
  if (!element.parentElement) throw new Error('The element is not inside another element');
  return element.parentElement;
}
