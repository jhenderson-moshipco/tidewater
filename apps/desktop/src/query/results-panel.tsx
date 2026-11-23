import { useId, type KeyboardEvent } from 'react';
import type { Notice, QueryError, StatementResult } from '../generated/query';
import { Elapsed } from '../shell/elapsed';
import { useQueryTabStore, type QueryTab, type ResultPanel } from '../store/query-tabs';
import { useWorkspaceStore } from '../store/workspace';
import { outcomeLabel } from './describe';
import { ResultsGrid } from './results-grid';
import { ResultsResizer } from './results-resizer';
import { revealInEditor } from './sql-editor';
import { lineColumn } from './statements';
import classes from './query.module.css';

type PanelTab = { panel: ResultPanel; label: string; detail: string };

function panelTabs(statements: ReadonlyArray<StatementResult>): Array<PanelTab> {
  const notices = statements.reduce((total, statement) => total + statement.notices.length, 0);
  return [
    ...statements.map((statement, index) => ({ panel: index, label: `Results ${index + 1}`, detail: outcomeLabel(statement.outcome) })),
    { panel: 'messages' as const, label: 'Messages', detail: String(notices) },
  ];
}

function moveAmong(event: KeyboardEvent<HTMLButtonElement>, tab_id: string, tabs: ReadonlyArray<PanelTab>, index: number) {
  const keys: Readonly<Record<string, number>> = { ArrowRight: index + 1, ArrowLeft: index - 1, Home: 0, End: tabs.length - 1 };
  const target = keys[event.key];
  if (target === undefined) return;
  event.preventDefault();
  const next = (target + tabs.length) % tabs.length;
  useQueryTabStore.getState().showPanel(tab_id, (tabs[next] as PanelTab).panel);
  const buttons = event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]');
  buttons?.[next]?.focus();
}

function ErrorView({ model }: { model: { tab_id: string; error: QueryError } }) {
  const { error } = model;
  const text = useQueryTabStore((state) => (state.tabs[model.tab_id] as QueryTab).text);
  const offset = useQueryTabStore((state) => (state.tabs[model.tab_id] as QueryTab).run_offset);
  const target = error.position === null ? null : offset + error.position;
  const at = target === null ? null : { target, ...lineColumn(text, target) };
  return (
    <div className={classes.errorView}>
      <p className={classes.errorMessage}>
        {error.code && <span className={classes.code}>{error.code}</span>} {error.message}
      </p>
      {error.detail && <p>Detail: {error.detail}</p>}
      {error.hint && <p>Hint: {error.hint}</p>}
      {at && (
        <button type="button" className={classes.button} onClick={() => revealInEditor(model.tab_id, at.target)}>
          Go to line {at.line}, column {at.column}
        </button>
      )}
    </div>
  );
}

function Messages({ notices }: { notices: ReadonlyArray<Notice> }) {
  if (notices.length === 0) return <p className={classes.muted}>No messages.</p>;
  return (
    <ul className={classes.messages}>
      {notices.map((notice, index) => (
        <li key={index}>
          <span className={classes.code}>{notice.severity}</span> {notice.message}
          {notice.detail && <span className={classes.muted}> Detail: {notice.detail}</span>}
          {notice.hint && <span className={classes.muted}> Hint: {notice.hint}</span>}
        </li>
      ))}
    </ul>
  );
}

function StatementView({ model }: { model: { tab_id: string; statement: StatementResult; index: number; last: boolean } }) {
  const busy = useQueryTabStore((state) => state.tabs[model.tab_id]?.status !== 'idle');
  const fetching = useQueryTabStore((state) => state.tabs[model.tab_id]?.status === 'fetching');
  const { statement } = model;
  const { outcome } = statement;
  const elapsed = `${Math.round(statement.elapsed_ms).toLocaleString()} ms`;

  switch (outcome.kind) {
    case 'rows':
      return (
        <>
          <ResultsGrid model={{ label: `Results ${model.index + 1}`, columns: outcome.columns, rows: outcome.rows }} />
          <div className={classes.resultsFooter}>
            <span>{outcomeLabel(outcome)}</span>
            {outcome.has_more && model.last && (
              <button
                type="button"
                className={classes.button}
                disabled={busy}
                onClick={() => void useQueryTabStore.getState().fetchMore(model.tab_id)}
              >
                {fetching ? (
                  <>
                    <span aria-hidden="true" className="spinner" /> Fetching…
                  </>
                ) : (
                  'Fetch next 500'
                )}
              </button>
            )}
            <span className={classes.spacer} />
            <span>{elapsed}</span>
          </div>
        </>
      );
    case 'command':
      return (
        <p className={classes.panelText}>
          {outcomeLabel(outcome)} · {elapsed}
        </p>
      );
    case 'error':
      return <ErrorView model={{ tab_id: model.tab_id, error: outcome.error }} />;
    case 'skipped':
      return <p className={classes.panelText}>Not run, because an earlier statement failed.</p>;
  }
}

