//! Each query tab's text, connection, file and cursor, kept on disk so a quit or crash loses none of it.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, PoisonError};

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::FileStamp;
use crate::error::CommandError;
use crate::servers::store::write_private;

const FORMAT: u32 = 1;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "drafts.ts")]
pub struct DraftConnection {
    pub server_id: String,
    pub database: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "drafts.ts")]
pub struct DraftFile {
    pub path: String,
    /// The text as last opened or saved, so a restored tab knows whether it has unsaved changes.
    pub saved_text: String,
    pub stamp: FileStamp,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "drafts.ts")]
pub struct TabDraft {
    pub id: String,
    pub title: String,
    pub connection: Option<DraftConnection>,
    pub text: String,
    pub selection_from: u32,
    pub selection_to: u32,
    pub file: Option<DraftFile>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "drafts.ts")]
pub struct DraftSnapshot {
    pub active_id: Option<String>,
    pub tabs: Vec<TabDraft>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, TS)]
#[ts(export, export_to = "drafts.ts")]
pub struct RestoredTabs {
    pub snapshot: DraftSnapshot,
    /// Titles of tabs whose file no longer exists. They come back as unsaved tabs.
    pub missing_files: Vec<String>,
    /// Where an unreadable drafts file was set aside, when there was one.
    pub set_aside: Option<String>,
}

#[derive(Serialize, Deserialize)]
struct DraftsFile {
    format: u32,
    snapshot: DraftSnapshot,
}

/// Clears the file of each tab whose file is gone, and lists those tabs.
fn without_missing_files(mut snapshot: DraftSnapshot) -> RestoredTabs {
    let mut missing_files = Vec::new();
    for tab in &mut snapshot.tabs {
        if let Some(file) = &tab.file
            && !Path::new(&file.path).exists()
        {
            missing_files.push(tab.title.clone());
            tab.file = None;
        }
    }
    RestoredTabs { snapshot, missing_files, set_aside: None }
}

pub struct DraftStore {
    path: PathBuf,
    lock: Mutex<()>,
}

impl DraftStore {
    pub fn new(path: PathBuf) -> Self {
        DraftStore { path, lock: Mutex::new(()) }
    }

    /// The tabs saved at the last launch. An unreadable file is set aside under a dated name and never deleted.
    pub fn load(&self) -> Result<RestoredTabs, CommandError> {
        let stamp = time::OffsetDateTime::now_utc()
            .format(time::macros::format_description!("[year]-[month]-[day]-[hour][minute][second]"))
            .expect("a UTC timestamp always formats");
        self.load_as(&stamp)
    }

    fn load_as(&self, stamp: &str) -> Result<RestoredTabs, CommandError> {
        let _guard = self.lock.lock().unwrap_or_else(PoisonError::into_inner);
        let bytes = match fs::read(&self.path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(RestoredTabs::default()),
            Err(error) => return Err(CommandError::Storage(format!("Couldn't read the saved tabs: {error}"))),
        };
        if let Some(file) = serde_json::from_slice::<DraftsFile>(&bytes).ok().filter(|file| file.format == FORMAT) {
            return Ok(without_missing_files(file.snapshot));
        }
        let aside = self.path.with_file_name(format!("tabs.unreadable-{stamp}.json"));
        fs::rename(&self.path, &aside).map_err(|error| CommandError::Storage(format!("Couldn't set the unreadable saved tabs aside: {error}")))?;
        Ok(RestoredTabs { set_aside: Some(aside.to_string_lossy().into_owned()), ..RestoredTabs::default() })
    }

