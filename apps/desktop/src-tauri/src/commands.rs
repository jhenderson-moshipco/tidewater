//! The commands the frontend calls through `invoke`.

use tauri::State;

use crate::connections::probe::{ProbeResult, probe};
use crate::connections::url::{ParsedConnection, parse_connection_string};
use crate::connections::{ConnectParams, ConnectionInfo, ConnectionManager};
use crate::error::CommandError;
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

#[tauri::command]
pub async fn disconnect_server(connections: State<'_, ConnectionManager>, id: String) -> Result<(), CommandError> {
    connections.disconnect(&id).await;
    Ok(())
}

#[tauri::command]
pub async fn list_connections(connections: State<'_, ConnectionManager>) -> Result<Vec<ConnectionInfo>, CommandError> {
    Ok(connections.list().await)
}
