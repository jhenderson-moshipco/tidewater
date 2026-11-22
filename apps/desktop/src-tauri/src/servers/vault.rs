//! Where the key that encrypts the server file exists.

use keyring::Entry;

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

impl KeyVault for OsKeychain {
    fn read(&self) -> KeyLookup {
        read_key(Entry::new(SERVICE, ACCOUNT))
    }

    fn write(&self, key: &str) -> Result<(), String> {
        write_key(Entry::new(SERVICE, ACCOUNT), key)
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
    }
}
