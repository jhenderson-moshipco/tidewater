//! The commands the frontend calls through `invoke`.

use tauri::State;

use crate::catalog::{self, CatalogNode, CatalogPath};
use crate::connections::probe::{ProbeResult, probe};
use crate::connections::url::{ParsedConnection, parse_connection_string};
use crate::connections::{ConnectParams, ConnectionInfo, ConnectionManager};
use crate::error::CommandError;
use crate::objects::model::{AvailableExtension, ChangeOptions, ChangePlan, ExtrasChange, ExtrasRead, ObjectDefinition, ObjectRef, ObjectType};
use crate::objects::{self, ApplyOutcome};
use crate::files::drafts::{DraftSnapshot, DraftStore, RestoredTabs};
use crate::files::{self, FileStamp, OpenedFile, SaveOutcome};
use crate::query::split::{self, StatementSpan};
use crate::query::{QuerySessions, RowBatch, RunResult};
use crate::servers::model::{GroupInput, PasswordChange, ServerGroup, ServerInput, ServerListView, ServerSummary};
use crate::servers::store::{ServerStore, StoreStatusView};
use crate::servers::vault::{AppVault, KeyStorage};

pub type Store = ServerStore<AppVault>;

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

/// Stops a connect to this server that is still in progress.
#[tauri::command]
pub fn cancel_connect(connections: State<'_, ConnectionManager>, id: String) {
    connections.cancel(&id);
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

/// The server's connection settings, pointed at `database`.
fn params_for(store: &Store, server_id: &str, database: &str) -> Result<ConnectParams, CommandError> {
    let mut params = store.read(|list| Ok(ConnectParams::from(list.find(server_id)?)))?;
    params.database = database.to_string();
    Ok(params)
}

/// The extensions the server can install, with their versions.
#[tauri::command(rename_all = "snake_case")]
pub async fn available_extensions(
    store: State<'_, Store>,
    connections: State<'_, ConnectionManager>,
    server_id: String,
    database: String,
) -> Result<Vec<AvailableExtension>, CommandError> {
    let client = connections.client(&server_id, &params_for(&store, &server_id, &database)?).await?;
    objects::available_extensions(&client).await
}

/// An object's grants, owner and triggers, or with no object what a new one of `object_type` starts with.
#[tauri::command(rename_all = "snake_case")]
pub async fn object_extras(
    store: State<'_, Store>,
    connections: State<'_, ConnectionManager>,
    server_id: String,
    database: String,
    object: Option<ObjectRef>,
    object_type: ObjectType,
) -> Result<ExtrasRead, CommandError> {
    let client = connections.client(&server_id, &params_for(&store, &server_id, &database)?).await?;
    objects::object_extras(&client, object.as_ref(), object_type).await
}

/// The database's trigger functions, for a trigger to call.
#[tauri::command(rename_all = "snake_case")]
pub async fn list_trigger_functions(
    store: State<'_, Store>,
    connections: State<'_, ConnectionManager>,
    server_id: String,
    database: String,
) -> Result<Vec<String>, CommandError> {
    let client = connections.client(&server_id, &params_for(&store, &server_id, &database)?).await?;
    objects::trigger_functions(&client).await
}

/// The server's roles, for choosing an owner.
#[tauri::command(rename_all = "snake_case")]
pub async fn list_roles(
    store: State<'_, Store>,
    connections: State<'_, ConnectionManager>,
    server_id: String,
    database: String,
) -> Result<Vec<String>, CommandError> {
    let client = connections.client(&server_id, &params_for(&store, &server_id, &database)?).await?;
    objects::role_names(&client).await
}

/// The user's schemas in a database, for choosing where an object goes.
#[tauri::command(rename_all = "snake_case")]
pub async fn list_schemas(
    store: State<'_, Store>,
    connections: State<'_, ConnectionManager>,
    server_id: String,
    database: String,
) -> Result<Vec<String>, CommandError> {
    let client = connections.client(&server_id, &params_for(&store, &server_id, &database)?).await?;
    objects::schema_names(&client).await
}

/// An object's current definition, for its editor.
#[tauri::command(rename_all = "snake_case")]
pub async fn object_definition(
    store: State<'_, Store>,
    connections: State<'_, ConnectionManager>,
    server_id: String,
    object: ObjectRef,
) -> Result<ObjectDefinition, CommandError> {
    let client = connections.client(&server_id, &params_for(&store, &server_id, &object.database)?).await?;
    objects::definition(&client, &object).await
}

/// The DDL an editor's change needs: a create when there is no original, a drop when there is no change.
#[tauri::command(rename_all = "snake_case")]
#[allow(clippy::too_many_arguments)]
pub async fn plan_object_change(
    store: State<'_, Store>,
    connections: State<'_, ConnectionManager>,
    server_id: String,
    database: String,
    object: Option<ObjectRef>,
    original: Option<ObjectDefinition>,
    changed: Option<ObjectDefinition>,
    options: ChangeOptions,
    extras: Option<ExtrasChange>,
) -> Result<ChangePlan, CommandError> {
    let client = connections.client(&server_id, &params_for(&store, &server_id, &database)?).await?;
    objects::plan(&client, object.as_ref(), original.as_ref(), changed.as_ref(), options, extras.as_ref()).await
}

/// Runs a plan's statements in one transaction, rolling all of them back if one fails, then each after-commit statement.
/// When the plan drops or renames a database, Tidewater's own connections and query tabs on it close first.
#[tauri::command(rename_all = "snake_case")]
#[allow(clippy::too_many_arguments)]
pub async fn apply_object_change(
    store: State<'_, Store>,
    connections: State<'_, ConnectionManager>,
    queries: State<'_, QuerySessions>,
    server_id: String,
    database: String,
    statements: Vec<String>,
    after_commit: Vec<String>,
    closes_database: Option<String>,
) -> Result<ApplyOutcome, CommandError> {
    let params = params_for(&store, &server_id, &database)?;
    if let Some(closed) = &closes_database {
        connections.disconnect_database(&server_id, closed).await;
        queries.close_database(&server_id, closed).await;
    }
    objects::apply(&params, &statements, &after_commit).await
}

/// Where the key for the saved servers is kept: a file only this user can read, or the system keychain.
#[tauri::command(async)]
pub fn key_storage(store: State<'_, Store>) -> KeyStorage {
    store.vault().storage()
}

/// Moves the key for the saved servers to `storage`, keeping only one copy.
#[tauri::command(async)]
pub fn set_key_storage(store: State<'_, Store>, storage: KeyStorage) -> Result<(), CommandError> {
    store.vault().set_storage(storage).map_err(CommandError::Storage)
}

#[tauri::command(async)]
pub fn read_sql_file(path: String) -> Result<OpenedFile, CommandError> {
    files::read_sql_file(std::path::Path::new(&path))
}

/// Saves the tab's text. With `expected`, saves only if no other program has changed the file since.
#[tauri::command(async)]
pub fn write_sql_file(path: String, text: String, expected: Option<FileStamp>) -> Result<SaveOutcome, CommandError> {
    files::write_sql_file(std::path::Path::new(&path), &text, expected)
}

#[tauri::command(async)]
pub fn load_tab_drafts(drafts: State<'_, DraftStore>) -> Result<RestoredTabs, CommandError> {
    drafts.load()
}

#[tauri::command(async)]
pub fn save_tab_drafts(drafts: State<'_, DraftStore>, snapshot: DraftSnapshot) -> Result<(), CommandError> {
    drafts.save(snapshot)
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};
    use tauri::ipc::{CallbackFn, InvokeBody};
    use tauri::test::{INVOKE_KEY, MockRuntime, get_ipc_response, mock_builder, mock_context, noop_assets};
    use tauri::webview::InvokeRequest;
    use tauri::{App, WebviewWindow, WebviewWindowBuilder};

    use super::*;
    use crate::servers::vault::OsKeychain;
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
        let store = Store::new(folder.path().join("servers.json"), AppVault::new(folder.path(), Box::new(OsKeychain)));
        let drafts = DraftStore::new(folder.path().join("tabs.json"));
        let mut app = crate::with_commands(mock_builder().manage(store).manage(drafts)).build(mock_context(noop_assets())).unwrap();
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
        let store_only = mock_builder().manage(Store::new(folder.path().join("servers.json"), AppVault::new(folder.path(), Box::new(OsKeychain))));
        let store_only = with_window(crate::with_commands(store_only).build(mock_context(noop_assets())).unwrap(), folder);
        let folder = tempfile::tempdir().unwrap();
        let without_queries = mock_builder()
            .manage(Store::new(folder.path().join("servers.json"), AppVault::new(folder.path(), Box::new(OsKeychain))))
            .manage(ConnectionManager::default());
        let without_queries = with_window(crate::with_commands(without_queries).build(mock_context(noop_assets())).unwrap(), folder);
        let app = test_app();
        let with_arguments = [
            "unlock_store", "save_server", "delete_server", "save_group", "delete_group", "test_connection", "connect_server",
            "disconnect_server", "catalog_children", "list_schemas", "available_extensions", "list_roles", "object_extras", "list_trigger_functions", "object_definition", "plan_object_change", "apply_object_change", "run_query", "fetch_more_rows", "cancel_query", "close_query_tab", "cancel_connect",
            "set_key_storage", "save_tab_drafts",
        ];

        for command in ["store_status", "start_fresh_store", "list_servers", "list_connections", "key_storage", "load_tab_drafts"].iter().chain(&with_arguments) {
            assert!(refusal(&no_state, command).starts_with("state not managed"), "{command}");
        }
        for command in [
            "delete_server", "connect_server", "catalog_children", "list_schemas", "available_extensions", "list_roles", "object_extras",
            "list_trigger_functions", "object_definition", "plan_object_change", "apply_object_change",
        ] {
            assert!(refusal(&store_only, command).starts_with("state not managed for field `connections`"), "{command}");
        }
        assert!(refusal(&store_only, "run_query").starts_with("state not managed for field `queries`"));
        assert!(refusal(&without_queries, "apply_object_change").starts_with("state not managed for field `queries`"));
        let unreadable_database = app.invoke(
            "apply_object_change",
            json!({ "server_id": "a", "database": "b", "statements": [], "after_commit": [], "closes_database": 7 }),
        );
        assert!(unreadable_database.unwrap_err().as_str().unwrap().contains("closes_database"));
        for (command, args, key) in [
            ("object_extras", json!({ "server_id": "a", "database": "b", "object": 7, "object_type": "table" }), "object"),
            ("plan_object_change", json!({ "server_id": "a", "database": "b", "options": { "cascade": false, "with_data": false, "force": false }, "extras": 7 }), "extras"),
        ] {
            assert!(app.invoke(command, args).unwrap_err().as_str().unwrap().contains(key), "{command}");
        }
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

    #[test]
    fn the_key_is_kept_in_a_file_until_the_keychain_is_chosen_and_a_connect_can_be_cancelled() {
        let app = test_app();
        assert_eq!(app.invoke("key_storage", json!({})), Ok(json!("file")));

        assert_eq!(app.invoke("set_key_storage", json!({ "storage": "keychain" })), Ok(Value::Null));
        assert_eq!(app.invoke("key_storage", json!({})), Ok(json!("keychain")));
        assert_eq!(app.invoke("cancel_connect", json!({ "id": "orders-dev" })), Ok(Value::Null));
    }

    #[test]
    fn a_key_storage_switch_that_fails_is_a_storage_error() {
        let app = test_app();
        std::fs::create_dir_all(app._folder.path().join("settings.json")).unwrap();
        assert_eq!(app.invoke("set_key_storage", json!({ "storage": "keychain" })).map_err(kind), Err("storage".into()));
    }

    #[test]
    fn a_query_file_is_saved_and_opened_and_the_open_tabs_are_kept() {
        let app = test_app();
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("q.sql").to_string_lossy().into_owned();
        let tabs = json!({ "active_id": "a", "tabs": [] });

        let saved = app.invoke("write_sql_file", json!({ "path": path, "text": "SELECT 1", "expected": null })).unwrap();
        let opened = app.invoke("read_sql_file", json!({ "path": path })).unwrap();
        assert_eq!(app.invoke("save_tab_drafts", json!({ "snapshot": tabs })), Ok(Value::Null));

        assert_eq!((saved["outcome"].as_str(), opened["text"].as_str()), (Some("saved"), Some("SELECT 1")));
        assert_eq!(app.invoke("load_tab_drafts", json!({})).unwrap()["snapshot"], tabs);
        assert_eq!(app.invoke("read_sql_file", json!({ "path": "/nowhere/q.sql" })).map_err(kind), Err("not_found".into()));
    }

    #[test]
    fn file_requests_missing_their_path_or_text_are_refused() {
        let app = test_app();
        for (command, args, missing) in [
            ("read_sql_file", json!({}), "path"),
            ("write_sql_file", json!({}), "path"),
            ("write_sql_file", json!({ "path": "q.sql" }), "text"),
        ] {
            let refused = app.invoke(command, args).unwrap_err();
            assert!(refused.as_str().unwrap().contains(&format!("missing required key {missing}")));
        }
        let unreadable = app.invoke("write_sql_file", json!({ "path": "q.sql", "text": "", "expected": "yesterday" }));
        assert!(unreadable.unwrap_err().as_str().unwrap().contains("expected"));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn object_commands_report_unknown_and_unreachable_servers() {
        let app = test_app();
        let port = closed_port().await.port;
        let saved = app.invoke("save_server", json!({ "input": server_input(None, port, json!({ "action": "clear" })) })).unwrap();
        let object = json!({ "database": "postgres", "object_type": "view", "oid": 1 });
        let options = json!({ "cascade": false, "with_data": true, "force": false });

        let calls = [
            ("list_schemas", json!({ "server_id": saved["id"], "database": "postgres" })),
            ("object_definition", json!({ "server_id": saved["id"], "object": object })),
            ("plan_object_change", json!({ "server_id": saved["id"], "database": "postgres", "object": null, "original": null, "changed": null, "options": options })),
            ("apply_object_change", json!({ "server_id": saved["id"], "database": "postgres", "statements": ["SELECT 1"], "after_commit": [] })),
            ("apply_object_change", json!({ "server_id": saved["id"], "database": "template1", "statements": [], "after_commit": [], "closes_database": "postgres" })),
            ("available_extensions", json!({ "server_id": saved["id"], "database": "postgres" })),
            ("list_roles", json!({ "server_id": saved["id"], "database": "postgres" })),
            ("object_extras", json!({ "server_id": saved["id"], "database": "postgres", "object_type": "table" })),
            ("list_trigger_functions", json!({ "server_id": saved["id"], "database": "postgres" })),
        ];
        for (command, args) in calls {
            assert_eq!(app.invoke(command, args).map_err(kind), Err("connection".into()), "{command}");
        }
        for (command, args) in [
            ("list_schemas", json!({ "server_id": "missing", "database": "postgres" })),
            ("object_definition", json!({ "server_id": "missing", "object": object })),
            ("plan_object_change", json!({ "server_id": "missing", "database": "postgres", "options": options })),
            ("apply_object_change", json!({ "server_id": "missing", "database": "postgres", "statements": [], "after_commit": [] })),
            ("available_extensions", json!({ "server_id": "missing", "database": "postgres" })),
            ("list_roles", json!({ "server_id": "missing", "database": "postgres" })),
            ("object_extras", json!({ "server_id": "missing", "database": "postgres", "object_type": "table" })),
            ("list_trigger_functions", json!({ "server_id": "missing", "database": "postgres" })),
        ] {
            assert_eq!(app.invoke(command, args).map_err(kind), Err("not_found".into()), "{command}");
        }

        for (command, args, missing) in [
            ("list_schemas", json!({ "server_id": "a" }), "database"),
            ("object_definition", json!({ "server_id": "a" }), "object"),
            ("plan_object_change", json!({ "server_id": "a" }), "database"),
            ("plan_object_change", json!({ "server_id": "a", "database": "b" }), "options"),
            ("apply_object_change", json!({ "server_id": "a" }), "database"),
            ("apply_object_change", json!({ "server_id": "a", "database": "b" }), "statements"),
            ("apply_object_change", json!({ "server_id": "a", "database": "b", "statements": [] }), "after_commit"),
            ("available_extensions", json!({ "server_id": "a" }), "database"),
            ("list_roles", json!({ "server_id": "a" }), "database"),
            ("object_extras", json!({ "server_id": "a", "database": "b" }), "object_type"),
            ("list_trigger_functions", json!({ "server_id": "a" }), "database"),
        ] {
            let refused = app.invoke(command, args).unwrap_err();
            assert!(refused.as_str().unwrap().contains(&format!("missing required key {missing}")), "{command}");
        }
        let unreadable = app.invoke("plan_object_change", json!({ "server_id": "a", "database": "b", "object": 7, "options": { "cascade": false, "with_data": false, "force": false } }));
        assert!(unreadable.unwrap_err().as_str().unwrap().contains("object"));
        for key in ["original", "changed"] {
            let args = json!({ "server_id": "a", "database": "b", key: 7, "options": { "cascade": false, "with_data": false, "force": false } });
            assert!(app.invoke("plan_object_change", args).unwrap_err().as_str().unwrap().contains(key));
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    #[ignore = "needs TIDEWATER_TEST_DATABASE_URL pointing at a running Postgres"]
    async fn live_an_object_is_read_planned_and_applied_through_the_commands() {
        let app = test_app();
        let live = crate::testing::live_params();
        let mut input = server_input(None, live.port, json!({ "action": "set", "value": live.password }));
        input["host"] = json!(live.host);
        input["user"] = json!(live.user);
        input["tls"] = json!("require");
        let id = app.invoke("save_server", json!({ "input": input })).unwrap()["id"].clone();
        let schema = format!("tw_{}", uuid::Uuid::new_v4().simple());
        let changed = json!({ "type": "schema", "name": schema, "comment": null });
        let options = json!({ "cascade": true, "with_data": true, "force": false });

        let planned = app.invoke("plan_object_change", json!({ "server_id": id, "database": live.database, "object": null, "original": null, "changed": changed, "options": options })).unwrap();
        let applied = app.invoke("apply_object_change", json!({ "server_id": id, "database": live.database, "statements": planned["statements"], "after_commit": [] })).unwrap();
        let schemas = app.invoke("list_schemas", json!({ "server_id": id, "database": live.database })).unwrap();
        let roles = app.invoke("list_roles", json!({ "server_id": id, "database": live.database })).unwrap();
        let extensions = app.invoke("available_extensions", json!({ "server_id": id, "database": live.database })).unwrap();
        assert!(roles.as_array().unwrap().contains(&json!(live.user)));
        assert!(extensions.as_array().unwrap().iter().any(|extension| extension["name"] == "plpgsql"));
        let extras = app.invoke("object_extras", json!({ "server_id": id, "database": live.database, "object_type": "schema" })).unwrap();
        let functions = app.invoke("list_trigger_functions", json!({ "server_id": id, "database": live.database })).unwrap();
        assert_eq!((extras["owner"].clone(), functions.is_array()), (json!(live.user), true));
        let oid = app.invoke("catalog_children", json!({ "server_id": id, "path": { "level": "database", "database": live.database }, "show_system": false })).unwrap()
            .as_array().unwrap().iter().find(|node| node["label"] == json!(schema)).unwrap()["object"].clone();
        let read = app.invoke("object_definition", json!({ "server_id": id, "object": oid })).unwrap();
        let dropped = app.invoke("plan_object_change", json!({ "server_id": id, "database": live.database, "object": oid, "original": read, "changed": null, "options": options })).unwrap();
        app.invoke("apply_object_change", json!({ "server_id": id, "database": live.database, "statements": dropped["statements"], "after_commit": [] })).unwrap();

        assert_eq!(applied, json!({ "outcome": "applied" }));
        assert!(schemas.as_array().unwrap().contains(&json!(schema)));
        assert_eq!(read, changed);
        assert_eq!(dropped["statements"], json!([format!("DROP SCHEMA {schema} CASCADE")]));
    }
}
