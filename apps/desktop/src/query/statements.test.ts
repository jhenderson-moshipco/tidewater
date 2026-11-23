import { describe, expect, it } from 'vitest';
import { lineColumn, statementAt } from './statements';

const spans = [
  { from: 0, to: 8 },
  { from: 12, to: 20 },
];

describe('statementAt', () => {
  it('picks the statement the cursor is inside, including at its ends', () => {
    expect(statementAt(spans, 3)).toEqual(spans[0]);
    expect(statementAt(spans, 12)).toEqual(spans[1]);
    expect(statementAt(spans, 20)).toEqual(spans[1]);
  });

  it('picks the statement just before a cursor in the gap after it', () => {
    expect(statementAt(spans, 10)).toEqual(spans[0]);
  });

  it('picks the first statement for a cursor before them all', () => {
    expect(statementAt([{ from: 4, to: 12 }], 1)).toEqual({ from: 4, to: 12 });
  });

  it('finds nothing in text without statements', () => {
    expect(statementAt([], 0)).toBeNull();
  });
});

describe('lineColumn', () => {
  it('counts lines and columns from 1', () => {
    expect(lineColumn('SELECT 1;\nSELECT nope', 0)).toEqual({ line: 1, column: 1 });
    expect(lineColumn('SELECT 1;\nSELECT nope', 17)).toEqual({ line: 2, column: 8 });
  });
});
