import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderWithUser } from '../testing/render';
import { ResultsGrid, columnWidths, nextPosition, row_height } from './results-grid';

const columns = [
  { name: 'id', type_name: 'int8' },
  { name: 'note', type_name: 'text' },
];
const rows = Array.from({ length: 1000 }, (_, index) => [String(index), index % 2 ? null : `note ${index}`]);

function renderGrid(grid_rows: Array<Array<string | null>> = rows) {
  const result = renderWithUser(<ResultsGrid model={{ label: 'Results 1', columns, rows: grid_rows }} />);
  return { ...result, grid: screen.getByRole('grid', { name: 'Results 1' }) };
}

const activeCell = (grid: HTMLElement) => document.getElementById(grid.getAttribute('aria-activedescendant') as string);

describe('columnWidths', () => {
  it('fits the name and type, or the longest early value, between a floor and a cap', () => {
    expect(columnWidths(columns, [['1', null]])).toEqual([9, 11]);
    expect(columnWidths([{ name: 'x', type_name: 'y' }], [])).toEqual([8]);
    expect(columnWidths(columns, [['1', 'z'.repeat(90)]])).toEqual([9, 48]);
  });
});

describe('nextPosition', () => {
  const size = { rows: 10, columns: 3, page: 4 };
  const at = { row: 5, column: 1 };

  it('moves one cell with the arrows and stays inside the grid', () => {
    expect(nextPosition('ArrowDown', false, at, size)).toEqual({ row: 6, column: 1 });
    expect(nextPosition('ArrowUp', false, { row: 0, column: 1 }, size)).toEqual({ row: 0, column: 1 });
    expect(nextPosition('ArrowRight', false, { row: 5, column: 2 }, size)).toEqual({ row: 5, column: 2 });
    expect(nextPosition('ArrowLeft', false, at, size)).toEqual({ row: 5, column: 0 });
  });

  it('moves a page with Page Up and Page Down, and to the edges with Home and End', () => {
    expect(nextPosition('PageDown', false, at, size)).toEqual({ row: 9, column: 1 });
    expect(nextPosition('PageUp', false, at, size)).toEqual({ row: 1, column: 1 });
    expect(nextPosition('Home', false, at, size)).toEqual({ row: 5, column: 0 });
    expect(nextPosition('End', false, at, size)).toEqual({ row: 5, column: 2 });
    expect(nextPosition('Home', true, at, size)).toEqual({ row: 0, column: 0 });
    expect(nextPosition('End', true, at, size)).toEqual({ row: 9, column: 2 });
  });

  it('leaves other keys to the browser', () => {
    expect(nextPosition('a', false, at, size)).toBeNull();
  });
});

describe('the results grid', () => {
  it('renders only the rows in view and counts them all for screen readers', () => {
    const { grid } = renderGrid();
    expect(grid.getAttribute('aria-rowcount')).toBe('1001');
    expect(screen.getAllByRole('row').length).toBeLessThan(60);
    expect(screen.getAllByRole('columnheader').map((header) => header.textContent)).toEqual(['id int8', 'note text']);
  });

  it('moves the active cell from the keyboard and scrolls it into view both ways', async () => {
    const { user, grid } = renderGrid();
    grid.focus();

    await user.keyboard('{ArrowRight}{ArrowDown}');
    expect(activeCell(grid)?.textContent).toBe('NULL');
    await user.keyboard('{Control>}{End}{/Control}');
    expect([activeCell(grid)?.textContent, grid.scrollTop]).toEqual(['NULL', 1000 * row_height + row_height - 30 * row_height]);
    await user.keyboard('{Control>}{Home}{/Control}');
    expect([activeCell(grid)?.textContent, grid.scrollTop]).toEqual(['0', 0]);
    await user.keyboard('q');
    expect(activeCell(grid)?.textContent).toBe('0');
  });

  it('keeps the rows around the scroll position rendered, using the measured height once there is one', () => {
    const { grid } = renderGrid();
    grid.scrollTop = 500 * row_height;
    fireEvent.scroll(grid);
    expect(screen.getByText('500')).toBeTruthy();

    Object.defineProperty(grid, 'clientHeight', { configurable: true, value: 10 * row_height });
    grid.scrollTop = 900 * row_height;
    fireEvent.scroll(grid);
    expect([screen.getByText('900'), screen.queryByText('950')]).toEqual([expect.anything(), null]);
  });

  it('keeps the same rows when a scroll stays inside the rendered window', () => {
    const { grid } = renderGrid();
    grid.scrollTop = 5;
    fireEvent.scroll(grid);
    expect(screen.getByText('0')).toBeTruthy();
  });

  it('makes a clicked cell the active one', () => {
    const { grid } = renderGrid();
    fireEvent.click(screen.getByText('note 2'));
    expect(activeCell(grid)?.textContent).toBe('note 2');
  });

  it('has no active cell without rows', () => {
    const { grid } = renderGrid([]);
    expect(grid.getAttribute('aria-activedescendant')).toBeNull();
  });
});
