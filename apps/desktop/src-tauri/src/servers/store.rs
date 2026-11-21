//! The encrypted saved-server file and the lock state the frontend sees.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use argon2::{Algorithm, Argon2, Params, Version};
use base64::Engine;
use base64::engine::general_purpose::{STANDARD, URL_SAFE};
use fernet::Fernet;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::model::ServerList;
use super::vault::{KeyLookup, KeyVault};
use crate::error::CommandError;

const FILE_FORMAT: u32 = 1;
const MIN_PASSPHRASE_CHARS: usize = 8;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
struct StoreFile {
    format: u32,
    kdf: Option<KdfParams>,
    token: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct KdfParams {
    algorithm: String,
    salt: String,
    memory_kib: u32,
    iterations: u32,
    parallelism: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, export_to = "store.ts")]
pub enum StoreStatus {
    Unlocked,
    Locked,
    NeedsPassphrase,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, TS)]
#[ts(export, export_to = "store.ts")]
pub struct StoreStatusView {
    pub status: StoreStatus,
    pub has_saved_file: bool,
    pub reason: Option<String>,
}

enum State {
    Unlocked { list: ServerList, key: Option<Fernet>, kdf: Option<KdfParams> },
    Locked { reason: String },
    NeedsPassphrase,
}

pub struct ServerStore<V: KeyVault> {
    path: PathBuf,
    vault: V,
    state: Mutex<State>,
}

fn read_file(path: &Path) -> Result<Option<StoreFile>, String> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("The saved-server file couldn't be read: {error}")),
    };
    let file: StoreFile = serde_json::from_slice(&bytes)
        .map_err(|error| format!("The saved-server file isn't in a format Tidewater recognizes: {error}"))?;
    if file.format != FILE_FORMAT {
        return Err(format!("The saved-server file uses format {}, which this version of Tidewater can't read", file.format));
    }
    Ok(Some(file))
}

fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), CommandError> {
    let storage = |error: std::io::Error| CommandError::Storage(format!("Couldn't save servers: {error}"));
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(storage)?;
    }
    let temporary = path.with_extension("json.tmp");
    let mut file = fs::File::create(&temporary).map_err(storage)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(fs::Permissions::from_mode(0o600)).map_err(storage)?;
    }
    file.write_all(bytes).map_err(storage)?;
    file.sync_all().map_err(storage)?;
    fs::rename(&temporary, path).map_err(storage)
}

fn decrypt_list(file: &StoreFile, key: &Fernet) -> Option<ServerList> {
    let bytes = key.decrypt(&file.token).ok()?;
    serde_json::from_slice(&bytes).ok()
}

fn new_kdf_params() -> Result<KdfParams, CommandError> {
    let mut salt = [0u8; argon2::RECOMMENDED_SALT_LEN];
    getrandom::fill(&mut salt).map_err(|error| CommandError::Storage(format!("Couldn't generate a salt: {error}")))?;
    Ok(KdfParams {
        algorithm: "argon2id".into(),
        salt: STANDARD.encode(salt),
        memory_kib: Params::DEFAULT_M_COST,
        iterations: Params::DEFAULT_T_COST,
        parallelism: Params::DEFAULT_P_COST,
    })
}

fn derive_key(passphrase: &str, kdf: &KdfParams) -> Result<Fernet, CommandError> {
    let invalid = |message: String| CommandError::Storage(format!("The saved-server file's key settings are invalid: {message}"));
    if kdf.algorithm != "argon2id" {
        return Err(invalid(format!("unknown algorithm {}", kdf.algorithm)));
    }
    let salt = STANDARD.decode(&kdf.salt).map_err(|error| invalid(error.to_string()))?;
    let params = Params::new(kdf.memory_kib, kdf.iterations, kdf.parallelism, Some(32)).map_err(|error| invalid(error.to_string()))?;
    let mut key = [0u8; 32];
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
        .hash_password_into(passphrase.as_bytes(), &salt, &mut key)
        .map_err(|error| invalid(error.to_string()))?;
    Fernet::new(&URL_SAFE.encode(key)).ok_or_else(|| invalid("derived key was rejected".into()))
}

