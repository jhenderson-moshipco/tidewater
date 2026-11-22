//! Helpers shared by the unit tests.

use std::sync::Once;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

use crate::connections::ConnectParams;
use crate::connections::url::parse_connection_string;
use crate::error::CommandError;
use crate::servers::model::{SessionDefaults, TlsMode};

/// Points every keyring entry at the in-memory mock, so no test reads the real system keychain.
pub fn mock_keychain() {
    static MOCK: Once = Once::new();
    MOCK.call_once(|| keyring::set_default_credential_builder(keyring::mock::default_credential_builder()));
}

/// The server in `TIDEWATER_TEST_DATABASE_URL`, used by the tests marked ignored.
pub fn live_params() -> ConnectParams {
    let url = std::env::var("TIDEWATER_TEST_DATABASE_URL").expect("set TIDEWATER_TEST_DATABASE_URL to run the live tests");
    let parsed = parse_connection_string(&url).expect("TIDEWATER_TEST_DATABASE_URL should parse");
    ConnectParams {
        host: parsed.host.expect("TIDEWATER_TEST_DATABASE_URL needs a host"),
        port: parsed.port.expect("TIDEWATER_TEST_DATABASE_URL needs a port"),
        database: parsed.database.expect("TIDEWATER_TEST_DATABASE_URL needs a database"),
        user: parsed.user.expect("TIDEWATER_TEST_DATABASE_URL needs a user"),
        password: parsed.password,
        tls: parsed.tls.expect("TIDEWATER_TEST_DATABASE_URL needs an sslmode"),
        session: SessionDefaults::default(),
    }
}

/// Parameters for a local port that nothing listens on.
pub async fn closed_port() -> ConnectParams {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    drop(listener);
    local_params(port)
}

fn local_params(port: u16) -> ConnectParams {
    ConnectParams {
        host: "127.0.0.1".into(),
        port,
        database: "postgres".into(),
        user: "tidewater".into(),
        password: None,
        tls: TlsMode::Disable,
        session: SessionDefaults::default(),
    }
}

#[derive(Clone, Copy)]
pub enum FakeServer {
    /// Answers the startup message with a fatal error carrying this SQLSTATE.
    RejectStartup(&'static str),
    /// Signs the client in, then fails its first query.
    FailFirstQuery,
}

fn message(tag: u8, body: &[u8]) -> Vec<u8> {
    let length = i32::try_from(body.len() + 4).unwrap();
    let mut out = vec![tag];
    out.extend_from_slice(&length.to_be_bytes());
    out.extend_from_slice(body);
    out
}

fn error_response(severity: &str, code: &str, text: &str, detail: Option<&str>) -> Vec<u8> {
    let mut fields = vec![(b'S', severity), (b'V', severity), (b'C', code), (b'M', text)];
    fields.extend(detail.map(|detail| (b'D', detail)));
    let mut body = Vec::new();
    for (field, value) in fields {
        body.push(field);
        body.extend_from_slice(value.as_bytes());
        body.push(0);
    }
    body.push(0);
    message(b'E', &body)
}

async fn answer(mut socket: TcpStream, behaviour: FakeServer) {
    let mut length = [0u8; 4];
    if socket.read_exact(&mut length).await.is_err() {
        return;
    }
    let mut startup = vec![0u8; usize::try_from(i32::from_be_bytes(length)).unwrap() - 4];
    socket.read_exact(&mut startup).await.unwrap();
    let reply = match behaviour {
        FakeServer::RejectStartup(code) => error_response("FATAL", code, "rejected", None),
        FakeServer::FailFirstQuery => {
            let mut signed_in = message(b'R', &0i32.to_be_bytes());
            signed_in.extend(message(b'Z', b"I"));
            socket.write_all(&signed_in).await.unwrap();
            let _ = socket.read(&mut [0u8; 1024]).await.unwrap();
            let mut failed = error_response("ERROR", "XX000", "query failed", Some("from the fake server"));
            failed.extend(message(b'Z', b"I"));
            failed
        }
    };
    socket.write_all(&reply).await.unwrap();
    let _ = socket.read(&mut [0u8; 1024]).await;
}

/// A local server that speaks just enough of the Postgres protocol to fail in the chosen way.
pub async fn fake_server(behaviour: FakeServer) -> ConnectParams {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        loop {
            let (socket, _) = listener.accept().await.unwrap();
            tokio::spawn(answer(socket, behaviour));
        }
    });
    local_params(port)
}

/// The error's kind and message, as the frontend receives them.
pub fn parts(error: CommandError) -> (String, String) {
    let value = serde_json::to_value(error).unwrap();
    (value["kind"].as_str().unwrap().to_string(), value["message"].as_str().unwrap().to_string())
}
