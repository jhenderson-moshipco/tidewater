//! The native application menu

use tauri::menu::{AboutMetadata, IsMenuItem, Menu, MenuEvent, MenuItem, MenuItemKind, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter, Runtime};

/// these id's get forwarded to the frontend
const FORWARDED: [&str; 13] = [
    "new_query_tab",
    "new_connection",
    "open_settings",
    "view_explorer",
    "view_search",
    "view_files",
    "view_history",
    "view_performance",
    "toggle_sidebar",
    "toggle_system_objects",
    "run_statement",
    "run_all",
    "cancel_query",
];

enum Entry {
    Action(&'static str, &'static str, Option<&'static str>),
    Planned(&'static str, Option<&'static str>),
    System(SystemItem),
}

enum SystemItem {
    Separator,
    #[cfg(target_os = "macos")]
    About,
    #[cfg(target_os = "macos")]
    Services,
    #[cfg(target_os = "macos")]
    Hide,
    #[cfg(target_os = "macos")]
    HideOthers,
    #[cfg(target_os = "macos")]
    ShowAll,
    Quit,
    CloseWindow,
    Undo,
    Redo,
    Cut,
    Copy,
    Paste,
    SelectAll,
    Minimize,
    Maximize,
    Fullscreen,
}

use Entry::*;
use SystemItem::*;

#[cfg(target_os = "macos")]
const APP_MENU: &[Entry] = &[
    System(About),
    System(Separator),
    Action("open_settings", "Settings…", Some("CmdOrCtrl+,")),
    System(Separator),
    System(Services),
    System(Separator),
    System(Hide),
    System(HideOthers),
    System(ShowAll),
    System(Separator),
    System(Quit),
];

const FILE_MENU: &[Entry] = &[
    Action("new_query_tab", "New Query Tab", Some("CmdOrCtrl+T")),
    Action("new_connection", "New Connection…", Some("CmdOrCtrl+Shift+N")),
    #[cfg(not(target_os = "macos"))]
    Action("open_settings", "Settings…", Some("CmdOrCtrl+,")),
    System(Separator),
    Planned("Open .sql File…", Some("CmdOrCtrl+O")),
    Planned("Save", Some("CmdOrCtrl+S")),
    Planned("Save As…", Some("CmdOrCtrl+Shift+S")),
    System(Separator),
    Planned("Import Settings…", None),
    Planned("Export Settings…", None),
    System(Separator),
    System(CloseWindow),
    #[cfg(not(target_os = "macos"))]
    System(Quit),
];

const EDIT_MENU: &[Entry] = &[
    System(Undo),
    System(Redo),
    System(Separator),
    System(Cut),
    System(Copy),
    System(Paste),
    System(SelectAll),
    System(Separator),
    Planned("Find", Some("CmdOrCtrl+F")),
    Planned("Format SQL", Some("Alt+Shift+F")),
];

const VIEW_MENU: &[Entry] = &[
    Planned("Command Palette", Some("CmdOrCtrl+K")),
    System(Separator),
    Action("view_explorer", "Explorer", Some("CmdOrCtrl+Shift+E")),
    Action("view_search", "Search", Some("CmdOrCtrl+Shift+F")),
    Action("view_files", "Saved Queries", None),
    Action("view_history", "History", None),
    Action("view_performance", "Performance", Some("CmdOrCtrl+Shift+M")),
    System(Separator),
    Action("toggle_sidebar", "Toggle Sidebar", Some("CmdOrCtrl+B")),
    Action("toggle_system_objects", "Show System Objects", None),
    Planned("Edit Layout…", None),
    System(Separator),
    System(Fullscreen),
];

const QUERY_MENU: &[Entry] = &[
    Action("run_statement", "Run Statement", Some("CmdOrCtrl+Enter")),
    Action("run_all", "Run All", Some("CmdOrCtrl+Shift+Enter")),
    Planned("Run Across Group…", Some("CmdOrCtrl+Alt+Enter")),
    Action("cancel_query", "Cancel", Some("CmdOrCtrl+.")),
    System(Separator),
    Planned("Explain", Some("CmdOrCtrl+E")),
    Planned("Explain Analyze", Some("CmdOrCtrl+Alt+E")),
    System(Separator),
    Planned("Begin Transaction", None),
    Planned("Commit", Some("CmdOrCtrl+Shift+C")),
    Planned("Rollback", Some("CmdOrCtrl+Shift+R")),
];

const SERVER_MENU: &[Entry] = &[
    Planned("Connect", None),
    Planned("Disconnect", None),
    Planned("Connect Whole Group", None),
    System(Separator),
    Planned("New Database…", None),
    Planned("New Schema…", None),
    Planned("Roles and Privileges", None),
    System(Separator),
    Planned("Back Up with pg_dump…", None),
    Planned("Restore…", None),
];

const TOOLS_MENU: &[Entry] = &[
    Planned("Sessions and Locks", None),
    System(Separator),
    Planned("Import CSV…", None),
    Planned("Export Results…", None),
    Planned("Vacuum and Analyze…", None),
    System(Separator),
    Planned("Keybindings", None),
];

const WINDOW_MENU: &[Entry] = &[System(Minimize), System(Maximize)];

const HELP_MENU: &[Entry] = &[
    Planned("Documentation", None),
    Planned("Keyboard Shortcuts", None),
    System(Separator),
    Planned("Report an Issue", None),
];

const MENUS: &[(&str, &[Entry])] = &[
    #[cfg(target_os = "macos")]
    ("Tidewater", APP_MENU),
    ("File", FILE_MENU),
    ("Edit", EDIT_MENU),
    ("View", VIEW_MENU),
    ("Query", QUERY_MENU),
    ("Server", SERVER_MENU),
    ("Tools", TOOLS_MENU),
    ("Window", WINDOW_MENU),
    ("Help", HELP_MENU),
];

fn system_item<R: Runtime>(app: &AppHandle<R>, item: &SystemItem) -> tauri::Result<PredefinedMenuItem<R>> {
    match item {
        Separator => PredefinedMenuItem::separator(app),
        #[cfg(target_os = "macos")]
        About => PredefinedMenuItem::about(app, None, Some(AboutMetadata::default())),
        #[cfg(target_os = "macos")]
        Services => PredefinedMenuItem::services(app, None),
        #[cfg(target_os = "macos")]
        Hide => PredefinedMenuItem::hide(app, None),
        #[cfg(target_os = "macos")]
        HideOthers => PredefinedMenuItem::hide_others(app, None),
        #[cfg(target_os = "macos")]
        ShowAll => PredefinedMenuItem::show_all(app, None),
        Quit => PredefinedMenuItem::quit(app, None),
        CloseWindow => PredefinedMenuItem::close_window(app, None),
        Undo => PredefinedMenuItem::undo(app, None),
        Redo => PredefinedMenuItem::redo(app, None),
        Cut => PredefinedMenuItem::cut(app, None),
        Copy => PredefinedMenuItem::copy(app, None),
        Paste => PredefinedMenuItem::paste(app, None),
        SelectAll => PredefinedMenuItem::select_all(app, None),
        Minimize => PredefinedMenuItem::minimize(app, None),
        Maximize => PredefinedMenuItem::maximize(app, None),
        Fullscreen => PredefinedMenuItem::fullscreen(app, None),
    }
}

fn item<R: Runtime>(app: &AppHandle<R>, entry: &Entry) -> tauri::Result<MenuItemKind<R>> {
    match entry {
        Action(id, label, accelerator) => MenuItem::with_id(app, *id, label, true, *accelerator).map(MenuItemKind::MenuItem),
        Planned(label, accelerator) => MenuItem::new(app, label, false, *accelerator).map(MenuItemKind::MenuItem),
        System(system) => system_item(app, system).map(MenuItemKind::Predefined),
    }
}

fn as_items<R: Runtime, I: IsMenuItem<R>>(items: &[I]) -> Vec<&dyn IsMenuItem<R>> {
    items.iter().map(|item| item as &dyn IsMenuItem<R>).collect()
}

fn submenu<R: Runtime>(app: &AppHandle<R>, title: &str, entries: &[Entry]) -> tauri::Result<Submenu<R>> {
    entries
        .iter()
        .map(|entry| item(app, entry))
        .collect::<tauri::Result<Vec<_>>>()
        .and_then(|items| Submenu::with_items(app, title, true, &as_items(&items)))
}

/// builds the menu for the client to consume
pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    MENUS
        .iter()
        .map(|(title, entries)| submenu(app, title, entries))
        .collect::<tauri::Result<Vec<_>>>()
        .and_then(|submenus| Menu::with_items(app, &as_items(&submenus)))
}

