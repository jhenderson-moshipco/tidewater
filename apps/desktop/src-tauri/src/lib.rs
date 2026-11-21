//! Tidewater's Rust core: the app window, its native menu, saved servers and live connections.

mod commands;
mod connections;
mod error;
mod menu;
mod servers;

use tauri::Manager;

/// entry point for the app
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let path = app.path().app_config_dir()?.join("servers.json");
            app.manage(commands::Store::open(path, servers::vault::OsKeychain));
            app.manage(connections::ConnectionManager::default());
            Ok(())
        })
        .menu(menu::build)
        .on_menu_event(menu::forward)
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
            commands::disconnect_server,
            commands::list_connections,
        ])
        .run(tauri::generate_context!())
        .expect("Tidewater failed to start");
}