    pub fn save(&self, snapshot: DraftSnapshot) -> Result<(), CommandError> {
        let _guard = self.lock.lock().unwrap_or_else(PoisonError::into_inner);
        let bytes = serde_json::to_vec(&DraftsFile { format: FORMAT, snapshot }).expect("drafts always serialize");
        let temporary = self.path.with_extension("json.tmp");
        self.path
            .parent()
            .map_or(Ok(()), fs::create_dir_all)
            .and_then(|()| write_private(&temporary, &bytes))
            .and_then(|()| fs::rename(&temporary, &self.path))
            .map_err(|error| CommandError::Storage(format!("Couldn't save the open tabs: {error}")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tab(id: &str, file: Option<DraftFile>) -> TabDraft {
        TabDraft {
            id: id.into(),
            title: format!("{id}.sql"),
            connection: Some(DraftConnection { server_id: "orders-dev".into(), database: "orders".into() }),
            text: "SELECT 1".into(),
            selection_from: 3,
            selection_to: 3,
            file,
        }
    }

    fn file_at(path: &Path) -> DraftFile {
        DraftFile { path: path.to_string_lossy().into_owned(), saved_text: "SELECT".into(), stamp: FileStamp { modified_ms: 1, size: 6 } }
    }

    fn store() -> (tempfile::TempDir, DraftStore) {
        let folder = tempfile::tempdir().unwrap();
        let store = DraftStore::new(folder.path().join("data").join("tabs.json"));
        (folder, store)
    }

    #[test]
    fn with_nothing_saved_there_are_no_tabs() {
        let (_folder, store) = store();
        assert_eq!(store.load(), Ok(RestoredTabs::default()));
    }

    #[test]
    fn saved_tabs_come_back_and_a_tab_whose_file_is_gone_comes_back_unsaved() {
        let (folder, store) = store();
        let kept = folder.path().join("kept.sql");
        fs::write(&kept, "SELECT").unwrap();
        let snapshot = DraftSnapshot {
            active_id: Some("b".into()),
            tabs: vec![tab("a", None), tab("b", Some(file_at(&kept))), tab("c", Some(file_at(&folder.path().join("gone.sql"))))],
        };

        store.save(snapshot.clone()).unwrap();
        let restored = store.load().unwrap();

        let mut expected = snapshot;
        expected.tabs[2].file = None;
        assert_eq!(restored, RestoredTabs { snapshot: expected, missing_files: vec!["c.sql".into()], set_aside: None });
    }

    #[test]
    fn an_unreadable_or_newer_file_is_set_aside_and_the_tabs_start_empty() {
        let (folder, store) = store();
        fs::create_dir_all(folder.path().join("data")).unwrap();
        let aside = folder.path().join("data").join("tabs.unreadable-stamp.json");

        for contents in ["not json", r#"{ "format": 2, "snapshot": { "active_id": null, "tabs": [] } }"#] {
            fs::write(folder.path().join("data").join("tabs.json"), contents).unwrap();
            let restored = store.load_as("stamp").unwrap();
            assert_eq!(restored.set_aside, Some(aside.to_string_lossy().into_owned()));
            assert_eq!(restored.snapshot, DraftSnapshot::default());
            assert_eq!(fs::read_to_string(&aside).unwrap(), contents);
        }
    }

    #[test]
    fn a_file_that_cant_be_read_or_set_aside_is_reported() {
        let (folder, store) = store();
        fs::create_dir_all(folder.path().join("data").join("tabs.json")).unwrap();
        assert!(crate::testing::parts(store.load().unwrap_err()).1.starts_with("Couldn't read the saved tabs"));

        let (folder, store) = self::store();
        fs::create_dir_all(folder.path().join("data").join("tabs.unreadable-stamp.json").join("taken")).unwrap();
        fs::write(folder.path().join("data").join("tabs.json"), "not json").unwrap();
        assert!(crate::testing::parts(store.load_as("stamp").unwrap_err()).1.starts_with("Couldn't set the unreadable saved tabs aside"));
    }

    #[test]
    fn a_save_that_cant_be_written_is_reported() {
        let (folder, store) = store();
        fs::create_dir_all(folder.path().join("data").join("tabs.json.tmp")).unwrap();
        assert!(crate::testing::parts(store.save(DraftSnapshot::default()).unwrap_err()).1.starts_with("Couldn't save the open tabs"));
    }
}
