#![allow(dead_code)]

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use std::sync::Arc;

use ed25519_dalek::SigningKey;
use kuku_contract::proto::kuku::sync::v1::{SyncCommitKind, SyncObjectKind};
use rusqlite::Connection;
use serde::Serialize;

use super::client::{
    ObjectReservationInput, PublishCommitInput, PublishedCommit, ReservedObject, SyncCommitApi,
    SyncHead, SyncTransferApi,
};
use super::crypto::{
    CommitBodyAad, CommitSignaturePayload, SymmetricKey, encrypt_commit_body,
    encrypted_blob_metadata, sign_commit_payload,
};
use super::db::{
    self, SyncCommitRecord, SyncTreeEntryRecord, SyncVaultRecord, get_vault, list_tree_entries,
    mark_files_synced, persist_tree_cache, update_vault_after_publish, upsert_local_commit,
    upsert_vault,
};
use super::errors::{SyncError, SyncResult};
use super::keys;
use super::packer::encrypt_pack;
use super::planner::{
    CHECKPOINT_PACK_KIND, CONTENT_PACK_KIND, CommitPlanKind, PlanFileOp, PlannerConfig, SyncPlan,
    plan_checkpoint, plan_incremental,
};
use super::scanner::{ScannedFile, scan_vault};
use super::transfer::{ObjectTransferQueue, ReservedEncryptedUploadObject};

pub const CHECKPOINT_COMMIT_INTERVAL: i64 = 100;
pub const CHECKPOINT_INCREMENTAL_BYTES_INTERVAL: i64 = 64 * 1024 * 1024;
pub const CHECKPOINT_WALL_CLOCK_INTERVAL_MS: i64 = 7 * 24 * 60 * 60 * 1000;
pub const CRYPTO_VERSION: &str = "kuku-sync-v1";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CheckpointTriggerInput {
    pub commits_since_checkpoint: i64,
    pub incremental_encrypted_bytes_since_checkpoint: i64,
    pub now_ms: i64,
    pub last_checkpoint_at_ms: Option<i64>,
    pub force: bool,
}

#[derive(Clone)]
pub struct SyncPushPipeline {
    transfer_api: Arc<dyn SyncTransferApi>,
    commit_api: Arc<dyn SyncCommitApi>,
    transfer_queue: ObjectTransferQueue,
    planner_config: PlannerConfig,
}

pub struct PushLocalChangesInput<'a> {
    pub conn: &'a mut Connection,
    pub vault_id: &'a str,
    pub vault_root: &'a Path,
    pub workspace_id: &'a str,
    pub device_id: &'a str,
    pub workspace_key: &'a SymmetricKey,
    pub signing_key: &'a SigningKey,
    pub now_ms: i64,
}