/// forwards events to the client
pub fn forward<R: Runtime>(app: &AppHandle<R>, event: MenuEvent) {
    let id = event.id().as_ref();
    if FORWARDED.contains(&id) {
        let _ = app.emit("menu", id);
    }
}

#[cfg(test)]
mod tests {
    use std::sync::mpsc;

    use tauri::Listener;

    use super::*;

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn only_the_forwarded_commands_are_enabled() {
        let app = crate::app(tauri::test::mock_builder()).build(tauri::test::mock_context(tauri::test::noop_assets())).unwrap();
        let mut enabled = Vec::new();
        for submenu in app.menu().unwrap().items().unwrap() {
            let items = submenu.as_submenu().unwrap().items().unwrap();
            let menu_items = items.iter().filter_map(MenuItemKind::as_menuitem);
            enabled.extend(menu_items.filter(|item| item.is_enabled().unwrap()).map(|item| item.id().0.clone()));
        }
        assert_eq!(enabled, FORWARDED.to_vec());
    }

    #[test]
    fn forwarded_commands_reach_the_frontend_and_others_dont() {
        let app = tauri::test::mock_app();
        let (sender, received) = mpsc::channel();
        app.listen_any("menu", move |event| sender.send(event.payload().to_string()).unwrap());

        forward(app.handle(), MenuEvent { id: "settings".into() });
        forward(app.handle(), MenuEvent { id: "view_search".into() });

        assert_eq!(received.recv().unwrap(), "\"view_search\"");
        assert!(received.try_recv().is_err());
    }
}
