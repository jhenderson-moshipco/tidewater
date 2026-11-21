//! Live database connections, kept by saved-server id.

pub mod probe;
pub mod tls;
pub mod url;

use std::collections::HashMap;
use std::error::Error as _;
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

fn build_config(params: &ConnectParams) -> Config {
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

enum OpenError {
    Setup(CommandError),
    Postgres(tokio_postgres::Error),
}

async fn open(params: &ConnectParams) -> Result<(Client, JoinHandle<()>), OpenError> {
    let connector = tls::connector(params.tls).map_err(OpenError::Setup)?;
    let (client, connection) = build_config(params).connect(connector).await.map_err(OpenError::Postgres)?;
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

struct LiveConnection {
    client: Client,
    driver: JoinHandle<()>,
    info: ConnectionInfo,
}

#[derive(Default)]
pub struct ConnectionManager {
    live: tokio::sync::Mutex<HashMap<String, LiveConnection>>,
}

impl ConnectionManager {
    pub async fn connect(&self, server_id: &str, params: ConnectParams) -> Result<ConnectionInfo, CommandError> {
        if let Some(existing) = self.live.lock().await.get(server_id) {
            if !existing.client.is_closed() {
                return Ok(existing.info.clone());
            }
        }
        let (client, driver) = open(&params).await.map_err(|error| match error {
            OpenError::Setup(error) => error,
            OpenError::Postgres(error) => CommandError::Connection(describe(&error)),
        })?;
        let (server_version, encryption) = session_info(&client).await.map_err(|error| {
            driver.abort();
            CommandError::Connection(describe(&error))
        })?;
        let info = ConnectionInfo { server_id: server_id.to_string(), server_version, encryption };
        let mut live = self.live.lock().await;
        if let Some(previous) = live.insert(server_id.to_string(), LiveConnection { client, driver, info: info.clone() }) {
            previous.driver.abort();
        }
        Ok(info)
    }

    pub async fn disconnect(&self, server_id: &str) {
        if let Some(connection) = self.live.lock().await.remove(server_id) {
            connection.driver.abort();
        }
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

    #[test]
    fn session_options_are_empty_without_defaults() {
        assert_eq!(session_options(&SessionDefaults::default()), "");
    }

    fn live_params() -> Option<ConnectParams> {
        let url = std::env::var("TIDEWATER_TEST_DATABASE_URL").ok()?;
        let parsed = url::parse_connection_string(&url).expect("TIDEWATER_TEST_DATABASE_URL should parse");
        Some(ConnectParams {
            host: parsed.host.unwrap_or_else(|| "localhost".into()),
            port: parsed.port.unwrap_or(5432),
            database: parsed.database.unwrap_or_else(|| "postgres".into()),
            user: parsed.user.unwrap_or_else(|| "postgres".into()),
            password: parsed.password,
            tls: parsed.tls.unwrap_or_default(),
            session: SessionDefaults::default(),
        })
    }

    #[tokio::test]
    #[ignore = "needs TIDEWATER_TEST_DATABASE_URL pointing at a running Postgres"]
    async fn live_connect_lists_and_disconnects() {
        let manager = ConnectionManager::default();
        let info = manager.connect("server-a", live_params().expect("set TIDEWATER_TEST_DATABASE_URL")).await.unwrap();
        assert!(!info.server_version.is_empty());
        assert_eq!(manager.list().await, vec![info]);

        manager.disconnect("server-a").await;
        assert!(manager.list().await.is_empty());
    }

    #[tokio::test]
    #[ignore = "needs TIDEWATER_TEST_DATABASE_URL pointing at a running Postgres"]
    async fn live_session_defaults_reach_the_server() {
        let mut params = live_params().expect("set TIDEWATER_TEST_DATABASE_URL");
        params.session = SessionDefaults { read_only: true, statement_timeout_ms: Some(15_000) };
        let Ok((client, driver)) = open(&params).await else { panic!("couldn't connect") };
        let row = client
            .query_one("SELECT current_setting('default_transaction_read_only'), current_setting('statement_timeout')", &[])
            .await
            .unwrap();
        assert_eq!(row.get::<_, String>(0), "on");
        assert_eq!(row.get::<_, String>(1), "15s");
        driver.abort();
    }

    #[test]
    fn session_options_set_read_only_and_statement_timeout() {
        let session = SessionDefaults { read_only: true, statement_timeout_ms: Some(15_000) };
        assert_eq!(session_options(&session), "-c default_transaction_read_only=on -c statement_timeout=15000");
    }
}
