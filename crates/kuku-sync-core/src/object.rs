use std::collections::{BTreeMap, BTreeSet};

use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{ChaCha20Poly1305, Key, Nonce};
use rand_core::{OsRng, RngCore};
use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::store::{LocalStore, MemoryLocalStore, StoreError, StoredVaultLoad};
use crate::vault::VaultCore;

const OBJECT_FORMAT_VERSION: &str = "kuku-sync-object-v1";

#[derive(Debug, Error)]
pub enum ObjectStoreError {
    #[error("object store serialization failed: {0}")]
    Serde(#[from] serde_json::Error),
    #[error("object crypto operation failed")]
    CryptoFailed,
    #[error("object is missing: {0}")]
    MissingObject(String),
    #[error("object id collision with different bytes: {0}")]
    ObjectIdCollision(String),
    #[error("missing objects block pointer publish: {0:?}")]
    MissingObjects(Vec<String>),
    #[error("pointer compare-and-set failed: current={current:?}")]
    PointerConflict { current: Option<String> },
    #[error("unsupported object format version: {0}")]
    UnsupportedVersion(String),
    #[error("local store operation failed: {0}")]
    Store(#[from] StoreError),
}

pub type ObjectStoreResult<T> = std::result::Result<T, ObjectStoreError>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum EncryptedObjectKind {
    Manifest,
    TextDoc,
    Blob,
    Journal,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EncryptedObjectEnvelope {
    pub object_id: String,
    pub version: String,
    pub workspace_id: String,
    pub doc_id: String,
    pub kind: EncryptedObjectKind,
    pub generation: u64,
    pub nonce: Vec<u8>,
    pub ciphertext: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ObjectSummary {
    pub object_id: String,
    pub version: String,
    pub workspace_id: String,
    pub doc_id: String,
    pub kind: EncryptedObjectKind,
    pub generation: u64,
    pub ciphertext_len: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ObjectCryptoKey {
    bytes: [u8; 32],
}

impl ObjectCryptoKey {
    pub fn new(bytes: [u8; 32]) -> Self {
        Self { bytes }
    }

    pub fn from_seed(seed: &[u8]) -> Self {
        Self {
            bytes: *blake3::hash(seed).as_bytes(),
        }
    }
}

#[derive(Debug, Clone)]
pub struct EncryptedObjectCodec {
    key: ObjectCryptoKey,
}

impl EncryptedObjectCodec {
    pub fn new(key: ObjectCryptoKey) -> Self {
        Self { key }
    }

    pub fn encrypt(
        &self,
        workspace_id: impl Into<String>,
        doc_id: impl Into<String>,
        kind: EncryptedObjectKind,
        generation: u64,
        plaintext: &[u8],
    ) -> ObjectStoreResult<EncryptedObjectEnvelope> {
        let workspace_id = workspace_id.into();
        let doc_id = doc_id.into();
        let mut nonce = [0_u8; 12];
        OsRng.fill_bytes(&mut nonce);
        self.encrypt_with_nonce(workspace_id, doc_id, kind, generation, plaintext, nonce)
    }

    fn encrypt_with_nonce(
        &self,
        workspace_id: String,
        doc_id: String,
        kind: EncryptedObjectKind,
        generation: u64,
        plaintext: &[u8],
        nonce: [u8; 12],
    ) -> ObjectStoreResult<EncryptedObjectEnvelope> {
        let aad = object_aad(
            OBJECT_FORMAT_VERSION,
            &workspace_id,
            &doc_id,
            kind,
            generation,
        )?;
        let cipher = ChaCha20Poly1305::new(Key::from_slice(&self.key.bytes));
        let ciphertext = cipher
            .encrypt(
                Nonce::from_slice(&nonce),
                Payload {
                    msg: plaintext,
                    aad: &aad,
                },
            )
            .map_err(|_| ObjectStoreError::CryptoFailed)?;
        let object_id = object_id_from_ciphertext(&aad, &nonce, &ciphertext);
        Ok(EncryptedObjectEnvelope {
            object_id,
            version: OBJECT_FORMAT_VERSION.to_owned(),
            workspace_id,
            doc_id,
            kind,
            generation,
            nonce: nonce.to_vec(),
            ciphertext,
        })
    }

    pub fn decrypt(&self, envelope: &EncryptedObjectEnvelope) -> ObjectStoreResult<Vec<u8>> {
        if envelope.version != OBJECT_FORMAT_VERSION {
            return Err(ObjectStoreError::UnsupportedVersion(
                envelope.version.clone(),
            ));
        }
        if envelope.nonce.len() != 12 {
            return Err(ObjectStoreError::CryptoFailed);
        }
        let aad = object_aad(
            &envelope.version,
            &envelope.workspace_id,
            &envelope.doc_id,
            envelope.kind,
            envelope.generation,
        )?;
        let cipher = ChaCha20Poly1305::new(Key::from_slice(&self.key.bytes));
        cipher
            .decrypt(
                Nonce::from_slice(&envelope.nonce),
                Payload {
                    msg: &envelope.ciphertext,
                    aad: &aad,
                },
            )
            .map_err(|_| ObjectStoreError::CryptoFailed)
    }
}

pub trait ObjectStore {
    fn put_object(&mut self, object: EncryptedObjectEnvelope) -> ObjectStoreResult<()>;
    fn get_object(&self, object_id: &str) -> ObjectStoreResult<Option<EncryptedObjectEnvelope>>;
    fn list_prefix(&self, prefix: &str) -> ObjectStoreResult<Vec<ObjectSummary>>;
    fn get_pointer(&self, pointer: &str) -> ObjectStoreResult<Option<String>>;
    fn compare_and_set_pointer(
        &mut self,
        pointer: &str,
        expected: Option<&str>,
        new_object_id: &str,
    ) -> ObjectStoreResult<bool>;
}

#[derive(Default, Clone)]
pub struct MemoryObjectStore {
    objects: BTreeMap<String, EncryptedObjectEnvelope>,
    pointers: BTreeMap<String, String>,
}

impl MemoryObjectStore {
    pub fn new() -> Self {
        Self::default()
    }
}

impl ObjectStore for MemoryObjectStore {
    fn put_object(&mut self, object: EncryptedObjectEnvelope) -> ObjectStoreResult<()> {
        if let Some(existing) = self.objects.get(&object.object_id) {
            if existing != &object {
                return Err(ObjectStoreError::ObjectIdCollision(object.object_id));
            }
            return Ok(());
        }
        self.objects.insert(object.object_id.clone(), object);
        Ok(())
    }

    fn get_object(&self, object_id: &str) -> ObjectStoreResult<Option<EncryptedObjectEnvelope>> {
        Ok(self.objects.get(object_id).cloned())
    }

    fn list_prefix(&self, prefix: &str) -> ObjectStoreResult<Vec<ObjectSummary>> {
        Ok(self
            .objects
            .range(prefix.to_owned()..)
            .take_while(|(object_id, _)| object_id.starts_with(prefix))
            .map(|(_, object)| object.summary())
            .collect())
    }

    fn get_pointer(&self, pointer: &str) -> ObjectStoreResult<Option<String>> {
        Ok(self.pointers.get(pointer).cloned())
    }

    fn compare_and_set_pointer(
        &mut self,
        pointer: &str,
        expected: Option<&str>,
        new_object_id: &str,
    ) -> ObjectStoreResult<bool> {
        let current = self.pointers.get(pointer).map(String::as_str);
        if current == expected {
            self.pointers
                .insert(pointer.to_owned(), new_object_id.to_owned());
            return Ok(true);
        }
        Ok(false)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VaultObjectPack {
    pub root_object_id: String,
    pub object_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PointerPublishResult {
    Published { pointer: String, object_id: String },
    AlreadyPublished { pointer: String, object_id: String },
    MissingObjects { object_ids: Vec<String> },
    Conflict { current: Option<String> },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct QuarantinedObject {
    pub object_id: String,
    pub reason: String,
}

pub struct ObjectVaultLoad {
    pub stored: StoredVaultLoad,
    pub quarantined_objects: Vec<QuarantinedObject>,
}

impl EncryptedObjectEnvelope {
    fn summary(&self) -> ObjectSummary {
        ObjectSummary {
            object_id: self.object_id.clone(),
            version: self.version.clone(),
            workspace_id: self.workspace_id.clone(),
            doc_id: self.doc_id.clone(),
            kind: self.kind,
            generation: self.generation,
            ciphertext_len: self.ciphertext.len(),
        }
    }
}

pub fn upload_vault_objects(
    core: &mut VaultCore,
    store: &mut impl ObjectStore,
    codec: &EncryptedObjectCodec,
    workspace_id: &str,
    generation: u64,
) -> ObjectStoreResult<VaultObjectPack> {
    let mut object_ids = Vec::new();
    let manifest = codec.encrypt(
        workspace_id,
        "manifest",
        EncryptedObjectKind::Manifest,
        generation,
        &core.manifest.save(),
    )?;
    let root_object_id = manifest.object_id.clone();
    store.put_object(manifest)?;
    object_ids.push(root_object_id.clone());

    for (doc_id, text_doc) in &mut core.text_docs {
        let object = codec.encrypt(
            workspace_id,
            doc_id.clone(),
            EncryptedObjectKind::TextDoc,
            generation,
            &text_doc.save(),
        )?;
        object_ids.push(object.object_id.clone());
        store.put_object(object)?;
    }
    object_ids.sort();

    Ok(VaultObjectPack {
        root_object_id,
        object_ids,
    })
}

pub fn load_vault_from_objects(
    actor: impl AsRef<[u8]>,
    store: &impl ObjectStore,
    codec: &EncryptedObjectCodec,
    object_ids: &[String],
) -> ObjectStoreResult<ObjectVaultLoad> {
    let mut local_store = MemoryLocalStore::new();
    let mut quarantined_objects = Vec::new();
    let mut seen_manifest = false;

    for object_id in object_ids {
        let Some(object) = store.get_object(object_id)? else {
            return Err(ObjectStoreError::MissingObject(object_id.clone()));
        };
        match codec.decrypt(&object) {
            Ok(plaintext) => match object.kind {
                EncryptedObjectKind::Manifest => {
                    local_store.save_manifest(&plaintext)?;
                    seen_manifest = true;
                }
                EncryptedObjectKind::TextDoc => {
                    local_store.save_text_doc(&object.doc_id, &plaintext)?;
                }
                EncryptedObjectKind::Blob | EncryptedObjectKind::Journal => {}
            },
            Err(error) => quarantined_objects.push(QuarantinedObject {
                object_id: object.object_id,
                reason: error.to_string(),
            }),
        }
    }

    if !seen_manifest {
        let stored = VaultCore::load_from_store(actor, &local_store)?;
        return Ok(ObjectVaultLoad {
            stored,
            quarantined_objects,
        });
    }

    let stored = VaultCore::load_from_store(actor, &local_store)?;
    Ok(ObjectVaultLoad {
        stored,
        quarantined_objects,
    })
}

pub fn publish_root_with_barrier(
    store: &mut impl ObjectStore,
    pointer: &str,
    expected: Option<&str>,
    root_object_id: &str,
    referenced_object_ids: &[String],
) -> ObjectStoreResult<PointerPublishResult> {
    let missing = missing_objects(store, referenced_object_ids)?;
    if !missing.is_empty() {
        return Ok(PointerPublishResult::MissingObjects {
            object_ids: missing,
        });
    }

    if store.get_pointer(pointer)?.as_deref() == Some(root_object_id) {
        return Ok(PointerPublishResult::AlreadyPublished {
            pointer: pointer.to_owned(),
            object_id: root_object_id.to_owned(),
        });
    }

    if store.compare_and_set_pointer(pointer, expected, root_object_id)? {
        return Ok(PointerPublishResult::Published {
            pointer: pointer.to_owned(),
            object_id: root_object_id.to_owned(),
        });
    }

    Ok(PointerPublishResult::Conflict {
        current: store.get_pointer(pointer)?,
    })
}

fn missing_objects(
    store: &impl ObjectStore,
    object_ids: &[String],
) -> ObjectStoreResult<Vec<String>> {
    let mut missing = Vec::new();
    let mut seen = BTreeSet::new();
    for object_id in object_ids {
        if !seen.insert(object_id) {
            continue;
        }
        if store.get_object(object_id)?.is_none() {
            missing.push(object_id.clone());
        }
    }
    Ok(missing)
}

#[derive(Serialize)]
struct ObjectAad<'a> {
    version: &'a str,
    workspace_id: &'a str,
    doc_id: &'a str,
    kind: EncryptedObjectKind,
    generation: u64,
}

fn object_aad(
    version: &str,
    workspace_id: &str,
    doc_id: &str,
    kind: EncryptedObjectKind,
    generation: u64,
) -> ObjectStoreResult<Vec<u8>> {
    Ok(serde_json::to_vec(&ObjectAad {
        version,
        workspace_id,
        doc_id,
        kind,
        generation,
    })?)
}

fn object_id_from_ciphertext(aad: &[u8], nonce: &[u8], ciphertext: &[u8]) -> String {
    let mut hasher = blake3::Hasher::new();
    hasher.update(aad);
    hasher.update(nonce);
    hasher.update(ciphertext);
    format!("obj_{}", hasher.finalize().to_hex())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::FileCreate;

    fn codec() -> EncryptedObjectCodec {
        EncryptedObjectCodec::new(ObjectCryptoKey::from_seed(b"test-key"))
    }

    fn create_core(content: &str) -> VaultCore {
        let mut core = VaultCore::new(b"a").unwrap();
        core.create_markdown(FileCreate {
            stable_file_id: "file-1".to_owned(),
            incarnation_id: "inc-1".to_owned(),
            display_path: "Notes/A.md".to_owned(),
            text_doc_id: "text-1".to_owned(),
            blob_ref: None,
            content: content.to_owned(),
        })
        .unwrap();
        core
    }

    #[test]
    fn encrypted_object_roundtrips_with_metadata() {
        let codec = codec();
        let object = codec
            .encrypt(
                "workspace-1",
                "manifest",
                EncryptedObjectKind::Manifest,
                7,
                b"payload",
            )
            .unwrap();

        assert_eq!(codec.decrypt(&object).unwrap(), b"payload");
        assert_eq!(object.version, OBJECT_FORMAT_VERSION);
        assert_eq!(object.workspace_id, "workspace-1");
        assert_eq!(object.generation, 7);
    }

    #[test]
    fn remote_object_id_does_not_contain_plaintext_path_or_hash() {
        let codec = codec();
        let object = codec
            .encrypt(
                "workspace-1",
                "text-1",
                EncryptedObjectKind::TextDoc,
                1,
                b"notes/a.md:plaintext-hash",
            )
            .unwrap();

        assert!(!object.object_id.contains("notes/a.md"));
        assert!(!object.object_id.contains("plaintext-hash"));
        assert!(
            !object
                .ciphertext
                .windows("notes/a.md".len())
                .any(|window| { window == "notes/a.md".as_bytes() })
        );
    }

    #[test]
    fn two_clients_converge_through_fake_remote() {
        let codec = codec();
        let mut remote = MemoryObjectStore::new();
        let mut a = create_core("hello");

        let pack = upload_vault_objects(&mut a, &mut remote, &codec, "workspace-1", 1).unwrap();
        let load = load_vault_from_objects(b"b", &remote, &codec, &pack.object_ids).unwrap();
        let mut b = load.stored.core.unwrap();

        assert_eq!(
            b.materialize()
                .unwrap()
                .files
                .get("file-1")
                .unwrap()
                .content
                .as_deref(),
            Some("hello")
        );
        assert_eq!(load.quarantined_objects, vec![]);
    }

    #[test]
    fn pointer_publish_before_missing_object_is_blocked() {
        let mut remote = MemoryObjectStore::new();
        let result = publish_root_with_barrier(
            &mut remote,
            "workspace/head",
            None,
            "missing-root",
            &["missing-root".to_owned()],
        )
        .unwrap();

        assert_eq!(
            result,
            PointerPublishResult::MissingObjects {
                object_ids: vec!["missing-root".to_owned()]
            }
        );
        assert_eq!(remote.get_pointer("workspace/head").unwrap(), None);
    }

    #[test]
    fn interrupted_upload_retry_is_idempotent() {
        let codec = codec();
        let mut remote = MemoryObjectStore::new();
        let object = codec
            .encrypt(
                "workspace-1",
                "manifest",
                EncryptedObjectKind::Manifest,
                1,
                b"payload",
            )
            .unwrap();

        remote.put_object(object.clone()).unwrap();
        remote.put_object(object.clone()).unwrap();

        assert_eq!(remote.objects.len(), 1);
        assert_eq!(remote.get_object(&object.object_id).unwrap(), Some(object));
    }

    #[test]
    fn interrupted_pointer_publish_retry_is_idempotent() {
        let codec = codec();
        let mut remote = MemoryObjectStore::new();
        let object = codec
            .encrypt(
                "workspace-1",
                "manifest",
                EncryptedObjectKind::Manifest,
                1,
                b"payload",
            )
            .unwrap();
        remote.put_object(object.clone()).unwrap();

        let first = publish_root_with_barrier(
            &mut remote,
            "workspace/head",
            None,
            &object.object_id,
            &[object.object_id.clone()],
        )
        .unwrap();
        let retry = publish_root_with_barrier(
            &mut remote,
            "workspace/head",
            None,
            &object.object_id,
            &[object.object_id.clone()],
        )
        .unwrap();

        assert!(matches!(first, PointerPublishResult::Published { .. }));
        assert!(matches!(
            retry,
            PointerPublishResult::AlreadyPublished { .. }
        ));
    }

    #[test]
    fn decrypt_failure_is_quarantined_and_projection_blocks_missing_text_doc() {
        let codec = codec();
        let mut remote = MemoryObjectStore::new();
        let mut core = create_core("hello");
        let pack = upload_vault_objects(&mut core, &mut remote, &codec, "workspace-1", 1).unwrap();
        let text_object_id = pack
            .object_ids
            .iter()
            .find(|object_id| {
                remote
                    .objects
                    .get(*object_id)
                    .is_some_and(|object| object.kind == EncryptedObjectKind::TextDoc)
            })
            .unwrap()
            .clone();
        remote
            .objects
            .get_mut(&text_object_id)
            .unwrap()
            .ciphertext
            .push(1);

        let load = load_vault_from_objects(b"b", &remote, &codec, &pack.object_ids).unwrap();

        assert_eq!(load.quarantined_objects.len(), 1);
        let mut loaded = load.stored.core.unwrap();
        assert!(loaded.materialize().unwrap().projection_plan.blocked);
    }
}
