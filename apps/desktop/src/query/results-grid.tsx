import { useId, useState, type KeyboardEvent, type UIEvent } from 'react';
import type { ResultColumn } from '../generated/query';

type Cell = string | null;
import classes from './query.module.css';

export const row_height = 24;
const overscan = 10;
/** Rows assumed to fit before the grid has been measured, as in a test DOM without layout. */
const fallback_rows = 30;

export type GridModel = {
  label: string;
  columns: ReadonlyArray<ResultColumn>;
  rows: ReadonlyArray<ReadonlyArray<Cell>>;
};

type Position = { row: number; column: number };

/** Each column's width in `ch`: wide enough for its name, type and longest early value, capped so one column can't fill the grid. */
export function columnWidths(columns: ReadonlyArray<ResultColumn>, rows: ReadonlyArray<ReadonlyArray<Cell>>): Array<number> {
  const sample = rows.slice(0, 200);
  return columns.map((column, index) => {
    const header = column.name.length + column.type_name.length + 1;
    const longest = Math.max(0, ...sample.map((row) => (row[index] ?? 'NULL').length));
    return Math.min(48, Math.max(6, header, longest) + 2);
  });
}

/** Where the active cell moves for a key, or `null` when the grid doesn't handle that key. */
export function nextPosition(key: string, ctrl: boolean, at: Position, size: { rows: number; columns: number; page: number }): Position | null {
  const last_row = size.rows - 1;
  const clamp = (row: number) => Math.min(last_row, Math.max(0, row));
  switch (key) {
    case 'ArrowDown':
      return { ...at, row: clamp(at.row + 1) };
    case 'ArrowUp':
      return { ...at, row: clamp(at.row - 1) };
    case 'ArrowRight':
      return { ...at, column: Math.min(size.columns - 1, at.column + 1) };
    case 'ArrowLeft':
      return { ...at, column: Math.max(0, at.column - 1) };
    case 'PageDown':
      return { ...at, row: clamp(at.row + size.page) };
    case 'PageUp':
      return { ...at, row: clamp(at.row - size.page) };
    case 'Home':
      return ctrl ? { row: 0, column: 0 } : { ...at, column: 0 };
    case 'End':
      return ctrl ? { row: last_row, column: size.columns - 1 } : { ...at, column: size.columns - 1 };
    default:
      return null;
  }
}

/**
 * A WAI-ARIA grid that renders only the rows in view. The grid is one tab stop; arrow keys, Page Up, Page Down,
 * Home and End move the active cell, announced through `aria-activedescendant`.
 */
export function ResultsGrid({ model }: { model: GridModel }) {
  const id = useId();
  const [view, setView] = useState({ top: 0, height: fallback_rows * row_height });
  const [active, setActive] = useState<Position>({ row: 0, column: 0 });
  const widths = columnWidths(model.columns, model.rows);
  const template = widths.map((width) => `${width}ch`).join(' ');
  const first = Math.max(0, Math.floor(view.top / row_height) - overscan);
  const end = Math.min(model.rows.length, Math.ceil((view.top + view.height) / row_height) + overscan);
  const cellId = (at: Position) => `${id}-${at.row}-${at.column}`;
  const page = Math.max(1, Math.floor(view.height / row_height) - 1);

  const scrolled = (event: UIEvent<HTMLDivElement>) => {
    const element = event.currentTarget;
    setView({ top: element.scrollTop, height: element.clientHeight || view.height });
  };

  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const size = { rows: model.rows.length, columns: model.columns.length, page };
    const next = nextPosition(event.key, event.ctrlKey || event.metaKey, active, size);
    if (!next) return;
    event.preventDefault();
    setActive(next);
    const element = event.currentTarget;
    const row_top = (next.row + 1) * row_height;
    let top = element.scrollTop;
    if (row_top < top + row_height) top = row_top - row_height;
    if (row_top + row_height > top + view.height) top = row_top + row_height - view.height;
    element.scrollTop = top;
    setView({ top, height: view.height });
  };

  return (
    <div
      role="grid"
      aria-label={model.label}
      aria-rowcount={model.rows.length + 1}
      aria-colcount={model.columns.length}
      aria-activedescendant={model.rows.length > 0 ? cellId(active) : undefined}
      tabIndex={0}
      className={classes.grid}
      onScroll={scrolled}
      onKeyDown={keyDown}
    >
      <div role="row" aria-rowindex={1} className={classes.gridHeader} style={{ gridTemplateColumns: template }}>
        {model.columns.map((column, index) => (
          <div key={index} role="columnheader" aria-colindex={index + 1} className={classes.gridHeaderCell}>
            {column.name} <span className={classes.columnType}>{column.type_name}</span>
          </div>
        ))}
      </div>
      <div className={classes.gridBody} style={{ height: model.rows.length * row_height }}>
        {model.rows.slice(first, end).map((row, offset) => {
          const row_index = first + offset;
          return (
            <div
              key={row_index}
              role="row"
              aria-rowindex={row_index + 2}
              className={classes.gridRow}
              style={{ gridTemplateColumns: template, transform: `translateY(${row_index * row_height}px)` }}
            >
              {row.map((cell, column) => {
                const at = { row: row_index, column };
                const is_active = active.row === row_index && active.column === column;
                return (
                  <div
                    key={column}
                    id={cellId(at)}
                    role="gridcell"
                    aria-colindex={column + 1}
                    aria-selected={is_active}
                    className={cell === null ? `${classes.gridCell} ${classes.nullCell}` : classes.gridCell}
                    onClick={() => setActive(at)}
                  >
                    {cell ?? 'NULL'}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}
