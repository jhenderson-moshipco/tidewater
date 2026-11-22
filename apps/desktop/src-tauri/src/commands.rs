//! The commands the frontend calls through `invoke`.

use tauri::State;

use crate::connections::probe::{ProbeResult, probe};
use crate::connections::url::{ParsedConnection, parse_connection_string};
use crate::connections::{ConnectParams, ConnectionInfo, ConnectionManager};
use crate::error::CommandError;
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
pub async fn delete_server(store: State<'_, Store>, connections: State<'_, ConnectionManager>, id: String) -> Result<(), CommandError> {
    store.update(|list| list.delete_server(&id))?;
    connections.disconnect(&id).await;
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
        _app: App<MockRuntime>,
        window: WebviewWindow<MockRuntime>,
        _folder: tempfile::TempDir,
    }

    fn with_window(app: App<MockRuntime>, folder: tempfile::TempDir) -> TestApp {
        let window = WebviewWindowBuilder::new(&app, "main", Default::default()).build().unwrap();
        TestApp { _app: app, window, _folder: folder }
    }

    /// The real app on Tauri's mock runtime, with its saved servers in a temporary folder.
    fn test_app() -> TestApp {
        mock_keychain();
        let folder = tempfile::tempdir().unwrap();
        let store = Store::new(folder.path().join("servers.json"), AppVault::new(folder.path(), Box::new(OsKeychain)));
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
            "session": { "read_only": false, "statement_timeout_ms": null },
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
        let app = test_app();
        let with_arguments = [
            "unlock_store", "save_server", "delete_server", "save_group", "delete_group", "test_connection", "connect_server",
            "disconnect_server", "cancel_connect", "set_key_storage",
        ];

        for command in ["store_status", "start_fresh_store", "list_servers", "list_connections", "key_storage"].iter().chain(&with_arguments) {
            assert!(refusal(&no_state, command).starts_with("state not managed"), "{command}");
        }
        for command in ["delete_server", "connect_server"] {
            assert!(refusal(&store_only, command).starts_with("state not managed for field `connections`"), "{command}");
        }
        for command in with_arguments {
            assert!(refusal(&app, command).contains("missing required key"), "{command}");
        }
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
}
