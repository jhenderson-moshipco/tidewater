import type { RunResult, StatementOutcome, TransactionStatus } from '../generated/query';

function count(n: number, word: string): string {
  return `${n.toLocaleString()} ${n === 1 ? word : `${word}s`}`;
}

/** A short line for a result tab and the results footer. */
export function outcomeLabel(outcome: StatementOutcome): string {
  switch (outcome.kind) {
    case 'rows': {
      const shown = count(outcome.rows.length, 'row');
      if (outcome.has_more) return `${shown}, more available`;
      if (outcome.total_rows !== null && outcome.total_rows > outcome.rows.length) {
        return `${outcome.rows.length.toLocaleString()} of ${count(outcome.total_rows, 'row')}`;
      }
      return outcome.total_rows === null ? `First ${shown}` : shown;
    }
    case 'command':
      return `${count(outcome.rows_affected, 'row')} affected`;
    case 'error':
      return 'Failed';
    case 'skipped':
      return 'Not run';
  }
}

/** The sentence a screen reader hears when a run finishes. */
export function runAnnouncement(result: RunResult): string {
  const replaced = result.session_replaced ? 'The previous session had ended, so a new one was opened. ' : '';
  const failed = result.statements.findIndex((statement) => statement.outcome.kind === 'error');
  const failure = result.statements[failed]?.outcome;
  if (failure?.kind === 'error') return `${replaced}Statement ${failed + 1} failed: ${failure.error.message}`;
  const last = result.statements[result.statements.length - 1];
  const label = last ? outcomeLabel(last.outcome) : '';
  const many = result.statements.length > 1 ? `${result.statements.length} statements run. Last: ` : '';
  return `${replaced}${many}${label}.`;
}

export const transaction_labels: Readonly<Record<TransactionStatus, string>> = {
  idle: 'no open transaction',
  open: 'transaction open',
  failed: 'transaction failed, roll back to continue',
  holding_results: 'holding results open',
  closed: 'session ended',
};
