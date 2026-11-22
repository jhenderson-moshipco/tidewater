//! The encrypted saved-server file and the lock state the frontend sees.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, OnceLock, PoisonError};

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
    /// Empty until first use, so the keychain and file are never read at launch.
    state: OnceLock<Mutex<State>>,
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

pub(crate) fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let mut options = fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    options.open(path).and_then(|mut file| file.write_all(bytes).and_then(|()| file.sync_all()))
}

fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), CommandError> {
    let temporary = path.with_extension("json.tmp");
    path.parent()
        .map_or(Ok(()), fs::create_dir_all)
        .and_then(|()| write_private(&temporary, bytes))
        .and_then(|()| fs::rename(&temporary, path))
        .map_err(|error| CommandError::Storage(format!("Couldn't save servers: {error}")))
}

fn decrypt_list(file: &StoreFile, key: &Fernet) -> Option<ServerList> {
    let bytes = key.decrypt(&file.token).ok()?;
    serde_json::from_slice(&bytes).ok()
}

fn new_kdf_params() -> KdfParams {
    let mut salt = [0u8; argon2::RECOMMENDED_SALT_LEN];
    getrandom::fill(&mut salt).expect("the system's random number source failed");
    KdfParams {
        algorithm: "argon2id".into(),
        salt: STANDARD.encode(salt),
        memory_kib: Params::DEFAULT_M_COST,
        iterations: Params::DEFAULT_T_COST,
        parallelism: Params::DEFAULT_P_COST,
    }
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
    Ok(Fernet::new(&URL_SAFE.encode(key)).expect("32 bytes always make a valid Fernet key"))
}

/// The unlocked state for a passphrase: the file's servers when it exists, otherwise a new empty list.
fn passphrase_state(path: &Path, passphrase: &str) -> Result<State, CommandError> {
    match read_file(path).map_err(CommandError::Storage)? {
        Some(file) => {
            let kdf = file.kdf.clone().ok_or_else(|| CommandError::Invalid("The saved-server file isn't passphrase-protected".into()))?;
            let key = derive_key(passphrase, &kdf)?;
            let list = decrypt_list(&file, &key).ok_or_else(|| CommandError::WrongPassphrase("That passphrase doesn't unlock the saved servers".into()))?;
            Ok(State::Unlocked { list, key: Some(key), kdf: Some(kdf) })
        }
        None if passphrase.chars().count() < MIN_PASSPHRASE_CHARS => {
            Err(CommandError::Invalid(format!("Use at least {MIN_PASSPHRASE_CHARS} characters")))
        }
        None => {
            let kdf = new_kdf_params();
            derive_key(passphrase, &kdf).map(|key| State::Unlocked { list: ServerList::default(), key: Some(key), kdf: Some(kdf) })
        }
    }
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
                None => State::Locked { reason: "The saved-server file doesn't match its key".into() },
            },
            KeyLookup::Missing => State::Locked { reason: "The key for the saved-server file is missing".into() },
            KeyLookup::NoKeyring(reason) | KeyLookup::Failed(reason) => {
                State::Locked { reason: format!("The key for the saved-server file couldn't be read: {reason}") }
            }
        },
    }
}

impl<V: KeyVault> ServerStore<V> {
    /// Creates the store without touching the keychain or the file; both are read on first use.
    pub fn new(path: PathBuf, vault: V) -> Self {
        ServerStore { path, vault, state: OnceLock::new() }
    }

    pub fn vault(&self) -> &V {
        &self.vault
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        self.state
            .get_or_init(|| Mutex::new(initial_state(&self.path, &self.vault)))
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
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
        *state = passphrase_state(&self.path, passphrase)?;
        Ok(self.status_of(&state))
    }

    /// Sets a locked file aside under a dated name and starts with no saved servers. The old file is never deleted.
    pub fn start_fresh(&self) -> Result<StoreStatusView, CommandError> {
        let stamp = time::OffsetDateTime::now_utc()
            .format(time::macros::format_description!("[year]-[month]-[day]-[hour][minute][second]"))
            .expect("a UTC timestamp always formats");
        self.start_fresh_as(&stamp)
    }

