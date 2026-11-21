//! The native application menu

use tauri::menu::{AboutMetadata, Menu, MenuEvent, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter, Runtime};

/// these id's get forwarded to the frontend
const FORWARDED: [&str; 7] = [
    "new_connection",
    "view_explorer",
    "view_search",
    "view_files",
    "view_history",
    "view_performance",
    "toggle_sidebar",
];

enum Entry {
    Action(&'static str, &'static str, Option<&'static str>),
    Planned(&'static str, Option<&'static str>),
    Separator,
    About,
    Services,
    Hide,
    HideOthers,
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

const APP_MENU: &[Entry] = &[
    About,
    Separator,
    Planned("Settings…", Some("CmdOrCtrl+,")),
    Separator,
    Services,
    Separator,
    Hide,
    HideOthers,
    ShowAll,
    Separator,
    Quit,
];

const FILE_MENU: &[Entry] = &[
    Planned("New Query Tab", Some("CmdOrCtrl+T")),
    Action("new_connection", "New Connection…", Some("CmdOrCtrl+Shift+N")),
    Separator,
    Planned("Open .sql File…", Some("CmdOrCtrl+O")),
    Planned("Save", Some("CmdOrCtrl+S")),
    Planned("Save As…", Some("CmdOrCtrl+Shift+S")),
    Separator,
    Planned("Import Settings…", None),
    Planned("Export Settings…", None),
    Separator,
    CloseWindow,
];

const EDIT_MENU: &[Entry] = &[
    Undo,
    Redo,
    Separator,
    Cut,
    Copy,
    Paste,
    SelectAll,
    Separator,
    Planned("Find", Some("CmdOrCtrl+F")),
    Planned("Format SQL", Some("Alt+Shift+F")),
];

const VIEW_MENU: &[Entry] = &[
    Planned("Command Palette", Some("CmdOrCtrl+K")),
    Separator,
    Action("view_explorer", "Explorer", Some("CmdOrCtrl+Shift+E")),
    Action("view_search", "Search", Some("CmdOrCtrl+Shift+F")),
    Action("view_files", "Saved Queries", None),
    Action("view_history", "History", None),
    Action("view_performance", "Performance", Some("CmdOrCtrl+Shift+M")),
    Separator,
    Action("toggle_sidebar", "Toggle Sidebar", Some("CmdOrCtrl+B")),
    Planned("Edit Layout…", None),
    Separator,
    Fullscreen,
];

const QUERY_MENU: &[Entry] = &[
    Planned("Run Statement", Some("CmdOrCtrl+Enter")),
    Planned("Run All", Some("CmdOrCtrl+Shift+Enter")),
    Planned("Run Across Group…", Some("CmdOrCtrl+Alt+Enter")),
    Planned("Cancel", Some("CmdOrCtrl+.")),
    Separator,
    Planned("Explain", Some("CmdOrCtrl+E")),
    Planned("Explain Analyze", Some("CmdOrCtrl+Alt+E")),
    Separator,
    Planned("Begin Transaction", None),
    Planned("Commit", Some("CmdOrCtrl+Shift+C")),
    Planned("Rollback", Some("CmdOrCtrl+Shift+R")),
];

const SERVER_MENU: &[Entry] = &[
    Planned("Connect", None),
    Planned("Disconnect", None),
    Planned("Connect Whole Group", None),
    Separator,
    Planned("New Database…", None),
    Planned("New Schema…", None),
    Planned("Roles and Privileges", None),
    Separator,
    Planned("Back Up with pg_dump…", None),
    Planned("Restore…", None),
];

const TOOLS_MENU: &[Entry] = &[
    Planned("Sessions and Locks", None),
    Separator,
    Planned("Import CSV…", None),
    Planned("Export Results…", None),
    Planned("Vacuum and Analyze…", None),
    Separator,
    Planned("Keybindings", None),
];

const WINDOW_MENU: &[Entry] = &[Minimize, Maximize];

const HELP_MENU: &[Entry] = &[
    Planned("Documentation", None),
    Planned("Keyboard Shortcuts", None),
    Separator,
    Planned("Report an Issue", None),
];

fn submenu<R: Runtime>(app: &AppHandle<R>, title: &str, entries: &[Entry]) -> tauri::Result<Submenu<R>> {
    let submenu = Submenu::new(app, title, true)?;
    for entry in entries {
        match entry {
            Action(id, label, accelerator) => submenu.append(&MenuItem::with_id(app, *id, label, true, *accelerator)?)?,
            Planned(label, accelerator) => submenu.append(&MenuItem::new(app, label, false, *accelerator)?)?,
            Separator => submenu.append(&PredefinedMenuItem::separator(app)?)?,
            About => submenu.append(&PredefinedMenuItem::about(app, None, Some(AboutMetadata::default()))?)?,
            Services => submenu.append(&PredefinedMenuItem::services(app, None)?)?,
            Hide => submenu.append(&PredefinedMenuItem::hide(app, None)?)?,
            HideOthers => submenu.append(&PredefinedMenuItem::hide_others(app, None)?)?,
            ShowAll => submenu.append(&PredefinedMenuItem::show_all(app, None)?)?,
            Quit => submenu.append(&PredefinedMenuItem::quit(app, None)?)?,
            CloseWindow => submenu.append(&PredefinedMenuItem::close_window(app, None)?)?,
            Undo => submenu.append(&PredefinedMenuItem::undo(app, None)?)?,
            Redo => submenu.append(&PredefinedMenuItem::redo(app, None)?)?,
            Cut => submenu.append(&PredefinedMenuItem::cut(app, None)?)?,
            Copy => submenu.append(&PredefinedMenuItem::copy(app, None)?)?,
            Paste => submenu.append(&PredefinedMenuItem::paste(app, None)?)?,
            SelectAll => submenu.append(&PredefinedMenuItem::select_all(app, None)?)?,
            Minimize => submenu.append(&PredefinedMenuItem::minimize(app, None)?)?,
            Maximize => submenu.append(&PredefinedMenuItem::maximize(app, None)?)?,
            Fullscreen => submenu.append(&PredefinedMenuItem::fullscreen(app, None)?)?,
        }
    }
    Ok(submenu)
}

/// builds the menu for the client to consume
pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let menu = Menu::new(app)?;
    if cfg!(target_os = "macos") {
        menu.append(&submenu(app, "Tidewater", APP_MENU)?)?;
    }
    let file = submenu(app, "File", FILE_MENU)?;
    if !cfg!(target_os = "macos") {
        file.append(&PredefinedMenuItem::quit(app, None)?)?;
    }
    menu.append(&file)?;
    menu.append(&submenu(app, "Edit", EDIT_MENU)?)?;
    menu.append(&submenu(app, "View", VIEW_MENU)?)?;
    menu.append(&submenu(app, "Query", QUERY_MENU)?)?;
    menu.append(&submenu(app, "Server", SERVER_MENU)?)?;
    menu.append(&submenu(app, "Tools", TOOLS_MENU)?)?;
    menu.append(&submenu(app, "Window", WINDOW_MENU)?)?;
    menu.append(&submenu(app, "Help", HELP_MENU)?)?;
    Ok(menu)
}

/// forwards events to the client
pub fn forward<R: Runtime>(app: &AppHandle<R>, event: MenuEvent) {
    let id = event.id().as_ref();
    if !FORWARDED.contains(&id) {
        return;
    }
    if let Err(error) = app.emit("menu", id) {
        eprintln!("could not forward menu command {id}: {error}");
    }
}
