import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useWorkspaceStore } from '../store/workspace';
import { renderWithUser } from '../testing/render';
import { ResultsPanel } from './results-panel';

const height = () => useWorkspaceStore.getState().results_height;

function renderResults() {
  const rendered = renderWithUser(<ResultsPanel tab_id="none" />);
  const handle = screen.getByRole('separator', { name: 'Results height' });
  const section = screen.getByRole('region', { name: 'Results' });
  vi.spyOn(section, 'getBoundingClientRect').mockImplementation(() => new DOMRect(0, 0, 800, Number.parseFloat(section.style.height)));
  return { ...rendered, handle, section };
}

describe('the results resizer', () => {
  it('makes the results taller with Up and shorter with Down, Home and End go to the limits, and other keys do nothing', async () => {
    const { user, handle, section } = renderResults();
    handle.focus();

    await user.keyboard('{ArrowUp}');
    expect([height(), handle.getAttribute('aria-valuenow'), section.style.height]).toEqual([336, '336', '336px']);
    await user.keyboard('{ArrowDown}{ArrowDown}');
    expect(height()).toBe(304);
    await user.keyboard('{Home}');
    expect(height()).toBe(800);
    await user.keyboard('{End}');
    expect(height()).toBe(120);
    await user.keyboard('a');
    expect(height()).toBe(120);
  });

  it('resets on double-click', async () => {
    useWorkspaceStore.setState({ results_height: 600 });
    const { user, handle } = renderResults();
    await user.dblClick(handle);
    expect(height()).toBe(320);
  });

  it('follows a drag without re-rendering, taller when dragged up, then saves the height it ended at', () => {
    const { handle, section } = renderResults();

    fireEvent.pointerMove(handle, { clientY: 100, pointerId: 1 });
    fireEvent.pointerUp(handle, { pointerId: 1 });
    expect(section.style.height).toBe('320px');

    fireEvent.pointerDown(handle, { clientY: 500, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientY: 450, pointerId: 1 });
    expect([section.style.height, handle.getAttribute('aria-valuenow'), height()]).toEqual(['370px', '370', 320]);
    fireEvent.pointerMove(handle, { clientY: 2000, pointerId: 1 });
    expect(section.style.height).toBe('120px');
    fireEvent.pointerCancel(handle, { pointerId: 1 });

    expect(height()).toBe(120);
  });
});
