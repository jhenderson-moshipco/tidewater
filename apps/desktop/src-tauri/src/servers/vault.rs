//! Where the key that encrypts the server file exists.

pub enum KeyLookup {
    Found(String),
    Missing,
    /// No keyring service exists on this system, affects linux distributions without a native passkey style service
    NoKeyring(String),
    /// A keyring exists but refused or failed the request
    Failed(String),
}

pub trait KeyVault: Send + Sync {
    fn read(&self) -> KeyLookup;
    fn write(&self, key: &str) -> Result<(), String>;
}

const SERVICE: &str = "Tidewater";
const ACCOUNT: &str = "server-store-key";

pub struct OsKeychain;

/// Check the error passed along by the OS keyring
fn lookup_from_error(error: keyring::Error) -> KeyLookup {
    match error {
        keyring::Error::NoEntry => KeyLookup::Missing,
        keyring::Error::NoStorageAccess(_) | keyring::Error::PlatformFailure(_) if cfg!(target_os = "linux") => {
            KeyLookup::NoKeyring(error.to_string())
        }
        other => KeyLookup::Failed(other.to_string()),
    }
}

impl KeyVault for OsKeychain {
    fn read(&self) -> KeyLookup {
        match keyring::Entry::new(SERVICE, ACCOUNT).and_then(|entry| entry.get_password()) {
            Ok(key) => KeyLookup::Found(key),
            Err(error) => lookup_from_error(error),
        }
    }

    fn write(&self, key: &str) -> Result<(), String> {
        keyring::Entry::new(SERVICE, ACCOUNT)
            .and_then(|entry| entry.set_password(key))
            .map_err(|error| error.to_string())
    }
}
