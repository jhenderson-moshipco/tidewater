import { describe, expect, it } from 'vitest';
import { queryError, rowsOutcome, runResult, statement } from '../testing/backend';
import { outcomeLabel, runAnnouncement } from './describe';

const rows = (count: number) => Array.from({ length: count }, (_, index) => [String(index)]);

describe('outcomeLabel', () => {
  it('says how many rows arrived, whether more follow, and the total when only some are shown', () => {
    expect(outcomeLabel(rowsOutcome(rows(1)))).toBe('1 row');
    expect(outcomeLabel(rowsOutcome(rows(500), { has_more: true, total_rows: null }))).toBe('500 rows, more available');
    expect(outcomeLabel(rowsOutcome(rows(500), { total_rows: 1200 }))).toBe('500 of 1,200 rows');
    expect(outcomeLabel(rowsOutcome(rows(500), { total_rows: null }))).toBe('First 500 rows');
  });

  it('labels commands, failures and skipped statements', () => {
    expect(outcomeLabel({ kind: 'command', rows_affected: 1 })).toBe('1 row affected');
    expect(outcomeLabel({ kind: 'command', rows_affected: 3 })).toBe('3 rows affected');
    expect(outcomeLabel({ kind: 'error', error: queryError() })).toBe('Failed');
    expect(outcomeLabel({ kind: 'skipped' })).toBe('Not run');
  });
});

describe('runAnnouncement', () => {
  it("reads the only statement's outcome", () => {
    expect(runAnnouncement(runResult([statement(rowsOutcome(rows(2)))]))).toBe('2 rows.');
  });

  it("counts several statements and reads the last one's outcome", () => {
    const result = runResult([statement({ kind: 'command', rows_affected: 0 }), statement(rowsOutcome(rows(1)))]);
    expect(runAnnouncement(result)).toBe('2 statements run. Last: 1 row.');
  });

  it('names the failed statement and its error, and says when the session was replaced', () => {
    const result = runResult([statement(rowsOutcome(rows(1))), statement({ kind: 'error', error: queryError() }), statement({ kind: 'skipped' })], {
      session_replaced: true,
    });
    expect(runAnnouncement(result)).toBe('The previous session had ended, so a new one was opened. Statement 2 failed: syntax error at or near "SELEC"');
  });

  it('reads an empty run as nothing', () => {
    expect(runAnnouncement(runResult([]))).toBe('.');
  });
});
