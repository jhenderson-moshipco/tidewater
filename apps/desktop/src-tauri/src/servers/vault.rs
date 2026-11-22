//! Where the key that encrypts the server file exists.

use std::fs;
use std::path::{Path, PathBuf};

use keyring::Entry;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::store::write_private;

#[derive(Debug, PartialEq, Eq)]
pub enum KeyLookup {
    Found(String),
    Missing,
    /// No keyring service exists on this system, affects linux distributions without a native passkey style service
    #[cfg_attr(not(target_os = "linux"), allow(dead_code))]
    NoKeyring(String),
    /// A keyring exists but refused or failed the request
    Failed(String),
}

pub trait KeyVault: Send + Sync {
    fn read(&self) -> KeyLookup;
    fn write(&self, key: &str) -> Result<(), String>;
    /// Deletes the key. Removing a key that isn't there succeeds.
    fn remove(&self) -> Result<(), String>;
}

const SERVICE: &str = "Tidewater";
const ACCOUNT: &str = "server-store-key";

pub struct OsKeychain;

/// Check the error passed along by the OS keyring
fn lookup_from_error(error: keyring::Error) -> KeyLookup {
    match error {
        keyring::Error::NoEntry => KeyLookup::Missing,
        #[cfg(target_os = "linux")]
        keyring::Error::NoStorageAccess(_) | keyring::Error::PlatformFailure(_) => KeyLookup::NoKeyring(error.to_string()),
        other => KeyLookup::Failed(other.to_string()),
    }
}

fn read_key(entry: keyring::Result<Entry>) -> KeyLookup {
    match entry.and_then(|entry| entry.get_password()) {
        Ok(key) => KeyLookup::Found(key),
        Err(error) => lookup_from_error(error),
    }
}

fn write_key(entry: keyring::Result<Entry>, key: &str) -> Result<(), String> {
    entry.and_then(|entry| entry.set_password(key)).map_err(|error| error.to_string())
}

fn remove_key(entry: keyring::Result<Entry>) -> Result<(), String> {
    match entry.and_then(|entry| entry.delete_credential()) {
        Err(error) if !matches!(error, keyring::Error::NoEntry) => Err(error.to_string()),
        _ => Ok(()),
    }
}

impl KeyVault for OsKeychain {
    fn read(&self) -> KeyLookup {
        read_key(Entry::new(SERVICE, ACCOUNT))
    }

    fn write(&self, key: &str) -> Result<(), String> {
        write_key(Entry::new(SERVICE, ACCOUNT), key)
    }

    fn remove(&self) -> Result<(), String> {
        remove_key(Entry::new(SERVICE, ACCOUNT))
    }
}

/// Where the app keeps the key: a file only this user can read, or, when the user opts in, the system keychain.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "settings.ts")]
pub enum KeyStorage {
    #[default]
    File,
    Keychain,
}

#[derive(Default, Serialize, Deserialize)]
struct AppSettings {
    #[serde(default)]
    key_storage: KeyStorage,
}

/// The key in a file next to the saved servers, readable only by the user who owns it.
pub struct KeyFile {
    path: PathBuf,
}

impl KeyVault for KeyFile {
    fn read(&self) -> KeyLookup {
        match fs::read_to_string(&self.path) {
            Ok(key) => KeyLookup::Found(key),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => KeyLookup::Missing,
            Err(error) => KeyLookup::Failed(error.to_string()),
        }
    }

    fn write(&self, key: &str) -> Result<(), String> {
        self.path
            .parent()
            .map_or(Ok(()), fs::create_dir_all)
            .and_then(|()| write_private(&self.path, key.as_bytes()))
            .map_err(|error| error.to_string())
    }

    fn remove(&self) -> Result<(), String> {
        match fs::remove_file(&self.path) {
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err(error.to_string()),
            _ => Ok(()),
        }
    }
}

/// The app's vault, which keeps the key wherever the user's setting says.
pub struct AppVault {
    settings: PathBuf,
    file: KeyFile,
    keychain: Box<dyn KeyVault>,
}

impl AppVault {
    /// Keeps `settings.json` and the key file in `config_dir`.
    pub fn new(config_dir: &Path, keychain: Box<dyn KeyVault>) -> Self {
        AppVault { settings: config_dir.join("settings.json"), file: KeyFile { path: config_dir.join("servers.key") }, keychain }
    }

