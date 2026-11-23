import type { KeyboardEvent, PointerEvent } from 'react';
import { clampResultsHeight, results_heights, useWorkspaceStore } from '../store/workspace';
import { parentOf } from '../utils/dom';
import classes from './query.module.css';

const KEY_STEP = 16;

let drag: { start_y: number; start_height: number } | null = null;

function startDrag(event: PointerEvent<HTMLDivElement>): void {
  const results = parentOf(event.currentTarget);
  event.currentTarget.setPointerCapture(event.pointerId);
  drag = { start_y: event.clientY, start_height: results.getBoundingClientRect().height };
}

/** Resizes the results panel directly while dragging, so nothing re-renders until the drag ends. Dragging up makes it taller. */
function moveDrag(event: PointerEvent<HTMLDivElement>): void {
  if (!drag) return;
  const results = parentOf(event.currentTarget);
  const height = clampResultsHeight(drag.start_height - (event.clientY - drag.start_y));
  results.style.height = `${height}px`;
  event.currentTarget.setAttribute('aria-valuenow', String(height));
}

function endDrag(event: PointerEvent<HTMLDivElement>): void {
  if (!drag) return;
  const results = parentOf(event.currentTarget);
  drag = null;
  event.currentTarget.releasePointerCapture(event.pointerId);
  useWorkspaceStore.getState().setResultsHeight(results.getBoundingClientRect().height);
}

function resizeWithKeys(event: KeyboardEvent<HTMLDivElement>): void {
  const workspace = useWorkspaceStore.getState();
  const targets: Record<string, number> = {
    ArrowUp: workspace.results_height + KEY_STEP,
    ArrowDown: workspace.results_height - KEY_STEP,
    Home: results_heights.max,
    End: results_heights.min,
  };
  const target = targets[event.key];
  if (target === undefined) return;
  event.preventDefault();
  workspace.setResultsHeight(target);
}

export function ResultsResizer() {
  const height = useWorkspaceStore((state) => state.results_height);

  return (
    <div
      role="separator"
      aria-orientation="horizontal"
      aria-label="Results height"
      aria-valuemin={results_heights.min}
      aria-valuemax={results_heights.max}
      aria-valuenow={height}
      tabIndex={0}
      className={classes.resizer}
      onPointerDown={startDrag}
      onPointerMove={moveDrag}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onKeyDown={resizeWithKeys}
      onDoubleClick={() => useWorkspaceStore.getState().setResultsHeight(results_heights.initial)}
    />
  );
}
