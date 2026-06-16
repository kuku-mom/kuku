use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use automerge::{ActorId, AutoCommit};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::error::SyncCoreError;
use crate::projection::ProjectedSnapshot;
use crate::review::ReviewResolutionRecord;
use crate::text_doc::TextDocument;
use crate::vault::VaultCore;

#[derive(Debug, Error)]
pub enum StoreError {
    #[error("store io failed: {0}")]
    Io(#[from] std::io::Error),
    #[error("store serialization failed: {0}")]
    Serde(#[from] serde_json::Error),
    #[error("automerge operation failed: {0}")]
    Automerge(#[from] automerge::AutomergeError),
    #[error("sync core operation failed: {0}")]
    SyncCore(#[from] SyncCoreError),
    #[error("writer lock is already held by actor {actor_id:?}")]
    WriterLockHeld { actor_id: Vec<u8> },
    #[error("writer lock token does not match")]
    WriterLockTokenMismatch,
    #[error("invalid text doc id in store: {0}")]
    InvalidDocId(String),
}

pub type StoreResult<T> = std::result::Result<T, StoreError>;

pub trait LocalStore {
    fn load_manifest(&self) -> StoreResult<Option<Vec<u8>>>;
    fn save_manifest(&mut self, bytes: &[u8]) -> StoreResult<()>;
    fn load_text_doc(&self, doc_id: &str) -> StoreResult<Option<Vec<u8>>>;
    fn save_text_doc(&mut self, doc_id: &str, bytes: &[u8]) -> StoreResult<()>;
    fn list_text_doc_ids(&self) -> StoreResult<Vec<String>>;
    fn append_journal_entry(&mut self, entry: JournalEntry) -> StoreResult<()>;
    fn read_journal(&self) -> StoreResult<Vec<JournalEntry>>;
    fn ack_journal_entry(&mut self, entry_id: &str) -> StoreResult<()>;
    fn save_projected_snapshot(&mut self, snapshot: ProjectedSnapshot) -> StoreResult<()>;
    fn remove_projected_snapshot(&mut self, file_id: &str) -> StoreResult<()>;
    fn list_projected_snapshots(&self) -> StoreResult<Vec<ProjectedSnapshot>>;
    fn save_review_resolution(&mut self, record: ReviewResolutionRecord) -> StoreResult<()>;
    fn remove_review_resolution(&mut self, review_item_id: &str) -> StoreResult<()>;
    fn list_review_resolutions(&self) -> StoreResult<Vec<ReviewResolutionRecord>>;
    fn acquire_writer_lock(&mut self, actor_id: &[u8]) -> StoreResult<WriterLockLease>;
    fn release_writer_lock(&mut self, token: &str) -> StoreResult<()>;
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct JournalEntry {
    pub entry_id: String,
    pub kind: JournalEntryKind,
    pub payload: String,
    pub created_at_ms: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum JournalEntryKind {
    LocalEdit,
    Projection,
    RemotePublish,
    SyncRun,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WriterLockLease {
    pub actor_id: Vec<u8>,
    pub token: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum StoreDiagnostic {
    MissingManifest,
    MissingTextDocRecord { text_doc_id: String },
}

pub struct StoredVaultLoad {
    pub core: Option<VaultCore>,
    pub diagnostics: Vec<StoreDiagnostic>,
}

impl VaultCore {
    pub fn save_to_store(&mut self, store: &mut impl LocalStore) -> StoreResult<()> {
        store.save_manifest(&self.manifest.save())?;
        for (doc_id, text_doc) in &mut self.text_docs {
            store.save_text_doc(doc_id, &text_doc.save())?;
        }
        Ok(())
    }

    pub fn load_from_store(
        actor: impl AsRef<[u8]>,
        store: &impl LocalStore,
    ) -> StoreResult<StoredVaultLoad> {
        let actor = actor.as_ref().to_vec();
        let Some(manifest_bytes) = store.load_manifest()? else {
            return Ok(StoredVaultLoad {
                core: None,
                diagnostics: vec![StoreDiagnostic::MissingManifest],
            });
        };

        let mut manifest = AutoCommit::load(&manifest_bytes)?;
        manifest.set_actor(ActorId::from(actor.as_slice()));
        let mut core = VaultCore {
            actor,
            manifest,
            text_docs: BTreeMap::new(),
            known_blobs: BTreeSet::new(),
        };

        let mut diagnostics = Vec::new();
        for text_doc_id in core.text_doc_ids_from_manifest()? {
            match store.load_text_doc(&text_doc_id)? {
                Some(bytes) => {
                    let text_doc =
                        TextDocument::load(core.actor.as_slice(), text_doc_id.clone(), &bytes)?;
                    core.text_docs.insert(text_doc_id, text_doc);
                }
                None => diagnostics.push(StoreDiagnostic::MissingTextDocRecord { text_doc_id }),
            }
        }

        Ok(StoredVaultLoad {
            core: Some(core),
            diagnostics,
        })
    }
}

#[derive(Clone, Default)]
pub struct MemoryLocalStore {
    manifest: Option<Vec<u8>>,
    text_docs: BTreeMap<String, Vec<u8>>,
    journal: Vec<JournalEntry>,
    projected_snapshots: BTreeMap<String, ProjectedSnapshot>,
    review_resolutions: BTreeMap<String, ReviewResolutionRecord>,
    writer_lock: Option<WriterLockLease>,
    lock_counter: u64,
}

impl MemoryLocalStore {
    pub fn new() -> Self {
        Self::default()
    }
}

impl LocalStore for MemoryLocalStore {
    fn load_manifest(&self) -> StoreResult<Option<Vec<u8>>> {
        Ok(self.manifest.clone())
    }

    fn save_manifest(&mut self, bytes: &[u8]) -> StoreResult<()> {
        self.manifest = Some(bytes.to_vec());
        Ok(())
    }

    fn load_text_doc(&self, doc_id: &str) -> StoreResult<Option<Vec<u8>>> {
        Ok(self.text_docs.get(doc_id).cloned())
    }

    fn save_text_doc(&mut self, doc_id: &str, bytes: &[u8]) -> StoreResult<()> {
        self.text_docs.insert(doc_id.to_owned(), bytes.to_vec());
        Ok(())
    }

    fn list_text_doc_ids(&self) -> StoreResult<Vec<String>> {
        Ok(self.text_docs.keys().cloned().collect())
    }

    fn append_journal_entry(&mut self, entry: JournalEntry) -> StoreResult<()> {
        self.journal.push(entry);
        Ok(())
    }

    fn read_journal(&self) -> StoreResult<Vec<JournalEntry>> {
        Ok(self.journal.clone())
    }

    fn ack_journal_entry(&mut self, entry_id: &str) -> StoreResult<()> {
        self.journal.retain(|entry| entry.entry_id != entry_id);
        Ok(())
    }

    fn save_projected_snapshot(&mut self, snapshot: ProjectedSnapshot) -> StoreResult<()> {
        self.projected_snapshots
            .insert(snapshot.file_id.clone(), snapshot);
        Ok(())
    }

    fn remove_projected_snapshot(&mut self, file_id: &str) -> StoreResult<()> {
        self.projected_snapshots.remove(file_id);
        Ok(())
    }

    fn list_projected_snapshots(&self) -> StoreResult<Vec<ProjectedSnapshot>> {
        Ok(self.projected_snapshots.values().cloned().collect())
    }

    fn save_review_resolution(&mut self, record: ReviewResolutionRecord) -> StoreResult<()> {
        self.review_resolutions
            .insert(record.review_item_id.clone(), record);
        Ok(())
    }

    fn remove_review_resolution(&mut self, review_item_id: &str) -> StoreResult<()> {
        self.review_resolutions.remove(review_item_id);
        Ok(())
    }

    fn list_review_resolutions(&self) -> StoreResult<Vec<ReviewResolutionRecord>> {
        Ok(self.review_resolutions.values().cloned().collect())
    }

    fn acquire_writer_lock(&mut self, actor_id: &[u8]) -> StoreResult<WriterLockLease> {
        if let Some(lock) = &self.writer_lock {
            return Err(StoreError::WriterLockHeld {
                actor_id: lock.actor_id.clone(),
            });
        }
        self.lock_counter += 1;
        let lease = WriterLockLease {
            actor_id: actor_id.to_vec(),
            token: format!("{}:{}", hex_encode(actor_id), self.lock_counter),
        };
        self.writer_lock = Some(lease.clone());
        Ok(lease)
    }

    fn release_writer_lock(&mut self, token: &str) -> StoreResult<()> {
        match &self.writer_lock {
            Some(lock) if lock.token == token => {
                self.writer_lock = None;
                Ok(())
            }
            _ => Err(StoreError::WriterLockTokenMismatch),
        }
    }
}

pub struct FileLocalStore {
    root: PathBuf,
}

impl FileLocalStore {
    pub fn new(root: impl Into<PathBuf>) -> StoreResult<Self> {
        let root = root.into();
        fs::create_dir_all(root.join("text_docs"))?;
        Ok(Self { root })
    }

    fn manifest_path(&self) -> PathBuf {
        self.root.join("manifest.bin")
    }

    fn text_doc_path(&self, doc_id: &str) -> PathBuf {
        self.root
            .join("text_docs")
            .join(format!("{}.bin", hex_encode(doc_id.as_bytes())))
    }

    fn journal_path(&self) -> PathBuf {
        self.root.join("journal.json")
    }

    fn projected_snapshots_path(&self) -> PathBuf {
        self.root.join("projected_snapshots.json")
    }

    fn review_resolutions_path(&self) -> PathBuf {
        self.root.join("review_resolutions.json")
    }

    fn writer_lock_path(&self) -> PathBuf {
        self.root.join("writer_lock.json")
    }

    fn read_journal_vec(&self) -> StoreResult<Vec<JournalEntry>> {
        read_json_or_default(&self.journal_path())
    }

    fn save_journal_vec(&self, journal: &[JournalEntry]) -> StoreResult<()> {
        write_json(&self.journal_path(), journal)
    }

    fn read_projected_snapshot_map(&self) -> StoreResult<BTreeMap<String, ProjectedSnapshot>> {
        read_json_or_default(&self.projected_snapshots_path())
    }

    fn save_projected_snapshot_map(
        &self,
        snapshots: &BTreeMap<String, ProjectedSnapshot>,
    ) -> StoreResult<()> {
        write_json(&self.projected_snapshots_path(), snapshots)
    }

    fn read_review_resolution_map(&self) -> StoreResult<BTreeMap<String, ReviewResolutionRecord>> {
        read_json_or_default(&self.review_resolutions_path())
    }

    fn save_review_resolution_map(
        &self,
        resolutions: &BTreeMap<String, ReviewResolutionRecord>,
    ) -> StoreResult<()> {
        write_json(&self.review_resolutions_path(), resolutions)
    }

    fn read_writer_lock(&self) -> StoreResult<Option<WriterLockLease>> {
        let path = self.writer_lock_path();
        if !path.exists() {
            return Ok(None);
        }
        Ok(Some(read_json(&path)?))
    }
}

impl LocalStore for FileLocalStore {
    fn load_manifest(&self) -> StoreResult<Option<Vec<u8>>> {
        let path = self.manifest_path();
        if !path.exists() {
            return Ok(None);
        }
        Ok(Some(fs::read(path)?))
    }

    fn save_manifest(&mut self, bytes: &[u8]) -> StoreResult<()> {
        fs::create_dir_all(&self.root)?;
        fs::write(self.manifest_path(), bytes)?;
        Ok(())
    }

    fn load_text_doc(&self, doc_id: &str) -> StoreResult<Option<Vec<u8>>> {
        let path = self.text_doc_path(doc_id);
        if !path.exists() {
            return Ok(None);
        }
        Ok(Some(fs::read(path)?))
    }

    fn save_text_doc(&mut self, doc_id: &str, bytes: &[u8]) -> StoreResult<()> {
        fs::create_dir_all(self.root.join("text_docs"))?;
        fs::write(self.text_doc_path(doc_id), bytes)?;
        Ok(())
    }

    fn list_text_doc_ids(&self) -> StoreResult<Vec<String>> {
        let dir = self.root.join("text_docs");
        if !dir.exists() {
            return Ok(Vec::new());
        }
        let mut ids = Vec::new();
        for entry in fs::read_dir(dir)? {
            let entry = entry?;
            let file_name = entry.file_name().to_string_lossy().into_owned();
            let Some(hex) = file_name.strip_suffix(".bin") else {
                continue;
            };
            ids.push(hex_decode_to_string(hex)?);
        }
        ids.sort();
        Ok(ids)
    }

    fn append_journal_entry(&mut self, entry: JournalEntry) -> StoreResult<()> {
        let mut journal = self.read_journal_vec()?;
        journal.push(entry);
        self.save_journal_vec(&journal)
    }

    fn read_journal(&self) -> StoreResult<Vec<JournalEntry>> {
        self.read_journal_vec()
    }

    fn ack_journal_entry(&mut self, entry_id: &str) -> StoreResult<()> {
        let mut journal = self.read_journal_vec()?;
        journal.retain(|entry| entry.entry_id != entry_id);
        self.save_journal_vec(&journal)
    }

    fn save_projected_snapshot(&mut self, snapshot: ProjectedSnapshot) -> StoreResult<()> {
        let mut snapshots = self.read_projected_snapshot_map()?;
        snapshots.insert(snapshot.file_id.clone(), snapshot);
        self.save_projected_snapshot_map(&snapshots)
    }

    fn remove_projected_snapshot(&mut self, file_id: &str) -> StoreResult<()> {
        let mut snapshots = self.read_projected_snapshot_map()?;
        snapshots.remove(file_id);
        self.save_projected_snapshot_map(&snapshots)
    }

    fn list_projected_snapshots(&self) -> StoreResult<Vec<ProjectedSnapshot>> {
        Ok(self
            .read_projected_snapshot_map()?
            .values()
            .cloned()
            .collect())
    }

    fn save_review_resolution(&mut self, record: ReviewResolutionRecord) -> StoreResult<()> {
        let mut resolutions = self.read_review_resolution_map()?;
        resolutions.insert(record.review_item_id.clone(), record);
        self.save_review_resolution_map(&resolutions)
    }

    fn remove_review_resolution(&mut self, review_item_id: &str) -> StoreResult<()> {
        let mut resolutions = self.read_review_resolution_map()?;
        resolutions.remove(review_item_id);
        self.save_review_resolution_map(&resolutions)
    }

    fn list_review_resolutions(&self) -> StoreResult<Vec<ReviewResolutionRecord>> {
        Ok(self
            .read_review_resolution_map()?
            .values()
            .cloned()
            .collect())
    }

    fn acquire_writer_lock(&mut self, actor_id: &[u8]) -> StoreResult<WriterLockLease> {
        if let Some(lock) = self.read_writer_lock()? {
            return Err(StoreError::WriterLockHeld {
                actor_id: lock.actor_id,
            });
        }
        let lease = WriterLockLease {
            actor_id: actor_id.to_vec(),
            token: format!("{}:{}", hex_encode(actor_id), now_millis()),
        };
        write_json(&self.writer_lock_path(), &lease)?;
        Ok(lease)
    }

    fn release_writer_lock(&mut self, token: &str) -> StoreResult<()> {
        let Some(lock) = self.read_writer_lock()? else {
            return Err(StoreError::WriterLockTokenMismatch);
        };
        if lock.token != token {
            return Err(StoreError::WriterLockTokenMismatch);
        }
        fs::remove_file(self.writer_lock_path())?;
        Ok(())
    }
}

fn read_json_or_default<T>(path: &Path) -> StoreResult<T>
where
    T: DeserializeOwned + Default,
{
    if !path.exists() {
        return Ok(T::default());
    }
    read_json(path)
}

fn read_json<T>(path: &Path) -> StoreResult<T>
where
    T: DeserializeOwned,
{
    let bytes = fs::read(path)?;
    Ok(serde_json::from_slice(&bytes)?)
}

fn write_json<T>(path: &Path, value: &T) -> StoreResult<()>
where
    T: Serialize + ?Sized,
{
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, serde_json::to_vec_pretty(value)?)?;
    Ok(())
}

fn hex_encode(bytes: &[u8]) -> String {
    bytes
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>()
}

fn hex_decode_to_string(value: &str) -> StoreResult<String> {
    if !value.len().is_multiple_of(2) {
        return Err(StoreError::InvalidDocId(value.to_owned()));
    }
    let mut bytes = Vec::with_capacity(value.len() / 2);
    for chunk in value.as_bytes().chunks_exact(2) {
        let chunk =
            std::str::from_utf8(chunk).map_err(|_| StoreError::InvalidDocId(value.to_owned()))?;
        let byte = u8::from_str_radix(chunk, 16)
            .map_err(|_| StoreError::InvalidDocId(value.to_owned()))?;
        bytes.push(byte);
    }
    String::from_utf8(bytes).map_err(|_| StoreError::InvalidDocId(value.to_owned()))
}

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::FileCreate;
    use crate::projection::ProjectedSnapshot;
    use crate::review::{ReviewResolutionCommand, ReviewResolutionRecord};

    fn create_note(core: &mut VaultCore, content: &str) {
        core.create_markdown(FileCreate {
            stable_file_id: "file-1".to_owned(),
            incarnation_id: "inc-1".to_owned(),
            display_path: "note.md".to_owned(),
            text_doc_id: "text-1".to_owned(),
            blob_ref: None,
            content: content.to_owned(),
        })
        .unwrap();
    }

    fn snapshot(hash: &str, generation: u64) -> ProjectedSnapshot {
        ProjectedSnapshot {
            file_id: "file-1".to_owned(),
            normalized_path: "note.md".to_owned(),
            content_hash: hash.to_owned(),
            mtime_ms: generation as i64,
            size: hash.len() as u64,
            projection_generation: generation,
        }
    }

    fn journal_entry(id: &str) -> JournalEntry {
        JournalEntry {
            entry_id: id.to_owned(),
            kind: JournalEntryKind::LocalEdit,
            payload: "text-1".to_owned(),
            created_at_ms: 1,
        }
    }

    fn review_resolution(id: &str) -> ReviewResolutionRecord {
        ReviewResolutionRecord {
            review_item_id: id.to_owned(),
            item_fingerprint: format!("fingerprint-{id}"),
            command: ReviewResolutionCommand::RejectImport {
                review_item_id: id.to_owned(),
            },
            resolved_at_ms: 1,
        }
    }

    #[test]
    fn manifest_and_text_docs_save_load_materialize_same_tree() {
        let mut core = VaultCore::new(b"a").unwrap();
        create_note(&mut core, "hello");
        let before = core.materialize().unwrap();
        let mut store = MemoryLocalStore::new();

        core.save_to_store(&mut store).unwrap();
        let mut loaded = VaultCore::load_from_store(b"b", &store)
            .unwrap()
            .core
            .expect("stored manifest should load");

        let after = loaded.materialize().unwrap();
        assert_eq!(after.files, before.files);
        assert_eq!(after.issues, vec![]);
    }

    #[test]
    fn local_edit_after_crash_reopen_preserves_pending_journal() {
        let mut core = VaultCore::new(b"a").unwrap();
        create_note(&mut core, "hello");
        let mut store = MemoryLocalStore::new();
        core.save_to_store(&mut store).unwrap();
        store
            .append_journal_entry(journal_entry("entry-1"))
            .unwrap();

        let crashed_store = store.clone();
        let loaded = VaultCore::load_from_store(b"a", &crashed_store).unwrap();

        assert!(loaded.core.is_some());
        assert_eq!(
            crashed_store.read_journal().unwrap(),
            vec![journal_entry("entry-1")]
        );
    }

    #[test]
    fn projection_applied_snapshot_is_stored() {
        let mut store = MemoryLocalStore::new();
        store
            .save_projected_snapshot(snapshot("hash-1", 1))
            .unwrap();

        assert_eq!(
            store.list_projected_snapshots().unwrap(),
            vec![snapshot("hash-1", 1)]
        );
    }

    #[test]
    fn acked_journal_entry_is_not_pending() {
        let mut store = MemoryLocalStore::new();
        store
            .append_journal_entry(journal_entry("entry-1"))
            .unwrap();
        store
            .append_journal_entry(journal_entry("entry-2"))
            .unwrap();

        store.ack_journal_entry("entry-1").unwrap();

        assert_eq!(
            store.read_journal().unwrap(),
            vec![journal_entry("entry-2")]
        );
    }

    #[test]
    fn review_resolutions_can_be_saved_and_removed() {
        let mut store = MemoryLocalStore::new();
        store
            .save_review_resolution(review_resolution("review-1"))
            .unwrap();

        assert_eq!(
            store.list_review_resolutions().unwrap(),
            vec![review_resolution("review-1")]
        );

        store.remove_review_resolution("review-1").unwrap();
        assert!(store.list_review_resolutions().unwrap().is_empty());
    }

    #[test]
    fn same_actor_concurrent_writer_is_rejected() {
        let mut store = MemoryLocalStore::new();
        let lease = store.acquire_writer_lock(b"actor-a").unwrap();

        let error = store.acquire_writer_lock(b"actor-a").unwrap_err();

        assert!(matches!(error, StoreError::WriterLockHeld { .. }));
        store.release_writer_lock(&lease.token).unwrap();
        assert!(store.acquire_writer_lock(b"actor-a").is_ok());
    }

    #[test]
    fn missing_text_doc_record_is_exposed_as_diagnostic() {
        let mut core = VaultCore::new(b"a").unwrap();
        create_note(&mut core, "hello");
        let mut store = MemoryLocalStore::new();
        core.save_to_store(&mut store).unwrap();
        store.text_docs.remove("text-1");

        let load = VaultCore::load_from_store(b"a", &store).unwrap();

        assert_eq!(
            load.diagnostics,
            vec![StoreDiagnostic::MissingTextDocRecord {
                text_doc_id: "text-1".to_owned()
            }]
        );
        let mut loaded = load.core.unwrap();
        assert!(loaded.materialize().unwrap().projection_plan.blocked);
    }

    #[test]
    fn missing_manifest_is_exposed_as_diagnostic() {
        let store = MemoryLocalStore::new();

        let load = VaultCore::load_from_store(b"a", &store).unwrap();

        assert!(load.core.is_none());
        assert_eq!(load.diagnostics, vec![StoreDiagnostic::MissingManifest]);
    }

    #[test]
    fn file_store_persists_manifest_text_docs_journal_and_snapshots() {
        let root = unique_temp_dir();
        let mut core = VaultCore::new(b"a").unwrap();
        create_note(&mut core, "file backed");
        {
            let mut store = FileLocalStore::new(&root).unwrap();
            core.save_to_store(&mut store).unwrap();
            store
                .append_journal_entry(journal_entry("entry-1"))
                .unwrap();
            store
                .save_projected_snapshot(snapshot("hash-1", 1))
                .unwrap();
            store
                .save_review_resolution(review_resolution("review-1"))
                .unwrap();
        }

        let store = FileLocalStore::new(&root).unwrap();
        let mut loaded = VaultCore::load_from_store(b"b", &store)
            .unwrap()
            .core
            .unwrap();
        let vault = loaded.materialize().unwrap();

        assert_eq!(
            vault.files.get("file-1").unwrap().content.as_deref(),
            Some("file backed")
        );
        assert_eq!(
            store.read_journal().unwrap(),
            vec![journal_entry("entry-1")]
        );
        assert_eq!(
            store.list_projected_snapshots().unwrap(),
            vec![snapshot("hash-1", 1)]
        );
        assert_eq!(
            store.list_review_resolutions().unwrap(),
            vec![review_resolution("review-1")]
        );
        fs::remove_dir_all(root).unwrap();
    }

    fn unique_temp_dir() -> PathBuf {
        let mut root = std::env::temp_dir();
        root.push(format!(
            "kuku-sync-core-store-test-{}-{}",
            std::process::id(),
            now_millis()
        ));
        root
    }
}