fn initial_state(path: &Path, vault: &impl KeyVault) -> State {
    let file = match read_file(path) {
        Ok(file) => file,
        Err(reason) => return State::Locked { reason },
    };
    match file {
        None => match vault.read() {
            KeyLookup::Found(key) => State::Unlocked { list: ServerList::default(), key: Fernet::new(&key), kdf: None },
            KeyLookup::Missing | KeyLookup::Failed(_) => State::Unlocked { list: ServerList::default(), key: None, kdf: None },
            KeyLookup::NoKeyring(_) => State::NeedsPassphrase,
        },
        Some(file) if file.kdf.is_some() => State::NeedsPassphrase,
        Some(file) => match vault.read() {
            KeyLookup::Found(key) => match Fernet::new(&key).and_then(|fernet| decrypt_list(&file, &fernet).map(|list| (list, fernet))) {
                Some((list, fernet)) => State::Unlocked { list, key: Some(fernet), kdf: None },
                None => State::Locked { reason: "The saved-server file doesn't match the key in this system's keychain".into() },
            },
            KeyLookup::Missing => State::Locked { reason: "The key for the saved-server file isn't in this system's keychain".into() },
            KeyLookup::NoKeyring(reason) | KeyLookup::Failed(reason) => {
                State::Locked { reason: format!("The system keychain couldn't be read: {reason}") }
            }
        },
    }
}