    fn start_fresh_as(&self, stamp: &str) -> Result<StoreStatusView, CommandError> {
        let mut state = self.lock();
        if matches!(*state, State::Unlocked { .. }) {
            return Err(CommandError::Invalid("Saved servers are already unlocked".into()));
        }
        if self.path.exists() {
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
                    .map_err(|error| CommandError::Storage(format!("Couldn't store the encryption key: {error}")))?;
                let fernet = Fernet::new(&generated).expect("a generated key is always valid");
                *key = Some(fernet.clone());
                fernet
            }
        };
        let plain = serde_json::to_vec(&next).expect("a server list always serializes");
        let file = StoreFile { format: FILE_FORMAT, kdf: kdf.clone(), token: fernet.encrypt(&plain) };
        let bytes = serde_json::to_vec_pretty(&file).expect("the store file always serializes");
        write_atomic(&self.path, &bytes)?;
        *list = next;
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::Ordering;

    use super::*;
    use crate::testing::{Keychain, MemoryVault, parts};
    use crate::servers::model::{Environment, PasswordChange, ServerInput, ServerSummary, SessionDefaults, TlsMode};

    fn vault_with(key: Option<String>) -> MemoryVault {
        MemoryVault { key: Mutex::new(key), ..MemoryVault::default() }
    }