pub struct PushMergeCommitInput<'a> {
    pub conn: &'a mut Connection,
    pub vault_id: &'a str,
    pub vault_root: &'a Path,
    pub workspace_id: &'a str,
    pub device_id: &'a str,
    pub workspace_key: &'a SymmetricKey,
    pub signing_key: &'a SigningKey,
    pub local_parent_commit_id: &'a str,
    pub now_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PushLocalChangesResult {
    pub published: bool,
    pub commit_id: Option<String>,
    pub commit_kind: Option<CommitPlanKind>,
    pub uploaded_object_ids: Vec<String>,
    pub file_op_count: usize,
    pub idempotent: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ReservedCommitObjects {
    body_object_id: String,
    pack_object_ids: BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct CommitBody {
    format: String,
    version: u8,
    commit_id: String,
    commit_kind: String,
    parent_commit_ids: Vec<String>,
    tree_id: String,
    changes: Vec<CommitBodyFileOp>,
    packs: Vec<CommitBodyPackRef>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", tag = "op")]
enum CommitBodyFileOp {
    #[serde(rename = "upsert_file")]
    UpsertFile {
        file_id: String,
        path: String,
        normalized_path: String,
        plaintext_hash: String,
        size_bytes: i64,
        content_ref: CommitBodyContentRef,
    },
    #[serde(rename = "delete_file")]
    DeleteFile {
        file_id: String,
        path: String,
        normalized_path: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct CommitBodyContentRef {
    object_id: String,
    entry_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct CommitBodyPackRef {
    pack_ref: String,
    object_id: String,
    pack_kind: String,
    shard_index: usize,
    entry_count: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct CommitIdentity<'a> {
    workspace_id: &'a str,
    author_device_id: &'a str,
    device_seq: i64,
    commit_kind: &'a str,
    expected_head_commit_id: &'a str,
    parent_commit_ids: &'a [String],
    body_object_id: &'a str,
    referenced_object_ids: &'a [String],
    tree_id: &'a str,
    changes: &'a [CommitBodyFileOp],
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct TreeCacheEntryBody<'a> {
    file_id: &'a str,
    normalized_path: &'a str,
    plaintext_hash: Option<&'a str>,
    content_object_id: Option<&'a str>,
    pack_entry_id: Option<&'a str>,
    kind: &'a str,
}

impl SyncPushPipeline {
    pub fn new(
        transfer_api: Arc<dyn SyncTransferApi>,
        commit_api: Arc<dyn SyncCommitApi>,
        transfer_queue: ObjectTransferQueue,
        planner_config: PlannerConfig,
    ) -> Self {
        Self {
            transfer_api,
            commit_api,
            transfer_queue,
            planner_config,
        }
    }

    pub async fn push_local_changes(
        &self,
        input: PushLocalChangesInput<'_>,
    ) -> SyncResult<PushLocalChangesResult> {
        validate_push_input(&input)?;
        let head = self.commit_api.get_head(input.workspace_id).await?;
        let vault = ensure_vault_record(&input, &head)?;
        let expected_head = head.current_head_commit_id.clone();
        ensure_local_head_can_push(&vault, &expected_head)?;

        let scanned_files = scan_vault(input.vault_root)?;
        let scan_inputs = scanned_files
            .iter()
            .map(ScannedFile::file_input)
            .collect::<Vec<_>>();
        let scan_result = db::apply_scan(input.conn, &scan_inputs, input.now_ms)?;
        let plan_kind = if expected_head.is_empty() {
            CommitPlanKind::Checkpoint
        } else {
            CommitPlanKind::Incremental
        };
        let plan = match plan_kind {
            CommitPlanKind::Checkpoint => {
                plan_initial_checkpoint(&scanned_files, &self.planner_config)?
            }
            CommitPlanKind::Incremental => {
                plan_incremental(&scan_result, &scanned_files, &self.planner_config)?
            }
            CommitPlanKind::Merge => unreachable!("local push does not select merge plan kind"),
        };
        if plan.is_empty() {
            return Ok(PushLocalChangesResult {
                published: false,
                commit_id: None,
                commit_kind: None,
                uploaded_object_ids: Vec::new(),
                file_op_count: 0,
                idempotent: false,
            });
        }

        let parents = parent_ids(&expected_head);
        let reserved = self
            .reserve_commit_objects(input.workspace_id, input.device_id, &plan)
            .await?;
        let mut referenced_object_ids = reserved
            .pack_object_ids
            .values()
            .cloned()
            .collect::<Vec<_>>();
        referenced_object_ids.sort();

        let tree_entries = materialize_tree_entries(input.conn, &expected_head, &plan, &reserved)?;
        let tree_id = tree_id_for_entries(&tree_entries)?;
        let changes = commit_body_file_ops(&plan, &reserved)?;
        let commit_kind = commit_kind_label(plan_kind);
        let commit_id = commit_id_for(&CommitIdentity {
            workspace_id: input.workspace_id,
            author_device_id: input.device_id,
            device_seq: vault.next_device_seq,
            commit_kind,
            expected_head_commit_id: &expected_head,
            parent_commit_ids: &parents,
            body_object_id: &reserved.body_object_id,
            referenced_object_ids: &referenced_object_ids,
            tree_id: &tree_id,
            changes: &changes,
        })?;

        let commit_body = CommitBody {
            format: "kuku.sync.commit-body".into(),
            version: 1,
            commit_id: commit_id.clone(),
            commit_kind: commit_kind.into(),
            parent_commit_ids: parents.clone(),
            tree_id: tree_id.clone(),
            changes,
            packs: commit_body_pack_refs(&plan, &reserved),
        };
        let uploads = encrypted_uploads(
            input.workspace_key,
            input.workspace_id,
            &commit_id,
            commit_kind,
            &parents,
            input.device_id,
            vault.next_device_seq,
            &reserved,
            &plan,
            &commit_body,
        )?;
        let uploaded = self
            .transfer_queue
            .upload_reserved_objects(
                input.workspace_id,
                input.device_id,
                &format!("upload_{commit_id}"),
                uploads,
            )
            .await?;
        let body_metadata = uploaded
            .iter()
            .find(|object| object.object_id == reserved.body_object_id)
            .ok_or_else(|| SyncError::Transport("commit body upload metadata missing".into()))?;
        let signature_payload = CommitSignaturePayload::new(
            input.workspace_id,
            &commit_id,
            commit_kind,
            &expected_head,
            parents.clone(),
            input.device_id,
            vault.next_device_seq,
            &reserved.body_object_id,
            &body_metadata.ciphertext_sha256,
            body_metadata.size_bytes,
            referenced_object_ids.clone(),
        );
        let signature = sign_commit_payload(input.signing_key, &signature_payload)?;
        let published = self
            .commit_api
            .publish_commit(PublishCommitInput {
                workspace_id: input.workspace_id.into(),
                commit_id: commit_id.clone(),
                commit_kind: proto_commit_kind(plan_kind),
                expected_head_commit_id: expected_head.clone(),
                parent_commit_ids: parents.clone(),
                author_device_id: input.device_id.into(),
                device_seq: vault.next_device_seq,
                body_object_id: reserved.body_object_id.clone(),
                body_ciphertext_sha256: body_metadata.ciphertext_sha256.clone(),
                body_size_bytes: body_metadata.size_bytes,
                referenced_object_ids: referenced_object_ids.clone(),
                signature,
            })
            .await?;
        apply_publish_success(
            input.conn,
            input.vault_id,
            &published,
            plan_kind,
            &parents,
            &tree_id,
            &tree_entries,
            &plan,
            vault.next_device_seq,
            input.now_ms,
        )?;

        Ok(PushLocalChangesResult {
            published: true,
            commit_id: Some(commit_id),
            commit_kind: Some(plan_kind),
            uploaded_object_ids: uploaded
                .into_iter()
                .map(|object| object.object_id)
                .collect(),
            file_op_count: plan.file_ops.len(),
            idempotent: published.idempotent,
        })
    }

    pub async fn push_merge_commit(
        &self,
        input: PushMergeCommitInput<'_>,
    ) -> SyncResult<PushLocalChangesResult> {
        validate_push_merge_input(&input)?;
        let head = self.commit_api.get_head(input.workspace_id).await?;
        let vault = ensure_merge_vault_record(&input, &head)?;
        let expected_head = head.current_head_commit_id.clone();
        ensure_merge_parent_can_push(&vault, &expected_head, input.local_parent_commit_id)?;

        let scanned_files = scan_vault(input.vault_root)?;
        let scan_inputs = scanned_files
            .iter()
            .map(ScannedFile::file_input)
            .collect::<Vec<_>>();
        let scan_result = db::apply_scan(input.conn, &scan_inputs, input.now_ms)?;
        let mut plan = plan_incremental(&scan_result, &scanned_files, &self.planner_config)?;
        plan.commit_kind = CommitPlanKind::Merge;
        if plan.is_empty() {
            return Ok(PushLocalChangesResult {
                published: false,
                commit_id: None,
                commit_kind: None,
                uploaded_object_ids: Vec::new(),
                file_op_count: 0,
                idempotent: false,
            });
        }

        let parents = vec![
            expected_head.clone(),
            input.local_parent_commit_id.to_string(),
        ];
        let plan_kind = CommitPlanKind::Merge;
        let reserved = self
            .reserve_commit_objects(input.workspace_id, input.device_id, &plan)
            .await?;
        let mut referenced_object_ids = reserved
            .pack_object_ids
            .values()
            .cloned()
            .collect::<Vec<_>>();
        referenced_object_ids.sort();

        let tree_entries = materialize_tree_entries(input.conn, &expected_head, &plan, &reserved)?;
        let tree_id = tree_id_for_entries(&tree_entries)?;
        let changes = commit_body_file_ops(&plan, &reserved)?;
        let commit_kind = commit_kind_label(plan_kind);
        let commit_id = commit_id_for(&CommitIdentity {
            workspace_id: input.workspace_id,
            author_device_id: input.device_id,
            device_seq: vault.next_device_seq,
            commit_kind,
            expected_head_commit_id: &expected_head,
            parent_commit_ids: &parents,
            body_object_id: &reserved.body_object_id,
            referenced_object_ids: &referenced_object_ids,
            tree_id: &tree_id,
            changes: &changes,
        })?;

        let commit_body = CommitBody {
            format: "kuku.sync.commit-body".into(),
            version: 1,
            commit_id: commit_id.clone(),
            commit_kind: commit_kind.into(),
            parent_commit_ids: parents.clone(),
            tree_id: tree_id.clone(),
            changes,
            packs: commit_body_pack_refs(&plan, &reserved),
        };
        let uploads = encrypted_uploads(
            input.workspace_key,
            input.workspace_id,
            &commit_id,
            commit_kind,
            &parents,
            input.device_id,
            vault.next_device_seq,
            &reserved,
            &plan,
            &commit_body,
        )?;
        let uploaded = self
            .transfer_queue
            .upload_reserved_objects(
                input.workspace_id,
                input.device_id,
                &format!("upload_{commit_id}"),
                uploads,
            )
            .await?;
        let body_metadata = uploaded
            .iter()
            .find(|object| object.object_id == reserved.body_object_id)
            .ok_or_else(|| SyncError::Transport("commit body upload metadata missing".into()))?;
        let signature_payload = CommitSignaturePayload::new(
            input.workspace_id,
            &commit_id,
            commit_kind,
            &expected_head,
            parents.clone(),
            input.device_id,
            vault.next_device_seq,
            &reserved.body_object_id,
            &body_metadata.ciphertext_sha256,
            body_metadata.size_bytes,
            referenced_object_ids.clone(),
        );
        let signature = sign_commit_payload(input.signing_key, &signature_payload)?;
        let published = self
            .commit_api
            .publish_commit(PublishCommitInput {
                workspace_id: input.workspace_id.into(),
                commit_id: commit_id.clone(),
                commit_kind: proto_commit_kind(plan_kind),
                expected_head_commit_id: expected_head.clone(),
                parent_commit_ids: parents.clone(),
                author_device_id: input.device_id.into(),
                device_seq: vault.next_device_seq,
                body_object_id: reserved.body_object_id.clone(),
                body_ciphertext_sha256: body_metadata.ciphertext_sha256.clone(),
                body_size_bytes: body_metadata.size_bytes,
                referenced_object_ids: referenced_object_ids.clone(),
                signature,
            })
            .await?;
        apply_publish_success(
            input.conn,
            input.vault_id,
            &published,
            plan_kind,
            &parents,
            &tree_id,
            &tree_entries,
            &plan,
            vault.next_device_seq,
            input.now_ms,
        )?;

        Ok(PushLocalChangesResult {
            published: true,
            commit_id: Some(commit_id),
            commit_kind: Some(plan_kind),
            uploaded_object_ids: uploaded
                .into_iter()
                .map(|object| object.object_id)
                .collect(),
            file_op_count: plan.file_ops.len(),
            idempotent: published.idempotent,
        })
    }

    async fn reserve_commit_objects(
        &self,
        workspace_id: &str,
        device_id: &str,
        plan: &SyncPlan,
    ) -> SyncResult<ReservedCommitObjects> {
        let mut requests = plan
            .pack_shards
            .iter()
            .map(|shard| {
                Ok(ObjectReservationInput {
                    client_object_ref: shard.pack_ref.clone(),
                    kind: object_kind_for_pack_kind(&shard.pack_kind)?,
                })
            })
            .collect::<SyncResult<Vec<_>>>()?;
        requests.push(ObjectReservationInput {
            client_object_ref: "commit-body".into(),
            kind: SyncObjectKind::SYNC_OBJECT_KIND_COMMIT_BODY,
        });

        let reserved = self
            .transfer_api
            .reserve_object_ids(workspace_id, device_id, requests)
            .await?;
        reserved_commit_objects(reserved)
    }
}

pub fn should_create_checkpoint(input: CheckpointTriggerInput) -> bool {
    if input.force {
        return true;
    }
    if input.commits_since_checkpoint >= CHECKPOINT_COMMIT_INTERVAL {
        return true;
    }
    if input.incremental_encrypted_bytes_since_checkpoint >= CHECKPOINT_INCREMENTAL_BYTES_INTERVAL {
        return true;
    }
    input
        .last_checkpoint_at_ms
        .is_some_and(|last| input.now_ms.saturating_sub(last) >= CHECKPOINT_WALL_CLOCK_INTERVAL_MS)
}

pub fn plan_initial_checkpoint(
    scanned_files: &[ScannedFile],
    config: &PlannerConfig,
) -> SyncResult<SyncPlan> {
    plan_checkpoint(scanned_files, config)
}

fn validate_push_input(input: &PushLocalChangesInput<'_>) -> SyncResult<()> {
    validate_required(input.vault_id, "vault_id")?;
    validate_required(input.workspace_id, "workspace_id")?;
    validate_required(input.device_id, "device_id")?;
    Ok(())
}

fn validate_push_merge_input(input: &PushMergeCommitInput<'_>) -> SyncResult<()> {
    validate_required(input.vault_id, "vault_id")?;
    validate_required(input.workspace_id, "workspace_id")?;
    validate_required(input.device_id, "device_id")?;
    validate_required(input.local_parent_commit_id, "local_parent_commit_id")?;
    Ok(())
}

fn ensure_vault_record(
    input: &PushLocalChangesInput<'_>,
    head: &SyncHead,
) -> SyncResult<SyncVaultRecord> {
    let existing = get_vault(input.conn, input.vault_id)?;
    let mut vault = existing.unwrap_or_else(|| SyncVaultRecord {
        vault_id: input.vault_id.into(),
        root_path: input.vault_root.to_string_lossy().to_string(),
        remote_workspace_id: input.workspace_id.into(),
        remote_head_commit_id: empty_to_none(&head.current_head_commit_id),
        local_head_commit_id: empty_to_none(&head.current_head_commit_id),
        device_id: input.device_id.into(),
        next_device_seq: 1,
        enabled: true,
        created_at_ms: input.now_ms,
        updated_at_ms: input.now_ms,
    });
    vault.root_path = input.vault_root.to_string_lossy().to_string();
    vault.remote_workspace_id = input.workspace_id.into();
    vault.device_id = input.device_id.into();
    vault.enabled = true;
    vault.updated_at_ms = input.now_ms;
    if vault.next_device_seq <= 0 {
        vault.next_device_seq = 1;
    }
    upsert_vault(input.conn, &vault)?;
    Ok(vault)
}

fn ensure_merge_vault_record(
    input: &PushMergeCommitInput<'_>,
    head: &SyncHead,
) -> SyncResult<SyncVaultRecord> {
    let existing = get_vault(input.conn, input.vault_id)?;
    let mut vault = existing.unwrap_or_else(|| SyncVaultRecord {
        vault_id: input.vault_id.into(),
        root_path: input.vault_root.to_string_lossy().to_string(),
        remote_workspace_id: input.workspace_id.into(),
        remote_head_commit_id: empty_to_none(&head.current_head_commit_id),
        local_head_commit_id: empty_to_none(&head.current_head_commit_id),
        device_id: input.device_id.into(),
        next_device_seq: 1,
        enabled: true,
        created_at_ms: input.now_ms,
        updated_at_ms: input.now_ms,
    });
    vault.root_path = input.vault_root.to_string_lossy().to_string();
    vault.remote_workspace_id = input.workspace_id.into();
    vault.remote_head_commit_id = empty_to_none(&head.current_head_commit_id);
    vault.device_id = input.device_id.into();
    vault.enabled = true;
    vault.updated_at_ms = input.now_ms;
    if vault.next_device_seq <= 0 {
        vault.next_device_seq = 1;
    }
    upsert_vault(input.conn, &vault)?;
    Ok(vault)
}

fn ensure_local_head_can_push(vault: &SyncVaultRecord, remote_head: &str) -> SyncResult<()> {
    let local_head = vault.local_head_commit_id.as_deref().unwrap_or_default();
    if !remote_head.is_empty() && local_head != remote_head {
        return Err(SyncError::Transport(format!(
            "remote head {remote_head} is not present locally; pull is required before push"
        )));
    }
    Ok(())
}

fn ensure_merge_parent_can_push(
    vault: &SyncVaultRecord,
    remote_head: &str,
    local_parent_commit_id: &str,
) -> SyncResult<()> {
    if remote_head.is_empty() {
        return Err(SyncError::InvalidArgument(
            "merge commit requires a remote head".into(),
        ));
    }
    if remote_head == local_parent_commit_id {
        return Err(SyncError::InvalidArgument(
            "merge commit requires a distinct local parent".into(),
        ));
    }
    ensure_local_head_can_push(vault, remote_head)
}

fn parent_ids(expected_head: &str) -> Vec<String> {
    if expected_head.is_empty() {
        Vec::new()
    } else {
        vec![expected_head.into()]
    }
}

fn reserved_commit_objects(reserved: Vec<ReservedObject>) -> SyncResult<ReservedCommitObjects> {
    let mut body_object_id = None;
    let mut pack_object_ids = BTreeMap::new();
    for object in reserved {
        if object.client_object_ref == "commit-body" {
            body_object_id = Some(object.object_id);
            continue;
        }
        pack_object_ids.insert(object.client_object_ref, object.object_id);
    }
    Ok(ReservedCommitObjects {
        body_object_id: body_object_id
            .ok_or_else(|| SyncError::Transport("missing reserved commit body object".into()))?,
        pack_object_ids,
    })
}

fn materialize_tree_entries(
    conn: &Connection,
    expected_head: &str,
    plan: &SyncPlan,
    reserved: &ReservedCommitObjects,
) -> SyncResult<Vec<SyncTreeEntryRecord>> {
    let mut by_file_id = if expected_head.is_empty() {
        BTreeMap::new()
    } else {
        list_tree_entries(conn, expected_head)?
            .into_iter()
            .map(|entry| (entry.file_id.clone(), entry))
            .collect::<BTreeMap<_, _>>()
    };
    for op in &plan.file_ops {
        match op {
            PlanFileOp::Upsert {
                file_id,
                normalized_path,
                plaintext_hash,
                pack_ref,
                pack_entry_id,
                ..
            } => {
                let object_id = reserved.pack_object_ids.get(pack_ref).ok_or_else(|| {
                    SyncError::Transport(format!("missing reserved pack object for {pack_ref}"))
                })?;
                by_file_id.insert(
                    file_id.clone(),
                    SyncTreeEntryRecord {
                        commit_id: String::new(),
                        file_id: file_id.clone(),
                        normalized_path: normalized_path.clone(),
                        plaintext_hash: Some(plaintext_hash.clone()),
                        content_object_id: Some(object_id.clone()),
                        pack_entry_id: Some(pack_entry_id.clone()),
                        kind: "markdown".into(),
                    },
                );
            }
            PlanFileOp::Delete { file_id, .. } => {
                by_file_id.remove(file_id);
            }
        }
    }
    let mut entries = by_file_id.into_values().collect::<Vec<_>>();
    entries.sort_by(|left, right| left.normalized_path.cmp(&right.normalized_path));
    Ok(entries)
}

fn tree_id_for_entries(entries: &[SyncTreeEntryRecord]) -> SyncResult<String> {
    let body = entries
        .iter()
        .map(|entry| TreeCacheEntryBody {
            file_id: &entry.file_id,
            normalized_path: &entry.normalized_path,
            plaintext_hash: entry.plaintext_hash.as_deref(),
            content_object_id: entry.content_object_id.as_deref(),
            pack_entry_id: entry.pack_entry_id.as_deref(),
            kind: &entry.kind,
        })
        .collect::<Vec<_>>();
    let json = serde_json::to_vec(&body)?;
    let hash = blake3::hash(&json).to_hex().to_string();
    Ok(format!("tree_{}", &hash[..32]))
}

fn commit_body_file_ops(
    plan: &SyncPlan,
    reserved: &ReservedCommitObjects,
) -> SyncResult<Vec<CommitBodyFileOp>> {
    plan.file_ops
        .iter()
        .map(|op| match op {
            PlanFileOp::Upsert {
                file_id,
                path,
                normalized_path,
                plaintext_hash,
                size_bytes,
                pack_ref,
                pack_entry_id,
            } => {
                let object_id = reserved.pack_object_ids.get(pack_ref).ok_or_else(|| {
                    SyncError::Transport(format!("missing reserved pack object for {pack_ref}"))
                })?;
                Ok(CommitBodyFileOp::UpsertFile {
                    file_id: file_id.clone(),
                    path: path.clone(),
                    normalized_path: normalized_path.clone(),
                    plaintext_hash: plaintext_hash.clone(),
                    size_bytes: *size_bytes,
                    content_ref: CommitBodyContentRef {
                        object_id: object_id.clone(),
                        entry_id: pack_entry_id.clone(),
                    },
                })
            }
            PlanFileOp::Delete {
                file_id,
                path,
                normalized_path,
            } => Ok(CommitBodyFileOp::DeleteFile {
                file_id: file_id.clone(),
                path: path.clone(),
                normalized_path: normalized_path.clone(),
            }),
        })
        .collect()
}

fn commit_body_pack_refs(
    plan: &SyncPlan,
    reserved: &ReservedCommitObjects,
) -> Vec<CommitBodyPackRef> {
    plan.pack_shards
        .iter()
        .filter_map(|shard| {
            reserved
                .pack_object_ids
                .get(&shard.pack_ref)
                .map(|object_id| CommitBodyPackRef {
                    pack_ref: shard.pack_ref.clone(),
                    object_id: object_id.clone(),
                    pack_kind: shard.pack_kind.clone(),
                    shard_index: shard.shard_index,
                    entry_count: shard.entries.len(),
                })
        })
        .collect()
}

fn commit_id_for(identity: &CommitIdentity<'_>) -> SyncResult<String> {
    let json = serde_json::to_vec(identity)?;
    let hash = blake3::hash(&json).to_hex().to_string();
    Ok(format!("commit_{}", &hash[..32]))
}

#[allow(clippy::too_many_arguments)]
fn encrypted_uploads(
    workspace_key: &SymmetricKey,
    workspace_id: &str,
    commit_id: &str,
    commit_kind: &str,
    parents: &[String],
    device_id: &str,
    device_seq: i64,
    reserved: &ReservedCommitObjects,
    plan: &SyncPlan,
    commit_body: &CommitBody,
) -> SyncResult<Vec<ReservedEncryptedUploadObject>> {
    let mut uploads = Vec::with_capacity(plan.pack_shards.len() + 1);
    for shard in &plan.pack_shards {
        let object_id = reserved
            .pack_object_ids
            .get(&shard.pack_ref)
            .ok_or_else(|| {
                SyncError::Transport(format!(
                    "missing reserved pack object for {}",
                    shard.pack_ref
                ))
            })?;
        let encrypted = encrypt_pack(
            workspace_key,
            workspace_id,
            object_id,
            &shard.pack_kind,
            commit_id,
            shard.pack_entries(),
        )?;
        uploads.push(ReservedEncryptedUploadObject {
            object_id: object_id.clone(),
            kind: object_kind_for_pack_kind(&shard.pack_kind)?,
            ciphertext: encrypted.blob,
        });
    }
    let commit_key = keys::commit_body_key(workspace_key, workspace_id);
    let aad = CommitBodyAad::new(
        workspace_id,
        commit_id,
        commit_kind,
        parents.to_vec(),
        device_id,
        device_seq,
        &reserved.body_object_id,
    );
    let body_plaintext = serde_json::to_vec(commit_body)?;
    let body_blob = encrypt_commit_body(&commit_key, &aad, &body_plaintext)?;
    uploads.push(ReservedEncryptedUploadObject {
        object_id: reserved.body_object_id.clone(),
        kind: SyncObjectKind::SYNC_OBJECT_KIND_COMMIT_BODY,
        ciphertext: body_blob,
    });
    Ok(uploads)
}

#[allow(clippy::too_many_arguments)]
fn apply_publish_success(
    conn: &mut Connection,
    vault_id: &str,
    published: &PublishedCommit,
    plan_kind: CommitPlanKind,
    parents: &[String],
    tree_id: &str,
    tree_entries: &[SyncTreeEntryRecord],
    plan: &SyncPlan,
    device_seq: i64,
    now_ms: i64,
) -> SyncResult<()> {
    let mut entries = tree_entries.to_vec();
    for entry in &mut entries {
        if entry.commit_id.is_empty() {
            entry.commit_id = published.commit_id.clone();
        }
    }
    let tree_json = tree_json_for_entries(&entries)?;
    persist_tree_cache(
        conn,
        &published.commit_id,
        tree_id,
        &tree_json,
        "local",
        &entries,
        now_ms,
    )?;
    let changed_file_ids = changed_file_ids(plan);
    mark_files_synced(conn, &published.commit_id, &changed_file_ids)?;
    upsert_local_commit(
        conn,
        &SyncCommitRecord {
            commit_id: published.commit_id.clone(),
            parent_commit_ids_json: serde_json::to_string(parents)?,
            commit_kind: commit_kind_label(plan_kind).into(),
            direction: "local".into(),
            status: "published".into(),
            created_at_ms: now_ms,
            applied_at_ms: Some(now_ms),
            error: None,
        },
    )?;
    update_vault_after_publish(conn, vault_id, &published.commit_id, device_seq + 1, now_ms)
}

fn tree_json_for_entries(entries: &[SyncTreeEntryRecord]) -> SyncResult<String> {
    let body = entries
        .iter()
        .map(|entry| TreeCacheEntryBody {
            file_id: &entry.file_id,
            normalized_path: &entry.normalized_path,
            plaintext_hash: entry.plaintext_hash.as_deref(),
            content_object_id: entry.content_object_id.as_deref(),
            pack_entry_id: entry.pack_entry_id.as_deref(),
            kind: &entry.kind,
        })
        .collect::<Vec<_>>();
    serde_json::to_string(&body).map_err(Into::into)
}

fn changed_file_ids(plan: &SyncPlan) -> Vec<String> {
    let mut seen = BTreeSet::new();
    for op in &plan.file_ops {
        match op {
            PlanFileOp::Upsert { file_id, .. } | PlanFileOp::Delete { file_id, .. } => {
                seen.insert(file_id.clone());
            }
        }
    }
    seen.into_iter().collect()
}

fn object_kind_for_pack_kind(pack_kind: &str) -> SyncResult<SyncObjectKind> {
    match pack_kind {
        CONTENT_PACK_KIND => Ok(SyncObjectKind::SYNC_OBJECT_KIND_CONTENT_PACK),
        CHECKPOINT_PACK_KIND => Ok(SyncObjectKind::SYNC_OBJECT_KIND_CHECKPOINT_PACK),
        _ => Err(SyncError::InvalidArgument(format!(
            "unsupported sync pack kind: {pack_kind}"
        ))),
    }
}

fn proto_commit_kind(plan_kind: CommitPlanKind) -> SyncCommitKind {
    match plan_kind {
        CommitPlanKind::Checkpoint => SyncCommitKind::SYNC_COMMIT_KIND_CHECKPOINT,
        CommitPlanKind::Incremental => SyncCommitKind::SYNC_COMMIT_KIND_INCREMENTAL,
        CommitPlanKind::Merge => SyncCommitKind::SYNC_COMMIT_KIND_MERGE,
    }
}

fn commit_kind_label(plan_kind: CommitPlanKind) -> &'static str {
    match plan_kind {
        CommitPlanKind::Checkpoint => "checkpoint",
        CommitPlanKind::Incremental => "incremental",
        CommitPlanKind::Merge => "merge",
    }
}

fn empty_to_none(value: &str) -> Option<String> {
    if value.is_empty() {
        None
    } else {
        Some(value.into())
    }
}

fn validate_required(value: &str, field: &str) -> SyncResult<()> {
    if value.trim().is_empty() {
        return Err(SyncError::InvalidArgument(format!("{field} is required")));
    }
    Ok(())
}

fn _body_metadata_for_test(bytes: &[u8]) -> (String, i64) {
    let metadata = encrypted_blob_metadata(bytes);
    (metadata.ciphertext_sha256, metadata.size_bytes)
}

#[cfg(test)]
mod tests {
    use std::future::Future;
    use std::io::Write;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    use async_trait::async_trait;
    use parking_lot::Mutex;
    use sha2::{Digest, Sha256};
    use tokio::runtime::Builder;

    use super::super::client::{
        CompletedObjectUploadDescriptor, ListCommitsOutput, ObjectDownloadTargetDescriptor,
        ObjectUploadCompletion, ObjectUploadDescriptor, ObjectUploadTargetDescriptor,
        UploadedObjectMetadata,
    };
    use super::super::transfer::{
        ObjectGetRequest, ObjectGetResponse, ObjectHttpError, ObjectPutRequest, ObjectPutResponse,
        ObjectTransferHttp, TransferQueueConfig,
    };
    use super::*;

    #[test]
    fn checkpoint_trigger_uses_count_bytes_time_or_force() {
        assert!(should_create_checkpoint(CheckpointTriggerInput {
            commits_since_checkpoint: CHECKPOINT_COMMIT_INTERVAL,
            incremental_encrypted_bytes_since_checkpoint: 0,
            now_ms: 0,
            last_checkpoint_at_ms: None,
            force: false,
        }));
        assert!(should_create_checkpoint(CheckpointTriggerInput {
            commits_since_checkpoint: 0,
            incremental_encrypted_bytes_since_checkpoint: CHECKPOINT_INCREMENTAL_BYTES_INTERVAL,
            now_ms: 0,
            last_checkpoint_at_ms: None,
            force: false,
        }));
        assert!(should_create_checkpoint(CheckpointTriggerInput {
            commits_since_checkpoint: 0,
            incremental_encrypted_bytes_since_checkpoint: 0,
            now_ms: CHECKPOINT_WALL_CLOCK_INTERVAL_MS,
            last_checkpoint_at_ms: Some(0),
            force: false,
        }));
        assert!(should_create_checkpoint(CheckpointTriggerInput {
            commits_since_checkpoint: 0,
            incremental_encrypted_bytes_since_checkpoint: 0,
            now_ms: 0,
            last_checkpoint_at_ms: None,
            force: true,
        }));
    }

    #[test]
    fn push_pipeline_publishes_initial_checkpoint_and_updates_local_index() {
        let root = temp_vault("initial-checkpoint");
        write_file(&root.join("a.md"), b"# A");
        let mut conn = db::open_memory_sync_db().unwrap();
        let fake = Arc::new(FakeSyncApi::default());
        let http = Arc::new(FakeObjectHttp::default());
        let pipeline = pipeline(fake.clone(), http.clone());

        let result = block_on(pipeline.push_local_changes(input(&mut conn, &root))).unwrap();

        assert!(result.published);
        assert_eq!(result.commit_kind, Some(CommitPlanKind::Checkpoint));
        assert_eq!(fake.inner.lock().publish_calls, 1);
        assert!(
            fake.inner
                .lock()
                .published_kinds
                .contains(&SyncCommitKind::SYNC_COMMIT_KIND_CHECKPOINT)
        );
        assert_eq!(http.inner.lock().put_bodies.len(), 2);
        let vault = db::get_vault(&conn, "vault_1").unwrap().unwrap();
        assert_eq!(vault.local_head_commit_id, result.commit_id);
        assert_eq!(vault.next_device_seq, 2);
        assert!(db::list_dirty_files(&conn).unwrap().is_empty());
        let entries =
            db::list_tree_entries(&conn, vault.local_head_commit_id.as_deref().unwrap()).unwrap();
        assert_eq!(entries.len(), 1);

        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn push_pipeline_publishes_incremental_content_pack() {
        let root = temp_vault("incremental");
        write_file(&root.join("a.md"), b"# A");
        let mut conn = db::open_memory_sync_db().unwrap();
        let fake = Arc::new(FakeSyncApi::default());
        let http = Arc::new(FakeObjectHttp::default());
        let pipeline = pipeline(fake.clone(), http);
        let initial = block_on(pipeline.push_local_changes(input(&mut conn, &root))).unwrap();
        write_file(&root.join("a.md"), b"# A changed");

        let result = block_on(pipeline.push_local_changes(input(&mut conn, &root))).unwrap();

        assert!(result.published);
        assert_ne!(result.commit_id, initial.commit_id);
        assert_eq!(result.commit_kind, Some(CommitPlanKind::Incremental));
        let inner = fake.inner.lock();
        assert_eq!(inner.publish_calls, 2);
        assert!(
            inner
                .published_kinds
                .contains(&SyncCommitKind::SYNC_COMMIT_KIND_INCREMENTAL)
        );
        drop(inner);
        let vault = db::get_vault(&conn, "vault_1").unwrap().unwrap();
        assert_eq!(vault.local_head_commit_id, result.commit_id);
        assert_eq!(vault.next_device_seq, 3);
        assert!(db::list_dirty_files(&conn).unwrap().is_empty());

        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn push_pipeline_publishes_merge_commit_with_two_parents() {
        let root = temp_vault("merge");
        write_file(&root.join("a.md"), b"# A");
        let mut conn = db::open_memory_sync_db().unwrap();
        let fake = Arc::new(FakeSyncApi::default());
        let http = Arc::new(FakeObjectHttp::default());
        let pipeline = pipeline(fake.clone(), http);
        let initial = block_on(pipeline.push_local_changes(input(&mut conn, &root))).unwrap();
        let local_parent = initial.commit_id.as_deref().unwrap().to_string();
        let remote_head = "remote_head_1".to_string();
        let mut remote_entries = db::list_tree_entries(&conn, &local_parent).unwrap();
        for entry in &mut remote_entries {
            entry.commit_id = remote_head.clone();
        }
        let remote_tree_id = tree_id_for_entries(&remote_entries).unwrap();
        let remote_tree_json = tree_json_for_entries(&remote_entries).unwrap();
        db::persist_tree_cache(
            &mut conn,
            &remote_head,
            &remote_tree_id,
            &remote_tree_json,
            "remote",
            &remote_entries,
            2,
        )
        .unwrap();
        db::update_vault_after_pull(&conn, "vault_1", &remote_head, 2).unwrap();
        fake.inner.lock().head = remote_head.clone();
        write_file(&root.join("a.md"), b"# A local");

        let result =
            block_on(pipeline.push_merge_commit(merge_input(&mut conn, &root, &local_parent)))
                .unwrap();

        assert!(result.published);
        assert_eq!(result.commit_kind, Some(CommitPlanKind::Merge));
        let inner = fake.inner.lock();
        assert_eq!(inner.publish_calls, 2);
        assert!(
            inner
                .published_kinds
                .contains(&SyncCommitKind::SYNC_COMMIT_KIND_MERGE)
        );
        assert_eq!(
            inner.published_parents.last().unwrap(),
            &vec![remote_head.clone(), local_parent]
        );
        drop(inner);
        let vault = db::get_vault(&conn, "vault_1").unwrap().unwrap();
        assert_eq!(vault.local_head_commit_id, result.commit_id);
        assert_eq!(vault.next_device_seq, 3);
        assert!(db::list_dirty_files(&conn).unwrap().is_empty());

        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn push_pipeline_publishes_delete_tombstone() {
        let root = temp_vault("delete");
        let path = root.join("a.md");
        write_file(&path, b"# A");
        let mut conn = db::open_memory_sync_db().unwrap();
        let fake = Arc::new(FakeSyncApi::default());
        let http = Arc::new(FakeObjectHttp::default());
        let pipeline = pipeline(fake.clone(), http);
        block_on(pipeline.push_local_changes(input(&mut conn, &root))).unwrap();
        std::fs::remove_file(path).unwrap();

        let result = block_on(pipeline.push_local_changes(input(&mut conn, &root))).unwrap();

        assert!(result.published);
        assert_eq!(result.commit_kind, Some(CommitPlanKind::Incremental));
        assert_eq!(result.file_op_count, 1);
        let vault = db::get_vault(&conn, "vault_1").unwrap().unwrap();
        let entries =
            db::list_tree_entries(&conn, vault.local_head_commit_id.as_deref().unwrap()).unwrap();
        assert!(entries.is_empty());
        assert!(db::list_dirty_files(&conn).unwrap().is_empty());

        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn push_pipeline_does_not_publish_when_upload_fails() {
        let root = temp_vault("partial-upload");
        write_file(&root.join("a.md"), b"# A");
        let mut conn = db::open_memory_sync_db().unwrap();
        let fake = Arc::new(FakeSyncApi::default());
        let http = Arc::new(FakeObjectHttp::default());
        http.fail_next_put(ObjectHttpError::Status {
            status: 400,
            body: "bad upload".into(),
        });
        let pipeline = pipeline(fake.clone(), http);

        let err = block_on(pipeline.push_local_changes(input(&mut conn, &root))).unwrap_err();

        assert!(matches!(err, SyncError::Transport(message) if message.contains("400")));
        assert_eq!(fake.inner.lock().publish_calls, 0);
        assert!(
            db::get_vault(&conn, "vault_1")
                .unwrap()
                .unwrap()
                .local_head_commit_id
                .is_none()
        );
        assert!(!db::list_dirty_files(&conn).unwrap().is_empty());

        std::fs::remove_dir_all(root).unwrap();
    }

    fn pipeline(api: Arc<FakeSyncApi>, http: Arc<FakeObjectHttp>) -> SyncPushPipeline {
        let transfer_queue = ObjectTransferQueue::new(
            api.clone(),
            http,
            TransferQueueConfig {
                max_upload_concurrency: 4,
                max_download_concurrency: 4,
                max_attempts: 1,
                initial_backoff: Duration::ZERO,
            },
        )
        .unwrap();
        SyncPushPipeline::new(api.clone(), api, transfer_queue, PlannerConfig::default())
    }

    fn input<'a>(conn: &'a mut Connection, root: &'a Path) -> PushLocalChangesInput<'a> {
        static WORKSPACE_KEY: SymmetricKey = [1u8; 32];
        PushLocalChangesInput {
            conn,
            vault_id: "vault_1",
            vault_root: root,
            workspace_id: "workspace_1",
            device_id: "device_1",
            workspace_key: &WORKSPACE_KEY,
            signing_key: Box::leak(Box::new(SigningKey::from_bytes(&[3u8; 32]))),
            now_ms: 1,
        }
    }

    fn merge_input<'a>(
        conn: &'a mut Connection,
        root: &'a Path,
        local_parent_commit_id: &'a str,
    ) -> PushMergeCommitInput<'a> {
        static WORKSPACE_KEY: SymmetricKey = [1u8; 32];
        PushMergeCommitInput {
            conn,
            vault_id: "vault_1",
            vault_root: root,
            workspace_id: "workspace_1",
            device_id: "device_1",
            workspace_key: &WORKSPACE_KEY,
            signing_key: Box::leak(Box::new(SigningKey::from_bytes(&[3u8; 32]))),
            local_parent_commit_id,
            now_ms: 2,
        }
    }

    fn block_on<T>(future: impl Future<Output = T>) -> T {
        Builder::new_current_thread()
            .enable_time()
            .build()
            .unwrap()
            .block_on(future)
    }

    fn temp_vault(name: &str) -> std::path::PathBuf {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "kuku-sync-push-{name}-{}-{stamp}",
            std::process::id()
        ));
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    fn write_file(path: &Path, bytes: &[u8]) {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        let mut file = std::fs::File::create(path).unwrap();
        file.write_all(bytes).unwrap();
    }

    #[derive(Default)]
    struct FakeSyncApi {
        inner: Mutex<FakeSyncApiInner>,
    }

    #[derive(Default)]
    struct FakeSyncApiInner {
        head: String,
        publish_calls: usize,
        published_kinds: Vec<SyncCommitKind>,
        published_parents: Vec<Vec<String>>,
    }

    #[async_trait]
    impl SyncCommitApi for FakeSyncApi {
        async fn get_head(&self, _workspace_id: &str) -> SyncResult<SyncHead> {
            Ok(SyncHead {
                current_head_commit_id: self.inner.lock().head.clone(),
                head_version: 0,
                latest_checkpoint_commit_id: String::new(),
            })
        }

        async fn list_commits(
            &self,
            _workspace_id: &str,
            _after_server_seq: i64,
            _page_size: i32,
        ) -> SyncResult<ListCommitsOutput> {
            Ok(ListCommitsOutput {
                commits: Vec::new(),
                has_more: false,
                next_after_server_seq: 0,
            })
        }

        async fn publish_commit(&self, input: PublishCommitInput) -> SyncResult<PublishedCommit> {
            let mut inner = self.inner.lock();
            if input.expected_head_commit_id != inner.head {
                return Err(SyncError::Transport("stale head".into()));
            }
            inner.publish_calls += 1;
            inner.published_kinds.push(input.commit_kind);
            inner.published_parents.push(input.parent_commit_ids);
            inner.head = input.commit_id.clone();
            Ok(PublishedCommit {
                commit_id: input.commit_id,
                head_version: inner.publish_calls as i64,
                idempotent: false,
            })
        }
    }

    #[async_trait]
    impl SyncTransferApi for FakeSyncApi {
        async fn reserve_object_ids(
            &self,
            _workspace_id: &str,
            _device_id: &str,
            objects: Vec<ObjectReservationInput>,
        ) -> SyncResult<Vec<ReservedObject>> {
            Ok(objects
                .into_iter()
                .map(|object| ReservedObject {
                    object_id: format!("object-{}", object.client_object_ref),
                    client_object_ref: object.client_object_ref,
                    kind: object.kind,
                })
                .collect())
        }

        async fn create_object_upload_batch(
            &self,
            _workspace_id: &str,
            _device_id: &str,
            _upload_attempt_id: &str,
            objects: Vec<ObjectUploadDescriptor>,
        ) -> SyncResult<Vec<ObjectUploadTargetDescriptor>> {
            Ok(objects
                .into_iter()
                .map(|object| ObjectUploadTargetDescriptor {
                    object_id: object.object_id.clone(),
                    put_url: format!("put://{}", object.object_id),
                    required_headers: Vec::new(),
                })
                .collect())
        }

        async fn complete_object_upload_batch(
            &self,
            _workspace_id: &str,
            _device_id: &str,
            _upload_attempt_id: &str,
            objects: Vec<CompletedObjectUploadDescriptor>,
        ) -> SyncResult<Vec<ObjectUploadCompletion>> {
            Ok(objects
                .into_iter()
                .map(|object| ObjectUploadCompletion {
                    object: Some(UploadedObjectMetadata {
                        object_id: object.object_id,
                        ciphertext_sha256: object.ciphertext_sha256,
                        size_bytes: object.size_bytes,
                    }),
                    error_reason: None,
                })
                .collect())
        }

        async fn create_object_download_batch(
            &self,
            _workspace_id: &str,
            _device_id: &str,
            _object_ids: Vec<String>,
        ) -> SyncResult<Vec<ObjectDownloadTargetDescriptor>> {
            Ok(Vec::new())
        }
    }

    #[derive(Default)]
    struct FakeObjectHttp {
        inner: Mutex<FakeObjectHttpInner>,
        fail_next_put: Mutex<Option<ObjectHttpError>>,
        in_flight: AtomicUsize,
    }

    #[derive(Default)]
    struct FakeObjectHttpInner {
        put_bodies: BTreeMap<String, Vec<u8>>,
    }

    impl FakeObjectHttp {
        fn fail_next_put(&self, error: ObjectHttpError) {
            *self.fail_next_put.lock() = Some(error);
        }
    }

    #[async_trait]
    impl ObjectTransferHttp for FakeObjectHttp {
        async fn put(
            &self,
            request: ObjectPutRequest,
        ) -> Result<ObjectPutResponse, ObjectHttpError> {
            self.in_flight.fetch_add(1, Ordering::SeqCst);
            let failure = self.fail_next_put.lock().take();
            if let Some(error) = failure {
                self.in_flight.fetch_sub(1, Ordering::SeqCst);
                return Err(error);
            }
            self.inner
                .lock()
                .put_bodies
                .insert(request.url.clone(), request.body);
            self.in_flight.fetch_sub(1, Ordering::SeqCst);
            Ok(ObjectPutResponse {
                provider_etag: Some(format!("etag-{}", request.url)),
            })
        }

        async fn get(
            &self,
            _request: ObjectGetRequest,
        ) -> Result<ObjectGetResponse, ObjectHttpError> {
            Ok(ObjectGetResponse { body: Vec::new() })
        }
    }

    fn _sha256_hex(bytes: &[u8]) -> String {
        hex::encode(Sha256::digest(bytes))
    }
}