    pub fn storage(&self) -> KeyStorage {
        fs::read(&self.settings).ok().and_then(|bytes| serde_json::from_slice::<AppSettings>(&bytes).ok()).unwrap_or_default().key_storage
    }

    fn vault_for(&self, storage: KeyStorage) -> &dyn KeyVault {
        match storage {
            KeyStorage::File => &self.file,
            KeyStorage::Keychain => self.keychain.as_ref(),
        }
    }

    /// Moves the key to `storage`, then removes it from where it was, so only one copy is ever kept.
    pub fn set_storage(&self, storage: KeyStorage) -> Result<(), String> {
        let current = self.storage();
        if storage == current {
            return Ok(());
        }
        let key = match self.vault_for(current).read() {
            KeyLookup::Found(key) => Some(key),
            KeyLookup::Missing => None,
            KeyLookup::NoKeyring(reason) | KeyLookup::Failed(reason) => return Err(format!("The key couldn't be read: {reason}")),
        };
        if let Some(key) = &key {
            self.vault_for(storage).write(key).map_err(|error| format!("The key couldn't be saved: {error}"))?;
        }
        let settings = serde_json::to_vec_pretty(&AppSettings { key_storage: storage }).expect("settings always serialize");
        self.settings
            .parent()
            .map_or(Ok(()), fs::create_dir_all)
            .and_then(|()| write_private(&self.settings, &settings)).map_err(|error| format!("The setting couldn't be saved: {error}"))?;
        self.vault_for(current).remove().map_err(|error| format!("The key moved, but its old copy couldn't be removed: {error}"))
    }
}

impl KeyVault for AppVault {
    /// With the file setting and no key file yet, takes the keychain's key once, so servers saved before keep opening.
    fn read(&self) -> KeyLookup {
        let storage = self.storage();
        let found = self.vault_for(storage).read();
        if storage == KeyStorage::Keychain || found != KeyLookup::Missing {
            return found;
        }
        let from_keychain = self.keychain.read();
        if let KeyLookup::Found(key) = &from_keychain
            && self.file.write(key).is_ok()
        {
            let _ = self.keychain.remove();
        }
        match from_keychain {
            KeyLookup::Found(key) => KeyLookup::Found(key),
            _ => KeyLookup::Missing,
        }
    }

    fn write(&self, key: &str) -> Result<(), String> {
        self.vault_for(self.storage()).write(key)
    }

    fn remove(&self) -> Result<(), String> {
        self.vault_for(self.storage()).remove()
    }
}

#[cfg(test)]
mod tests {
    use keyring::mock::MockCredential;

    use super::*;

    fn mock_entry() -> Entry {
        Entry::new_with_credential(Box::new(MockCredential::default()))
    }

    fn failing_entry(error: keyring::Error) -> Entry {
        let entry = mock_entry();
        let mock: &MockCredential = entry.get_credential().downcast_ref().expect("a mock credential");
        mock.set_error(error);
        entry
    }

    fn invalid() -> keyring::Error {
        keyring::Error::Invalid("service".into(), "empty".into())
    }

    #[test]
    fn a_saved_key_is_found() {
        let entry = mock_entry();
        entry.set_password("the-key").unwrap();
        assert_eq!(read_key(Ok(entry)), KeyLookup::Found("the-key".into()));
    }

    #[test]
    fn an_empty_keychain_entry_is_missing() {
        assert_eq!(read_key(Ok(mock_entry())), KeyLookup::Missing);
    }

    #[test]
    fn a_keychain_that_refuses_the_read_has_failed() {
        assert_eq!(read_key(Ok(failing_entry(invalid()))), KeyLookup::Failed(invalid().to_string()));
    }

