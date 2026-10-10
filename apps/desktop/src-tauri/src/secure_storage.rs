#[cfg(debug_assertions)]
use std::path::PathBuf;

use base64::{Engine as _, engine::general_purpose::STANDARD};

#[cfg(debug_assertions)]
use crate::variant;

#[cfg(debug_assertions)]
pub const INSECURE_DEBUG_SECURE_STORE_ENV: &str = "KUKU_ALLOW_INSECURE_DEBUG_SECURE_STORE";

const KEYRING_VALUE_PREFIX: &str = "kuku-secure:v1:";

#[derive(Debug)]
pub enum SecureStorageError {
    #[cfg(debug_assertions)]
    State(String),
    Store(String),
    NotFound,
}

impl std::fmt::Display for SecureStorageError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            #[cfg(debug_assertions)]
            SecureStorageError::State(message) => write!(f, "{message}"),
            SecureStorageError::Store(message) => write!(f, "{message}"),
            SecureStorageError::NotFound => write!(f, "secure value not found"),
        }
    }
}

impl std::error::Error for SecureStorageError {}

#[cfg(debug_assertions)]
pub fn read_bytes(service: &str, account: &str) -> Result<Option<Vec<u8>>, SecureStorageError> {
    if should_use_insecure_debug_fallback() {
        return read_debug_file(service, account);
    }
    read_keyring(service, account)
}

#[cfg(not(debug_assertions))]
pub fn read_bytes(service: &str, account: &str) -> Result<Option<Vec<u8>>, SecureStorageError> {
    read_keyring(service, account)
}

#[cfg(debug_assertions)]
pub fn write_bytes(service: &str, account: &str, content: &[u8]) -> Result<(), SecureStorageError> {
    if should_use_insecure_debug_fallback() {
        return write_debug_file(service, account, content);
    }
    write_keyring(service, account, content)
}

#[cfg(not(debug_assertions))]
pub fn write_bytes(service: &str, account: &str, content: &[u8]) -> Result<(), SecureStorageError> {
    write_keyring(service, account, content)
}

#[cfg(debug_assertions)]
pub fn delete(service: &str, account: &str) -> Result<(), SecureStorageError> {
    if should_use_insecure_debug_fallback() {
        return delete_debug_file(service, account);
    }
    delete_keyring(service, account)
}

#[cfg(not(debug_assertions))]
pub fn delete(service: &str, account: &str) -> Result<(), SecureStorageError> {
    delete_keyring(service, account)
}

#[cfg(debug_assertions)]
fn should_use_insecure_debug_fallback() -> bool {
    insecure_debug_fallback_enabled(
        std::env::var(INSECURE_DEBUG_SECURE_STORE_ENV)
            .ok()
            .as_deref(),
    )
}

#[cfg(debug_assertions)]
fn insecure_debug_fallback_enabled(value: Option<&str>) -> bool {
    matches!(
        value,
        Some("1" | "true" | "TRUE" | "yes" | "YES" | "on" | "ON")
    )
}

#[cfg(debug_assertions)]
fn read_debug_file(service: &str, account: &str) -> Result<Option<Vec<u8>>, SecureStorageError> {
    let path = debug_store_path(service, account)?;
    if !path.exists() {
        return Ok(None);
    }
    std::fs::read(path).map(Some).map_err(|error| {
        SecureStorageError::Store(format!(
            "failed to read insecure debug secure store: {error}"
        ))
    })
}

#[cfg(debug_assertions)]
fn write_debug_file(
    service: &str,
    account: &str,
    content: &[u8],
) -> Result<(), SecureStorageError> {
    let path = debug_store_path(service, account)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| {
            SecureStorageError::Store(format!(
                "failed to create insecure debug secure store: {error}"
            ))
        })?;
    }
    std::fs::write(path, content).map_err(|error| {
        SecureStorageError::Store(format!(
            "failed to write insecure debug secure store: {error}"
        ))
    })
}

#[cfg(debug_assertions)]
fn delete_debug_file(service: &str, account: &str) -> Result<(), SecureStorageError> {
    let path = debug_store_path(service, account)?;
    if !path.exists() {
        return Err(SecureStorageError::NotFound);
    }
    std::fs::remove_file(path).map_err(|error| {
        SecureStorageError::Store(format!(
            "failed to delete insecure debug secure store: {error}"
        ))
    })
}

