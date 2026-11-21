//! Tidewater's Rust core: the app window and its native menu.

mod menu;

/// entry point for the app
pub fn run() {
    tauri::Builder::default()
        .menu(menu::build)
        .on_menu_event(menu::forward)
        .run(tauri::generate_context!())
        .expect("Tidewater failed to start");
}