/** What the tab is doing while a run or fetch is under way, shown above the results it will replace. */
function Progress({ tab_id }: { tab_id: string }) {
  const status = useQueryTabStore((state) => state.tabs[tab_id]?.status ?? 'idle');
  const started_at = useQueryTabStore((state) => state.tabs[tab_id]?.started_at ?? null);
  if (status === 'idle' || started_at === null) return null;

  return (
    <div className={classes.progress}>
      <span aria-hidden="true" className="spinner" />
      <span>
        {status === 'running' ? 'Running…' : 'Fetching more rows…'} <Elapsed started={started_at} />
      </span>
      {status === 'running' && <span className={classes.muted}>⌘. to cancel</span>}
      <span aria-hidden="true" className={classes.progressBar} />
    </div>
  );
}

export function ResultsPanel({ tab_id }: { tab_id: string }) {
  const id = useId();
  const result = useQueryTabStore((state) => state.tabs[tab_id]?.result ?? null);
  const panel = useQueryTabStore((state) => state.tabs[tab_id]?.panel ?? 0);
  const error = useQueryTabStore((state) => state.tabs[tab_id]?.error ?? null);
  const height = useWorkspaceStore((state) => state.results_height);
  const busy = useQueryTabStore((state) => state.tabs[tab_id]?.status !== 'idle');

  if (!result) {
    return (
      <section aria-label="Results" aria-busy={busy} className={classes.results} style={{ height }}>
        <ResultsResizer />
        <Progress tab_id={tab_id} />
        {error ? (
          <p role="alert" className={classes.runError}>
            {error}
          </p>
        ) : (
          <p className={classes.panelText}>Results shown here</p>
        )}
      </section>
    );
  }

  const tabs = panelTabs(result.statements);
  const shown = tabs.find((tab) => tab.panel === panel) ?? (tabs[0] as PanelTab);
  const tabId = (tab: PanelTab) => `${id}-tab-${tab.panel}`;
  const notices = result.statements.flatMap((statement) => statement.notices);
  const statement = typeof shown.panel === 'number' ? result.statements[shown.panel] : undefined;

  return (
    <section aria-label="Results" aria-busy={busy} data-busy={busy} className={classes.results} style={{ height }}>
      <ResultsResizer />
      <Progress tab_id={tab_id} />
      {error && (
        <p role="alert" className={classes.runError}>
          {error}
        </p>
      )}
      <div role="tablist" aria-label="Result sets" className={classes.panelTabs}>
        {tabs.map((tab, index) => (
          <button
            key={tab.label}
            type="button"
            role="tab"
            id={tabId(tab)}
            aria-selected={tab === shown}
            aria-controls={`${id}-panel`}
            tabIndex={tab === shown ? 0 : -1}
            className={classes.panelTab}
            onClick={() => useQueryTabStore.getState().showPanel(tab_id, tab.panel)}
            onKeyDown={(event) => moveAmong(event, tab_id, tabs, index)}
          >
            {tab.label} <span className={classes.panelTabDetail}>{tab.detail}</span>
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`${id}-panel`} aria-labelledby={tabId(shown)} className={classes.panelBody}>
        {statement ? (
          <StatementView
            key={shown.panel}
            model={{ tab_id, statement, index: shown.panel as number, last: shown.panel === result.statements.length - 1 }}
          />
        ) : (
          <Messages notices={notices} />
        )}
      </div>
    </section>
  );
}
