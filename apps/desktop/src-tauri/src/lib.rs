//! Tidewater's Rust core: the app window, its native menu, saved servers and live connections.

mod catalog;
mod commands;
mod connections;
mod error;
mod files;
mod menu;
mod query;
mod servers;
#[cfg(test)]
mod testing;

use tauri::{App, Builder, Emitter, Manager, Runtime};

/// Emitted with a tab id when that tab's idle results close on their own.
pub const RESULTS_CLOSED_EVENT: &str = "query-results-closed";

/// Adds Tidewater's state, menu and commands to a Tauri builder.
pub fn app<R: Runtime>(builder: Builder<R>) -> Builder<R> {
    with_commands(builder).plugin(tauri_plugin_dialog::init()).menu(menu::build).on_menu_event(menu::forward)
}

/// Registers the saved-server store and connection manager. Neither touches the disk or keychain until first use.
fn manage_state<R: Runtime>(app: &mut App<R>) -> Result<(), Box<dyn std::error::Error>> {
    app.manage(connections::ConnectionManager::default());
    let handle = app.handle().clone();
    app.manage(query::QuerySessions::new(move |tab_id| {
        let _ = handle.emit(RESULTS_CLOSED_EVENT, tab_id);
    }));
    let paths = app.path();
    paths
        .app_config_dir()
        .and_then(|config| paths.app_data_dir().map(|data| (config, data)))
        .map(|(config, data)| {
            let vault = servers::vault::AppVault::new(&config, Box::new(servers::vault::OsKeychain));
            app.manage(commands::Store::new(config.join("servers.json"), vault));
            app.manage(files::drafts::DraftStore::new(data.join("tabs.json")));
        })
        .map_err(Into::into)
}

/// The state and commands without the native menu, which macOS only builds on the main thread.
fn with_commands<R: Runtime>(builder: Builder<R>) -> Builder<R> {
    builder
        .setup(manage_state)
        .invoke_handler(tauri::generate_handler![
            commands::store_status,
            commands::unlock_store,
            commands::start_fresh_store,
            commands::list_servers,
            commands::save_server,
            commands::delete_server,
            commands::save_group,
            commands::delete_group,
            commands::parse_connection,
            commands::test_connection,
            commands::connect_server,
            commands::cancel_connect,
            commands::disconnect_server,
            commands::list_connections,
            commands::catalog_children,
            commands::split_statements,
            commands::run_query,
            commands::fetch_more_rows,
            commands::cancel_query,
            commands::close_query_tab,
            commands::key_storage,
            commands::set_key_storage,
            commands::read_sql_file,
            commands::write_sql_file,
            commands::load_tab_drafts,
            commands::save_tab_drafts,
        ])
}
