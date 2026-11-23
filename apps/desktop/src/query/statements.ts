import type { StatementSpan } from '../generated/query';

/** The statement the cursor is in, or the last one starting before it; the first one when the cursor is before them all. */
export function statementAt(spans: ReadonlyArray<StatementSpan>, cursor: number): StatementSpan | null {
  const before = spans.filter((span) => span.from <= cursor);
  return before[before.length - 1] ?? spans[0] ?? null;
}

/** The 1-based line and column of a UTF-16 offset in `text`. */
export function lineColumn(text: string, offset: number): { line: number; column: number } {
  const before = text.slice(0, offset).split('\n');
  return { line: before.length, column: (before[before.length - 1] as string).length + 1 };
}