    #[test]
    fn an_entry_that_cannot_be_created_fails_the_read_and_the_write() {
        assert_eq!(read_key(Err(invalid())), KeyLookup::Failed(invalid().to_string()));
        assert_eq!(write_key(Err(invalid()), "the-key"), Err(invalid().to_string()));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn on_linux_a_missing_secret_service_means_no_keyring() {
        let unavailable = || keyring::Error::NoStorageAccess("no secret service".into());
        assert_eq!(read_key(Ok(failing_entry(unavailable()))), KeyLookup::NoKeyring(unavailable().to_string()));
    }

    #[cfg(not(target_os = "linux"))]
    #[test]
    fn outside_linux_a_platform_failure_is_a_failed_read() {
        let unavailable = || keyring::Error::PlatformFailure("keychain locked".into());
        assert_eq!(read_key(Ok(failing_entry(unavailable()))), KeyLookup::Failed(unavailable().to_string()));
    }

    #[test]
    fn the_os_keychain_reads_and_writes_through_the_default_store() {
        crate::testing::mock_keychain();
        assert_eq!(OsKeychain.read(), KeyLookup::Missing);
        assert_eq!(OsKeychain.write("the-key"), Ok(()));
        assert_eq!(OsKeychain.remove(), Ok(()));
    }

    use crate::testing::{Keychain, MemoryVault};

    #[test]
    fn deleting_a_keychain_entry_succeeds_when_it_is_gone_and_reports_other_failures() {
        let entry = mock_entry();
        entry.set_password("key").unwrap();
        assert_eq!(remove_key(Ok(entry)), Ok(()));
        assert_eq!(remove_key(Ok(mock_entry())), Ok(()));
        assert_eq!(remove_key(Ok(failing_entry(invalid()))), Err(invalid().to_string()));
    }

    struct Vault {
        _folder: tempfile::TempDir,
        config: PathBuf,
        vault: AppVault,
    }

    /// An app vault in a fresh folder whose keychain is `keychain`, holding `key`.
    fn app_vault(keychain: Keychain, key: Option<&str>) -> (Vault, std::sync::Arc<MemoryVault>) {
        struct Shared(std::sync::Arc<MemoryVault>);
        impl KeyVault for Shared {
            fn read(&self) -> KeyLookup {
                self.0.read()
            }
            fn write(&self, key: &str) -> Result<(), String> {
                self.0.write(key)
            }
            fn remove(&self) -> Result<(), String> {
                self.0.remove()
            }
        }
        let folder = tempfile::tempdir().unwrap();
        let config = folder.path().join("config");
        let memory = std::sync::Arc::new(MemoryVault { key: std::sync::Mutex::new(key.map(str::to_string)), keychain, ..MemoryVault::default() });
        let vault = AppVault::new(&config, Box::new(Shared(std::sync::Arc::clone(&memory))));
        (Vault { _folder: folder, config, vault }, memory)
    }

    fn key_file(vault: &Vault) -> Option<String> {
        fs::read_to_string(vault.config.join("servers.key")).ok()
    }

    #[test]
    fn by_default_the_key_lives_in_a_file_only_the_owner_can_read_and_the_keychain_is_never_asked() {
        let (vault, keychain) = app_vault(Keychain::Working, None);

        assert_eq!(vault.vault.storage(), KeyStorage::File);
        assert_eq!(vault.vault.read(), KeyLookup::Missing);
        vault.vault.write("file-key").unwrap();

        assert_eq!(vault.vault.read(), KeyLookup::Found("file-key".into()));
        #[cfg(unix)]
        assert_eq!(std::os::unix::fs::PermissionsExt::mode(&fs::metadata(vault.config.join("servers.key")).unwrap().permissions()) & 0o777, 0o600);
        assert_eq!((keychain.reads(), keychain.key()), (1, None));
    }

    #[test]
    fn a_key_left_in_the_keychain_moves_into_the_file_on_first_read() {
        let (vault, keychain) = app_vault(Keychain::Working, Some("old-key"));

        assert_eq!(vault.vault.read(), KeyLookup::Found("old-key".into()));
        assert_eq!(vault.vault.read(), KeyLookup::Found("old-key".into()));

        assert_eq!((key_file(&vault), keychain.key(), keychain.reads()), (Some("old-key".into()), None, 1));
    }

    #[test]
    fn a_keychain_that_fails_while_taking_its_old_key_leaves_the_key_missing() {
        let (vault, _) = app_vault(Keychain::Refusing, None);
        assert_eq!(vault.vault.read(), KeyLookup::Missing);
    }

    #[test]
    fn with_the_keychain_setting_the_key_is_read_written_and_removed_only_there() {
        let (vault, keychain) = app_vault(Keychain::Working, None);
        vault.vault.set_storage(KeyStorage::Keychain).unwrap();

        vault.vault.write("keychain-key").unwrap();
        assert_eq!((vault.vault.read(), key_file(&vault)), (KeyLookup::Found("keychain-key".into()), None));
        vault.vault.remove().unwrap();

        assert_eq!((vault.vault.storage(), keychain.key()), (KeyStorage::Keychain, None));
    }

    #[test]
    fn switching_moves_the_key_and_keeps_only_one_copy_each_way() {
        let (vault, keychain) = app_vault(Keychain::Working, None);
        vault.vault.write("the-key").unwrap();

        vault.vault.set_storage(KeyStorage::Keychain).unwrap();
        assert_eq!((keychain.key(), key_file(&vault)), (Some("the-key".into()), None));
        vault.vault.set_storage(KeyStorage::File).unwrap();
        assert_eq!((keychain.key(), key_file(&vault)), (None, Some("the-key".into())));
        assert_eq!(vault.vault.set_storage(KeyStorage::File), Ok(()));
    }

    #[test]
    fn switching_with_no_key_yet_only_changes_the_setting() {
        let (vault, keychain) = app_vault(Keychain::Working, None);
        vault.vault.set_storage(KeyStorage::Keychain).unwrap();
        assert_eq!((vault.vault.storage(), keychain.key()), (KeyStorage::Keychain, None));
    }

    #[test]
    fn a_switch_that_cant_read_or_save_the_key_changes_nothing() {
        let (vault, _) = app_vault(Keychain::Refusing, None);
        vault.vault.write("the-key").unwrap();
        let refused = vault.vault.set_storage(KeyStorage::Keychain).unwrap_err();
        assert!(refused.starts_with("The key couldn't be saved"), "{refused}");
        assert_eq!((vault.vault.storage(), key_file(&vault)), (KeyStorage::File, Some("the-key".into())));

        fs::write(vault.config.join("settings.json"), r#"{ "key_storage": "keychain" }"#).unwrap();
        let unreadable = vault.vault.set_storage(KeyStorage::File).unwrap_err();
        assert!(unreadable.starts_with("The key couldn't be read"), "{unreadable}");
    }

    #[test]
    fn a_switch_whose_setting_cant_be_saved_reports_it() {
        let (vault, _) = app_vault(Keychain::Working, None);
        fs::create_dir_all(vault.config.join("settings.json")).unwrap();
        let refused = vault.vault.set_storage(KeyStorage::Keychain).unwrap_err();
        assert!(refused.starts_with("The setting couldn't be saved"), "{refused}");
    }

    #[test]
    fn a_switch_whose_old_copy_cant_be_removed_says_the_key_moved() {
        let (vault, keychain) = app_vault(Keychain::Sticky, None);
        vault.vault.set_storage(KeyStorage::Keychain).unwrap();
        vault.vault.write("the-key").unwrap();

        let partly = vault.vault.set_storage(KeyStorage::File).unwrap_err();

        assert!(partly.starts_with("The key moved, but its old copy couldn't be removed"), "{partly}");
        assert_eq!((vault.vault.storage(), key_file(&vault), keychain.key()), (KeyStorage::File, Some("the-key".into()), Some("the-key".into())));
    }

    #[test]
    fn an_unreadable_settings_file_means_the_default_file_setting() {
        let (vault, _) = app_vault(Keychain::Working, None);
        fs::create_dir_all(&vault.config).unwrap();
        fs::write(vault.config.join("settings.json"), "not json").unwrap();
        assert_eq!(vault.vault.storage(), KeyStorage::File);
    }

    #[test]
    fn a_key_file_that_cant_be_read_or_removed_reports_it() {
        let folder = tempfile::tempdir().unwrap();
        fs::create_dir_all(folder.path().join("servers.key").join("inside")).unwrap();
        let file = KeyFile { path: folder.path().join("servers.key") };
        assert_eq!(std::mem::discriminant(&file.read()), std::mem::discriminant(&KeyLookup::Failed(String::new())));
        assert!(file.remove().is_err());
        assert_eq!(KeyFile { path: folder.path().join("gone.key") }.remove(), Ok(()));
        fs::write(folder.path().join("a-file"), "").unwrap();
        assert!(KeyFile { path: folder.path().join("a-file").join("servers.key") }.write("key").is_err());
    }

    #[test]
    fn a_switch_away_from_a_keychain_with_no_keyring_service_reports_it() {
        let (vault, _) = app_vault(Keychain::NoKeyring, None);
        fs::create_dir_all(&vault.config).unwrap();
        fs::write(vault.config.join("settings.json"), r#"{ "key_storage": "keychain" }"#).unwrap();
        assert_eq!(vault.vault.set_storage(KeyStorage::File), Err("The key couldn't be read: no secret service".into()));
    }
}
