//! The .sql files query tabs open and save, and the tab drafts kept between launches.

pub mod drafts;

use std::fs;
use std::io::Read;
use std::path::Path;
use std::time::UNIX_EPOCH;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::error::CommandError;

/// When a file was last written and how big it was, to notice another program changing it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "files.ts")]
pub struct FileStamp {
    /// Milliseconds since the Unix epoch.
    #[ts(type = "number")]
    pub modified_ms: u64,
    #[ts(type = "number")]
    pub size: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[ts(export, export_to = "files.ts")]
pub struct OpenedFile {
    pub path: String,
    pub name: String,
    pub text: String,
    pub stamp: FileStamp,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(tag = "outcome", rename_all = "snake_case")]
#[ts(export, export_to = "files.ts")]
pub enum SaveOutcome {
    Saved { stamp: FileStamp },
    /// Another program changed or removed the file since Tidewater last read or wrote it, so nothing was written.
    ChangedOnDisk,
}

fn stamp_of(metadata: &fs::Metadata) -> FileStamp {
    let modified = metadata.modified().ok().and_then(|time| time.duration_since(UNIX_EPOCH).ok());
    let modified_ms = modified.map_or(0, |since| u64::try_from(since.as_millis()).unwrap_or(u64::MAX));
    FileStamp { modified_ms, size: metadata.len() }
}

/// The file's stamp, or `None` when it doesn't exist or can't be read.
pub fn current_stamp(path: &Path) -> Option<FileStamp> {
    fs::metadata(path).ok().map(|metadata| stamp_of(&metadata))
}

pub fn display_name(path: &Path) -> String {
    path.file_name().unwrap_or(path.as_os_str()).to_string_lossy().into_owned()
}

fn file_error(path: &Path, verb: &str, error: &std::io::Error) -> CommandError {
    let name = display_name(path);
    if error.kind() == std::io::ErrorKind::NotFound {
        return CommandError::NotFound(format!("{name} doesn't exist."));
    }
    CommandError::Storage(format!("{name} couldn't be {verb}: {error}"))
}

/// Reads a UTF-8 text file. Any extension is accepted.
pub fn read_sql_file(path: &Path) -> Result<OpenedFile, CommandError> {
    let (metadata, bytes) = fs::File::open(path)
        .and_then(|file| file.metadata().map(|metadata| (file, metadata)))
        .and_then(|(mut file, metadata)| {
            let mut bytes = Vec::new();
            file.read_to_end(&mut bytes).map(|_| (metadata, bytes))
        })
        .map_err(|error| file_error(path, "read", &error))?;
    let text = String::from_utf8(bytes)
        .map_err(|_| CommandError::Invalid(format!("{} isn't UTF-8 text, so Tidewater can't open it.", display_name(path))))?;
    Ok(OpenedFile { path: path.to_string_lossy().into_owned(), name: display_name(path), text, stamp: stamp_of(&metadata) })
}

/// Writes `text` to the file. With `expected`, writes only if the file still has that stamp.
pub fn write_sql_file(path: &Path, text: &str, expected: Option<FileStamp>) -> Result<SaveOutcome, CommandError> {
    if expected.is_some() && current_stamp(path) != expected {
        return Ok(SaveOutcome::ChangedOnDisk);
    }
    fs::write(path, text)
        .and_then(|()| fs::metadata(path))
        .map(|metadata| SaveOutcome::Saved { stamp: stamp_of(&metadata) })
        .map_err(|error| file_error(path, "saved", &error))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_saved_file_reads_back_with_its_name_text_and_stamp() {
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("recent-orders.sql");

        let saved = write_sql_file(&path, "SELECT 1;\n", None).unwrap();
        let opened = read_sql_file(&path).unwrap();

        assert_eq!((opened.name.as_str(), opened.text.as_str()), ("recent-orders.sql", "SELECT 1;\n"));
        assert_eq!(saved, SaveOutcome::Saved { stamp: opened.stamp });
        assert_eq!(opened.stamp.size, 10);
    }

    #[test]
    fn a_file_that_isnt_utf8_is_refused() {
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("dump.bin");
        fs::write(&path, [0xff, 0xfe, 0x00]).unwrap();

        let refused = read_sql_file(&path);

        assert_eq!(refused, Err(CommandError::Invalid("dump.bin isn't UTF-8 text, so Tidewater can't open it.".into())));
    }

    #[test]
    fn a_missing_file_is_not_found_and_a_folder_cant_be_read_or_saved() {
        let folder = tempfile::tempdir().unwrap();

        let missing = read_sql_file(&folder.path().join("gone.sql"));
        let unreadable = read_sql_file(folder.path()).unwrap_err();
        let unwritable = write_sql_file(folder.path(), "SELECT 1", None).unwrap_err();

        assert_eq!(missing, Err(CommandError::NotFound("gone.sql doesn't exist.".into())));
        assert!(crate::testing::parts(unreadable).1.contains("couldn't be read"));
        assert!(crate::testing::parts(unwritable).1.contains("couldn't be saved"));
    }

    #[test]
    fn a_save_that_expects_the_last_stamp_writes_only_while_the_file_still_has_it() {
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("q.sql");
        write_sql_file(&path, "SELECT 1", None).unwrap();
        let stamp = current_stamp(&path).unwrap();

        assert_eq!(write_sql_file(&path, "SELECT 22", Some(stamp)), Ok(SaveOutcome::Saved { stamp: current_stamp(&path).unwrap() }));
        assert_eq!(write_sql_file(&path, "SELECT 3", Some(stamp)), Ok(SaveOutcome::ChangedOnDisk));
        assert_eq!(fs::read_to_string(&path).unwrap(), "SELECT 22");
        fs::remove_file(&path).unwrap();
        assert_eq!(write_sql_file(&path, "SELECT 3", Some(stamp)), Ok(SaveOutcome::ChangedOnDisk));
    }
}
