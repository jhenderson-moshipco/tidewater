//! Tidewater's Rust core: the app window, its native menu, saved servers and live connections.

mod commands;
mod connections;
mod error;
mod menu;
mod servers;
#[cfg(test)]
mod testing;

use tauri::{App, Builder, Manager, Runtime};

/// Adds Tidewater's state, menu and commands to a Tauri builder.
pub fn app<R: Runtime>(builder: Builder<R>) -> Builder<R> {
    with_commands(builder).menu(menu::build).on_menu_event(menu::forward)
}

/// Registers the saved-server store and connection manager. Neither touches the disk or keychain until first use.
fn manage_state<R: Runtime>(app: &mut App<R>) -> Result<(), Box<dyn std::error::Error>> {
    app.manage(connections::ConnectionManager::default());
    app.path()
        .app_config_dir()
        .map(|folder| {
            let vault = servers::vault::AppVault::new(&folder, Box::new(servers::vault::OsKeychain));
            app.manage(commands::Store::new(folder.join("servers.json"), vault));
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
            commands::key_storage,
            commands::set_key_storage,
        ])
}
