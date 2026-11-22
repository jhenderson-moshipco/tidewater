import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useWorkspaceStore } from '../store/workspace';
import { renderWithUser } from '../testing/render';
import { Sidebar } from './sidebar';

const width = () => useWorkspaceStore.getState().sidebar_width;

function renderSidebar() {
  const rendered = renderWithUser(<Sidebar />);
  const handle = screen.getByRole('separator', { name: 'Sidebar width' });
  const aside = screen.getByRole('complementary');
  vi.spyOn(aside, 'getBoundingClientRect').mockImplementation(() => new DOMRect(0, 0, Number.parseFloat(aside.style.width), 600));
  return { ...rendered, handle, aside };
}

describe('the sidebar resizer', () => {
  it('resizes with the arrow keys, Home and End, and ignores other keys', async () => {
    const { user, handle, aside } = renderSidebar();
    handle.focus();

    await user.keyboard('{ArrowRight}');
    expect([width(), handle.getAttribute('aria-valuenow'), aside.style.width]).toEqual([288, '288', '288px']);
    await user.keyboard('{ArrowLeft}{ArrowLeft}');
    expect(width()).toBe(256);
    await user.keyboard('{End}');
    expect(width()).toBe(640);
    await user.keyboard('{Home}');
    expect(width()).toBe(200);
    await user.keyboard('a');
    expect(width()).toBe(200);
  });

  it('resets on double-click', async () => {
    useWorkspaceStore.setState({ sidebar_width: 500 });
    const { user, handle } = renderSidebar();
    await user.dblClick(handle);
    expect(width()).toBe(272);
  });

  it('follows a drag without re-rendering, then saves the width it ended at', () => {
    const { handle, aside } = renderSidebar();

    fireEvent.pointerMove(handle, { clientX: 400, pointerId: 1 });
    fireEvent.pointerUp(handle, { pointerId: 1 });
    expect(aside.style.width).toBe('272px');

    fireEvent.pointerDown(handle, { clientX: 100, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 150, pointerId: 1 });
    expect([aside.style.width, handle.getAttribute('aria-valuenow'), width()]).toEqual(['322px', '322', 272]);
    fireEvent.pointerMove(handle, { clientX: 2000, pointerId: 1 });
    expect(aside.style.width).toBe('640px');
    fireEvent.pointerCancel(handle, { pointerId: 1 });

    expect(width()).toBe(640);
  });
});