#[cfg(debug_assertions)]
fn debug_store_path(service: &str, account: &str) -> Result<PathBuf, SecureStorageError> {
    let home = dirs::home_dir().ok_or_else(|| {
        SecureStorageError::State("cannot resolve the user home directory".into())
    })?;
    Ok(variant::data_root(&home)
        .join("debug-secure-store")
        .join(format!("{service}.{account}.json")))
}

fn read_keyring(service: &str, account: &str) -> Result<Option<Vec<u8>>, SecureStorageError> {
    let entry = keyring::Entry::new(service, account)
        .map_err(|error| SecureStorageError::Store(format!("failed to open keyring: {error}")))?;
    match entry.get_password() {
        Ok(content) => Ok(Some(decode_keyring_value(&content)?)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(SecureStorageError::Store(format!(
            "failed to read keyring: {error}"
        ))),
    }
}

/// The explicitly opted-in live-model smoke test may read the existing KukuDev
/// Gemini credential. Never route a real credential through the smoke app's
/// insecure synthetic-secret store, or accept arbitrary service/account names.
#[cfg(feature = "native-smoke")]
pub(crate) fn read_smoke_dev_ai_key() -> Result<Option<Vec<u8>>, SecureStorageError> {
    read_keyring("mom.kuku.desktop.plugin-secrets.dev", "ai-chat:apiKey")
}

fn write_keyring(service: &str, account: &str, content: &[u8]) -> Result<(), SecureStorageError> {
    let entry = keyring::Entry::new(service, account)
        .map_err(|error| SecureStorageError::Store(format!("failed to open keyring: {error}")))?;
    entry
        .set_password(&encode_keyring_value(content))
        .map_err(|error| SecureStorageError::Store(format!("failed to write keyring: {error}")))
}

fn delete_keyring(service: &str, account: &str) -> Result<(), SecureStorageError> {
    let entry = keyring::Entry::new(service, account)
        .map_err(|error| SecureStorageError::Store(format!("failed to open keyring: {error}")))?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Err(SecureStorageError::NotFound),
        Err(error) => Err(SecureStorageError::Store(format!(
            "failed to delete keyring: {error}"
        ))),
    }
}

fn encode_keyring_value(content: &[u8]) -> String {
    format!("{KEYRING_VALUE_PREFIX}{}", STANDARD.encode(content))
}

fn decode_keyring_value(content: &str) -> Result<Vec<u8>, SecureStorageError> {
    if let Some(encoded) = content.strip_prefix(KEYRING_VALUE_PREFIX) {
        return STANDARD.decode(encoded).map_err(|error| {
            SecureStorageError::Store(format!("invalid keyring payload encoding: {error}"))
        });
    }
    Ok(content.as_bytes().to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(debug_assertions)]
    #[test]
    fn insecure_debug_fallback_env_is_opt_in() {
        assert!(!insecure_debug_fallback_enabled(None));
        assert!(!insecure_debug_fallback_enabled(Some("0")));
        assert!(!insecure_debug_fallback_enabled(Some("false")));
        assert!(insecure_debug_fallback_enabled(Some("1")));
        assert!(insecure_debug_fallback_enabled(Some("true")));
        assert!(insecure_debug_fallback_enabled(Some("yes")));
        assert!(insecure_debug_fallback_enabled(Some("on")));
    }

    #[test]
    fn decode_keyring_value_supports_prefixed_and_legacy_payloads() {
        let encoded = encode_keyring_value(br#"{"token":"abc"}"#);
        assert_eq!(
            decode_keyring_value(&encoded).unwrap(),
            br#"{"token":"abc"}"#.to_vec()
        );

        assert_eq!(
            decode_keyring_value(r#"{"token":"legacy"}"#).unwrap(),
            br#"{"token":"legacy"}"#.to_vec()
        );
    }

    #[cfg(debug_assertions)]
    #[test]
    fn debug_store_path_uses_kuku_debug_secure_store_directory() {
        let path = debug_store_path("mom.kuku.desktop.auth", "tokens").unwrap();
        assert!(path.ends_with(".kuku/debug-secure-store/mom.kuku.desktop.auth.tokens.json"));
    }
}
