//! Live database connections, kept per saved server and database.

pub mod probe;
pub mod tls;
pub mod url;

use std::collections::HashMap;
use std::error::Error as _;
use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use tauri::async_runtime::JoinHandle;
use tokio_postgres::{Client, Config};
use ts_rs::TS;

use crate::error::CommandError;
use crate::servers::model::{SavedServer, SessionDefaults, TlsMode};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConnectParams {
    pub host: String,
    pub port: u16,
    pub database: String,
    pub user: String,
    pub password: Option<String>,
    pub tls: TlsMode,
    pub session: SessionDefaults,
}

impl From<&SavedServer> for ConnectParams {
    fn from(server: &SavedServer) -> Self {
        ConnectParams {
            host: server.host.clone(),
            port: server.port,
            database: server.database.clone(),
            user: server.user.clone(),
            password: server.password.clone(),
            tls: server.tls,
            session: server.session.clone(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[ts(export, export_to = "connections.ts")]
pub struct ConnectionInfo {
    pub server_id: String,
    pub database: String,
    pub server_version: String,
    pub encryption: Option<String>,
}

/// Server startup options for the session defaults, passed the same way as libpq's `options`.
pub fn session_options(session: &SessionDefaults) -> String {
    let mut parts = Vec::new();
    if session.read_only {
        parts.push("-c default_transaction_read_only=on".to_string());
    }
    if let Some(milliseconds) = session.statement_timeout_ms {
        parts.push(format!("-c statement_timeout={milliseconds}"));
    }
    parts.join(" ")
}

pub(crate) fn build_config(params: &ConnectParams) -> Config {
    let mut config = Config::new();
    config
        .host(&params.host)
        .port(params.port)
        .dbname(&params.database)
        .user(&params.user)
        .application_name("Tidewater")
        .connect_timeout(CONNECT_TIMEOUT)
        .ssl_mode(tls::ssl_mode(params.tls));
    if let Some(password) = &params.password {
        config.password(password);
    }
    let options = session_options(&params.session);
    if !options.is_empty() {
        config.options(options);
    }
    config
}

impl From<tokio_postgres::Error> for CommandError {
    fn from(error: tokio_postgres::Error) -> Self {
        CommandError::Connection(describe(&error))
    }
}

/// The error's message followed by every underlying cause.
pub fn describe(error: &tokio_postgres::Error) -> String {
    if let Some(database_error) = error.as_db_error() {
        return match database_error.detail() {
            Some(detail) => format!("{} ({detail})", database_error.message()),
            None => database_error.message().to_string(),
        };
    }
    let mut message = error.to_string();
    let mut source = error.source();
    while let Some(cause) = source {
        message.push_str(": ");
        message.push_str(&cause.to_string());
        source = cause.source();
    }
    message
}

pub(crate) async fn open(params: &ConnectParams) -> Result<(Client, JoinHandle<()>), tokio_postgres::Error> {
    let (client, connection) = build_config(params).connect(tls::connector(params.tls)).await?;
    let driver = tauri::async_runtime::spawn(async move {
        let _ = connection.await;
    });
    Ok((client, driver))
}

/// The server version and, when the session is encrypted, its TLS version.
async fn session_info(client: &Client) -> Result<(String, Option<String>), tokio_postgres::Error> {
    let row = client
        .query_one(
            "SELECT current_setting('server_version'), (SELECT version FROM pg_stat_ssl WHERE pid = pg_backend_pid())",
            &[],
        )
        .await?;
    Ok((row.get(0), row.get(1)))
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
struct Key {
    server_id: String,
    database: String,
}

struct LiveConnection {
    client: Arc<Client>,
    driver: JoinHandle<()>,
    info: ConnectionInfo,
}

#[derive(Default)]
pub struct ConnectionManager {
    live: tokio::sync::Mutex<HashMap<Key, LiveConnection>>,
    /// Wakes a server's connects in progress so they give up.
    cancels: std::sync::Mutex<HashMap<String, Arc<tokio::sync::Notify>>>,
}

impl ConnectionManager {
    fn cancel_signal(&self, server_id: &str) -> Arc<tokio::sync::Notify> {
        let mut cancels = self.cancels.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        cancels.entry(server_id.to_string()).or_default().clone()
    }

    /// Stops this server's connects in progress. Connections already open stay open.
    pub fn cancel(&self, server_id: &str) {
        self.cancel_signal(server_id).notify_waiters();
    }

    /// The open client for `params.database` on this server, connecting first if it isn't open or the server closed it.
    async fn ensure(&self, server_id: &str, params: &ConnectParams) -> Result<(Arc<Client>, ConnectionInfo), CommandError> {
        let key = Key { server_id: server_id.to_string(), database: params.database.clone() };
        if let Some(existing) = self.live.lock().await.get(&key) {
            if !existing.client.is_closed() {
                return Ok((existing.client.clone(), existing.info.clone()));
            }
        }
        let cancel = self.cancel_signal(server_id);
        let (client, driver) = tokio::select! {
            opened = open(params) => opened?,
            () = cancel.notified() => return Err(CommandError::Cancelled("Connecting was cancelled.".into())),
        };
        let (server_version, encryption) = session_info(&client).await.map_err(|error| {
            driver.abort();
            CommandError::from(error)
        })?;
        let info = ConnectionInfo { server_id: key.server_id.clone(), database: key.database.clone(), server_version, encryption };
        let client = Arc::new(client);
        let mut live = self.live.lock().await;
        if let Some(previous) = live.insert(key, LiveConnection { client: client.clone(), driver, info: info.clone() }) {
            previous.driver.abort();
        }
        Ok((client, info))
    }

    pub async fn connect(&self, server_id: &str, params: ConnectParams) -> Result<ConnectionInfo, CommandError> {
        Ok(self.ensure(server_id, &params).await?.1)
    }

    pub async fn client(&self, server_id: &str, params: &ConnectParams) -> Result<Arc<Client>, CommandError> {
        Ok(self.ensure(server_id, params).await?.0)
    }

    /// Closes every database connection open for this server.
    pub async fn disconnect(&self, server_id: &str) {
        self.live.lock().await.retain(|key, connection| {
            if key.server_id != server_id {
                return true;
            }
            connection.driver.abort();
            false
        });
    }

    pub async fn list(&self) -> Vec<ConnectionInfo> {
        self.live
            .lock()
            .await
            .values()
            .filter(|connection| !connection.client.is_closed())
            .map(|connection| connection.info.clone())
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::{FakeServer, closed_port, fake_server, live_params};

    #[test]
    fn session_options_are_empty_without_defaults() {
        assert_eq!(session_options(&SessionDefaults::default()), "");
    }

    #[test]
    fn session_options_set_read_only_and_statement_timeout() {
        let session = SessionDefaults { read_only: true, statement_timeout_ms: Some(15_000), ..SessionDefaults::default() };
        assert_eq!(session_options(&session), "-c default_transaction_read_only=on -c statement_timeout=15000");
    }

    #[tokio::test]
    async fn a_config_sends_the_password_and_options_only_when_set() {
        let mut params = closed_port().await;
        let bare = build_config(&params);
        assert_eq!((bare.get_password(), bare.get_options()), (None, None));
        assert_eq!(bare.get_application_name(), Some("Tidewater"));

        params.password = Some("s3cret".into());
        params.session.read_only = true;
        let full = build_config(&params);

        assert_eq!(full.get_password(), Some(b"s3cret".as_slice()));
        assert_eq!(full.get_options(), Some("-c default_transaction_read_only=on"));
    }

    #[tokio::test]
    async fn a_refused_connection_describes_the_error_and_its_cause() {
        let manager = ConnectionManager::default();

        let (kind, message) = crate::testing::parts(manager.connect("server-a", closed_port().await).await.unwrap_err());

        assert_eq!(kind, "connection");
        assert!(message.starts_with("error connecting to server: "), "{message}");
        assert!(manager.list().await.is_empty());
    }

    #[tokio::test]
    async fn a_session_whose_first_query_fails_is_not_kept() {
        let manager = ConnectionManager::default();

        let refused = manager.connect("server-a", fake_server(FakeServer::FailFirstQuery).await).await;

        assert_eq!(refused, Err(CommandError::Connection("query failed (from the fake server)".into())));
        assert!(manager.list().await.is_empty());
    }

    #[tokio::test]
    async fn cancelling_stops_a_connect_that_is_waiting_on_the_server() {
        let manager = ConnectionManager::default();
        let params = fake_server(FakeServer::Silent).await;

        let (refused, ()) = tokio::join!(manager.connect("server-a", params), async {
            tokio::time::sleep(Duration::from_millis(100)).await;
            manager.cancel("server-a");
        });

        assert_eq!(refused, Err(CommandError::Cancelled("Connecting was cancelled.".into())));
        assert!(manager.list().await.is_empty());
        manager.cancel("server-b");
    }

    #[tokio::test]
    async fn disconnecting_a_server_that_isnt_connected_does_nothing() {
        let manager = ConnectionManager::default();
        manager.disconnect("server-a").await;
        assert!(manager.list().await.is_empty());
    }

    #[tokio::test]
    #[ignore = "needs TIDEWATER_TEST_DATABASE_URL pointing at a running Postgres"]
    async fn live_connect_lists_and_disconnects() {
        let manager = ConnectionManager::default();
        let info = manager.connect("server-a", live_params()).await.unwrap();
        assert!(!info.server_version.is_empty());
        assert_eq!(manager.list().await, vec![info]);

        manager.disconnect("server-a").await;
        assert!(manager.list().await.is_empty());
    }

    #[tokio::test]
    #[ignore = "needs TIDEWATER_TEST_DATABASE_URL pointing at a running Postgres"]
    async fn live_connecting_again_reuses_an_open_session() {
        let manager = ConnectionManager::default();
        let first = manager.connect("server-a", live_params()).await.unwrap();

        let second = manager.connect("server-a", live_params()).await.unwrap();

        assert_eq!(second, first);
        assert_eq!(manager.list().await.len(), 1);
        manager.disconnect("server-a").await;
    }

    #[tokio::test]
    #[ignore = "needs TIDEWATER_TEST_DATABASE_URL pointing at a running Postgres"]
    async fn live_connecting_again_replaces_a_session_the_server_closed() {
        let manager = ConnectionManager::default();
        manager.connect("server-a", live_params()).await.unwrap();
        let key = Key { server_id: "server-a".into(), database: live_params().database };
        let pid: i32 = manager.live.lock().await[&key].client.query_one("SELECT pg_backend_pid()", &[]).await.unwrap().get(0);
        let (admin, admin_driver) = open(&live_params()).await.unwrap();
        admin.execute("SELECT pg_terminate_backend($1)", &[&pid]).await.unwrap();
        (&mut manager.live.lock().await.get_mut(&key).unwrap().driver).await.unwrap();
        assert!(manager.list().await.is_empty());

        manager.connect("server-a", live_params()).await.unwrap();

        assert_eq!(manager.list().await.len(), 1);
        manager.disconnect("server-a").await;
        admin_driver.abort();
    }

    #[tokio::test]
    #[ignore = "needs TIDEWATER_TEST_DATABASE_URL pointing at a running Postgres"]
    async fn live_disconnect_closes_every_database_of_a_server() {
        let manager = ConnectionManager::default();
        let params = live_params();
        let mut second = params.clone();
        second.database = "template1".into();
        manager.client("server-a", &params).await.unwrap();
        manager.client("server-a", &second).await.unwrap();
        manager.client("server-b", &params).await.unwrap();
        assert_eq!(manager.list().await.len(), 3);

        manager.disconnect("server-a").await;

        let remaining = manager.list().await;
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0].server_id, "server-b");
    }

    #[tokio::test]
    #[ignore = "needs TIDEWATER_TEST_DATABASE_URL pointing at a running Postgres"]
    async fn live_session_defaults_reach_the_server() {
        let mut params = live_params();
        params.session = SessionDefaults { read_only: true, statement_timeout_ms: Some(15_000), ..SessionDefaults::default() };
        let (client, driver) = open(&params).await.unwrap();
        let row = client
            .query_one("SELECT current_setting('default_transaction_read_only'), current_setting('statement_timeout')", &[])
            .await
            .unwrap();
        assert_eq!(row.get::<_, String>(0), "on");
        assert_eq!(row.get::<_, String>(1), "15s");
        driver.abort();
    }
}
