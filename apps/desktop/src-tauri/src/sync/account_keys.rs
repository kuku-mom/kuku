#![allow(dead_code)]

use base64::{Engine as _, engine::general_purpose::STANDARD};
use bip39::{Language, Mnemonic};
use chacha20poly1305::aead::{Aead, Payload};
use chacha20poly1305::{Key, KeyInit, XChaCha20Poly1305, XNonce};
use rand_core::{OsRng, RngCore};
use serde::{Deserialize, Serialize};

use super::crypto::{SymmetricKey, canonical_json, decrypt_blob, encrypt_blob};
use super::errors::{SyncError, SyncResult};
use super::keys::{Argon2idKdfParams, passphrase_kek};

const KEY_LEN: usize = 32;
const XCHACHA20_NONCE_LEN: usize = 24;

pub const ACCOUNT_METADATA_KEY_PURPOSE: &str = "kuku-sync-account-metadata-v1";
pub const ACCOUNT_WORKSPACE_WRAP_KEY_PURPOSE: &str = "kuku-sync-account-workspace-wrap-v1";
pub const ACCOUNT_DEVICE_METADATA_KEY_PURPOSE: &str = "kuku-sync-account-device-metadata-v1";

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct AccountRecoveryKeyEnvelope {
    pub account_key_id: String,
    pub envelope_id: String,
    pub recipient_type: String,
    pub key_version: i64,
    pub kdf: Argon2idKdfParams,
    pub wrap: WrappedAccountRootKey,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct WrappedAccountRootKey {
    pub alg: String,
    pub nonce: String,
    pub ciphertext: String,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct WorkspaceDisplayMetadata {
    pub schema_version: u8,
    pub name: String,
}

impl WorkspaceDisplayMetadata {
    pub fn new(name: impl Into<String>) -> Self {
        Self {
            schema_version: 1,
            name: name.into(),
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct DeviceDisplayMetadata {
    pub schema_version: u8,
    pub name: String,
}

impl DeviceDisplayMetadata {
    pub fn new(name: impl Into<String>) -> Self {
        Self {
            schema_version: 1,
            name: name.into(),
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
struct AccountRecoveryEnvelopeAad {
    format: String,
    version: u8,
    account_key_id: String,
    envelope_id: String,
    recipient_type: String,
}

impl AccountRecoveryEnvelopeAad {
    fn new(account_key_id: &str, envelope_id: &str) -> Self {
        Self {
            format: "kuku.sync.account-key-envelope".into(),
            version: 1,
            account_key_id: account_key_id.into(),
            envelope_id: envelope_id.into(),
            recipient_type: "recovery_phrase".into(),
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
struct WorkspaceMetadataAad {
    format: String,
    version: u8,
    account_key_id: String,
    workspace_id: String,
    metadata_version: i64,
}

impl WorkspaceMetadataAad {
    fn new(account_key_id: &str, workspace_id: &str, metadata_version: i64) -> Self {
        Self {
            format: "kuku.sync.workspace-metadata".into(),
            version: 1,
            account_key_id: account_key_id.into(),
            workspace_id: workspace_id.into(),
            metadata_version,
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
struct WorkspaceKeyForAccountAad {
    format: String,
    version: u8,
    account_key_id: String,
    workspace_id: String,
    workspace_key_version: i64,
}

impl WorkspaceKeyForAccountAad {
    fn new(account_key_id: &str, workspace_id: &str, workspace_key_version: i64) -> Self {
        Self {
            format: "kuku.sync.workspace-key-for-account".into(),
            version: 1,
            account_key_id: account_key_id.into(),
            workspace_id: workspace_id.into(),
            workspace_key_version,
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
struct DeviceMetadataAad {
    format: String,
    version: u8,
    account_key_id: String,
    workspace_id: String,
    device_id: String,
    metadata_version: i64,
}

impl DeviceMetadataAad {
    fn new(
        account_key_id: &str,
        workspace_id: &str,
        device_id: &str,
        metadata_version: i64,
    ) -> Self {
        Self {
            format: "kuku.sync.device-metadata".into(),
            version: 1,
            account_key_id: account_key_id.into(),
            workspace_id: workspace_id.into(),
            device_id: device_id.into(),
            metadata_version,
        }
    }
}

pub fn generate_recovery_phrase() -> SyncResult<String> {
    let mut entropy = [0u8; KEY_LEN];
    OsRng.fill_bytes(&mut entropy);
    let mnemonic = Mnemonic::from_entropy_in(Language::English, &entropy).map_err(|error| {
        SyncError::Crypto(format!("recovery phrase generation failed: {error}"))
    })?;
    Ok(mnemonic.to_string())
}

pub fn normalize_recovery_phrase(phrase: &str) -> String {
    phrase
        .split_whitespace()
        .map(str::to_lowercase)
        .collect::<Vec<_>>()
        .join(" ")
}

pub fn random_account_root_key() -> SymmetricKey {
    let mut key = [0u8; KEY_LEN];
    OsRng.fill_bytes(&mut key);
    key
}

pub fn derive_account_subkey(
    account_root_key: &SymmetricKey,
    purpose: &str,
    account_key_id: &str,
) -> SymmetricKey {
    let mut input = Vec::with_capacity(purpose.len() + 1 + account_key_id.len());
    input.extend_from_slice(purpose.as_bytes());
    input.push(0);
    input.extend_from_slice(account_key_id.as_bytes());
    *blake3::keyed_hash(account_root_key, &input).as_bytes()
}

pub fn account_metadata_key(account_root_key: &SymmetricKey, account_key_id: &str) -> SymmetricKey {
    derive_account_subkey(
        account_root_key,
        ACCOUNT_METADATA_KEY_PURPOSE,
        account_key_id,
    )
}

pub fn account_workspace_wrap_key(
    account_root_key: &SymmetricKey,
    account_key_id: &str,
) -> SymmetricKey {
    derive_account_subkey(
        account_root_key,
        ACCOUNT_WORKSPACE_WRAP_KEY_PURPOSE,
        account_key_id,
    )
}

pub fn account_device_metadata_key(
    account_root_key: &SymmetricKey,
    account_key_id: &str,
) -> SymmetricKey {
    derive_account_subkey(
        account_root_key,
        ACCOUNT_DEVICE_METADATA_KEY_PURPOSE,
        account_key_id,
    )
}

pub fn wrap_account_root_key_with_recovery_phrase(
    account_key_id: &str,
    envelope_id: &str,
    key_version: i64,
    account_root_key: &SymmetricKey,
    recovery_phrase: &str,
) -> SyncResult<AccountRecoveryKeyEnvelope> {
    wrap_account_root_key_with_params(
        account_key_id,
        envelope_id,
        key_version,
        account_root_key,
        recovery_phrase,
        Argon2idKdfParams::default(),
    )
}

pub fn wrap_account_root_key_with_params(
    account_key_id: &str,
    envelope_id: &str,
    key_version: i64,
    account_root_key: &SymmetricKey,
    recovery_phrase: &str,
    kdf: Argon2idKdfParams,
) -> SyncResult<AccountRecoveryKeyEnvelope> {
    let normalized_phrase = require_recovery_phrase(recovery_phrase)?;
    let kek = passphrase_kek(&normalized_phrase, &kdf)?;
    let aad = canonical_json(&AccountRecoveryEnvelopeAad::new(
        account_key_id,
        envelope_id,
    ))?;
    let mut nonce = [0u8; XCHACHA20_NONCE_LEN];
    OsRng.fill_bytes(&mut nonce);
    let ciphertext = XChaCha20Poly1305::new(Key::from_slice(&kek))
        .encrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: account_root_key,
                aad: &aad,
            },
        )
        .map_err(|_| SyncError::Crypto("account root key wrap failed".into()))?;

    Ok(AccountRecoveryKeyEnvelope {
        account_key_id: account_key_id.into(),
        envelope_id: envelope_id.into(),
        recipient_type: "recovery_phrase".into(),
        key_version,
        kdf,
        wrap: WrappedAccountRootKey {
            alg: "XChaCha20-Poly1305".into(),
            nonce: STANDARD.encode(nonce),
            ciphertext: STANDARD.encode(ciphertext),
        },
    })
}

pub fn unwrap_account_root_key_with_recovery_phrase(
    envelope: &AccountRecoveryKeyEnvelope,
    recovery_phrase: &str,
) -> SyncResult<SymmetricKey> {
    if envelope.recipient_type != "recovery_phrase" {
        return Err(SyncError::InvalidArgument(
            "account key envelope recipient_type must be recovery_phrase".into(),
        ));
    }
    if envelope.wrap.alg != "XChaCha20-Poly1305" {
        return Err(SyncError::Crypto(
            "unsupported account root key wrap alg".into(),
        ));
    }

    let normalized_phrase = require_recovery_phrase(recovery_phrase)?;
    let kek = passphrase_kek(&normalized_phrase, &envelope.kdf)?;
    let nonce = decode_fixed::<XCHACHA20_NONCE_LEN>(&envelope.wrap.nonce, "wrap nonce")?;
    let ciphertext = STANDARD
        .decode(&envelope.wrap.ciphertext)
        .map_err(|error| SyncError::Serialization(format!("invalid wrap ciphertext: {error}")))?;
    let aad = canonical_json(&AccountRecoveryEnvelopeAad::new(
        &envelope.account_key_id,
        &envelope.envelope_id,
    ))?;
    let plaintext = XChaCha20Poly1305::new(Key::from_slice(&kek))
        .decrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: &ciphertext,
                aad: &aad,
            },
        )
        .map_err(|_| SyncError::Crypto("account recovery phrase unwrap failed".into()))?;
    plaintext
        .try_into()
        .map_err(|_| SyncError::Crypto("invalid account root key length".into()))
}

pub fn encrypt_workspace_metadata(
    account_root_key: &SymmetricKey,
    account_key_id: &str,
    workspace_id: &str,
    metadata_version: i64,
    metadata: &WorkspaceDisplayMetadata,
) -> SyncResult<Vec<u8>> {
    encrypt_blob(
        &account_metadata_key(account_root_key, account_key_id),
        &WorkspaceMetadataAad::new(account_key_id, workspace_id, metadata_version),
        &serde_json::to_vec(metadata)?,
    )
}

pub fn decrypt_workspace_metadata(
    account_root_key: &SymmetricKey,
    account_key_id: &str,
    workspace_id: &str,
    metadata_version: i64,
    encrypted_metadata: &[u8],
) -> SyncResult<WorkspaceDisplayMetadata> {
    let plaintext = decrypt_blob(
        &account_metadata_key(account_root_key, account_key_id),
        &WorkspaceMetadataAad::new(account_key_id, workspace_id, metadata_version),
        encrypted_metadata,
    )?;
    serde_json::from_slice(&plaintext).map_err(Into::into)
}

pub fn encrypt_workspace_key_for_account(
    account_root_key: &SymmetricKey,
    account_key_id: &str,
    workspace_id: &str,
    workspace_key_version: i64,
    workspace_key: &SymmetricKey,
) -> SyncResult<Vec<u8>> {
    encrypt_blob(
        &account_workspace_wrap_key(account_root_key, account_key_id),
        &WorkspaceKeyForAccountAad::new(account_key_id, workspace_id, workspace_key_version),
        workspace_key,
    )
}

pub fn decrypt_workspace_key_for_account(
    account_root_key: &SymmetricKey,
    account_key_id: &str,
    workspace_id: &str,
    workspace_key_version: i64,
    encrypted_workspace_key: &[u8],
) -> SyncResult<SymmetricKey> {
    let plaintext = decrypt_blob(
        &account_workspace_wrap_key(account_root_key, account_key_id),
        &WorkspaceKeyForAccountAad::new(account_key_id, workspace_id, workspace_key_version),
        encrypted_workspace_key,
    )?;
    plaintext
        .try_into()
        .map_err(|_| SyncError::Crypto("invalid workspace key length".into()))
}

pub fn encrypt_device_metadata(
    account_root_key: &SymmetricKey,
    account_key_id: &str,
    workspace_id: &str,
    device_id: &str,
    metadata_version: i64,
    metadata: &DeviceDisplayMetadata,
) -> SyncResult<Vec<u8>> {
    encrypt_blob(
        &account_device_metadata_key(account_root_key, account_key_id),
        &DeviceMetadataAad::new(account_key_id, workspace_id, device_id, metadata_version),
        &serde_json::to_vec(metadata)?,
    )
}

pub fn decrypt_device_metadata(
    account_root_key: &SymmetricKey,
    account_key_id: &str,
    workspace_id: &str,
    device_id: &str,
    metadata_version: i64,
    encrypted_metadata: &[u8],
) -> SyncResult<DeviceDisplayMetadata> {
    let plaintext = decrypt_blob(
        &account_device_metadata_key(account_root_key, account_key_id),
        &DeviceMetadataAad::new(account_key_id, workspace_id, device_id, metadata_version),
        encrypted_metadata,
    )?;
    serde_json::from_slice(&plaintext).map_err(Into::into)
}

fn require_recovery_phrase(recovery_phrase: &str) -> SyncResult<String> {
    let normalized = normalize_recovery_phrase(recovery_phrase);
    if normalized.is_empty() {
        return Err(SyncError::InvalidArgument(
            "recovery phrase must not be empty".into(),
        ));
    }
    Ok(normalized)
}

fn decode_fixed<const N: usize>(value: &str, field: &str) -> SyncResult<[u8; N]> {
    let bytes = STANDARD
        .decode(value)
        .map_err(|error| SyncError::Serialization(format!("invalid {field}: {error}")))?;
    bytes
        .try_into()
        .map_err(|_| SyncError::Serialization(format!("invalid {field} length")))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_kdf_params() -> Argon2idKdfParams {
        Argon2idKdfParams {
            name: "argon2id".into(),
            salt: STANDARD.encode([8u8; 16]),
            mem_kib: 1024,
            iterations: 1,
            parallelism: 1,
        }
    }

    #[test]
    fn generated_recovery_phrase_has_twenty_four_words() {
        let phrase = generate_recovery_phrase().unwrap();
        let words = phrase.split_whitespace().collect::<Vec<_>>();

        assert_eq!(words.len(), 24);
        assert_eq!(normalize_recovery_phrase(&phrase), phrase);
    }

    #[test]
    fn recovery_phrase_normalization_collapses_case_and_whitespace() {
        let normalized = normalize_recovery_phrase("  ALPHA\nbeta\tGamma  ");

        assert_eq!(normalized, "alpha beta gamma");
    }

    #[test]
    fn account_subkeys_are_stable_and_domain_separated() {
        let account_root_key = [3u8; KEY_LEN];

        let metadata_a = account_metadata_key(&account_root_key, "account-key-1");
        let metadata_b = account_metadata_key(&account_root_key, "account-key-1");
        let wrap = account_workspace_wrap_key(&account_root_key, "account-key-1");
        let other_account = account_metadata_key(&account_root_key, "account-key-2");

        assert_eq!(metadata_a, metadata_b);
        assert_ne!(metadata_a, wrap);
        assert_ne!(metadata_a, other_account);
    }

    #[test]
    fn account_recovery_envelope_roundtrips_and_normalizes_phrase() {
        let account_root_key = [5u8; KEY_LEN];
        let envelope = wrap_account_root_key_with_params(
            "account-key-1",
            "recovery:v1",
            1,
            &account_root_key,
            "alpha beta gamma",
            test_kdf_params(),
        )
        .unwrap();

        let unwrapped =
            unwrap_account_root_key_with_recovery_phrase(&envelope, "  ALPHA\nbeta\tGamma  ")
                .unwrap();
        let wrong = unwrap_account_root_key_with_recovery_phrase(&envelope, "alpha beta wrong");

        assert_eq!(unwrapped, account_root_key);
        assert!(wrong.is_err());
    }

    #[test]
    fn workspace_metadata_roundtrips_without_plaintext_marker() {
        let account_root_key = [6u8; KEY_LEN];
        let metadata = WorkspaceDisplayMetadata::new("workspace display name marker");

        let encrypted = encrypt_workspace_metadata(
            &account_root_key,
            "account-key-1",
            "workspace-1",
            1,
            &metadata,
        )
        .unwrap();
        let decrypted = decrypt_workspace_metadata(
            &account_root_key,
            "account-key-1",
            "workspace-1",
            1,
            &encrypted,
        )
        .unwrap();

        assert_eq!(decrypted, metadata);
        assert!(!String::from_utf8_lossy(&encrypted).contains("workspace display name marker"));
    }

    #[test]
    fn workspace_metadata_rejects_wrong_aad() {
        let account_root_key = [6u8; KEY_LEN];
        let metadata = WorkspaceDisplayMetadata::new("notes");
        let encrypted = encrypt_workspace_metadata(
            &account_root_key,
            "account-key-1",
            "workspace-1",
            1,
            &metadata,
        )
        .unwrap();

        let wrong_workspace = decrypt_workspace_metadata(
            &account_root_key,
            "account-key-1",
            "workspace-2",
            1,
            &encrypted,
        );
        let wrong_version = decrypt_workspace_metadata(
            &account_root_key,
            "account-key-1",
            "workspace-1",
            2,
            &encrypted,
        );

        assert!(wrong_workspace.is_err());
        assert!(wrong_version.is_err());
    }

    #[test]
    fn workspace_key_for_account_roundtrips() {
        let account_root_key = [7u8; KEY_LEN];
        let workspace_key = [9u8; KEY_LEN];

        let encrypted = encrypt_workspace_key_for_account(
            &account_root_key,
            "account-key-1",
            "workspace-1",
            1,
            &workspace_key,
        )
        .unwrap();
        let decrypted = decrypt_workspace_key_for_account(
            &account_root_key,
            "account-key-1",
            "workspace-1",
            1,
            &encrypted,
        )
        .unwrap();
        let wrong_account = decrypt_workspace_key_for_account(
            &account_root_key,
            "account-key-2",
            "workspace-1",
            1,
            &encrypted,
        );

        assert_eq!(decrypted, workspace_key);
        assert!(wrong_account.is_err());
    }

    #[test]
    fn device_metadata_roundtrips() {
        let account_root_key = [8u8; KEY_LEN];
        let metadata = DeviceDisplayMetadata::new("Mansuiki's Mac");

        let encrypted = encrypt_device_metadata(
            &account_root_key,
            "account-key-1",
            "workspace-1",
            "device-1",
            1,
            &metadata,
        )
        .unwrap();
        let decrypted = decrypt_device_metadata(
            &account_root_key,
            "account-key-1",
            "workspace-1",
            "device-1",
            1,
            &encrypted,
        )
        .unwrap();

        assert_eq!(decrypted, metadata);
    }
}
