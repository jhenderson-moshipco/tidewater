//! Query tabs. Each tab runs its statements on a backend session of its own and can keep the last
//! statement's rows open in a cursor, so fetch more reads the next batch without running it again.

pub mod split;

use std::collections::HashMap;
use std::pin::pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use serde::Serialize;
use tauri::async_runtime::JoinHandle;
use tokio_postgres::error::{DbError, ErrorPosition};
use tokio_postgres::{AsyncMessage, CancelToken, Client, SimpleQueryMessage, SimpleQueryRow};
use ts_rs::TS;

use crate::connections::{ConnectParams, build_config, describe, tls};
use crate::error::CommandError;
use crate::servers::model::TlsMode;
use split::{Statement, StatementSpan};

/// Rows sent per batch, both for the first fetch and for each fetch more.
pub const BATCH_ROWS: usize = 500;
const CURSOR: &str = "tidewater_results";
const IN_TRANSACTION: &str = "SELECT now() <> statement_timestamp()";

/// A cell as Postgres prints it, or `None` for NULL.
pub type Cell = Option<String>;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[ts(export, export_to = "query.ts")]
pub struct ResultColumn {
    pub name: String,
    pub type_name: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[ts(export, export_to = "query.ts")]
pub struct Notice {
    pub severity: String,
    pub code: String,
    pub message: String,
    pub detail: Option<String>,
    pub hint: Option<String>,
}

impl From<&DbError> for Notice {
    fn from(error: &DbError) -> Self {
        Notice {
            severity: error.severity().to_string(),
            code: error.code().code().to_string(),
            message: error.message().to_string(),
            detail: error.detail().map(str::to_string),
            hint: error.hint().map(str::to_string),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[ts(export, export_to = "query.ts")]
pub struct QueryError {
    pub message: String,
    /// The SQLSTATE, when the server sent one.
    pub code: Option<String>,
    pub detail: Option<String>,
    pub hint: Option<String>,
    /// Where the error points in the editor text, in UTF-16 code units.
    pub position: Option<u32>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[ts(export, export_to = "query.ts")]
pub enum StatementOutcome {
    Rows {
        columns: Vec<ResultColumn>,
        rows: Vec<Vec<Cell>>,
        /// Whether fetch more can read further rows from the open cursor.
        has_more: bool,
        /// The statement's full row count, when it is known.
        #[ts(type = "number | null")]
        total_rows: Option<u64>,
    },
    Command {
        #[ts(type = "number")]
        rows_affected: u64,
    },
    Error {
        error: QueryError,
    },
    /// Not run, because an earlier statement failed.
    Skipped,
}

#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[ts(export, export_to = "query.ts")]
pub struct StatementResult {
    pub span: StatementSpan,
    pub elapsed_ms: f64,
    pub notices: Vec<Notice>,
    pub outcome: StatementOutcome,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "query.ts")]
pub enum TransactionStatus {
    /// No transaction is open.
    Idle,
    /// A transaction the user began is open.
    Open,
    /// A transaction the user began has failed and only rolls back.
    Failed,
    /// Tidewater's own transaction is open, holding the results for fetch more.
    HoldingResults,
    /// The session has ended. The next run opens a new one.
    Closed,
}

#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[ts(export, export_to = "query.ts")]
pub struct RunResult {
    pub statements: Vec<StatementResult>,
    pub transaction: TransactionStatus,
    /// The tab's previous session had ended, so the run opened a new one without its settings or transaction.
    pub session_replaced: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, TS)]
#[ts(export, export_to = "query.ts")]
pub struct RowBatch {
    pub rows: Vec<Vec<Cell>>,
    pub has_more: bool,
    pub elapsed_ms: f64,
    pub notices: Vec<Notice>,
    pub transaction: TransactionStatus,
}

/// A cursor left open for fetch more.
struct OpenResults {
    own_transaction: bool,
    /// The row read past the last batch, which shows whether more rows remain.
    pending: Vec<Vec<Cell>>,
    generation: u64,
}

struct Session {
    server_id: String,
    database: String,
    client: Client,
    driver: JoinHandle<()>,
    notices: Arc<Mutex<Vec<Notice>>>,
    open: Option<OpenResults>,
    results_timeout_ms: u32,
}

impl Drop for Session {
    fn drop(&mut self) {
        self.driver.abort();
    }
}

impl Session {
    fn take_notices(&self) -> Vec<Notice> {
        self.notices.lock().map(|mut notices| std::mem::take(&mut *notices)).unwrap_or_default()
    }

    async fn transaction(&self) -> TransactionStatus {
        if self.open.as_ref().is_some_and(|open| open.own_transaction) {
            return TransactionStatus::HoldingResults;
        }
        match in_transaction(&self.client).await {
            Some(true) => TransactionStatus::Open,
            Some(false) => TransactionStatus::Idle,
            None if self.client.is_closed() => TransactionStatus::Closed,
            None => TransactionStatus::Failed,
        }
    }

    /// Closes the open cursor, committing the transaction Tidewater began for it.
    async fn close_results(&mut self) {
        if let Some(open) = self.open.take() {
            let sql = if open.own_transaction { format!("CLOSE {CURSOR}; COMMIT") } else { format!("CLOSE {CURSOR}") };
            let _ = self.client.batch_execute(&sql).await;
        }
    }
}

/// Whether a transaction block is open, or `None` when it has failed or the session has ended. Outside a block, a
/// simple query's statement starts its own transaction, so the two timestamps match.
async fn in_transaction(client: &Client) -> Option<bool> {
    let messages = client.simple_query(IN_TRANSACTION).await.ok()?;
    messages.iter().find_map(|message| if let SimpleQueryMessage::Row(row) = message { Some(row.get(0) == Some("t")) } else { None })
}

async fn open_session(server_id: &str, params: &ConnectParams) -> Result<Session, CommandError> {
    let (client, mut connection) = build_config(params).connect(tls::connector(params.tls)).await?;
    let notices = Arc::new(Mutex::new(Vec::new()));
    let sink = notices.clone();
    let driver = tauri::async_runtime::spawn(async move {
        while let Some(Ok(message)) = std::future::poll_fn(|cx| connection.poll_message(cx)).await {
            if let (AsyncMessage::Notice(notice), Ok(mut notices)) = (message, sink.lock()) {
                notices.push(Notice::from(&notice));
            }
        }
    });
    Ok(Session {
        server_id: server_id.to_string(),
        database: params.database.clone(),
        client,
        driver,
        notices,
        open: None,
        results_timeout_ms: params.session.results_timeout_ms,
    })
}

fn elapsed_ms(start: Instant) -> f64 {
    start.elapsed().as_secs_f64() * 1000.0
}

fn utf16_offset(statement: &Statement<'_>, position: u32) -> u32 {
    let before = usize::try_from(position.saturating_sub(1)).unwrap_or(usize::MAX);
    statement.span.from + statement.text.chars().take(before).map(|character| character.len_utf16() as u32).sum::<u32>()
}

/// The error for the editor. `statement` is the text the server parsed, when its positions point into the statement.
fn query_error(error: &tokio_postgres::Error, statement: Option<&Statement<'_>>) -> QueryError {
    let Some(database_error) = error.as_db_error() else {
        return QueryError { message: describe(error), code: None, detail: None, hint: None, position: None };
    };
    let position = match (database_error.position(), statement) {
        (Some(ErrorPosition::Original(position)), Some(statement)) => Some(utf16_offset(statement, *position)),
        _ => None,
    };
    QueryError {
        message: database_error.message().to_string(),
        code: Some(database_error.code().code().to_string()),
        detail: database_error.detail().map(str::to_string),
        hint: database_error.hint().map(str::to_string),
        position,
    }
}

fn failed(error: &tokio_postgres::Error, statement: Option<&Statement<'_>>) -> StatementOutcome {
    StatementOutcome::Error { error: query_error(error, statement) }
}

fn cells(row: &SimpleQueryRow) -> Vec<Cell> {
    (0..row.len()).map(|index| row.get(index).map(str::to_string)).collect()
}

async fn fetch(client: &Client, count: usize) -> Result<Vec<Vec<Cell>>, tokio_postgres::Error> {
    let messages = client.simple_query(&format!("FETCH FORWARD {count} FROM {CURSOR}")).await?;
    Ok(messages.iter().filter_map(|message| if let SimpleQueryMessage::Row(row) = message { Some(cells(row)) } else { None }).collect())
}

/// Runs a statement whose rows can't be held in a cursor, keeping the first batch and counting the rest.
async fn stream_rows(client: &Client, text: &str) -> Result<(Vec<Vec<Cell>>, u64), tokio_postgres::Error> {
    let mut stream = pin!(client.simple_query_raw(text).await?);
    let mut rows = Vec::new();
    let mut total = 0;
    while let Some(message) = stream.next().await {
        if let SimpleQueryMessage::Row(row) = message? {
            total += 1;
            if rows.len() < BATCH_ROWS {
                rows.push(cells(&row));
            }
        }
    }
    Ok((rows, total))
}

/// The rows of one batch and whether more follow, keeping the row read past the batch for the next one.
fn split_batch(mut rows: Vec<Vec<Cell>>) -> (Vec<Vec<Cell>>, Vec<Vec<Cell>>) {
    let pending = rows.split_off(rows.len().min(BATCH_ROWS));
    (rows, pending)
}

struct Tab {
    session: tokio::sync::Mutex<Option<Session>>,
    cancel: Mutex<Option<(CancelToken, TlsMode)>>,
    generation: AtomicU64,
}

type ResultsClosed = Arc<dyn Fn(&str) + Send + Sync>;

/// The query tabs' sessions, keyed by tab id.
pub struct QuerySessions {
    tabs: Mutex<HashMap<String, Arc<Tab>>>,
    on_results_closed: ResultsClosed,
}

impl QuerySessions {
    /// `on_results_closed` hears a tab's id when its idle results close on their own.
    pub fn new(on_results_closed: impl Fn(&str) + Send + Sync + 'static) -> Self {
        QuerySessions { tabs: Mutex::default(), on_results_closed: Arc::new(on_results_closed) }
    }

    fn tab(&self, tab_id: &str) -> Arc<Tab> {
        let mut tabs = self.tabs.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        tabs.entry(tab_id.to_string())
            .or_insert_with(|| Arc::new(Tab { session: Default::default(), cancel: Mutex::default(), generation: AtomicU64::new(0) }))
            .clone()
    }

    fn existing(&self, tab_id: &str) -> Option<Arc<Tab>> {
        self.tabs.lock().unwrap_or_else(std::sync::PoisonError::into_inner).get(tab_id).cloned()
    }

    /// Runs each statement in `sql` in order on the tab's session, stopping at the first that fails.
    pub async fn run(&self, tab_id: &str, server_id: &str, params: &ConnectParams, sql: &str) -> Result<RunResult, CommandError> {
        let statements = split::split(sql);
        if statements.is_empty() {
            return Err(CommandError::Invalid("There is no statement to run.".into()));
        }
        let tab = self.tab(tab_id);
        let mut guard = tab.session.lock().await;
        let same_target = |session: &Session| session.server_id == server_id && session.database == params.database;
        if let Some(session) = guard.as_mut().filter(|session| !same_target(session) && !session.client.is_closed()) {
            session.close_results().await;
            if in_transaction(&session.client).await != Some(false) {
                return Err(CommandError::Invalid(
                    "Commit or roll back this tab's open transaction before switching it to another connection.".into(),
                ));
            }
        }
        let session_replaced = guard.as_ref().is_some_and(|session| same_target(session) && session.client.is_closed());
        if !guard.as_ref().is_some_and(|session| same_target(session) && !session.client.is_closed()) {
            *guard = None;
            let session = open_session(server_id, params).await?;
            *tab.cancel.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = Some((session.client.cancel_token(), params.tls));
            *guard = Some(session);
        }
        let session = guard.as_mut().expect("the tab has a session");
        session.results_timeout_ms = params.session.results_timeout_ms;
        session.close_results().await;
        session.take_notices();
        let generation = tab.generation.fetch_add(1, Ordering::SeqCst) + 1;

        let last = statements.len() - 1;
        let mut results = Vec::with_capacity(statements.len());
        let mut stopped = false;
        for (index, statement) in statements.iter().enumerate() {
            if stopped {
                results.push(StatementResult { span: statement.span, elapsed_ms: 0.0, notices: Vec::new(), outcome: StatementOutcome::Skipped });
                continue;
            }
            let start = Instant::now();
            let outcome = run_statement(session, statement, index == last, generation).await;
            stopped = matches!(outcome, StatementOutcome::Error { .. });
            results.push(StatementResult { span: statement.span, elapsed_ms: elapsed_ms(start), notices: session.take_notices(), outcome });
        }
        self.schedule_close(tab_id, &tab, session, generation);
        let transaction = session.transaction().await;
        Ok(RunResult { statements: results, transaction, session_replaced })
    }

    /// The next batch from the tab's open cursor.
    pub async fn fetch_more(&self, tab_id: &str) -> Result<RowBatch, CommandError> {
        let closed = || CommandError::Invalid("These results are closed. Run the statement again to see more rows.".into());
        let tab = self.existing(tab_id).ok_or_else(closed)?;
        let mut guard = tab.session.lock().await;
        let session = guard.as_mut().ok_or_else(closed)?;
        let mut open = session.open.take().ok_or_else(closed)?;
        let start = Instant::now();
        let fetched = match fetch(&session.client, BATCH_ROWS + 1 - open.pending.len()).await {
            Ok(rows) => rows,
            Err(error) => {
                if open.own_transaction {
                    let _ = session.client.batch_execute("ROLLBACK").await;
                }
                return Err(CommandError::Connection(query_error(&error, None).message));
            }
        };
        let notices = session.take_notices();
        let mut rows = std::mem::take(&mut open.pending);
        rows.extend(fetched);
        let (rows, pending) = split_batch(rows);
        let has_more = !pending.is_empty();
        let generation = tab.generation.fetch_add(1, Ordering::SeqCst) + 1;
        session.open = Some(OpenResults { pending, generation, ..open });
        if !has_more {
            session.close_results().await;
        }
        self.schedule_close(tab_id, &tab, session, generation);
        Ok(RowBatch { rows, has_more, elapsed_ms: elapsed_ms(start), notices, transaction: session.transaction().await })
    }

    /// Asks the server to cancel the statement the tab is running. A tab without a session has nothing to cancel.
    pub async fn cancel(&self, tab_id: &str) -> Result<(), CommandError> {
        let token = self.existing(tab_id).and_then(|tab| tab.cancel.lock().ok().and_then(|cancel| cancel.clone()));
        match token {
            Some((token, mode)) => token.cancel_query(tls::connector(mode)).await.map_err(CommandError::from),
            None => Ok(()),
        }
    }

    /// Ends the tab's session. The server rolls back anything it left open.
    pub fn close(&self, tab_id: &str) {
        let tab = self.tabs.lock().unwrap_or_else(std::sync::PoisonError::into_inner).remove(tab_id);
        drop(tab);
    }

    /// Ends every tab session on this server.
    pub async fn close_server(&self, server_id: &str) {
        self.close_where(|session| session.server_id == server_id).await;
    }

    /// Ends the tab sessions on one of this server's databases, as before it is dropped or renamed.
    pub async fn close_database(&self, server_id: &str, database: &str) {
        self.close_where(|session| session.server_id == server_id && session.database == database).await;
    }

    async fn close_where(&self, matches: impl Fn(&Session) -> bool) {
        let tabs: Vec<(String, Arc<Tab>)> =
            self.tabs.lock().unwrap_or_else(std::sync::PoisonError::into_inner).iter().map(|(id, tab)| (id.clone(), tab.clone())).collect();
        for (tab_id, tab) in tabs {
            if tab.session.lock().await.as_ref().is_some_and(&matches) {
                self.close(&tab_id);
            }
        }
    }

    fn schedule_close(&self, tab_id: &str, tab: &Arc<Tab>, session: &Session, generation: u64) {
        if session.open.is_none() {
            return;
        }
        let timeout_ms = session.results_timeout_ms;
        let tab: Weak<Tab> = Arc::downgrade(tab);
        let tab_id = tab_id.to_string();
        let notify = self.on_results_closed.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_millis(u64::from(timeout_ms))).await;
            let Some(tab) = tab.upgrade() else { return };
            let mut guard = tab.session.lock().await;
            if let Some(session) = guard.as_mut().filter(|session| session.open.as_ref().is_some_and(|open| open.generation == generation)) {
                session.close_results().await;
                notify(&tab_id);
            }
        });
    }
}

