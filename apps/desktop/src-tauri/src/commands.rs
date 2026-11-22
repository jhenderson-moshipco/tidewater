//! The commands the frontend calls through `invoke`.

use tauri::State;

use crate::catalog::{self, CatalogNode, CatalogPath};
use crate::connections::probe::{ProbeResult, probe};
use crate::connections::url::{ParsedConnection, parse_connection_string};
use crate::connections::{ConnectParams, ConnectionInfo, ConnectionManager};
use crate::error::CommandError;
use crate::query::split::{self, StatementSpan};
use crate::query::{QuerySessions, RowBatch, RunResult};
use crate::servers::model::{GroupInput, PasswordChange, ServerGroup, ServerInput, ServerListView, ServerSummary};
use crate::servers::store::{ServerStore, StoreStatusView};
use crate::servers::vault::OsKeychain;

pub type Store = ServerStore<OsKeychain>;

#[tauri::command(async)]
pub fn store_status(store: State<'_, Store>) -> StoreStatusView {
    store.status()
}

#[tauri::command(async)]
pub fn unlock_store(store: State<'_, Store>, passphrase: String) -> Result<StoreStatusView, CommandError> {
    store.unlock_with_passphrase(&passphrase)
}

#[tauri::command(async)]
pub fn start_fresh_store(store: State<'_, Store>) -> Result<StoreStatusView, CommandError> {
    store.start_fresh()
}

#[tauri::command(async)]
pub fn list_servers(store: State<'_, Store>) -> Result<ServerListView, CommandError> {
    store.read(|list| Ok(list.view()))
}

#[tauri::command(async)]
pub fn save_server(store: State<'_, Store>, input: ServerInput) -> Result<ServerSummary, CommandError> {
    store.update(|list| list.upsert_server(input))
}

#[tauri::command]
pub async fn delete_server(
    store: State<'_, Store>,
    connections: State<'_, ConnectionManager>,
    queries: State<'_, QuerySessions>,
    id: String,
) -> Result<(), CommandError> {
    store.update(|list| list.delete_server(&id))?;
    connections.disconnect(&id).await;
    queries.close_server(&id).await;
    Ok(())
}

#[tauri::command(async)]
pub fn save_group(store: State<'_, Store>, input: GroupInput) -> Result<ServerGroup, CommandError> {
    store.update(|list| list.upsert_group(input))
}

#[tauri::command(async)]
pub fn delete_group(store: State<'_, Store>, id: String) -> Result<(), CommandError> {
    store.update(|list| list.delete_group(&id))
}

#[tauri::command]
pub fn parse_connection(input: String) -> Result<ParsedConnection, CommandError> {
    parse_connection_string(&input)
}

#[tauri::command]
pub async fn test_connection(store: State<'_, Store>, input: ServerInput) -> Result<Vec<ProbeResult>, CommandError> {
    let password = match &input.password {
        PasswordChange::Set(password) => Some(password.clone()),
        PasswordChange::Clear => None,
        PasswordChange::Keep => store.read(|list| list.resolve_password(input.id.as_deref(), &input.password))?,
    };
    let params = ConnectParams {
        host: input.host.trim().to_string(),
        port: input.port,
        database: input.database.trim().to_string(),
        user: input.user.trim().to_string(),
        password,
        tls: input.tls,
        session: input.session,
    };
    Ok(probe(&params).await)
}

#[tauri::command]
pub async fn connect_server(store: State<'_, Store>, connections: State<'_, ConnectionManager>, id: String) -> Result<ConnectionInfo, CommandError> {
    let params = store.read(|list| Ok(ConnectParams::from(list.find(&id)?)))?;
    connections.connect(&id, params).await
}

#[tauri::command]
pub async fn disconnect_server(connections: State<'_, ConnectionManager>, id: String) -> Result<(), CommandError> {
    connections.disconnect(&id).await;
    Ok(())
}

