import type { KeyboardEvent, PointerEvent } from 'react';
import { clampSidebarWidth, sidebar_widths, useWorkspaceStore } from '../store/workspace';
import { parentOf } from '../utils/dom';
import classes from './shell.module.css';

const KEY_STEP = 16;

let drag: { start_x: number; start_width: number } | null = null;

function startDrag(event: PointerEvent<HTMLDivElement>): void {
  const sidebar = parentOf(event.currentTarget);
  event.currentTarget.setPointerCapture(event.pointerId);
  drag = { start_x: event.clientX, start_width: sidebar.getBoundingClientRect().width };
}

/** Resizes the sidebar element directly while dragging, so nothing re-renders until the drag ends. */
function moveDrag(event: PointerEvent<HTMLDivElement>): void {
  if (!drag) return;
  const sidebar = parentOf(event.currentTarget);
  const width = clampSidebarWidth(drag.start_width + event.clientX - drag.start_x);
  sidebar.style.width = `${width}px`;
  event.currentTarget.setAttribute('aria-valuenow', String(width));
}

function endDrag(event: PointerEvent<HTMLDivElement>): void {
  if (!drag) return;
  const sidebar = parentOf(event.currentTarget);
  drag = null;
  event.currentTarget.releasePointerCapture(event.pointerId);
  useWorkspaceStore.getState().setSidebarWidth(sidebar.getBoundingClientRect().width);
}

function resizeWithKeys(event: KeyboardEvent<HTMLDivElement>): void {
  const workspace = useWorkspaceStore.getState();
  const targets: Record<string, number> = {
    ArrowLeft: workspace.sidebar_width - KEY_STEP,
    ArrowRight: workspace.sidebar_width + KEY_STEP,
    Home: sidebar_widths.min,
    End: sidebar_widths.max,
  };
  const target = targets[event.key];
  if (target === undefined) return;
  event.preventDefault();
  workspace.setSidebarWidth(target);
}

export function SidebarResizer() {
  const width = useWorkspaceStore((state) => state.sidebar_width);

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Sidebar width"
      aria-valuemin={sidebar_widths.min}
      aria-valuemax={sidebar_widths.max}
      aria-valuenow={width}
      tabIndex={0}
      className={classes.resizer}
      onPointerDown={startDrag}
      onPointerMove={moveDrag}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onKeyDown={resizeWithKeys}
      onDoubleClick={() => useWorkspaceStore.getState().setSidebarWidth(sidebar_widths.initial)}
    />
  );
}
