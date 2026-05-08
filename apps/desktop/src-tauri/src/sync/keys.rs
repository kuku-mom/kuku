#![allow(dead_code)]

use argon2::{Algorithm, Argon2, Params, Version};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use chacha20poly1305::aead::{Aead, Payload};
use chacha20poly1305::{Key, KeyInit, XChaCha20Poly1305, XNonce};
use ed25519_dalek::SigningKey;
use rand_core::{OsRng, RngCore};
use serde::{Deserialize, Serialize};

use crate::{secure_storage, variant};

use super::crypto::{KeyEnvelopeAad, SymmetricKey, canonical_json};
use super::errors::{SyncError, SyncResult};

const WORKSPACE_KEY_LEN: usize = 32;
const ARGON2_SALT_LEN: usize = 16;
const XCHACHA20_NONCE_LEN: usize = 24;

pub const PACK_KEY_PURPOSE: &str = "kuku-sync-pack-v1";
pub const COMMIT_BODY_KEY_PURPOSE: &str = "kuku-sync-commit-body-v1";
pub const CHECKPOINT_KEY_PURPOSE: &str = "kuku-sync-checkpoint-v1";
pub const PATH_KEY_PURPOSE: &str = "kuku-sync-path-v1";
pub const WRAP_KEY_PURPOSE: &str = "kuku-sync-wrap-v1";

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct PassphraseKeyEnvelope {
    pub workspace_id: String,
    pub envelope_id: String,
    pub recipient_type: String,
    pub key_version: i64,
    pub kdf: Argon2idKdfParams,
    pub wrap: WrappedWorkspaceKey,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct Argon2idKdfParams {
    pub name: String,
    pub salt: String,
    pub mem_kib: u32,
    pub iterations: u32,
    pub parallelism: u32,
}

impl Default for Argon2idKdfParams {
    fn default() -> Self {
        let mut salt = [0u8; ARGON2_SALT_LEN];
        OsRng.fill_bytes(&mut salt);
        Self {
            name: "argon2id".into(),
            salt: STANDARD.encode(salt),
            mem_kib: 65_536,
            iterations: 3,
            parallelism: 1,
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct WrappedWorkspaceKey {
    pub alg: String,
    pub nonce: String,
    pub ciphertext: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkspaceKeySource {
    Remembered,
    Passphrase,
}

pub fn random_workspace_key() -> SymmetricKey {
    let mut key = [0u8; WORKSPACE_KEY_LEN];
    OsRng.fill_bytes(&mut key);
    key
}

pub fn derive_subkey(
    workspace_key: &SymmetricKey,
    purpose: &str,
    workspace_id: &str,
) -> SymmetricKey {
    let mut input = Vec::with_capacity(purpose.len() + 1 + workspace_id.len());
    input.extend_from_slice(purpose.as_bytes());
    input.push(0);
    input.extend_from_slice(workspace_id.as_bytes());
    *blake3::keyed_hash(workspace_key, &input).as_bytes()
}

pub fn pack_key(workspace_key: &SymmetricKey, workspace_id: &str) -> SymmetricKey {
    derive_subkey(workspace_key, PACK_KEY_PURPOSE, workspace_id)
}

pub fn commit_body_key(workspace_key: &SymmetricKey, workspace_id: &str) -> SymmetricKey {
    derive_subkey(workspace_key, COMMIT_BODY_KEY_PURPOSE, workspace_id)
}

pub fn checkpoint_key(workspace_key: &SymmetricKey, workspace_id: &str) -> SymmetricKey {
    derive_subkey(workspace_key, CHECKPOINT_KEY_PURPOSE, workspace_id)
}

pub fn wrap_key(workspace_key: &SymmetricKey, workspace_id: &str) -> SymmetricKey {
    derive_subkey(workspace_key, WRAP_KEY_PURPOSE, workspace_id)
}

pub fn wrap_workspace_key_with_passphrase(
    workspace_id: &str,
    envelope_id: &str,
    key_version: i64,
    workspace_key: &SymmetricKey,
    passphrase: &str,
) -> SyncResult<PassphraseKeyEnvelope> {
    let kdf = Argon2idKdfParams::default();
    wrap_workspace_key_with_params(
        workspace_id,
        envelope_id,
        key_version,
        workspace_key,
        passphrase,
        kdf,
    )
}

pub fn wrap_workspace_key_with_params(
    workspace_id: &str,
    envelope_id: &str,
    key_version: i64,
    workspace_key: &SymmetricKey,
    passphrase: &str,
    kdf: Argon2idKdfParams,
) -> SyncResult<PassphraseKeyEnvelope> {
    let kek = passphrase_kek(passphrase, &kdf)?;
    let aad = canonical_json(&KeyEnvelopeAad::passphrase(workspace_id, envelope_id))?;
    let mut nonce = [0u8; XCHACHA20_NONCE_LEN];
    OsRng.fill_bytes(&mut nonce);
    let ciphertext = XChaCha20Poly1305::new(Key::from_slice(&kek))
        .encrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: workspace_key,
                aad: &aad,
            },
        )
        .map_err(|_| SyncError::Crypto("workspace key wrap failed".into()))?;

    Ok(PassphraseKeyEnvelope {
        workspace_id: workspace_id.into(),
        envelope_id: envelope_id.into(),
        recipient_type: "passphrase".into(),
        key_version,
        kdf,
        wrap: WrappedWorkspaceKey {
            alg: "XChaCha20-Poly1305".into(),
            nonce: STANDARD.encode(nonce),
            ciphertext: STANDARD.encode(ciphertext),
        },
    })
}

pub fn unwrap_workspace_key_with_passphrase(
    envelope: &PassphraseKeyEnvelope,
    passphrase: &str,
) -> SyncResult<SymmetricKey> {
    if envelope.recipient_type != "passphrase" {
        return Err(SyncError::InvalidArgument(
            "key envelope recipient_type must be passphrase".into(),
        ));
    }
    if envelope.wrap.alg != "XChaCha20-Poly1305" {
        return Err(SyncError::Crypto(
            "unsupported workspace key wrap alg".into(),
        ));
    }
    let kek = passphrase_kek(passphrase, &envelope.kdf)?;
    let nonce = decode_fixed::<XCHACHA20_NONCE_LEN>(&envelope.wrap.nonce, "wrap nonce")?;
    let ciphertext = STANDARD
        .decode(&envelope.wrap.ciphertext)
        .map_err(|error| SyncError::Serialization(format!("invalid wrap ciphertext: {error}")))?;
    let aad = canonical_json(&KeyEnvelopeAad::passphrase(
        &envelope.workspace_id,
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
        .map_err(|_| SyncError::Crypto("workspace key unwrap failed".into()))?;
    plaintext
        .try_into()
        .map_err(|_| SyncError::Crypto("invalid workspace key length".into()))
}

pub fn sync_keychain_service() -> String {
    variant::keychain_service("sync-keys")
}

pub fn workspace_key_account(vault_id: &str) -> String {
    format!("vault:{vault_id}:workspace-key:v1")
}

pub fn passphrase_account(vault_id: &str) -> String {
    format!("vault:{vault_id}:passphrase:v1")
}

pub fn device_signing_key_account(vault_id: &str) -> String {
    format!("vault:{vault_id}:device-signing-key:v1")
}

pub fn device_encryption_key_account(vault_id: &str) -> String {
    format!("vault:{vault_id}:device-encryption-key:v1")
}

pub fn account_root_key_account(account_key_id: &str) -> String {
    format!("sync-account:{account_key_id}:root-key:v1")
}

pub fn account_recovery_phrase_account(account_key_id: &str) -> String {
    format!("sync-account:{account_key_id}:recovery-phrase:v1")
}

pub fn remember_account_root_key(
    account_key_id: &str,
    account_root_key: &SymmetricKey,
) -> SyncResult<()> {
    secure_storage::write_bytes(
        &sync_keychain_service(),
        &account_root_key_account(account_key_id),
        account_root_key,
    )
    .map_err(secure_storage_error)
}

pub fn read_account_root_key(account_key_id: &str) -> SyncResult<Option<SymmetricKey>> {
    let Some(bytes) = secure_storage::read_bytes(
        &sync_keychain_service(),
        &account_root_key_account(account_key_id),
    )
    .map_err(secure_storage_error)?
    else {
        return Ok(None);
    };
    let key = bytes
        .try_into()
        .map_err(|_| SyncError::Crypto("remembered account root key has invalid length".into()))?;
    Ok(Some(key))
}

pub fn remember_account_recovery_phrase(
    account_key_id: &str,
    recovery_phrase: &str,
) -> SyncResult<()> {
    secure_storage::write_bytes(
        &sync_keychain_service(),
        &account_recovery_phrase_account(account_key_id),
        recovery_phrase.as_bytes(),
    )
    .map_err(secure_storage_error)
}

pub fn read_account_recovery_phrase(account_key_id: &str) -> SyncResult<Option<String>> {
    let Some(bytes) = secure_storage::read_bytes(
        &sync_keychain_service(),
        &account_recovery_phrase_account(account_key_id),
    )
    .map_err(secure_storage_error)?
    else {
        return Ok(None);
    };
    String::from_utf8(bytes)
        .map(Some)
        .map_err(|_| SyncError::Crypto("remembered recovery phrase is not valid UTF-8".into()))
}

pub fn remember_workspace_key(vault_id: &str, workspace_key: &SymmetricKey) -> SyncResult<()> {
    secure_storage::write_bytes(
        &sync_keychain_service(),
        &workspace_key_account(vault_id),
        workspace_key,
    )
    .map_err(secure_storage_error)
}

pub fn read_remembered_workspace_key(vault_id: &str) -> SyncResult<Option<SymmetricKey>> {
    let Some(bytes) =
        secure_storage::read_bytes(&sync_keychain_service(), &workspace_key_account(vault_id))
            .map_err(secure_storage_error)?
    else {
        return Ok(None);
    };
    let key = bytes
        .try_into()
        .map_err(|_| SyncError::Crypto("remembered workspace key has invalid length".into()))?;
    Ok(Some(key))
}

pub fn forget_workspace_key(vault_id: &str) -> SyncResult<()> {
    match secure_storage::delete(&sync_keychain_service(), &workspace_key_account(vault_id)) {
        Ok(()) | Err(secure_storage::SecureStorageError::NotFound) => Ok(()),
        Err(error) => Err(secure_storage_error(error)),
    }
}

pub fn remember_passphrase(vault_id: &str, passphrase: &str) -> SyncResult<()> {
    secure_storage::write_bytes(
        &sync_keychain_service(),
        &passphrase_account(vault_id),
        passphrase.as_bytes(),
    )
    .map_err(secure_storage_error)
}

pub fn read_remembered_passphrase(vault_id: &str) -> SyncResult<Option<String>> {
    let Some(bytes) =
        secure_storage::read_bytes(&sync_keychain_service(), &passphrase_account(vault_id))
            .map_err(secure_storage_error)?
    else {
        return Ok(None);
    };
    String::from_utf8(bytes)
        .map(Some)
        .map_err(|_| SyncError::Crypto("remembered passphrase is not valid UTF-8".into()))
}

pub fn forget_passphrase(vault_id: &str) -> SyncResult<()> {
    match secure_storage::delete(&sync_keychain_service(), &passphrase_account(vault_id)) {
        Ok(()) | Err(secure_storage::SecureStorageError::NotFound) => Ok(()),
        Err(error) => Err(secure_storage_error(error)),
    }
}

pub fn random_device_signing_key() -> SigningKey {
    let mut key = [0u8; 32];
    OsRng.fill_bytes(&mut key);
    SigningKey::from_bytes(&key)
}

pub fn remember_device_signing_key(vault_id: &str, signing_key: &SigningKey) -> SyncResult<()> {
    secure_storage::write_bytes(
        &sync_keychain_service(),
        &device_signing_key_account(vault_id),
        &signing_key.to_bytes(),
    )
    .map_err(secure_storage_error)
}

pub fn read_device_signing_key(vault_id: &str) -> SyncResult<Option<SigningKey>> {
    let Some(bytes) = secure_storage::read_bytes(
        &sync_keychain_service(),
        &device_signing_key_account(vault_id),
    )
    .map_err(secure_storage_error)?
    else {
        return Ok(None);
    };
    let key = bytes.try_into().map_err(|_| {
        SyncError::Crypto("remembered device signing key has invalid length".into())
    })?;
    Ok(Some(SigningKey::from_bytes(&key)))
}

pub fn unlock_workspace_key(
    remembered_key: Option<SymmetricKey>,
    passphrase_envelope: &PassphraseKeyEnvelope,
    passphrase: &str,
) -> SyncResult<(SymmetricKey, WorkspaceKeySource)> {
    if let Some(workspace_key) = remembered_key {
        return Ok((workspace_key, WorkspaceKeySource::Remembered));
    }

    let workspace_key = unwrap_workspace_key_with_passphrase(passphrase_envelope, passphrase)?;
    Ok((workspace_key, WorkspaceKeySource::Passphrase))
}

pub fn unlock_workspace_key_for_vault(
    vault_id: &str,
    passphrase_envelope: &PassphraseKeyEnvelope,
    passphrase: &str,
) -> SyncResult<(SymmetricKey, WorkspaceKeySource)> {
    let remembered_key = read_remembered_workspace_key(vault_id)?;
    unlock_workspace_key(remembered_key, passphrase_envelope, passphrase)
}

pub(crate) fn passphrase_kek(
    passphrase: &str,
    params: &Argon2idKdfParams,
) -> SyncResult<SymmetricKey> {
    if params.name != "argon2id" {
        return Err(SyncError::Crypto("unsupported passphrase kdf".into()));
    }
    let salt = STANDARD
        .decode(&params.salt)
        .map_err(|error| SyncError::Serialization(format!("invalid argon2id salt: {error}")))?;
    let params = Params::new(
        params.mem_kib,
        params.iterations,
        params.parallelism,
        Some(WORKSPACE_KEY_LEN),
    )
    .map_err(|error| SyncError::Crypto(format!("invalid argon2id params: {error}")))?;
    let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut out = [0u8; WORKSPACE_KEY_LEN];
    argon2
        .hash_password_into(passphrase.as_bytes(), &salt, &mut out)
        .map_err(|error| SyncError::Crypto(format!("argon2id failed: {error}")))?;
    Ok(out)
}

fn decode_fixed<const N: usize>(value: &str, field: &str) -> SyncResult<[u8; N]> {
    let bytes = STANDARD
        .decode(value)
        .map_err(|error| SyncError::Serialization(format!("invalid {field}: {error}")))?;
    bytes
        .try_into()
        .map_err(|_| SyncError::Serialization(format!("invalid {field} length")))
}

fn secure_storage_error(error: secure_storage::SecureStorageError) -> SyncError {
    match error {
        secure_storage::SecureStorageError::State(message) => SyncError::Storage(message),
        secure_storage::SecureStorageError::Store(message) => SyncError::Storage(message),
        secure_storage::SecureStorageError::NotFound => SyncError::Storage("key not found".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_kdf_params() -> Argon2idKdfParams {
        Argon2idKdfParams {
            name: "argon2id".into(),
            salt: STANDARD.encode([9u8; ARGON2_SALT_LEN]),
            mem_kib: 1024,
            iterations: 1,
            parallelism: 1,
        }
    }

    #[test]
    fn keyed_blake3_subkeys_are_stable_and_domain_separated() {
        let workspace_key = [1u8; WORKSPACE_KEY_LEN];

        let pack_a = derive_subkey(&workspace_key, PACK_KEY_PURPOSE, "workspace-1");
        let pack_b = derive_subkey(&workspace_key, PACK_KEY_PURPOSE, "workspace-1");
        let commit = derive_subkey(&workspace_key, COMMIT_BODY_KEY_PURPOSE, "workspace-1");

        assert_eq!(pack_a, pack_b);
        assert_ne!(pack_a, commit);
    }

    #[test]
    fn keychain_account_names_match_phase3_policy() {
        assert_eq!(
            workspace_key_account("vault-1"),
            "vault:vault-1:workspace-key:v1"
        );
        assert_eq!(passphrase_account("vault-1"), "vault:vault-1:passphrase:v1");
        assert_eq!(
            account_root_key_account("account-1"),
            "sync-account:account-1:root-key:v1"
        );
        assert_eq!(
            account_recovery_phrase_account("account-1"),
            "sync-account:account-1:recovery-phrase:v1"
        );
        assert_eq!(
            device_signing_key_account("vault-1"),
            "vault:vault-1:device-signing-key:v1"
        );
        assert_eq!(
            device_encryption_key_account("vault-1"),
            "vault:vault-1:device-encryption-key:v1"
        );
    }

    #[test]
    fn passphrase_envelope_roundtrips_and_wrong_passphrase_fails() {
        let workspace_key = [4u8; WORKSPACE_KEY_LEN];
        let envelope = wrap_workspace_key_with_params(
            "workspace-1",
            "passphrase:v1",
            1,
            &workspace_key,
            "correct horse battery staple",
            test_kdf_params(),
        )
        .unwrap();

        let unwrapped =
            unwrap_workspace_key_with_passphrase(&envelope, "correct horse battery staple")
                .unwrap();
        let wrong = unwrap_workspace_key_with_passphrase(&envelope, "wrong passphrase");

        assert_eq!(unwrapped, workspace_key);
        assert!(wrong.is_err());
    }

    #[test]
    fn missing_remembered_key_uses_passphrase_unlock_path() {
        let workspace_key = [7u8; WORKSPACE_KEY_LEN];
        let envelope = wrap_workspace_key_with_params(
            "workspace-1",
            "passphrase:v1",
            1,
            &workspace_key,
            "correct horse battery staple",
            test_kdf_params(),
        )
        .unwrap();

        let (unlocked, source) =
            unlock_workspace_key(None, &envelope, "correct horse battery staple").unwrap();
        let (remembered, remembered_source) =
            unlock_workspace_key(Some(workspace_key), &envelope, "wrong passphrase").unwrap();

        assert_eq!(unlocked, workspace_key);
        assert_eq!(source, WorkspaceKeySource::Passphrase);
        assert_eq!(remembered, workspace_key);
        assert_eq!(remembered_source, WorkspaceKeySource::Remembered);
    }
}