/// Runs one statement. Only the run's last statement may leave its cursor open for fetch more.
async fn run_statement(session: &mut Session, statement: &Statement<'_>, keep_open: bool, generation: u64) -> StatementOutcome {
    let client = &session.client;
    let prepared = match client.prepare(statement.text).await {
        Ok(prepared) => prepared,
        Err(error) => return failed(&error, Some(statement)),
    };
    let columns: Vec<ResultColumn> =
        prepared.columns().iter().map(|column| ResultColumn { name: column.name().to_string(), type_name: column.type_().name().to_string() }).collect();
    drop(prepared);
    if columns.is_empty() {
        return match client.simple_query(statement.text).await {
            Ok(messages) => StatementOutcome::Command {
                rows_affected: messages.iter().map(|message| if let SimpleQueryMessage::CommandComplete(count) = message { *count } else { 0 }).sum(),
            },
            Err(error) => failed(&error, Some(statement)),
        };
    }

    let own_transaction = in_transaction(client).await == Some(false);
    // A simple query is parsed whole before any of it runs, so the savepoint goes first on its own to survive a
    // DECLARE that doesn't parse.
    let opener = if own_transaction {
        format!("BEGIN; DECLARE {CURSOR} NO SCROLL CURSOR FOR {}\n", statement.text)
    } else {
        let _ = client.batch_execute(&format!("SAVEPOINT {CURSOR}")).await;
        format!("DECLARE {CURSOR} NO SCROLL CURSOR FOR {}\n; RELEASE SAVEPOINT {CURSOR}", statement.text)
    };
    if client.batch_execute(&opener).await.is_err() {
        let undo = if own_transaction { "ROLLBACK".to_string() } else { format!("ROLLBACK TO SAVEPOINT {CURSOR}; RELEASE SAVEPOINT {CURSOR}") };
        let _ = client.batch_execute(&undo).await;
        session.take_notices();
        return match stream_rows(client, statement.text).await {
            Ok((rows, total)) => StatementOutcome::Rows { columns, rows, has_more: false, total_rows: Some(total) },
            Err(error) => failed(&error, Some(statement)),
        };
    }

    let rows = match fetch(client, BATCH_ROWS + 1).await {
        Ok(rows) => rows,
        Err(error) => {
            if own_transaction {
                let _ = client.batch_execute("ROLLBACK").await;
            }
            return failed(&error, None);
        }
    };
    let (rows, pending) = split_batch(rows);
    let has_more = !pending.is_empty();
    let total_rows = if has_more { None } else { Some(rows.len() as u64) };
    session.open = Some(OpenResults { own_transaction, pending, generation });
    if !(has_more && keep_open) {
        session.close_results().await;
    }
    StatementOutcome::Rows { columns, rows, has_more: has_more && keep_open, total_rows }
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};
    use tokio::sync::mpsc;

    use super::*;
    use crate::testing::{closed_port, live_params, parts};

    fn sessions() -> (Arc<QuerySessions>, mpsc::UnboundedReceiver<String>) {
        let (sender, receiver) = mpsc::unbounded_channel();
        (Arc::new(QuerySessions::new(move |tab_id| sender.send(tab_id.to_string()).unwrap())), receiver)
    }

    async fn run(sessions: &QuerySessions, sql: &str) -> RunResult {
        sessions.run("tab", "server-a", &live_params(), sql).await.unwrap()
    }

    fn kind(error: CommandError) -> String {
        parts(error).0
    }

    fn outcome(result: &RunResult, index: usize) -> Value {
        serde_json::to_value(&result.statements[index].outcome).unwrap()
    }

    /// A rows outcome's row count, whether fetch more is offered, and its total.
    fn rows(result: &RunResult, index: usize) -> Value {
        let outcome = outcome(result, index);
        json!([outcome["rows"].as_array().map(Vec::len), outcome["has_more"], outcome["total_rows"]])
    }

    /// An error outcome's SQLSTATE and position.
    fn error(result: &RunResult, index: usize) -> Value {
        let outcome = outcome(result, index);
        json!([outcome["error"]["code"], outcome["error"]["position"]])
    }

    fn cell(result: &RunResult, index: usize) -> Value {
        outcome(result, index)["rows"][0][0].clone()
    }

    fn utf16(text: &str) -> u32 {
        text.encode_utf16().count() as u32
    }

    fn timed_out_after(milliseconds: u32) -> ConnectParams {
        let mut params = live_params();
        params.session.results_timeout_ms = milliseconds;
        params
    }

    #[tokio::test]
    async fn text_without_a_statement_is_refused_before_connecting() {
        let (sessions, _) = sessions();
        let refused = sessions.run("tab", "server-a", &closed_port().await, "-- only a comment\n;").await;
        assert_eq!(refused, Err(CommandError::Invalid("There is no statement to run.".into())));
    }

    #[tokio::test]
    async fn a_run_that_cant_connect_fails_and_leaves_nothing_to_fetch_or_cancel() {
        let (sessions, _) = sessions();

        let refused = sessions.run("tab", "server-a", &closed_port().await, "SELECT 1").await;

        assert_eq!(refused.map_err(kind), Err("connection".into()));
        assert_eq!(sessions.fetch_more("tab").await.map_err(kind), Err("invalid".into()));
        assert_eq!(sessions.cancel("tab").await, Ok(()));
    }

    #[tokio::test]
    async fn fetching_on_a_tab_that_never_ran_is_closed_and_cancelling_does_nothing() {
        let (sessions, _) = sessions();
        let closed = Err(CommandError::Invalid("These results are closed. Run the statement again to see more rows.".into()));
        assert_eq!(sessions.fetch_more("never").await, closed);
        assert_eq!(sessions.cancel("never").await, Ok(()));
        sessions.close("never");
    }

    #[test]
    fn a_position_counts_the_chars_before_it_in_utf16_from_the_statements_start() {
        let statement = Statement { text: "SELECT '😀', x", span: StatementSpan { from: 10, to: 23 } };
        assert_eq!(utf16_offset(&statement, 1), 10);
        assert_eq!(utf16_offset(&statement, 13), 10 + utf16("SELECT '😀', "));
    }

    #[tokio::test]
    #[ignore = "needs TIDEWATER_TEST_DATABASE_URL pointing at a running Postgres"]
    async fn live_closing_a_database_ends_only_the_tabs_on_it() {
        let (sessions, _) = sessions();
        let template = ConnectParams { database: "template1".into(), ..live_params() };
        sessions.run("on-template", "server-a", &template, "SELECT 1").await.unwrap();
        sessions.run("on-main", "server-a", &live_params(), "SELECT 1").await.unwrap();
        sessions.run("elsewhere", "server-b", &template, "SELECT 1").await.unwrap();

        sessions.close_database("server-a", "template1").await;

        let open = ["on-template", "on-main", "elsewhere"].map(|tab_id| sessions.existing(tab_id).is_some());
        assert_eq!(open, [false, true, true]);
    }

    #[tokio::test]
    #[ignore = "needs TIDEWATER_TEST_DATABASE_URL pointing at a running Postgres"]
    async fn live_a_select_returns_its_columns_and_text_cells_with_null_as_none() {
        let (sessions, _) = sessions();

        let result = run(&sessions, "SELECT 1 AS n, 'x'::text AS t, NULL::int AS z").await;

        let expected = StatementOutcome::Rows {
            columns: vec![
                ResultColumn { name: "n".into(), type_name: "int4".into() },
                ResultColumn { name: "t".into(), type_name: "text".into() },
                ResultColumn { name: "z".into(), type_name: "int4".into() },
            ],
            rows: vec![vec![Some("1".into()), Some("x".into()), None]],
            has_more: false,
            total_rows: Some(1),
        };
        assert_eq!(result.statements[0].outcome, expected);
        assert_eq!((result.transaction, result.session_replaced), (TransactionStatus::Idle, false));
    }

    #[tokio::test]
    #[ignore = "needs TIDEWATER_TEST_DATABASE_URL pointing at a running Postgres"]
    async fn live_a_select_with_no_columns_is_a_command_reporting_its_one_row() {
        let (sessions, _) = sessions();
        assert_eq!(run(&sessions, "SELECT").await.statements[0].outcome, StatementOutcome::Command { rows_affected: 1 });
    }

    #[tokio::test]
    #[ignore = "needs TIDEWATER_TEST_DATABASE_URL pointing at a running Postgres"]
    async fn live_1200_rows_arrive_500_at_a_time_and_the_last_batch_closes_the_results() {
        let (sessions, _) = sessions();

        let first = run(&sessions, "SELECT g FROM generate_series(1, 1200) g").await;
        assert_eq!((rows(&first, 0), first.transaction), (json!([500, true, null]), TransactionStatus::HoldingResults));

        let second = sessions.fetch_more("tab").await.unwrap();
        assert_eq!((second.rows.len(), second.has_more, second.rows[0][0].as_deref()), (500, true, Some("501")));
        let third = sessions.fetch_more("tab").await.unwrap();
        assert_eq!((third.rows.len(), third.has_more, third.transaction), (200, false, TransactionStatus::Idle));
        assert_eq!(sessions.fetch_more("tab").await.map_err(kind), Err("invalid".into()));
    }

    #[tokio::test]
    #[ignore = "needs TIDEWATER_TEST_DATABASE_URL pointing at a running Postgres"]
    async fn live_exactly_1000_rows_end_on_the_second_batch_without_an_empty_third() {
        let (sessions, _) = sessions();

        run(&sessions, "SELECT g FROM generate_series(1, 1000) g").await;
        let second = sessions.fetch_more("tab").await.unwrap();

        assert_eq!((second.rows.len(), second.has_more, second.rows[499][0].as_deref()), (500, false, Some("1000")));
    }

    #[tokio::test]
    #[ignore = "needs TIDEWATER_TEST_DATABASE_URL pointing at a running Postgres"]
    async fn live_several_statements_return_one_result_each_and_only_the_last_keeps_fetch_more() {
        let (sessions, _) = sessions();
        let sql = "SELECT g FROM generate_series(1, 600) g; CREATE TEMP TABLE t (x int); INSERT INTO t VALUES (1), (2);\n\
                   SELECT g FROM generate_series(1, 600) g";

        let result = run(&sessions, sql).await;

        assert_eq!(rows(&result, 0), json!([500, false, null]));
        assert_eq!(result.statements[1].outcome, StatementOutcome::Command { rows_affected: 0 });
        assert_eq!(result.statements[2].outcome, StatementOutcome::Command { rows_affected: 2 });
        assert_eq!(rows(&result, 3), json!([500, true, null]));
        let from = utf16("SELECT g FROM generate_series(1, 600) g; ");
        assert_eq!(result.statements[1].span, StatementSpan { from, to: from + utf16("CREATE TEMP TABLE t (x int)") });
    }

    #[tokio::test]
    #[ignore = "needs TIDEWATER_TEST_DATABASE_URL pointing at a running Postgres"]
    async fn live_a_failed_statement_stops_the_run_and_the_rest_are_skipped() {
        let (sessions, _) = sessions();

        let result = run(&sessions, "SELECT '😀'; SELEC 2; SELECT 3").await;

        assert_eq!(error(&result, 1), json!(["42601", utf16("SELECT '😀'; ")]));
        assert_eq!((&result.statements[2].outcome, result.statements[2].elapsed_ms), (&StatementOutcome::Skipped, 0.0));
    }

    #[tokio::test]
    #[ignore = "needs TIDEWATER_TEST_DATABASE_URL pointing at a running Postgres"]
    async fn live_an_error_position_counts_utf16_units_of_the_editor_text() {
        let (sessions, _) = sessions();
        let result = run(&sessions, "SELECT 1;\nSELECT '😀', nope").await;
        assert_eq!(error(&result, 1), json!(["42703", utf16("SELECT 1;\nSELECT '😀', ")]));
    }

    #[tokio::test]
    #[ignore = "needs TIDEWATER_TEST_DATABASE_URL pointing at a running Postgres"]
    async fn live_rows_that_cant_be_a_cursor_show_the_first_500_and_the_total() {
        let (sessions, _) = sessions();
        let sql = "CREATE TEMP TABLE big AS SELECT g FROM generate_series(1, 700) g; UPDATE big SET g = g RETURNING g; SHOW server_version";

        let result = run(&sessions, sql).await;

        assert_eq!((rows(&result, 1), rows(&result, 2)), (json!([500, false, 700]), json!([1, false, 1])));
        assert_eq!(result.transaction, TransactionStatus::Idle);
    }

    #[tokio::test]
    #[ignore = "needs TIDEWATER_TEST_DATABASE_URL pointing at a running Postgres"]
    async fn live_rows_that_cant_be_a_cursor_inside_the_users_transaction_keep_it_open() {
        let (sessions, _) = sessions();

        let result = run(&sessions, "BEGIN; CREATE TEMP TABLE r AS SELECT 1 AS x; UPDATE r SET x = 2 RETURNING x").await;

        assert_eq!((rows(&result, 2), result.transaction), (json!([1, false, 1]), TransactionStatus::Open));
    }

    #[tokio::test]
    #[ignore = "needs TIDEWATER_TEST_DATABASE_URL pointing at a running Postgres"]
    async fn live_an_error_while_streaming_rows_that_cant_be_a_cursor_is_reported() {
        let (sessions, _) = sessions();
        let result = run(&sessions, "EXPLAIN ANALYZE SELECT 1 / (g - 3) FROM generate_series(1, 5) g").await;
        assert_eq!(error(&result, 0), json!(["22012", null]));
    }

    #[tokio::test]
    #[ignore = "needs TIDEWATER_TEST_DATABASE_URL pointing at a running Postgres"]
    async fn live_an_error_while_fetching_rolls_back_tidewaters_transaction_and_has_no_position() {
        let (sessions, _) = sessions();

        let result = run(&sessions, "SELECT 1 / (g - 3) FROM generate_series(1, 5) g").await;

        assert_eq!((error(&result, 0), result.transaction), (json!(["22012", null]), TransactionStatus::Idle));
    }

    #[tokio::test]
    #[ignore = "needs TIDEWATER_TEST_DATABASE_URL pointing at a running Postgres"]
    async fn live_an_error_while_fetching_inside_the_users_transaction_leaves_it_failed() {
        let (sessions, _) = sessions();
        run(&sessions, "BEGIN").await;

        let result = run(&sessions, "SELECT 1 / (g - 3) FROM generate_series(1, 5) g").await;

        assert_eq!(result.transaction, TransactionStatus::Failed);
        assert_eq!(run(&sessions, "ROLLBACK").await.transaction, TransactionStatus::Idle);
    }

    #[tokio::test]
    #[ignore = "needs TIDEWATER_TEST_DATABASE_URL pointing at a running Postgres"]
    async fn live_an_error_during_fetch_more_ends_the_results_and_rolls_back() {
        let (sessions, _) = sessions();
        run(&sessions, "SELECT 1 / (g - 600) FROM generate_series(1, 700) g").await;

        let failed = sessions.fetch_more("tab").await;

        assert_eq!(failed, Err(CommandError::Connection("division by zero".into())));
        assert_eq!(sessions.fetch_more("tab").await.map_err(kind), Err("invalid".into()));
        assert_eq!(run(&sessions, "SELECT 1").await.transaction, TransactionStatus::Idle);
    }

    #[tokio::test]
    #[ignore = "needs TIDEWATER_TEST_DATABASE_URL pointing at a running Postgres"]
    async fn live_an_error_during_fetch_more_inside_the_users_transaction_leaves_it_failed() {
        let (sessions, _) = sessions();
        run(&sessions, "BEGIN; SELECT 1 / (g - 600) FROM generate_series(1, 700) g").await;

        let failed = sessions.fetch_more("tab").await;

        assert_eq!(failed, Err(CommandError::Connection("division by zero".into())));
        assert_eq!(run(&sessions, "ROLLBACK").await.transaction, TransactionStatus::Idle);
    }

    #[tokio::test]
    #[ignore = "needs TIDEWATER_TEST_DATABASE_URL pointing at a running Postgres"]
    async fn live_results_inside_the_users_transaction_stay_in_it_through_fetch_more_and_the_next_run() {
        let (sessions, _) = sessions();

        let first = run(&sessions, "BEGIN; SELECT g FROM generate_series(1, 600) g").await;
        assert_eq!((rows(&first, 1), first.transaction), (json!([500, true, null]), TransactionStatus::Open));
        let more = sessions.fetch_more("tab").await.unwrap();
        assert_eq!((more.rows.len(), more.has_more, more.transaction), (100, false, TransactionStatus::Open));

        run(&sessions, "SELECT g FROM generate_series(1, 600) g").await;
        let next = run(&sessions, "SELECT 1").await;

        assert_eq!(next.transaction, TransactionStatus::Open);
        assert_eq!(run(&sessions, "COMMIT").await.transaction, TransactionStatus::Idle);
    }

    #[tokio::test]
    #[ignore = "needs TIDEWATER_TEST_DATABASE_URL pointing at a running Postgres"]
    async fn live_commands_report_rows_affected_and_a_raised_exception_with_its_detail_and_hint() {
        let (sessions, _) = sessions();
        let sql = "CREATE TEMP TABLE c (x int); INSERT INTO c SELECT generate_series(1, 3);\n\
                   DO $$ BEGIN RAISE EXCEPTION 'nope' USING DETAIL = 'why', HINT = 'fix it'; END $$";

        let result = run(&sessions, sql).await;

        assert_eq!(result.statements[0].outcome, StatementOutcome::Command { rows_affected: 0 });
        assert_eq!(result.statements[1].outcome, StatementOutcome::Command { rows_affected: 3 });
        let error = QueryError {
            message: "nope".into(),
            code: Some("P0001".into()),
            detail: Some("why".into()),
            hint: Some("fix it".into()),
            position: None,
        };
        assert_eq!(result.statements[2].outcome, StatementOutcome::Error { error });
    }

    #[tokio::test]
    #[ignore = "needs TIDEWATER_TEST_DATABASE_URL pointing at a running Postgres"]
    async fn live_notices_belong_to_the_statement_that_raised_them_and_notifications_are_ignored() {
        let (sessions, _) = sessions();

        let result = run(&sessions, "LISTEN tidewater; NOTIFY tidewater; DO $$ BEGIN RAISE NOTICE 'hello' USING DETAIL = 'd'; END $$; SELECT 1").await;

        let notice = Notice { severity: "NOTICE".into(), code: "00000".into(), message: "hello".into(), detail: Some("d".into()), hint: None };
        let notices: Vec<&[Notice]> = result.statements.iter().map(|statement| statement.notices.as_slice()).collect();
        assert_eq!(notices, [&[][..], &[], &[notice], &[]]);
    }

    #[tokio::test]
    #[ignore = "needs TIDEWATER_TEST_DATABASE_URL pointing at a running Postgres"]
    async fn live_a_tab_whose_session_was_terminated_reconnects_on_the_next_run_and_says_so() {
        let (sessions, _) = sessions();
        let first = run(&sessions, "SELECT pg_backend_pid()").await;
        let pid: i32 = cell(&first, 0).as_str().unwrap().parse().unwrap();
        let admin = open_session("admin", &live_params()).await.unwrap();
        admin.client.execute("SELECT pg_terminate_backend($1)", &[&pid]).await.unwrap();
        let tab = sessions.tab("tab");
        (&mut tab.session.lock().await.as_mut().unwrap().driver).await.unwrap();

        let again = run(&sessions, "SELECT 1").await;

        assert_eq!((again.session_replaced, again.transaction), (true, TransactionStatus::Idle));
    }

    #[tokio::test]
    #[ignore = "needs TIDEWATER_TEST_DATABASE_URL pointing at a running Postgres"]
    async fn live_a_statement_that_ends_its_own_session_reports_it_closed() {
        let (sessions, _) = sessions();

        let result = run(&sessions, "SELECT pg_terminate_backend(pg_backend_pid())").await;

        assert_eq!((outcome(&result, 0)["kind"].as_str(), result.transaction), (Some("error"), TransactionStatus::Closed));
    }

    #[tokio::test]
    #[ignore = "needs TIDEWATER_TEST_DATABASE_URL pointing at a running Postgres"]
    async fn live_switching_database_is_refused_while_the_users_transaction_is_open_but_not_while_results_are_held() {
        let (sessions, _) = sessions();
        let mut other = live_params();
        other.database = "template1".into();
        run(&sessions, "BEGIN").await;

        let refused = sessions.run("tab", "server-a", &other, "SELECT 1").await;
        assert_eq!(refused.map_err(kind), Err("invalid".into()));

        run(&sessions, "ROLLBACK; SELECT g FROM generate_series(1, 600) g").await;
        let switched = sessions.run("tab", "server-a", &other, "SELECT current_database()").await.unwrap();
        assert_eq!((cell(&switched, 0), switched.session_replaced), (json!("template1"), false));
    }

    #[tokio::test]
    #[ignore = "needs TIDEWATER_TEST_DATABASE_URL pointing at a running Postgres"]
    async fn live_idle_results_close_after_the_servers_timeout_and_the_tab_hears_it_once() {
        let (sessions, mut closed) = sessions();
        sessions.run("tab", "server-a", &timed_out_after(50), "SELECT g FROM generate_series(1, 1600) g").await.unwrap();
        sessions.fetch_more("tab").await.unwrap();

        let heard = tokio::time::timeout(Duration::from_secs(5), closed.recv()).await.unwrap();
        tokio::time::sleep(Duration::from_millis(200)).await;

        assert_eq!((heard.as_deref(), closed.try_recv().ok()), (Some("tab"), None));
        assert_eq!(sessions.fetch_more("tab").await.map_err(kind), Err("invalid".into()));
    }

    #[tokio::test]
    #[ignore = "needs TIDEWATER_TEST_DATABASE_URL pointing at a running Postgres"]
    async fn live_a_closed_tabs_timer_does_nothing() {
        let (sessions, mut closed) = sessions();
        sessions.run("tab", "server-a", &timed_out_after(50), "SELECT g FROM generate_series(1, 600) g").await.unwrap();

        sessions.close("tab");
        tokio::time::sleep(Duration::from_millis(300)).await;

        assert_eq!(closed.try_recv().ok(), None);
    }

    #[tokio::test(flavor = "multi_thread")]
    #[ignore = "needs TIDEWATER_TEST_DATABASE_URL pointing at a running Postgres"]
    async fn live_cancel_stops_the_running_statement_and_the_tab_stays_usable() {
        let (sessions, _) = sessions();
        run(&sessions, "SELECT 1").await;
        let running = tokio::spawn({
            let sessions = sessions.clone();
            async move { run(&sessions, "SELECT pg_sleep(30)").await }
        });
        tokio::time::sleep(Duration::from_millis(300)).await;

        sessions.cancel("tab").await.unwrap();

        let result = tokio::time::timeout(Duration::from_secs(5), running).await.unwrap().unwrap();
        assert_eq!(error(&result, 0), json!(["57014", null]));
        assert_eq!(run(&sessions, "SELECT 1").await.transaction, TransactionStatus::Idle);
    }

    #[tokio::test]
    #[ignore = "needs TIDEWATER_TEST_DATABASE_URL pointing at a running Postgres"]
    async fn live_closing_a_server_ends_only_its_own_tabs() {
        let (sessions, _) = sessions();
        sessions.run("a", "server-a", &live_params(), "SELECT 1").await.unwrap();
        sessions.run("b", "server-b", &live_params(), "SELECT 1").await.unwrap();

        sessions.close_server("server-a").await;

        assert_eq!(sessions.tabs.lock().unwrap().keys().collect::<Vec<_>>(), ["b"]);
    }

    #[tokio::test]
    #[ignore = "needs TIDEWATER_TEST_DATABASE_URL pointing at a running Postgres"]
    async fn live_a_dropped_connection_fails_each_step_with_a_message_and_no_code() {
        let mut session = open_session("server-a", &live_params()).await.unwrap();
        session.driver.abort();
        let _ = (&mut session.driver).await;
        let statement = split::split("SELECT 1").remove(0);

        let outcome = run_statement(&mut session, &statement, true, 1).await;

        assert_eq!(serde_json::to_value(&outcome).unwrap()["error"]["code"], Value::Null);
        assert_eq!(stream_rows(&session.client, "SELECT 1").await.map_err(|error| error.is_closed()), Err(true));
        assert_eq!(fetch(&session.client, 1).await.map_err(|error| error.is_closed()), Err(true));
        assert_eq!(session.transaction().await, TransactionStatus::Closed);
    }
}
