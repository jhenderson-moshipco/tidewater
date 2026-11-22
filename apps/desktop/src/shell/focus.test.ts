import { afterEach, describe, expect, it } from 'vitest';
import { restoreFocusIfLost } from './focus';

const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));

function focusable(id: string): HTMLElement {
  const element = document.createElement('h2');
  element.id = id;
  element.tabIndex = -1;
  document.body.append(element);
  return element;
}

describe('restoreFocusIfLost', () => {
  afterEach(() => document.body.replaceChildren());

  it('leaves focus alone when it is still on the page', async () => {
    focusable('sidebar-title');
    const button = document.createElement('button');
    document.body.append(button);
    button.focus();

    restoreFocusIfLost();
    await nextFrame();

    expect(document.activeElement).toBe(button);
  });

  it('moves lost focus to the sidebar heading, or the main area when the sidebar is closed', async () => {
    const main = focusable('workspace-main');
    const heading = focusable('sidebar-title');

    restoreFocusIfLost();
    await nextFrame();
    expect(document.activeElement).toBe(heading);

    heading.remove();
    restoreFocusIfLost();
    await nextFrame();
    expect(document.activeElement).toBe(main);
  });

  it('does nothing when neither target is on the page', async () => {
    restoreFocusIfLost();
    await nextFrame();
    expect(document.activeElement).toBe(document.body);
  });
});