impl<V: KeyVault> ServerStore<V> {
    pub fn open(path: PathBuf, vault: V) -> Self {
        let state = initial_state(&path, &vault);
        ServerStore { path, vault, state: Mutex::new(state) }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn status_of(&self, state: &State) -> StoreStatusView {
        let has_saved_file = self.path.exists();
        match state {
            State::Unlocked { .. } => StoreStatusView { status: StoreStatus::Unlocked, has_saved_file, reason: None },
            State::Locked { reason } => StoreStatusView { status: StoreStatus::Locked, has_saved_file, reason: Some(reason.clone()) },
            State::NeedsPassphrase => StoreStatusView { status: StoreStatus::NeedsPassphrase, has_saved_file, reason: None },
        }
    }

    pub fn status(&self) -> StoreStatusView {
        let state = self.lock();
        self.status_of(&state)
    }

    /// Unlocks a passphrase-protected file, or sets the passphrase when there is no file yet.
    pub fn unlock_with_passphrase(&self, passphrase: &str) -> Result<StoreStatusView, CommandError> {
        let mut state = self.lock();
        if !matches!(*state, State::NeedsPassphrase) {
            return Err(CommandError::Invalid("Saved servers aren't waiting for a passphrase".into()));
        }
        let next = match read_file(&self.path).map_err(CommandError::Storage)? {
            Some(file) => {
                let kdf = file.kdf.clone().ok_or_else(|| CommandError::Invalid("The saved-server file isn't passphrase-protected".into()))?;
                let key = derive_key(passphrase, &kdf)?;
                let list = decrypt_list(&file, &key).ok_or_else(|| CommandError::WrongPassphrase("That passphrase doesn't unlock the saved servers".into()))?;
                State::Unlocked { list, key: Some(key), kdf: Some(kdf) }
            }
            None => {
                if passphrase.chars().count() < MIN_PASSPHRASE_CHARS {
                    return Err(CommandError::Invalid(format!("Use at least {MIN_PASSPHRASE_CHARS} characters")));
                }
                let kdf = new_kdf_params()?;
                let key = derive_key(passphrase, &kdf)?;
                State::Unlocked { list: ServerList::default(), key: Some(key), kdf: Some(kdf) }
            }
        };
        *state = next;
        Ok(self.status_of(&state))
    }

    /// Sets a locked file aside under a dated name and starts with no saved servers. The old file is never deleted.
    pub fn start_fresh(&self) -> Result<StoreStatusView, CommandError> {
        let mut state = self.lock();
        if matches!(*state, State::Unlocked { .. }) {
            return Err(CommandError::Invalid("Saved servers are already unlocked".into()));
        }
        if self.path.exists() {
            let stamp = time::OffsetDateTime::now_utc()
                .format(time::macros::format_description!("[year]-[month]-[day]-[hour][minute][second]"))
                .map_err(|error| CommandError::Storage(error.to_string()))?;
            let aside = self.path.with_file_name(format!("servers.locked-{stamp}.json"));
            fs::rename(&self.path, &aside).map_err(|error| CommandError::Storage(format!("Couldn't set the old file aside: {error}")))?;
        }
        *state = initial_state(&self.path, &self.vault);
        Ok(self.status_of(&state))
    }

    pub fn read<R>(&self, reader: impl FnOnce(&ServerList) -> Result<R, CommandError>) -> Result<R, CommandError> {
        let state = self.lock();
        match &*state {
            State::Unlocked { list, .. } => reader(list),
            _ => Err(CommandError::StoreLocked("Saved servers are locked".into())),
        }
    }

    /// Applies `change` to a copy of the list, saves it, and only then keeps it.
    pub fn update<R>(&self, change: impl FnOnce(&mut ServerList) -> Result<R, CommandError>) -> Result<R, CommandError> {
        let mut state = self.lock();
        let State::Unlocked { list, key, kdf } = &mut *state else {
            return Err(CommandError::StoreLocked("Saved servers are locked".into()));
        };
        let mut next = list.clone();
        let result = change(&mut next)?;
        let fernet = match key {
            Some(fernet) => fernet.clone(),
            None => {
                let generated = Fernet::generate_key();
                self.vault
                    .write(&generated)
                    .map_err(|error| CommandError::Storage(format!("Couldn't store the encryption key in the system keychain: {error}")))?;
                let fernet = Fernet::new(&generated).ok_or_else(|| CommandError::Storage("Generated key was rejected".into()))?;
                *key = Some(fernet.clone());
                fernet
            }
        };
        let plain = serde_json::to_vec(&next).map_err(|error| CommandError::Storage(error.to_string()))?;
        let file = StoreFile { format: FILE_FORMAT, kdf: kdf.clone(), token: fernet.encrypt(&plain) };
        let bytes = serde_json::to_vec_pretty(&file).map_err(|error| CommandError::Storage(error.to_string()))?;
        write_atomic(&self.path, &bytes)?;
        *list = next;
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::servers::model::{Environment, PasswordChange, ServerInput, SessionDefaults, TlsMode};

    #[derive(Default)]
    struct MemoryVault {
        key: Mutex<Option<String>>,
        no_keyring: bool,
    }

    impl KeyVault for MemoryVault {
        fn read(&self) -> KeyLookup {
            if self.no_keyring {
                return KeyLookup::NoKeyring("no secret service".into());
            }
            match self.key.lock().unwrap().clone() {
                Some(key) => KeyLookup::Found(key),
                None => KeyLookup::Missing,
            }
        }

        fn write(&self, key: &str) -> Result<(), String> {
            if self.no_keyring {
                return Err("no secret service".into());
            }
            *self.key.lock().unwrap() = Some(key.to_string());
            Ok(())
        }
    }

    fn vault_with(key: Option<String>) -> MemoryVault {
        MemoryVault { key: Mutex::new(key), no_keyring: false }
    }

    fn no_keyring() -> MemoryVault {
        MemoryVault { key: Mutex::new(None), no_keyring: true }
    }

    fn server(name: &str) -> ServerInput {
        ServerInput {
            id: None,
            name: name.into(),
            group_id: None,
            environment: Environment::Prod,
            host: "db.example.com".into(),
            port: 5432,
            database: "orders".into(),
            user: "app".into(),
            password: PasswordChange::Set("hunter2-secret".into()),
            tls: TlsMode::VerifyFull,
            session: SessionDefaults::default(),
        }
    }

    fn saved_key(store: &ServerStore<MemoryVault>) -> Option<String> {
        store.vault.key.lock().unwrap().clone()
    }

    #[test]
    fn a_first_save_generates_a_key_and_writes_only_ciphertext() {
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("servers.json");
        let store = ServerStore::open(path.clone(), vault_with(None));
        assert_eq!(store.status().status, StoreStatus::Unlocked);

        store.update(|list| list.upsert_server(server("orders-prod"))).unwrap();

        assert!(saved_key(&store).is_some());
        let on_disk = fs::read_to_string(&path).unwrap();
        assert!(!on_disk.contains("hunter2-secret"));
        assert!(!on_disk.contains("db.example.com"));
    }

    #[test]
    fn reopening_with_the_same_key_restores_the_servers() {
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("servers.json");
        let store = ServerStore::open(path.clone(), vault_with(None));
        store.update(|list| list.upsert_server(server("orders-prod"))).unwrap();
        let key = saved_key(&store);

        let reopened = ServerStore::open(path, vault_with(key));

        let names = reopened.read(|list| Ok(list.servers.iter().map(|s| s.name.clone()).collect::<Vec<_>>())).unwrap();
        assert_eq!(names, vec!["orders-prod".to_string()]);
    }

    #[test]
    fn a_missing_key_locks_the_store_and_leaves_the_file_untouched() {
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("servers.json");
        ServerStore::open(path.clone(), vault_with(None)).update(|list| list.upsert_server(server("orders-prod"))).unwrap();
        let before = fs::read(&path).unwrap();

        let locked = ServerStore::open(path.clone(), vault_with(None));

        let status = locked.status();
        assert_eq!(status.status, StoreStatus::Locked);
        assert!(status.has_saved_file);
        assert!(matches!(locked.read(|_| Ok(())), Err(CommandError::StoreLocked(_))));
        assert!(matches!(locked.update(|_| Ok(())), Err(CommandError::StoreLocked(_))));
        assert_eq!(fs::read(&path).unwrap(), before);
    }

    #[test]
    fn a_different_key_locks_the_store() {
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("servers.json");
        ServerStore::open(path.clone(), vault_with(None)).update(|list| list.upsert_server(server("orders-prod"))).unwrap();

        let locked = ServerStore::open(path, vault_with(Some(Fernet::generate_key())));

        assert_eq!(locked.status().status, StoreStatus::Locked);
    }

    #[test]
    fn starting_fresh_sets_the_locked_file_aside_without_deleting_it() {
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("servers.json");
        ServerStore::open(path.clone(), vault_with(None)).update(|list| list.upsert_server(server("orders-prod"))).unwrap();
        let locked = ServerStore::open(path.clone(), vault_with(None));

        let status = locked.start_fresh().unwrap();

        assert_eq!(status.status, StoreStatus::Unlocked);
        assert!(!path.exists());
        let set_aside: Vec<_> = fs::read_dir(folder.path())
            .unwrap()
            .filter_map(|entry| entry.ok()?.file_name().into_string().ok())
            .filter(|name| name.starts_with("servers.locked-"))
            .collect();
        assert_eq!(set_aside.len(), 1);
    }

    #[test]
    fn starting_fresh_is_refused_while_unlocked() {
        let folder = tempfile::tempdir().unwrap();
        let store = ServerStore::open(folder.path().join("servers.json"), vault_with(None));
        assert!(matches!(store.start_fresh(), Err(CommandError::Invalid(_))));
    }

    #[test]
    fn without_a_keyring_a_passphrase_creates_then_unlocks_the_file() {
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("servers.json");
        let store = ServerStore::open(path.clone(), no_keyring());
        assert_eq!(store.status().status, StoreStatus::NeedsPassphrase);
        assert!(matches!(store.unlock_with_passphrase("short"), Err(CommandError::Invalid(_))));

        store.unlock_with_passphrase("correct horse battery").unwrap();
        store.update(|list| list.upsert_server(server("orders-prod"))).unwrap();

        let reopened = ServerStore::open(path, no_keyring());
        assert_eq!(reopened.status().status, StoreStatus::NeedsPassphrase);
        assert!(matches!(reopened.unlock_with_passphrase("wrong passphrase"), Err(CommandError::WrongPassphrase(_))));
        assert_eq!(reopened.status().status, StoreStatus::NeedsPassphrase);
        reopened.unlock_with_passphrase("correct horse battery").unwrap();
        assert_eq!(reopened.read(|list| Ok(list.servers.len())).unwrap(), 1);
    }

    #[test]
    fn a_failed_change_leaves_the_saved_list_as_it_was() {
        let folder = tempfile::tempdir().unwrap();
        let store = ServerStore::open(folder.path().join("servers.json"), vault_with(None));
        store.update(|list| list.upsert_server(server("orders-prod"))).unwrap();

        let result = store.update(|list| {
            list.servers.clear();
            Err::<(), _>(CommandError::Invalid("rejected".into()))
        });

        assert!(result.is_err());
        assert_eq!(store.read(|list| Ok(list.servers.len())).unwrap(), 1);
    }
}