#[tauri::command]
pub async fn list_connections(connections: State<'_, ConnectionManager>) -> Result<Vec<ConnectionInfo>, CommandError> {
    Ok(connections.list().await)
}

/// The children of a schema tree node, or the server's databases when `path` is empty. Opens the node's database lazily.
#[tauri::command(rename_all = "snake_case")]
pub async fn catalog_children(
    store: State<'_, Store>,
    connections: State<'_, ConnectionManager>,
    server_id: String,
    path: Option<CatalogPath>,
    show_system: bool,
) -> Result<Vec<CatalogNode>, CommandError> {
    let mut params = store.read(|list| Ok(ConnectParams::from(list.find(&server_id)?)))?;
    if let Some(path) = &path {
        params.database = path.database().to_string();
    }
    let client = connections.client(&server_id, &params).await?;
    let nodes = match &path {
        None => catalog::databases(&client).await,
        Some(path) => catalog::children(&client, path, show_system).await,
    };
    nodes.map_err(CommandError::from)
}

/// Where each statement in the editor text starts and ends.
#[tauri::command]
pub fn split_statements(sql: String) -> Vec<StatementSpan> {
    split::split(&sql).into_iter().map(|statement| statement.span).collect()
}

/// Runs the statements in `sql` on the tab's own session for this server and database.
#[tauri::command(rename_all = "snake_case")]
pub async fn run_query(
    store: State<'_, Store>,
    queries: State<'_, QuerySessions>,
    tab_id: String,
    server_id: String,
    database: String,
    sql: String,
) -> Result<RunResult, CommandError> {
    let mut params = store.read(|list| Ok(ConnectParams::from(list.find(&server_id)?)))?;
    params.database = database;
    queries.run(&tab_id, &server_id, &params, &sql).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn fetch_more_rows(queries: State<'_, QuerySessions>, tab_id: String) -> Result<RowBatch, CommandError> {
    queries.fetch_more(&tab_id).await
}

#[tauri::command(rename_all = "snake_case")]
pub async fn cancel_query(queries: State<'_, QuerySessions>, tab_id: String) -> Result<(), CommandError> {
    queries.cancel(&tab_id).await
}

#[tauri::command(rename_all = "snake_case")]
pub fn close_query_tab(queries: State<'_, QuerySessions>, tab_id: String) {
    queries.close(&tab_id);
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};
    use tauri::ipc::{CallbackFn, InvokeBody};
    use tauri::test::{INVOKE_KEY, MockRuntime, get_ipc_response, mock_builder, mock_context, noop_assets};
    use tauri::webview::InvokeRequest;
    use tauri::{App, WebviewWindow, WebviewWindowBuilder};

    use super::*;
    use crate::testing::{closed_port, mock_keychain};

    #[cfg(windows)]
    const APP_URL: &str = "http://tauri.localhost";
    #[cfg(not(windows))]
    const APP_URL: &str = "tauri://localhost";

    struct TestApp {
        app: App<MockRuntime>,
        window: WebviewWindow<MockRuntime>,
        _folder: tempfile::TempDir,
    }

    fn with_window(app: App<MockRuntime>, folder: tempfile::TempDir) -> TestApp {
        let window = WebviewWindowBuilder::new(&app, "main", Default::default()).build().unwrap();
        TestApp { app, window, _folder: folder }
    }

    /// The real app on Tauri's mock runtime, with its saved servers in a temporary folder.
    fn test_app() -> TestApp {
        mock_keychain();
        let folder = tempfile::tempdir().unwrap();
        let store = Store::new(folder.path().join("servers.json"), OsKeychain);
        let mut app = crate::with_commands(mock_builder().manage(store)).build(mock_context(noop_assets())).unwrap();
        crate::manage_state(&mut app).unwrap();
        with_window(app, folder)
    }

    impl TestApp {
        fn invoke(&self, command: &str, args: Value) -> Result<Value, Value> {
            let request = InvokeRequest {
                cmd: command.into(),
                callback: CallbackFn(0),
                error: CallbackFn(1),
                url: APP_URL.parse().unwrap(),
                body: InvokeBody::Json(args),
                headers: Default::default(),
                invoke_key: INVOKE_KEY.to_string(),
            };
            get_ipc_response(&self.window, request).map(|body| body.deserialize::<Value>().unwrap())
        }
    }

    fn server_input(id: Option<&str>, port: u16, password: Value) -> Value {
        json!({
            "id": id,
            "name": "orders-dev",
            "group_id": null,
            "environment": "dev",
            "host": "127.0.0.1",
            "port": port,
            "database": "postgres",
            "user": "tidewater",
            "password": password,
            "tls": "disable",
            "session": { "read_only": false, "statement_timeout_ms": null, "results_timeout_ms": 300_000 },
        })
    }

    fn kind(error: Value) -> String {
        error["kind"].as_str().unwrap().to_string()
    }

    #[test]
    fn servers_and_groups_are_saved_listed_and_deleted() {
        let app = test_app();
        assert_eq!(app.invoke("store_status", json!({})), Ok(json!({ "status": "unlocked", "has_saved_file": false, "reason": null })));

        let group = app.invoke("save_group", json!({ "input": { "id": null, "name": "Orders" } })).unwrap();
        let server = app.invoke("save_server", json!({ "input": server_input(None, 5432, json!({ "action": "keep" })) })).unwrap();
        let listed = app.invoke("list_servers", json!({})).unwrap();
        assert_eq!((listed["groups"].as_array().unwrap().len(), listed["servers"].as_array().unwrap().len()), (1, 1));

        assert_eq!(app.invoke("delete_group", json!({ "id": group["id"] })), Ok(Value::Null));
        assert_eq!(app.invoke("delete_server", json!({ "id": server["id"] })), Ok(Value::Null));
        assert_eq!(app.invoke("delete_server", json!({ "id": server["id"] })).map_err(kind), Err("not_found".into()));
    }

    #[test]
    fn unlocking_and_starting_fresh_are_refused_while_unlocked() {
        let app = test_app();
        assert_eq!(app.invoke("unlock_store", json!({ "passphrase": "correct horse battery" })).map_err(kind), Err("invalid".into()));
        assert_eq!(app.invoke("start_fresh_store", json!({})).map_err(kind), Err("invalid".into()));
    }

    fn refusal(app: &TestApp, command: &str) -> String {
        app.invoke(command, json!({})).unwrap_err().as_str().unwrap().to_string()
    }

    #[test]
    fn requests_a_command_cant_read_are_refused_without_running_it() {
        let no_state = with_window(crate::with_commands(mock_builder()).build(mock_context(noop_assets())).unwrap(), tempfile::tempdir().unwrap());
        let folder = tempfile::tempdir().unwrap();
        let store_only = mock_builder().manage(Store::new(folder.path().join("servers.json"), OsKeychain));
        let store_only = with_window(crate::with_commands(store_only).build(mock_context(noop_assets())).unwrap(), folder);
        let app = test_app();
        let with_arguments = [
            "unlock_store", "save_server", "delete_server", "save_group", "delete_group", "test_connection", "connect_server",
            "disconnect_server", "catalog_children", "run_query", "fetch_more_rows", "cancel_query", "close_query_tab",
        ];

        for command in ["store_status", "start_fresh_store", "list_servers", "list_connections"].iter().chain(&with_arguments) {
            assert!(refusal(&no_state, command).starts_with("state not managed"), "{command}");
        }
        for command in ["delete_server", "connect_server", "catalog_children"] {
            assert!(refusal(&store_only, command).starts_with("state not managed for field `connections`"), "{command}");
        }
        assert!(refusal(&store_only, "run_query").starts_with("state not managed for field `queries`"));
        for command in with_arguments {
            assert!(refusal(&app, command).contains("missing required key"), "{command}");
        }
        let unreadable_path = app.invoke("catalog_children", json!({ "server_id": "a", "path": "nowhere", "show_system": false }));
        assert!(unreadable_path.unwrap_err().as_str().unwrap().contains("path"));
        let no_toggle = app.invoke("catalog_children", json!({ "server_id": "a" }));
        assert!(no_toggle.unwrap_err().as_str().unwrap().contains("missing required key show_system"));
        for (keys, missing) in [(json!({ "tab_id": "a" }), "server_id"), (json!({ "tab_id": "a", "server_id": "b" }), "database")] {
            let refused = app.invoke("run_query", keys).unwrap_err();
            assert!(refused.as_str().unwrap().contains(&format!("missing required key {missing}")));
        }
        let no_sql = app.invoke("run_query", json!({ "tab_id": "a", "server_id": "b", "database": "c" }));
        assert!(no_sql.unwrap_err().as_str().unwrap().contains("missing required key sql"));
        assert_eq!(app.invoke("list_servers", json!({})), Ok(json!({ "groups": [], "servers": [] })));
    }
    #[test]
    fn a_pasted_connection_string_is_parsed() {
        let app = test_app();
        let parsed = app.invoke("parse_connection", json!({ "input": "postgres://app@db.internal/orders" })).unwrap();
        assert_eq!((parsed["host"].as_str(), parsed["user"].as_str()), (Some("db.internal"), Some("app")));
        assert_eq!(app.invoke("parse_connection", json!({ "input": "" })).map_err(kind), Err("invalid".into()));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn testing_a_connection_resolves_each_kind_of_password_change() {
        let app = test_app();
        let port = closed_port().await.port;
        let saved = app.invoke("save_server", json!({ "input": server_input(None, port, json!({ "action": "set", "value": "pw" })) })).unwrap();
        let id = saved["id"].as_str().unwrap();

        for password in [json!({ "action": "set", "value": "pw" }), json!({ "action": "clear" }), json!({ "action": "keep" })] {
            let steps = app.invoke("test_connection", json!({ "input": server_input(Some(id), port, password) })).unwrap();
            assert_eq!(steps[1]["outcome"], "failed");
        }
        let unknown = server_input(Some("missing"), port, json!({ "action": "keep" }));
        assert_eq!(app.invoke("test_connection", json!({ "input": unknown })).map_err(kind), Err("not_found".into()));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn the_schema_tree_reports_unknown_and_unreachable_servers() {
        let app = test_app();
        let port = closed_port().await.port;
        let saved = app.invoke("save_server", json!({ "input": server_input(None, port, json!({ "action": "clear" })) })).unwrap();
        let path = json!({ "level": "database", "database": "orders" });

        let unknown = app.invoke("catalog_children", json!({ "server_id": "missing", "path": null, "show_system": false }));
        let unreachable = app.invoke("catalog_children", json!({ "server_id": saved["id"], "path": path, "show_system": false }));

        assert_eq!(unknown.map_err(kind), Err("not_found".into()));
        assert_eq!(unreachable.map_err(kind), Err("connection".into()));
    }

    #[tokio::test(flavor = "multi_thread")]
    #[ignore = "needs TIDEWATER_TEST_DATABASE_URL pointing at a running Postgres"]
    async fn live_the_schema_tree_lists_databases_then_their_schemas() {
        let app = test_app();
        let live = crate::testing::live_params();
        let mut input = server_input(None, live.port, json!({ "action": "set", "value": live.password }));
        input["host"] = json!(live.host);
        input["user"] = json!(live.user);
        input["database"] = json!(live.database);
        input["tls"] = json!("require");
        let id = app.invoke("save_server", json!({ "input": input })).unwrap()["id"].clone();

        let databases = app.invoke("catalog_children", json!({ "server_id": id, "path": null, "show_system": false })).unwrap();
        let path = json!({ "level": "database", "database": live.database });
        let schemas = app.invoke("catalog_children", json!({ "server_id": id, "path": path, "show_system": true })).unwrap();

        let labels = |nodes: &Value| nodes.as_array().unwrap().iter().map(|node| node["label"].as_str().unwrap().to_string()).collect::<Vec<_>>();
        assert!(labels(&databases).contains(&live.database));
        assert!(labels(&schemas).contains(&"pg_catalog".to_string()));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn connecting_reports_unknown_and_unreachable_servers() {
        let app = test_app();
        let port = closed_port().await.port;
        let saved = app.invoke("save_server", json!({ "input": server_input(None, port, json!({ "action": "clear" })) })).unwrap();

        assert_eq!(app.invoke("connect_server", json!({ "id": "missing" })).map_err(kind), Err("not_found".into()));
        assert_eq!(app.invoke("connect_server", json!({ "id": saved["id"] })).map_err(kind), Err("connection".into()));
        assert_eq!(app.invoke("disconnect_server", json!({ "id": saved["id"] })), Ok(Value::Null));
        assert_eq!(app.invoke("list_connections", json!({})), Ok(json!([])));
    }

    #[test]
    fn statements_are_split_into_editor_spans() {
        let app = test_app();
        let spans = app.invoke("split_statements", json!({ "sql": "SELECT 1; SELECT ';'" })).unwrap();
        assert_eq!(spans, json!([{ "from": 0, "to": 8 }, { "from": 10, "to": 20 }]));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn a_query_on_an_unknown_server_is_not_found_and_an_idle_tab_closes_quietly() {
        let app = test_app();
        let run = json!({ "tab_id": "tab", "server_id": "missing", "database": "postgres", "sql": "SELECT 1" });

        assert_eq!(app.invoke("run_query", run).map_err(kind), Err("not_found".into()));
        assert_eq!(app.invoke("fetch_more_rows", json!({ "tab_id": "tab" })).map_err(kind), Err("invalid".into()));
        assert_eq!(app.invoke("cancel_query", json!({ "tab_id": "tab" })), Ok(Value::Null));
        assert_eq!(app.invoke("close_query_tab", json!({ "tab_id": "tab" })), Ok(Value::Null));
    }

    #[tokio::test(flavor = "multi_thread")]
    #[ignore = "needs TIDEWATER_TEST_DATABASE_URL pointing at a running Postgres"]
    async fn live_a_query_tab_runs_fetches_more_and_hears_its_idle_results_close() {
        use tauri::Listener;

        let app = test_app();
        let live = crate::testing::live_params();
        let mut input = server_input(None, live.port, json!({ "action": "set", "value": live.password }));
        input["host"] = json!(live.host);
        input["user"] = json!(live.user);
        input["tls"] = json!("require");
        input["session"]["results_timeout_ms"] = json!(100);
        let id = app.invoke("save_server", json!({ "input": input })).unwrap()["id"].clone();
        let (sender, mut closed) = tokio::sync::mpsc::unbounded_channel();
        app.app.listen(crate::RESULTS_CLOSED_EVENT, move |event| sender.send(event.payload().to_string()).unwrap());
        let sql = "SELECT g FROM generate_series(1, 1200) g";

        let run = app.invoke("run_query", json!({ "tab_id": "tab", "server_id": id, "database": live.database, "sql": sql })).unwrap();
        let more = app.invoke("fetch_more_rows", json!({ "tab_id": "tab" })).unwrap();

        assert_eq!((run["transaction"].as_str(), run["statements"][0]["outcome"]["has_more"].as_bool()), (Some("holding_results"), Some(true)));
        assert_eq!(more["rows"][0][0], "501");
        let heard = tokio::time::timeout(std::time::Duration::from_secs(5), closed.recv()).await.unwrap();
        assert_eq!(heard.as_deref(), Some("\"tab\""));
        assert_eq!(app.invoke("delete_server", json!({ "id": id })), Ok(Value::Null));
    }
}
