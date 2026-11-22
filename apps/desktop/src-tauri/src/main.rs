#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    tidewater_lib::app(tauri::Builder::default())
        .run(tauri::generate_context!())
        .expect("Tidewater failed to start");
}