    fn keychain(keychain: Keychain) -> MemoryVault {
        MemoryVault { keychain, ..MemoryVault::default() }
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

    fn add<V: KeyVault>(store: &ServerStore<V>, name: &str) -> Result<ServerSummary, CommandError> {
        store.update(|list| list.upsert_server(server(name)))
    }

    fn try_count<V: KeyVault>(store: &ServerStore<V>) -> Result<usize, CommandError> {
        store.read(|list| Ok(list.servers.len()))
    }

    fn server_count<V: KeyVault>(store: &ServerStore<V>) -> usize {
        try_count(store).unwrap()
    }

    /// A folder holding a keychain-protected file with one server, and the key that opens it.
    fn saved_file() -> (tempfile::TempDir, PathBuf, Option<String>) {
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("servers.json");
        let store = ServerStore::new(path.clone(), vault_with(None));
        add(&store, "orders-prod").unwrap();
        let key = saved_key(&store);
        (folder, path, key)
    }

    fn locked_reason<V: KeyVault>(store: &ServerStore<V>) -> String {
        let status = store.status();
        assert_eq!(status.status, StoreStatus::Locked);
        status.reason.expect("a locked store says why")
    }

    fn kdf(algorithm: &str, salt: &str, memory_kib: u32) -> KdfParams {
        KdfParams { algorithm: algorithm.into(), salt: salt.into(), memory_kib, iterations: 1, parallelism: 1 }
    }

    fn invalid_settings(settings: KdfParams) -> String {
        let (kind, message) = parts(derive_key("passphrase", &settings).err().unwrap());
        assert_eq!(kind, "storage");
        message.strip_prefix("The saved-server file's key settings are invalid: ").unwrap().to_string()
    }

    #[test]
    fn creating_the_store_reads_nothing_until_first_use() {
        let folder = tempfile::tempdir().unwrap();
        let store = ServerStore::new(folder.path().join("servers.json"), vault_with(None));
        assert_eq!(store.vault.reads.load(Ordering::SeqCst), 0);

        store.status();
        store.status();

        assert_eq!(store.vault.reads.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn a_first_save_generates_a_key_and_writes_only_ciphertext() {
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("servers.json");
        let store = ServerStore::new(path.clone(), vault_with(None));
        assert_eq!(store.status().status, StoreStatus::Unlocked);

        add(&store, "orders-prod").unwrap();

        assert!(saved_key(&store).is_some());
        let on_disk = fs::read_to_string(&path).unwrap();
        assert!(!on_disk.contains("hunter2-secret"));
        assert!(!on_disk.contains("db.example.com"));
    }

    #[cfg(unix)]
    #[test]
    fn the_saved_file_is_readable_only_by_its_owner() {
        use std::os::unix::fs::PermissionsExt;
        let (_folder, path, _key) = saved_file();
        assert_eq!(fs::metadata(path).unwrap().permissions().mode() & 0o777, 0o600);
    }

    #[test]
    fn reopening_with_the_same_key_restores_the_servers() {
        let (_folder, path, key) = saved_file();

        let reopened = ServerStore::new(path, vault_with(key));

        let names = reopened.read(|list| Ok(list.servers.iter().map(|s| s.name.clone()).collect::<Vec<_>>())).unwrap();
        assert_eq!(names, vec!["orders-prod".to_string()]);
    }

    #[test]
    fn a_key_already_in_the_keychain_is_used_for_the_first_save() {
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("servers.json");
        let key = Fernet::generate_key();
        let store = ServerStore::new(path.clone(), vault_with(Some(key.clone())));

        add(&store, "orders-prod").unwrap();

        assert_eq!(saved_key(&store), Some(key.clone()));
        assert_eq!(server_count(&ServerStore::new(path, vault_with(Some(key)))), 1);
    }

    #[test]
    fn a_missing_key_locks_the_store_and_leaves_the_file_untouched() {
        let (_folder, path, _key) = saved_file();
        let before = fs::read(&path).unwrap();

        let locked = ServerStore::new(path.clone(), vault_with(None));

        assert_eq!(locked_reason(&locked), "The key for the saved-server file is missing");
        assert!(locked.status().has_saved_file);
        let refused = CommandError::StoreLocked("Saved servers are locked".into());
        assert_eq!(try_count(&locked), Err(refused.clone()));
        assert_eq!(add(&locked, "orders-dev"), Err(refused));
        assert_eq!(fs::read(&path).unwrap(), before);
    }

    #[test]
    fn a_different_key_locks_the_store() {
        let (_folder, path, _key) = saved_file();

        let locked = ServerStore::new(path, vault_with(Some(Fernet::generate_key())));

        assert_eq!(locked_reason(&locked), "The saved-server file doesn't match its key");
    }

    #[test]
    fn a_keychain_that_refuses_the_read_locks_an_existing_file() {
        let (_folder, path, _key) = saved_file();

        let locked = ServerStore::new(path, keychain(Keychain::Refusing));

        assert_eq!(locked_reason(&locked), "The key for the saved-server file couldn't be read: denied");
    }

    #[test]
    fn without_a_keyring_a_keychain_protected_file_stays_locked() {
        let (_folder, path, _key) = saved_file();

        let locked = ServerStore::new(path, keychain(Keychain::NoKeyring));

        assert_eq!(locked_reason(&locked), "The key for the saved-server file couldn't be read: no secret service");
    }

    #[test]
    fn a_keychain_that_refuses_the_write_fails_the_first_save() {
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("servers.json");
        let store = ServerStore::new(path.clone(), keychain(Keychain::Refusing));

        let saved = add(&store, "orders-prod");

        assert_eq!(saved, Err(CommandError::Storage("Couldn't store the encryption key: denied".into())));
        assert!(!path.exists());
        assert_eq!(server_count(&store), 0);
    }

    #[test]
    fn an_unreadable_file_locks_the_store() {
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("servers.json");
        fs::create_dir(&path).unwrap();

        let reason = locked_reason(&ServerStore::new(path, vault_with(None)));

        assert!(reason.starts_with("The saved-server file couldn't be read: "), "{reason}");
    }

    #[test]
    fn a_file_that_isnt_json_locks_the_store() {
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("servers.json");
        fs::write(&path, "not json").unwrap();

        let reason = locked_reason(&ServerStore::new(path, vault_with(None)));

        assert!(reason.starts_with("The saved-server file isn't in a format Tidewater recognizes: "), "{reason}");
    }

    #[test]
    fn a_file_from_a_newer_format_locks_the_store() {
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("servers.json");
        fs::write(&path, r#"{"format":2,"kdf":null,"token":""}"#).unwrap();

        let reason = locked_reason(&ServerStore::new(path, vault_with(None)));

        assert_eq!(reason, "The saved-server file uses format 2, which this version of Tidewater can't read");
    }

    #[test]
    fn starting_fresh_sets_the_locked_file_aside_without_deleting_it() {
        let (folder, path, _key) = saved_file();
        let locked = ServerStore::new(path.clone(), vault_with(None));

        let status = locked.start_fresh().unwrap();

        assert_eq!(status.status, StoreStatus::Unlocked);
        assert!(!path.exists());
        let set_aside: Vec<_> = fs::read_dir(folder.path())
            .unwrap()
            .map(|entry| entry.unwrap().file_name().into_string().unwrap())
            .filter(|name| name.starts_with("servers.locked-"))
            .collect();
        assert_eq!(set_aside.len(), 1);
    }

    #[test]
    fn starting_fresh_without_a_file_reopens_the_store() {
        let folder = tempfile::tempdir().unwrap();
        let store = ServerStore::new(folder.path().join("servers.json"), keychain(Keychain::NoKeyring));
        assert_eq!(store.status().status, StoreStatus::NeedsPassphrase);

        assert_eq!(store.start_fresh().unwrap().status, StoreStatus::NeedsPassphrase);
    }

    #[test]
    fn starting_fresh_is_refused_while_unlocked() {
        let folder = tempfile::tempdir().unwrap();
        let store = ServerStore::new(folder.path().join("servers.json"), vault_with(None));
        assert_eq!(store.start_fresh(), Err(CommandError::Invalid("Saved servers are already unlocked".into())));
    }

    #[test]
    fn a_file_that_cant_be_set_aside_is_left_where_it_is() {
        let (folder, path, _key) = saved_file();
        let taken = folder.path().join("servers.locked-stamp.json");
        fs::create_dir(&taken).unwrap();
        fs::write(taken.join("keep"), "").unwrap();
        let locked = ServerStore::new(path.clone(), vault_with(None));

        let (kind, message) = parts(locked.start_fresh_as("stamp").unwrap_err());

        assert_eq!(kind, "storage");
        assert!(message.starts_with("Couldn't set the old file aside: "), "{message}");
        assert!(path.exists());
        assert_eq!(locked.status().status, StoreStatus::Locked);
    }

    #[test]
    fn without_a_keyring_a_passphrase_creates_then_unlocks_the_file() {
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("servers.json");
        let store = ServerStore::new(path.clone(), keychain(Keychain::NoKeyring));
        assert_eq!(store.status().status, StoreStatus::NeedsPassphrase);
        assert_eq!(store.unlock_with_passphrase("short"), Err(CommandError::Invalid("Use at least 8 characters".into())));

        store.unlock_with_passphrase("correct horse battery").unwrap();
        add(&store, "orders-prod").unwrap();

        let reopened = ServerStore::new(path, keychain(Keychain::NoKeyring));
        assert_eq!(reopened.status().status, StoreStatus::NeedsPassphrase);
        assert_eq!(
            reopened.unlock_with_passphrase("wrong passphrase"),
            Err(CommandError::WrongPassphrase("That passphrase doesn't unlock the saved servers".into()))
        );
        assert_eq!(reopened.status().status, StoreStatus::NeedsPassphrase);
        reopened.unlock_with_passphrase("correct horse battery").unwrap();
        assert_eq!(server_count(&reopened), 1);
    }

    #[test]
    fn a_passphrase_is_refused_when_the_store_isnt_waiting_for_one() {
        let folder = tempfile::tempdir().unwrap();
        let store = ServerStore::new(folder.path().join("servers.json"), vault_with(None));
        assert_eq!(
            store.unlock_with_passphrase("correct horse battery"),
            Err(CommandError::Invalid("Saved servers aren't waiting for a passphrase".into()))
        );
    }

    #[test]
    fn a_passphrase_is_refused_when_the_file_changed_to_a_keychain_file() {
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("servers.json");
        let waiting = ServerStore::new(path.clone(), keychain(Keychain::NoKeyring));
        assert_eq!(waiting.status().status, StoreStatus::NeedsPassphrase);
        add(&ServerStore::new(path, vault_with(None)), "orders-prod").unwrap();

        assert_eq!(
            waiting.unlock_with_passphrase("correct horse battery"),
            Err(CommandError::Invalid("The saved-server file isn't passphrase-protected".into()))
        );
    }

    #[test]
    fn a_passphrase_is_refused_when_the_file_became_unreadable() {
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("servers.json");
        let waiting = ServerStore::new(path.clone(), keychain(Keychain::NoKeyring));
        assert_eq!(waiting.status().status, StoreStatus::NeedsPassphrase);
        fs::write(&path, "not json").unwrap();

        let (kind, message) = parts(waiting.unlock_with_passphrase("correct horse battery").unwrap_err());

        assert_eq!(kind, "storage");
        assert!(message.starts_with("The saved-server file isn't in a format Tidewater recognizes: "), "{message}");
    }

    #[test]
    fn a_passphrase_file_with_tampered_key_settings_is_refused() {
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("servers.json");
        let store = ServerStore::new(path.clone(), keychain(Keychain::NoKeyring));
        store.unlock_with_passphrase("correct horse battery").unwrap();
        add(&store, "orders-prod").unwrap();
        let mut file = read_file(&path).unwrap().unwrap();
        file.kdf = Some(kdf("scrypt", "", 0));
        fs::write(&path, serde_json::to_vec(&file).unwrap()).unwrap();

        let reopened = ServerStore::new(path, keychain(Keychain::NoKeyring));

        assert_eq!(
            reopened.unlock_with_passphrase("correct horse battery"),
            Err(CommandError::Storage("The saved-server file's key settings are invalid: unknown algorithm scrypt".into()))
        );
    }

    #[test]
    fn key_settings_with_a_bad_salt_memory_cost_or_salt_length_are_refused() {
        assert_eq!(invalid_settings(kdf("argon2id", "not base64!", 19_456)), "Invalid symbol 32, offset 3.");
        assert_eq!(invalid_settings(kdf("argon2id", "c2FsdHNhbHQ=", 0)), "memory cost is too small");
        assert_eq!(invalid_settings(kdf("argon2id", "AAAA", 19_456)), "salt is too short");
    }

    #[test]
    fn a_failed_change_leaves_the_saved_list_as_it_was() {
        let folder = tempfile::tempdir().unwrap();
        let store = ServerStore::new(folder.path().join("servers.json"), vault_with(None));
        add(&store, "orders-prod").unwrap();

        let result = store.update(|list| {
            list.servers.clear();
            Err::<(), _>(CommandError::Invalid("rejected".into()))
        });

        assert_eq!(result, Err(CommandError::Invalid("rejected".into())));
        assert_eq!(add(&store, "  "), Err(CommandError::Invalid("Name is required".into())));
        assert_eq!(server_count(&store), 1);
    }

    #[test]
    fn a_failed_write_leaves_the_saved_list_as_it_was() {
        let folder = tempfile::tempdir().unwrap();
        let path = folder.path().join("servers.json");
        let store = ServerStore::new(path.clone(), vault_with(None));
        add(&store, "orders-prod").unwrap();
        fs::create_dir(path.with_extension("json.tmp")).unwrap();

        let (kind, message) = parts(add(&store, "orders-dev").unwrap_err());

        assert_eq!(kind, "storage");
        assert!(message.starts_with("Couldn't save servers: "), "{message}");
        assert_eq!(server_count(&store), 1);
    }

    #[test]
    fn a_change_that_panics_doesnt_lock_out_later_commands() {
        let folder = tempfile::tempdir().unwrap();
        let store = ServerStore::new(folder.path().join("servers.json"), vault_with(None));

        let panicked = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| store.update(|_| -> Result<(), CommandError> { panic!("boom") })));

        assert!(panicked.is_err());
        assert_eq!(store.status().status, StoreStatus::Unlocked);
    }
}
