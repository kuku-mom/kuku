#![allow(dead_code)]

use chacha20poly1305::aead::{Aead, Payload};
use chacha20poly1305::{Key, KeyInit, XChaCha20Poly1305, XNonce};
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use rand_core::{OsRng, RngCore};
use serde::Serialize;
use sha2::{Digest, Sha256};

use super::errors::{SyncError, SyncResult};

const BLOB_MAGIC: &[u8] = b"KUKUSYNCBLOB\0";
const BLOB_VERSION: u8 = 1;
const ALG_XCHACHA20_POLY1305: u8 = 1;
const XCHACHA20_NONCE_LEN: usize = 24;
const SHA256_LEN: usize = 32;
const BLOB_HEADER_FIXED_LEN: usize = BLOB_MAGIC.len() + 3;

pub type SymmetricKey = [u8; 32];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EncryptedBlobMetadata {
    pub ciphertext_sha256: String,
    pub size_bytes: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedEncryptedBlob {
    pub nonce: [u8; XCHACHA20_NONCE_LEN],
    pub aad_hash: [u8; SHA256_LEN],
    pub ciphertext_and_tag: Vec<u8>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct PackAad {
    pub format: String,
    pub version: u8,
    pub workspace_id: String,
    pub object_id: String,
    pub object_kind: String,
    pub commit_id: String,
}

impl PackAad {
    pub fn new(workspace_id: &str, object_id: &str, object_kind: &str, commit_id: &str) -> Self {
        Self {
            format: "kuku.sync.pack".into(),
            version: 1,
            workspace_id: workspace_id.into(),
            object_id: object_id.into(),
            object_kind: object_kind.into(),
            commit_id: commit_id.into(),
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct CommitBodyAad {
    pub format: String,
    pub version: u8,
    pub workspace_id: String,
    pub commit_id: String,
    pub commit_kind: String,
    pub parents: Vec<String>,
    pub author_device_id: String,
    pub device_seq: i64,
    pub body_object_id: String,
}

impl CommitBodyAad {
    pub fn new(
        workspace_id: &str,
        commit_id: &str,
        commit_kind: &str,
        parents: Vec<String>,
        author_device_id: &str,
        device_seq: i64,
        body_object_id: &str,
    ) -> Self {
        Self {
            format: "kuku.sync.commit-body".into(),
            version: 1,
            workspace_id: workspace_id.into(),
            commit_id: commit_id.into(),
            commit_kind: commit_kind.into(),
            parents,
            author_device_id: author_device_id.into(),
            device_seq,
            body_object_id: body_object_id.into(),
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct KeyEnvelopeAad {
    pub format: String,
    pub version: u8,
    pub workspace_id: String,
    pub envelope_id: String,
    pub recipient_type: String,
}

impl KeyEnvelopeAad {
    pub fn passphrase(workspace_id: &str, envelope_id: &str) -> Self {
        Self {
            format: "kuku.sync.key-envelope".into(),
            version: 1,
            workspace_id: workspace_id.into(),
            envelope_id: envelope_id.into(),
            recipient_type: "passphrase".into(),
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct CommitSignaturePayload {
    pub workspace_id: String,
    pub commit_id: String,
    pub commit_kind: String,
    pub expected_head_commit_id: String,
    pub parent_commit_ids: Vec<String>,
    pub author_device_id: String,
    pub device_seq: i64,
    pub body_object_id: String,
    pub body_ciphertext_sha256: String,
    pub body_size_bytes: i64,
    pub referenced_object_ids: Vec<String>,
}

impl CommitSignaturePayload {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        workspace_id: &str,
        commit_id: &str,
        commit_kind: &str,
        expected_head_commit_id: &str,
        parent_commit_ids: Vec<String>,
        author_device_id: &str,
        device_seq: i64,
        body_object_id: &str,
        body_ciphertext_sha256: &str,
        body_size_bytes: i64,
        mut referenced_object_ids: Vec<String>,
    ) -> Self {
        referenced_object_ids.sort();
        Self {
            workspace_id: workspace_id.into(),
            commit_id: commit_id.into(),
            commit_kind: commit_kind.into(),
            expected_head_commit_id: expected_head_commit_id.into(),
            parent_commit_ids,
            author_device_id: author_device_id.into(),
            device_seq,
            body_object_id: body_object_id.into(),
            body_ciphertext_sha256: body_ciphertext_sha256.into(),
            body_size_bytes,
            referenced_object_ids,
        }
    }
}

pub fn canonical_json<T: Serialize>(value: &T) -> SyncResult<Vec<u8>> {
    serde_json::to_vec(value).map_err(Into::into)
}

pub fn encrypt_blob<T: Serialize>(
    key: &SymmetricKey,
    aad: &T,
    plaintext: &[u8],
) -> SyncResult<Vec<u8>> {
    let mut nonce = [0u8; XCHACHA20_NONCE_LEN];
    OsRng.fill_bytes(&mut nonce);
    encrypt_blob_with_nonce(key, aad, plaintext, nonce)
}

pub fn encrypt_blob_with_nonce<T: Serialize>(
    key: &SymmetricKey,
    aad: &T,
    plaintext: &[u8],
    nonce: [u8; XCHACHA20_NONCE_LEN],
) -> SyncResult<Vec<u8>> {
    let aad = canonical_json(aad)?;
    let ciphertext = cipher(key)
        .encrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: plaintext,
                aad: &aad,
            },
        )
        .map_err(|_| SyncError::Crypto("encrypt failed".into()))?;

    let mut out =
        Vec::with_capacity(BLOB_HEADER_FIXED_LEN + nonce.len() + SHA256_LEN + ciphertext.len());
    out.extend_from_slice(BLOB_MAGIC);
    out.push(BLOB_VERSION);
    out.push(ALG_XCHACHA20_POLY1305);
    out.push(XCHACHA20_NONCE_LEN as u8);
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&sha256(&aad));
    out.extend_from_slice(&ciphertext);
    Ok(out)
}

pub fn decrypt_blob<T: Serialize>(key: &SymmetricKey, aad: &T, blob: &[u8]) -> SyncResult<Vec<u8>> {
    let aad = canonical_json(aad)?;
    let parsed = parse_blob(blob)?;
    let expected_aad_hash = sha256(&aad);
    if parsed.aad_hash != expected_aad_hash {
        return Err(SyncError::Crypto("aad hash mismatch".into()));
    }
    cipher(key)
        .decrypt(
            XNonce::from_slice(&parsed.nonce),
            Payload {
                msg: &parsed.ciphertext_and_tag,
                aad: &aad,
            },
        )
        .map_err(|_| SyncError::Crypto("decrypt failed".into()))
}

pub fn parse_blob(blob: &[u8]) -> SyncResult<ParsedEncryptedBlob> {
    if blob.len() < BLOB_HEADER_FIXED_LEN + XCHACHA20_NONCE_LEN + SHA256_LEN {
        return Err(SyncError::Crypto("encrypted blob is too short".into()));
    }
    if &blob[..BLOB_MAGIC.len()] != BLOB_MAGIC {
        return Err(SyncError::Crypto("invalid encrypted blob magic".into()));
    }
    let version = blob[BLOB_MAGIC.len()];
    if version != BLOB_VERSION {
        return Err(SyncError::UnsupportedVersion(version));
    }
    let alg_id = blob[BLOB_MAGIC.len() + 1];
    if alg_id != ALG_XCHACHA20_POLY1305 {
        return Err(SyncError::Crypto(
            "unsupported encrypted blob algorithm".into(),
        ));
    }
    let nonce_len = blob[BLOB_MAGIC.len() + 2] as usize;
    if nonce_len != XCHACHA20_NONCE_LEN {
        return Err(SyncError::Crypto(
            "invalid encrypted blob nonce length".into(),
        ));
    }
    let nonce_start = BLOB_HEADER_FIXED_LEN;
    let aad_hash_start = nonce_start + nonce_len;
    let ciphertext_start = aad_hash_start + SHA256_LEN;
    if blob.len() < ciphertext_start {
        return Err(SyncError::Crypto("encrypted blob is truncated".into()));
    }
    let mut nonce = [0u8; XCHACHA20_NONCE_LEN];
    nonce.copy_from_slice(&blob[nonce_start..aad_hash_start]);
    let mut aad_hash = [0u8; SHA256_LEN];
    aad_hash.copy_from_slice(&blob[aad_hash_start..ciphertext_start]);
    Ok(ParsedEncryptedBlob {
        nonce,
        aad_hash,
        ciphertext_and_tag: blob[ciphertext_start..].to_vec(),
    })
}

pub fn encrypted_blob_metadata(blob: &[u8]) -> EncryptedBlobMetadata {
    EncryptedBlobMetadata {
        ciphertext_sha256: hex::encode(sha256(blob)),
        size_bytes: blob.len().min(i64::MAX as usize) as i64,
    }
}

pub fn encrypt_commit_body(
    commit_key: &SymmetricKey,
    aad: &CommitBodyAad,
    plaintext_body: &[u8],
) -> SyncResult<Vec<u8>> {
    encrypt_blob(commit_key, aad, plaintext_body)
}

pub fn decrypt_commit_body(
    commit_key: &SymmetricKey,
    aad: &CommitBodyAad,
    encrypted_body: &[u8],
) -> SyncResult<Vec<u8>> {
    decrypt_blob(commit_key, aad, encrypted_body)
}

pub fn sign_commit_payload(
    signing_key: &SigningKey,
    payload: &CommitSignaturePayload,
) -> SyncResult<Vec<u8>> {
    let canonical = canonical_json(payload)?;
    Ok(signing_key.sign(&canonical).to_bytes().to_vec())
}

pub fn verify_commit_signature(
    verifying_key: &VerifyingKey,
    payload: &CommitSignaturePayload,
    signature: &[u8],
) -> SyncResult<()> {
    let canonical = canonical_json(payload)?;
    let signature = Signature::try_from(signature)
        .map_err(|_| SyncError::Crypto("invalid ed25519 signature length".into()))?;
    verifying_key
        .verify(&canonical, &signature)
        .map_err(|_| SyncError::Crypto("invalid ed25519 signature".into()))
}

fn cipher(key: &SymmetricKey) -> XChaCha20Poly1305 {
    XChaCha20Poly1305::new(Key::from_slice(key))
}

fn sha256(value: &[u8]) -> [u8; SHA256_LEN] {
    Sha256::digest(value).into()
}

#[cfg(test)]
mod tests {
    use ed25519_dalek::SigningKey;

    use super::*;

    fn key() -> SymmetricKey {
        [7u8; 32]
    }

    fn pack_aad() -> PackAad {
        PackAad::new("workspace-1", "object-1", "content_pack", "commit-1")
    }

    #[test]
    fn encrypted_blob_roundtrips_and_records_metadata() {
        let blob = encrypt_blob_with_nonce(&key(), &pack_aad(), b"secret", [1u8; 24]).unwrap();

        let decrypted = decrypt_blob(&key(), &pack_aad(), &blob).unwrap();
        let metadata = encrypted_blob_metadata(&blob);

        assert_eq!(decrypted, b"secret");
        assert_eq!(metadata.size_bytes, blob.len() as i64);
        assert_eq!(metadata.ciphertext_sha256.len(), 64);
    }

    #[test]
    fn encrypted_blob_rejects_unsupported_version() {
        let mut blob = encrypt_blob_with_nonce(&key(), &pack_aad(), b"secret", [1u8; 24]).unwrap();
        blob[BLOB_MAGIC.len()] = 2;

        let err = decrypt_blob(&key(), &pack_aad(), &blob).unwrap_err();

        assert!(matches!(err, SyncError::UnsupportedVersion(2)));
    }

    #[test]
    fn encrypted_blob_rejects_wrong_aad_hash() {
        let mut blob = encrypt_blob_with_nonce(&key(), &pack_aad(), b"secret", [1u8; 24]).unwrap();
        let aad_hash_start = BLOB_HEADER_FIXED_LEN + XCHACHA20_NONCE_LEN;
        blob[aad_hash_start] ^= 0xff;

        let err = decrypt_blob(&key(), &pack_aad(), &blob).unwrap_err();

        assert!(matches!(err, SyncError::Crypto(message) if message == "aad hash mismatch"));
    }

    #[test]
    fn commit_body_wrong_parent_list_fails() {
        let aad = CommitBodyAad::new(
            "workspace-1",
            "commit-1",
            "incremental",
            vec!["parent-1".into()],
            "device-1",
            1,
            "body-1",
        );
        let wrong_aad = CommitBodyAad::new(
            "workspace-1",
            "commit-1",
            "incremental",
            vec!["parent-2".into()],
            "device-1",
            1,
            "body-1",
        );
        let blob = encrypt_commit_body(&key(), &aad, br#"{"changes":[]}"#).unwrap();

        let decrypted = decrypt_commit_body(&key(), &aad, &blob).unwrap();
        let err = decrypt_commit_body(&key(), &wrong_aad, &blob).unwrap_err();

        assert_eq!(decrypted, br#"{"changes":[]}"#);
        assert!(matches!(err, SyncError::Crypto(message) if message == "aad hash mismatch"));
    }

    #[test]
    fn commit_signature_payload_uses_server_field_order_and_sorts_refs() {
        let payload = CommitSignaturePayload::new(
            "workspace-1",
            "commit-1",
            "incremental",
            "head-1",
            vec!["head-1".into()],
            "device-1",
            42,
            "body-1",
            "a".repeat(64).as_str(),
            1234,
            vec!["z".into(), "a".into()],
        );

        let canonical = String::from_utf8(canonical_json(&payload).unwrap()).unwrap();

        assert_eq!(
            canonical,
            r#"{"workspace_id":"workspace-1","commit_id":"commit-1","commit_kind":"incremental","expected_head_commit_id":"head-1","parent_commit_ids":["head-1"],"author_device_id":"device-1","device_seq":42,"body_object_id":"body-1","body_ciphertext_sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","body_size_bytes":1234,"referenced_object_ids":["a","z"]}"#
        );
    }

    #[test]
    fn commit_signature_verifies_and_tamper_fails() {
        let signing_key = SigningKey::from_bytes(&[3u8; 32]);
        let verifying_key = signing_key.verifying_key();
        let payload = CommitSignaturePayload::new(
            "workspace-1",
            "commit-1",
            "checkpoint",
            "",
            vec![],
            "device-1",
            1,
            "body-1",
            "b".repeat(64).as_str(),
            99,
            vec!["pack-1".into()],
        );
        let mut tampered = payload.clone();
        tampered.device_seq = 2;

        let signature = sign_commit_payload(&signing_key, &payload).unwrap();

        verify_commit_signature(&verifying_key, &payload, &signature).unwrap();
        assert!(verify_commit_signature(&verifying_key, &tampered, &signature).is_err());
    }
}
