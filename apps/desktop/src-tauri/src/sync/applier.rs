#![allow(dead_code)]

use std::collections::{BTreeMap, BTreeSet};
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use kuku_contract::proto::kuku::sync::v1::{SyncCommitKind, SyncKeyRecipientType, SyncObjectKind};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};

use crate::search::SearchState;
use crate::vault::resolve_vault_path_strict;
use crate::vault::watcher::{ExpectedMutationLedger, ExpectedMutationToken};

use super::client::{
    ListCommitsOutput, SyncCommitApi, SyncCommitHeader, SyncHead, SyncKeyEnvelopeMetadata,
};
use super::crypto::{CommitBodyAad, SymmetricKey, decrypt_commit_body, encrypted_blob_metadata};
use super::db::{
    self, FILE_KIND_MARKDOWN, SyncCommitRecord, SyncConflictRecord, SyncFileInput, SyncFileRecord,
    SyncTreeEntryRecord, SyncVaultRecord, file_id_for_normalized_path, get_vault,
    list_tree_entries, mark_files_synced, persist_tree_cache, update_vault_after_pull,
    upsert_conflict, upsert_local_commit, upsert_vault,
};
use super::errors::{SyncError, SyncResult};
use super::keys::{self, PassphraseKeyEnvelope, WorkspaceKeySource, WrappedWorkspaceKey};
use super::merge::{MarkdownMergeOutcome, conflict_copy_relative_path, merge_markdown};
use super::packer::{UnpackedPack, decrypt_pack};
use super::planner::{CHECKPOINT_PACK_KIND, CONTENT_PACK_KIND};
use super::scanner::{normalize_vault_relative_path, scan_vault};
use super::transfer::{DownloadedObject, ObjectTransferQueue};

const LIST_COMMITS_PAGE_SIZE: i32 = 100;
const REMOTE_APPLY_SOURCE: &str = "sync-remote-apply";

#[derive(Clone)]
pub struct SyncPullPipeline {
    commit_api: Arc<dyn SyncCommitApi>,
    transfer_queue: ObjectTransferQueue,
}

pub struct PullRemoteChangesInput<'a> {
    pub conn: &'a mut Connection,
    pub vault_id: &'a str,
    pub vault_root: &'a Path,
    pub workspace_id: &'a str,
    pub device_id: &'a str,
    pub workspace_key: &'a SymmetricKey,
    pub hooks: RemoteApplyHooks<'a>,
    pub now_ms: i64,
}

#[derive(Clone, Copy, Default)]
pub struct RemoteApplyHooks<'a> {
    pub expected_mutations: Option<&'a ExpectedMutationLedger>,
    pub search: Option<&'a SearchState>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PullRemoteChangesResult {
    pub applied_commits: Vec<String>,
    pub bootstrapped_from_checkpoint: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
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

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
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

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct CommitBodyContentRef {
    object_id: String,
    entry_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
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
struct TreeCacheEntryBody<'a> {
    file_id: &'a str,
    normalized_path: &'a str,
    plaintext_hash: Option<&'a str>,
    content_object_id: Option<&'a str>,
    pack_entry_id: Option<&'a str>,
    kind: &'a str,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct DecryptedCommit {
    header: SyncCommitHeader,
    body: CommitBody,
    packs: BTreeMap<String, UnpackedPack>,
}

#[derive(Debug, Clone)]
struct ReplaySelection {
    commits: Vec<SyncCommitHeader>,
    bootstrapped_from_checkpoint: bool,
}

#[derive(Debug, Clone)]
struct RemoteMergeState {
    dirty_files: BTreeMap<String, SyncFileRecord>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct AppliedCommitState {
    synced_file_ids: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RemoteApplyAction {
    AppliedRemote,
    KeptLocalDirty,
}

impl SyncPullPipeline {
    pub fn new(commit_api: Arc<dyn SyncCommitApi>, transfer_queue: ObjectTransferQueue) -> Self {
        Self {
            commit_api,
            transfer_queue,
        }
    }

    pub async fn pull_remote_changes(
        &self,
        mut input: PullRemoteChangesInput<'_>,
    ) -> SyncResult<PullRemoteChangesResult> {
        validate_pull_input(&input)?;
        let head = self.commit_api.get_head(input.workspace_id).await?;
        let vault = ensure_pull_vault_record(&input, &head)?;
        if head.current_head_commit_id.is_empty() {
            return Ok(PullRemoteChangesResult {
                applied_commits: Vec::new(),
                bootstrapped_from_checkpoint: false,
            });
        }

        let commits = list_all_commits(self.commit_api.as_ref(), input.workspace_id).await?;
        let selection = select_replay_commits(&vault, &head, &commits)?;
        if selection.commits.is_empty() {
            return Ok(PullRemoteChangesResult {
                applied_commits: Vec::new(),
                bootstrapped_from_checkpoint: false,
            });
        }

        refresh_local_scan(input.conn, input.vault_root, input.now_ms)?;
        let merge_state = RemoteMergeState {
            dirty_files: db::list_dirty_files(input.conn)?
                .into_iter()
                .map(|file| (file.file_id.clone(), file))
                .collect(),
        };
        let mut tree_by_file_id = self
            .initial_or_rematerialized_tree_entries(&input, &vault, &commits)
            .await?;
        let mut applied = Vec::with_capacity(selection.commits.len());
        for header in selection.commits {
            let commit = self
                .decrypt_commit(
                    input.workspace_id,
                    input.device_id,
                    input.workspace_key,
                    header,
                )
                .await?;
            self.apply_decrypted_commit(&mut input, &merge_state, &commit, &mut tree_by_file_id)
                .await?;
            applied.push(commit.header.commit_id);
        }

        Ok(PullRemoteChangesResult {
            applied_commits: applied,
            bootstrapped_from_checkpoint: selection.bootstrapped_from_checkpoint,
        })
    }

    async fn decrypt_commit(
        &self,
        workspace_id: &str,
        device_id: &str,
        workspace_key: &SymmetricKey,
        header: SyncCommitHeader,
    ) -> SyncResult<DecryptedCommit> {
        let body_download = self
            .download_one(workspace_id, device_id, &header.body_object_id)
            .await?;
        validate_downloaded_commit_body(&header, &body_download)?;
        let commit_kind = commit_kind_label(header.commit_kind)?;
        let commit_key = keys::commit_body_key(workspace_key, workspace_id);
        let aad = CommitBodyAad::new(
            workspace_id,
            &header.commit_id,
            commit_kind,
            header.parent_commit_ids.clone(),
            &header.author_device_id,
            header.device_seq,
            &header.body_object_id,
        );
        let plaintext = decrypt_commit_body(&commit_key, &aad, &body_download.ciphertext)?;
        let body: CommitBody = serde_json::from_slice(&plaintext)?;
        validate_commit_body(&header, commit_kind, &body)?;

        let mut packs = BTreeMap::new();
        let pack_ids = body
            .packs
            .iter()
            .map(|pack| pack.object_id.clone())
            .collect::<Vec<_>>();
        let downloads = self
            .download_many(workspace_id, device_id, pack_ids)
            .await?;
        for pack_ref in &body.packs {
            let downloaded = downloads.get(&pack_ref.object_id).ok_or_else(|| {
                SyncError::Transport(format!(
                    "download response missing pack object {}",
                    pack_ref.object_id
                ))
            })?;
            validate_downloaded_pack(pack_ref, downloaded)?;
            let unpacked = decrypt_pack(
                workspace_key,
                workspace_id,
                &pack_ref.object_id,
                &pack_ref.pack_kind,
                &header.commit_id,
                &downloaded.ciphertext,
            )?;
            if unpacked.index.entries.len() != pack_ref.entry_count {
                return Err(SyncError::Integrity(format!(
                    "pack {} entry count mismatch",
                    pack_ref.object_id
                )));
            }
            packs.insert(pack_ref.object_id.clone(), unpacked);
        }

        Ok(DecryptedCommit {
            header,
            body,
            packs,
        })
    }

    async fn initial_or_rematerialized_tree_entries(
        &self,
        input: &PullRemoteChangesInput<'_>,
        vault: &SyncVaultRecord,
        commits: &[SyncCommitHeader],
    ) -> SyncResult<BTreeMap<String, SyncTreeEntryRecord>> {
        let local_head = vault.local_head_commit_id.as_deref().unwrap_or_default();
        let tree = initial_tree_entries(input.conn, vault)?;
        if local_head.is_empty() || !tree.is_empty() {
            return Ok(tree);
        }
        self.rematerialize_tree_entries(input, commits, local_head)
            .await
    }

    async fn rematerialize_tree_entries(
        &self,
        input: &PullRemoteChangesInput<'_>,
        commits: &[SyncCommitHeader],
        target_commit_id: &str,
    ) -> SyncResult<BTreeMap<String, SyncTreeEntryRecord>> {
        let mut tree_by_file_id = BTreeMap::new();
        for header in commits {
            let commit = self
                .decrypt_commit(
                    input.workspace_id,
                    input.device_id,
                    input.workspace_key,
                    header.clone(),
                )
                .await?;
            materialize_remote_tree_only(&commit, &mut tree_by_file_id)?;
            if commit.header.commit_id == target_commit_id {
                return Ok(tree_by_file_id);
            }
        }
        Err(SyncError::Transport(format!(
            "local head {target_commit_id} is not present in remote history"
        )))
    }

    async fn download_one(
        &self,
        workspace_id: &str,
        device_id: &str,
        object_id: &str,
    ) -> SyncResult<DownloadedObject> {
        let mut downloads = self
            .transfer_queue
            .download_objects(workspace_id, device_id, vec![object_id.to_string()])
            .await?;
        if downloads.len() != 1 {
            return Err(SyncError::Transport(format!(
                "download response for {object_id} returned {} objects",
                downloads.len()
            )));
        }
        Ok(downloads.remove(0))
    }

    async fn download_many(
        &self,
        workspace_id: &str,
        device_id: &str,
        object_ids: Vec<String>,
    ) -> SyncResult<BTreeMap<String, DownloadedObject>> {
        let downloads = self
            .transfer_queue
            .download_objects(workspace_id, device_id, object_ids)
            .await?;
        Ok(downloads
            .into_iter()
            .map(|object| (object.object_id.clone(), object))
            .collect())
    }

    async fn download_tree_entry_content(
        &self,
        input: &PullRemoteChangesInput<'_>,
        commit_id: &str,
        entry: &SyncTreeEntryRecord,
    ) -> SyncResult<Option<Vec<u8>>> {
        let (Some(object_id), Some(entry_id)) = (
            entry.content_object_id.as_deref(),
            entry.pack_entry_id.as_deref(),
        ) else {
            return Ok(None);
        };
        let object = self
            .download_one(input.workspace_id, input.device_id, object_id)
            .await?;
        let pack_kind = pack_kind_for_object_kind(object.kind)?;
        let unpacked = decrypt_pack(
            input.workspace_key,
            input.workspace_id,
            object_id,
            pack_kind,
            commit_id,
            &object.ciphertext,
        )?;
        Ok(unpacked.entries.get(entry_id).cloned())
    }

    async fn apply_decrypted_commit(
        &self,
        input: &mut PullRemoteChangesInput<'_>,
        merge_state: &RemoteMergeState,
        commit: &DecryptedCommit,
        tree_by_file_id: &mut BTreeMap<String, SyncTreeEntryRecord>,
    ) -> SyncResult<AppliedCommitState> {
        if commit.header.commit_kind == SyncCommitKind::SYNC_COMMIT_KIND_CHECKPOINT {
            tree_by_file_id.clear();
        }

        let mut synced_file_ids = Vec::new();
        for change in &commit.body.changes {
            match change {
                CommitBodyFileOp::UpsertFile {
                    file_id,
                    path,
                    normalized_path,
                    plaintext_hash,
                    size_bytes,
                    content_ref,
                } => {
                    validate_remote_file_identity(file_id, path, normalized_path)?;
                    let remote_plaintext = pack_entry_plaintext(&commit.packs, content_ref)?;
                    validate_plaintext_metadata(
                        path,
                        remote_plaintext,
                        plaintext_hash,
                        *size_bytes,
                    )?;
                    let base_entry = tree_by_file_id.get(file_id).cloned();
                    let dirty = merge_state.dirty_files.get(file_id);
                    let action = if let Some(dirty) = dirty {
                        self.merge_remote_upsert(
                            input,
                            &commit.header,
                            base_entry.as_ref(),
                            dirty,
                            path,
                            remote_plaintext,
                        )
                        .await?
                    } else {
                        apply_remote_write(input.vault_root, input.hooks, path, remote_plaintext)
                            .await?;
                        RemoteApplyAction::AppliedRemote
                    };
                    tree_by_file_id.insert(
                        file_id.clone(),
                        SyncTreeEntryRecord {
                            commit_id: commit.header.commit_id.clone(),
                            file_id: file_id.clone(),
                            normalized_path: normalized_path.clone(),
                            plaintext_hash: Some(plaintext_hash.clone()),
                            content_object_id: Some(content_ref.object_id.clone()),
                            pack_entry_id: Some(content_ref.entry_id.clone()),
                            kind: FILE_KIND_MARKDOWN.into(),
                        },
                    );
                    if action == RemoteApplyAction::AppliedRemote {
                        synced_file_ids.push(file_id.clone());
                    }
                }
                CommitBodyFileOp::DeleteFile {
                    file_id,
                    path,
                    normalized_path,
                } => {
                    validate_remote_file_identity(file_id, path, normalized_path)?;
                    let dirty = merge_state.dirty_files.get(file_id);
                    let action = self
                        .merge_remote_delete(input, &commit.header, dirty, path)
                        .await?;
                    tree_by_file_id.remove(file_id);
                    if action == RemoteApplyAction::AppliedRemote {
                        synced_file_ids.push(file_id.clone());
                    }
                }
            }
        }

        persist_applied_commit(input, commit, tree_by_file_id, &synced_file_ids)?;
        Ok(AppliedCommitState { synced_file_ids })
    }

    async fn merge_remote_upsert(
        &self,
        input: &mut PullRemoteChangesInput<'_>,
        remote_header: &SyncCommitHeader,
        base_entry: Option<&SyncTreeEntryRecord>,
        dirty: &SyncFileRecord,
        path: &str,
        remote_plaintext: &[u8],
    ) -> SyncResult<RemoteApplyAction> {
        if dirty.deleted {
            write_conflict_copy(
                input,
                path,
                remote_plaintext,
                base_entry.map(|entry| entry.commit_id.as_str()),
                remote_header,
            )
            .await?;
            return Ok(RemoteApplyAction::KeptLocalDirty);
        }

        let local_plaintext = read_local_file(input.vault_root, &dirty.path).await?;
        let Some(base_entry) = base_entry else {
            write_conflict_copy(input, path, remote_plaintext, None, remote_header).await?;
            return Ok(RemoteApplyAction::KeptLocalDirty);
        };
        let Some(base_plaintext) = self
            .download_tree_entry_content(input, &base_entry.commit_id, base_entry)
            .await?
        else {
            write_conflict_copy(
                input,
                path,
                remote_plaintext,
                Some(&base_entry.commit_id),
                remote_header,
            )
            .await?;
            return Ok(RemoteApplyAction::KeptLocalDirty);
        };

        match merge_markdown(&base_plaintext, &local_plaintext, remote_plaintext)? {
            MarkdownMergeOutcome::Merged(merged) => {
                apply_remote_write(input.vault_root, input.hooks, path, &merged).await?;
                if merged == remote_plaintext {
                    Ok(RemoteApplyAction::AppliedRemote)
                } else {
                    Ok(RemoteApplyAction::KeptLocalDirty)
                }
            }
            MarkdownMergeOutcome::Conflict => {
                write_conflict_copy(
                    input,
                    path,
                    remote_plaintext,
                    Some(&base_entry.commit_id),
                    remote_header,
                )
                .await?;
                Ok(RemoteApplyAction::KeptLocalDirty)
            }
        }
    }

    async fn merge_remote_delete(
        &self,
        input: &mut PullRemoteChangesInput<'_>,
        remote_header: &SyncCommitHeader,
        dirty: Option<&SyncFileRecord>,
        path: &str,
    ) -> SyncResult<RemoteApplyAction> {
        match dirty {
            None => {
                apply_remote_delete(input.vault_root, input.hooks, path).await?;
                Ok(RemoteApplyAction::AppliedRemote)
            }
            Some(dirty) if dirty.deleted => {
                apply_remote_delete(input.vault_root, input.hooks, path).await?;
                Ok(RemoteApplyAction::AppliedRemote)
            }
            Some(dirty) => {
                let local_plaintext = read_local_file(input.vault_root, &dirty.path).await?;
                write_conflict_copy(input, path, &local_plaintext, None, remote_header).await?;
                apply_remote_delete(input.vault_root, input.hooks, path).await?;
                Ok(RemoteApplyAction::AppliedRemote)
            }
        }
    }
}

pub fn passphrase_envelope_from_metadata(
    metadata: &SyncKeyEnvelopeMetadata,
) -> SyncResult<PassphraseKeyEnvelope> {
    if metadata.recipient_type != SyncKeyRecipientType::SYNC_KEY_RECIPIENT_TYPE_PASSPHRASE {
        return Err(SyncError::InvalidArgument(
            "sync key envelope is not passphrase-backed".into(),
        ));
    }
    Ok(PassphraseKeyEnvelope {
        workspace_id: metadata.workspace_id.clone(),
        envelope_id: metadata.envelope_id.clone(),
        recipient_type: "passphrase".into(),
        key_version: metadata.key_version,
        kdf: serde_json::from_str(&metadata.kdf_params_json)?,
        wrap: serde_json::from_slice::<WrappedWorkspaceKey>(&metadata.encrypted_envelope)?,
    })
}

pub fn unlock_workspace_key_from_envelopes(
    envelopes: &[SyncKeyEnvelopeMetadata],
    passphrase: &str,
) -> SyncResult<(SymmetricKey, WorkspaceKeySource)> {
    let metadata = envelopes
        .iter()
        .find(|envelope| {
            envelope.recipient_type == SyncKeyRecipientType::SYNC_KEY_RECIPIENT_TYPE_PASSPHRASE
        })
        .ok_or_else(|| SyncError::InvalidArgument("no passphrase key envelope found".into()))?;
    let envelope = passphrase_envelope_from_metadata(metadata)?;
    let workspace_key = keys::unwrap_workspace_key_with_passphrase(&envelope, passphrase)?;
    Ok((workspace_key, WorkspaceKeySource::Passphrase))
}

async fn list_all_commits(
    api: &dyn SyncCommitApi,
    workspace_id: &str,
) -> SyncResult<Vec<SyncCommitHeader>> {
    let mut after_server_seq = 0;
    let mut commits = Vec::new();
    loop {
        let page = api
            .list_commits(workspace_id, after_server_seq, LIST_COMMITS_PAGE_SIZE)
            .await?;
        append_commit_page(&mut commits, &page)?;
        if !page.has_more {
            break;
        }
        if page.next_after_server_seq <= after_server_seq {
            return Err(SyncError::Transport(
                "ListCommits did not advance pagination cursor".into(),
            ));
        }
        after_server_seq = page.next_after_server_seq;
    }
    Ok(commits)
}

fn append_commit_page(
    commits: &mut Vec<SyncCommitHeader>,
    page: &ListCommitsOutput,
) -> SyncResult<()> {
    for commit in &page.commits {
        if commits
            .last()
            .is_some_and(|previous| previous.server_seq >= commit.server_seq)
        {
            return Err(SyncError::Transport(
                "ListCommits returned non-increasing server_seq".into(),
            ));
        }
        commits.push(commit.clone());
    }
    Ok(())
}

fn select_replay_commits(
    vault: &SyncVaultRecord,
    head: &SyncHead,
    commits: &[SyncCommitHeader],
) -> SyncResult<ReplaySelection> {
    let local_head = vault.local_head_commit_id.as_deref().unwrap_or_default();
    if local_head == head.current_head_commit_id {
        return Ok(ReplaySelection {
            commits: Vec::new(),
            bootstrapped_from_checkpoint: false,
        });
    }

    let start_index = if local_head.is_empty() {
        if head.latest_checkpoint_commit_id.is_empty() {
            0
        } else {
            commits
                .iter()
                .position(|commit| commit.commit_id == head.latest_checkpoint_commit_id)
                .ok_or_else(|| {
                    SyncError::Transport(format!(
                        "latest checkpoint {} is missing from remote history",
                        head.latest_checkpoint_commit_id
                    ))
                })?
        }
    } else {
        commits
            .iter()
            .position(|commit| commit.commit_id == local_head)
            .map(|index| index + 1)
            .ok_or_else(|| {
                SyncError::Transport(format!(
                    "local head {local_head} is not present in remote history"
                ))
            })?
    };

    let replay = commits[start_index..].to_vec();
    if replay
        .last()
        .is_none_or(|commit| commit.commit_id != head.current_head_commit_id)
    {
        return Err(SyncError::Transport(format!(
            "remote history does not include head {}",
            head.current_head_commit_id
        )));
    }

    Ok(ReplaySelection {
        commits: replay,
        bootstrapped_from_checkpoint: local_head.is_empty()
            && !head.latest_checkpoint_commit_id.is_empty(),
    })
}

fn validate_pull_input(input: &PullRemoteChangesInput<'_>) -> SyncResult<()> {
    validate_required(input.vault_id, "vault_id")?;
    validate_required(input.workspace_id, "workspace_id")?;
    validate_required(input.device_id, "device_id")?;
    Ok(())
}

fn ensure_pull_vault_record(
    input: &PullRemoteChangesInput<'_>,
    head: &SyncHead,
) -> SyncResult<SyncVaultRecord> {
    let existing = get_vault(input.conn, input.vault_id)?;
    let mut vault = existing.unwrap_or_else(|| SyncVaultRecord {
        vault_id: input.vault_id.into(),
        root_path: input.vault_root.to_string_lossy().to_string(),
        remote_workspace_id: input.workspace_id.into(),
        remote_head_commit_id: empty_to_none(&head.current_head_commit_id),
        local_head_commit_id: None,
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

fn initial_tree_entries(
    conn: &Connection,
    vault: &SyncVaultRecord,
) -> SyncResult<BTreeMap<String, SyncTreeEntryRecord>> {
    let Some(local_head) = vault.local_head_commit_id.as_deref() else {
        return Ok(BTreeMap::new());
    };
    Ok(list_tree_entries(conn, local_head)?
        .into_iter()
        .map(|entry| (entry.file_id.clone(), entry))
        .collect())
}

fn refresh_local_scan(conn: &mut Connection, vault_root: &Path, now_ms: i64) -> SyncResult<()> {
    let scanned_files = scan_vault(vault_root)?;
    let scan_inputs = scanned_files
        .iter()
        .map(|file| file.file_input())
        .collect::<Vec<SyncFileInput>>();
    db::apply_scan(conn, &scan_inputs, now_ms)?;
    Ok(())
}

fn materialize_remote_tree_only(
    commit: &DecryptedCommit,
    tree_by_file_id: &mut BTreeMap<String, SyncTreeEntryRecord>,
) -> SyncResult<()> {
    if commit.header.commit_kind == SyncCommitKind::SYNC_COMMIT_KIND_CHECKPOINT {
        tree_by_file_id.clear();
    }
    for change in &commit.body.changes {
        match change {
            CommitBodyFileOp::UpsertFile {
                file_id,
                path,
                normalized_path,
                plaintext_hash,
                size_bytes,
                content_ref,
            } => {
                validate_remote_file_identity(file_id, path, normalized_path)?;
                let plaintext = pack_entry_plaintext(&commit.packs, content_ref)?;
                validate_plaintext_metadata(path, plaintext, plaintext_hash, *size_bytes)?;
                tree_by_file_id.insert(
                    file_id.clone(),
                    SyncTreeEntryRecord {
                        commit_id: commit.header.commit_id.clone(),
                        file_id: file_id.clone(),
                        normalized_path: normalized_path.clone(),
                        plaintext_hash: Some(plaintext_hash.clone()),
                        content_object_id: Some(content_ref.object_id.clone()),
                        pack_entry_id: Some(content_ref.entry_id.clone()),
                        kind: FILE_KIND_MARKDOWN.into(),
                    },
                );
            }
            CommitBodyFileOp::DeleteFile {
                file_id,
                path,
                normalized_path,
            } => {
                validate_remote_file_identity(file_id, path, normalized_path)?;
                tree_by_file_id.remove(file_id);
            }
        }
    }
    Ok(())
}

fn persist_applied_commit(
    input: &mut PullRemoteChangesInput<'_>,
    commit: &DecryptedCommit,
    tree_by_file_id: &BTreeMap<String, SyncTreeEntryRecord>,
    synced_file_ids: &[String],
) -> SyncResult<()> {
    let mut entries = tree_by_file_id.values().cloned().collect::<Vec<_>>();
    entries.sort_by(|left, right| left.normalized_path.cmp(&right.normalized_path));
    validate_tree_id(&commit.body.tree_id, &entries)?;
    persist_tree_cache(
        input.conn,
        &commit.header.commit_id,
        &commit.body.tree_id,
        &tree_json_for_entries(&entries)?,
        "remote",
        &entries,
        input.now_ms,
    )?;

    let scanned_files = scan_vault(input.vault_root)?;
    let scan_inputs = scanned_files
        .iter()
        .map(|file| file.file_input())
        .collect::<Vec<SyncFileInput>>();
    db::apply_scan(input.conn, &scan_inputs, input.now_ms)?;
    mark_files_synced(input.conn, &commit.header.commit_id, synced_file_ids)?;
    upsert_local_commit(
        input.conn,
        &SyncCommitRecord {
            commit_id: commit.header.commit_id.clone(),
            parent_commit_ids_json: serde_json::to_string(&commit.header.parent_commit_ids)?,
            commit_kind: commit.body.commit_kind.clone(),
            direction: "remote".into(),
            status: "applied".into(),
            created_at_ms: input.now_ms,
            applied_at_ms: Some(input.now_ms),
            error: None,
        },
    )?;
    update_vault_after_pull(
        input.conn,
        input.vault_id,
        &commit.header.commit_id,
        input.now_ms,
    )
}

async fn apply_remote_write(
    vault_root: &Path,
    hooks: RemoteApplyHooks<'_>,
    path: &str,
    plaintext: &[u8],
) -> SyncResult<()> {
    let resolved = resolve_remote_path(vault_root, path).await?;
    let token = hooks
        .expected_mutations
        .map(|ledger| ledger.record_write(path, false));
    let result = async {
        if let Some(parent) = resolved.parent() {
            tokio::fs::create_dir_all(parent).await.map_err(|error| {
                SyncError::Storage(format!("failed to create sync parent directory: {error}"))
            })?;
        }
        tokio::fs::write(&resolved, plaintext)
            .await
            .map_err(|error| {
                SyncError::Storage(format!(
                    "failed to apply remote file {}: {error}",
                    resolved.display()
                ))
            })
    }
    .await;
    finish_remote_mutation(hooks.expected_mutations, token, result)?;
    if let Some(search) = hooks.search {
        search
            .notify_written_with_source(path, REMOTE_APPLY_SOURCE)
            .map_err(SyncError::Storage)?;
    }
    Ok(())
}

async fn write_conflict_copy(
    input: &mut PullRemoteChangesInput<'_>,
    original_path: &str,
    plaintext: &[u8],
    base_commit_id: Option<&str>,
    remote_header: &SyncCommitHeader,
) -> SyncResult<String> {
    let conflict_path = conflict_copy_relative_path(original_path, input.now_ms, |candidate| {
        input.vault_root.join(candidate).exists()
    })?;
    apply_remote_write(input.vault_root, input.hooks, &conflict_path, plaintext).await?;
    upsert_conflict(
        &*input.conn,
        &SyncConflictRecord {
            conflict_id: conflict_id_for(
                original_path,
                &conflict_path,
                base_commit_id,
                &remote_header.commit_id,
                input.now_ms,
            ),
            path: original_path.into(),
            conflict_path: conflict_path.clone(),
            base_commit_id: base_commit_id.map(ToOwned::to_owned),
            local_commit_id: None,
            remote_commit_id: Some(remote_header.commit_id.clone()),
            status: "open".into(),
            created_at_ms: input.now_ms,
        },
    )?;
    Ok(conflict_path)
}

async fn read_local_file(vault_root: &Path, path: &str) -> SyncResult<Vec<u8>> {
    let resolved = resolve_remote_path(vault_root, path).await?;
    tokio::fs::read(&resolved).await.map_err(|error| {
        SyncError::Storage(format!(
            "failed to read local merge file {}: {error}",
            resolved.display()
        ))
    })
}

fn conflict_id_for(
    path: &str,
    conflict_path: &str,
    base_commit_id: Option<&str>,
    remote_commit_id: &str,
    created_at_ms: i64,
) -> String {
    let mut input = Vec::new();
    input.extend_from_slice(path.as_bytes());
    input.push(0);
    input.extend_from_slice(conflict_path.as_bytes());
    input.push(0);
    if let Some(base_commit_id) = base_commit_id {
        input.extend_from_slice(base_commit_id.as_bytes());
    }
    input.push(0);
    input.extend_from_slice(remote_commit_id.as_bytes());
    input.push(0);
    input.extend_from_slice(created_at_ms.to_string().as_bytes());
    let hash = blake3::hash(&input).to_hex().to_string();
    format!("conflict_{}", &hash[..32])
}

async fn apply_remote_delete(
    vault_root: &Path,
    hooks: RemoteApplyHooks<'_>,
    path: &str,
) -> SyncResult<()> {
    let resolved = resolve_remote_path(vault_root, path).await?;
    let existed = tokio::fs::metadata(&resolved).await.is_ok();
    let token = hooks
        .expected_mutations
        .filter(|_| existed)
        .map(|ledger| ledger.record_delete(path, false));
    let result = match tokio::fs::remove_file(&resolved).await {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
        Err(error) => Err(SyncError::Storage(format!(
            "failed to apply remote delete {}: {error}",
            resolved.display()
        ))),
    };
    finish_remote_mutation(hooks.expected_mutations, token, result)?;
    if let Some(search) = hooks.search {
        search
            .notify_removed_with_source(path, false, REMOTE_APPLY_SOURCE)
            .map_err(SyncError::Storage)?;
    }
    Ok(())
}

fn finish_remote_mutation(
    ledger: Option<&ExpectedMutationLedger>,
    token: Option<ExpectedMutationToken>,
    result: SyncResult<()>,
) -> SyncResult<()> {
    match result {
        Ok(()) => Ok(()),
        Err(error) => {
            if let (Some(ledger), Some(token)) = (ledger, token) {
                ledger.cancel(token);
            }
            Err(error)
        }
    }
}

async fn resolve_remote_path(vault_root: &Path, path: &str) -> SyncResult<PathBuf> {
    resolve_vault_path_strict(vault_root, path)
        .await
        .map_err(SyncError::InvalidArgument)
}

fn validate_commit_body(
    header: &SyncCommitHeader,
    commit_kind: &str,
    body: &CommitBody,
) -> SyncResult<()> {
    if body.format != "kuku.sync.commit-body" {
        return Err(SyncError::Serialization(
            "unsupported sync commit body format".into(),
        ));
    }
    if body.version != 1 {
        return Err(SyncError::UnsupportedVersion(body.version));
    }
    if body.commit_id != header.commit_id {
        return Err(SyncError::Integrity("commit body id mismatch".into()));
    }
    if body.commit_kind != commit_kind {
        return Err(SyncError::Integrity("commit body kind mismatch".into()));
    }
    if body.parent_commit_ids != header.parent_commit_ids {
        return Err(SyncError::Integrity("commit body parents mismatch".into()));
    }
    let mut body_pack_ids = body
        .packs
        .iter()
        .map(|pack| pack.object_id.clone())
        .collect::<Vec<_>>();
    body_pack_ids.sort();
    let mut referenced_object_ids = header.referenced_object_ids.clone();
    referenced_object_ids.sort();
    if body_pack_ids != referenced_object_ids {
        return Err(SyncError::Integrity(
            "commit body referenced objects mismatch".into(),
        ));
    }
    validate_packs(body)?;
    Ok(())
}

fn validate_packs(body: &CommitBody) -> SyncResult<()> {
    let mut seen = BTreeSet::new();
    for pack in &body.packs {
        validate_required(&pack.object_id, "pack.object_id")?;
        if !seen.insert(pack.object_id.clone()) {
            return Err(SyncError::Integrity(format!(
                "duplicate pack object in commit body: {}",
                pack.object_id
            )));
        }
        object_kind_for_pack_kind(&pack.pack_kind)?;
    }
    Ok(())
}

fn validate_downloaded_commit_body(
    header: &SyncCommitHeader,
    object: &DownloadedObject,
) -> SyncResult<()> {
    if object.object_id != header.body_object_id {
        return Err(SyncError::Integrity(
            "commit body object id mismatch".into(),
        ));
    }
    if object.kind != SyncObjectKind::SYNC_OBJECT_KIND_COMMIT_BODY {
        return Err(SyncError::Integrity(
            "commit body object kind mismatch".into(),
        ));
    }
    if object.ciphertext_sha256 != header.body_ciphertext_sha256 {
        return Err(SyncError::Integrity(
            "commit body ciphertext hash mismatch".into(),
        ));
    }
    let metadata = encrypted_blob_metadata(&object.ciphertext);
    if metadata.size_bytes != header.body_size_bytes {
        return Err(SyncError::Integrity(
            "commit body ciphertext size mismatch".into(),
        ));
    }
    Ok(())
}

fn validate_downloaded_pack(
    pack_ref: &CommitBodyPackRef,
    object: &DownloadedObject,
) -> SyncResult<()> {
    if object.object_id != pack_ref.object_id {
        return Err(SyncError::Integrity("pack object id mismatch".into()));
    }
    let expected_kind = object_kind_for_pack_kind(&pack_ref.pack_kind)?;
    if object.kind != expected_kind {
        return Err(SyncError::Integrity("pack object kind mismatch".into()));
    }
    Ok(())
}

fn validate_remote_file_identity(
    file_id: &str,
    path: &str,
    normalized_path: &str,
) -> SyncResult<()> {
    validate_required(file_id, "file_id")?;
    validate_required(path, "path")?;
    let observed_normalized = normalize_vault_relative_path(path)?;
    if observed_normalized != normalized_path {
        return Err(SyncError::Integrity(format!(
            "remote file normalized path mismatch for {path}"
        )));
    }
    if file_id_for_normalized_path(normalized_path) != file_id {
        return Err(SyncError::Integrity(format!(
            "remote file id mismatch for {normalized_path}"
        )));
    }
    if Path::new(path)
        .extension()
        .and_then(|extension| extension.to_str())
        .is_none_or(|extension| !extension.eq_ignore_ascii_case("md"))
    {
        return Err(SyncError::InvalidArgument(format!(
            "remote file is not markdown: {path}"
        )));
    }
    Ok(())
}

fn validate_plaintext_metadata(
    path: &str,
    plaintext: &[u8],
    plaintext_hash: &str,
    size_bytes: i64,
) -> SyncResult<()> {
    let observed_size = i64::try_from(plaintext.len())
        .map_err(|_| SyncError::InvalidArgument(format!("remote file is too large: {path}")))?;
    if observed_size != size_bytes {
        return Err(SyncError::Integrity(format!(
            "remote file size mismatch: {path}"
        )));
    }
    let observed_hash = blake3::hash(plaintext).to_hex().to_string();
    if observed_hash != plaintext_hash {
        return Err(SyncError::Integrity(format!(
            "remote file plaintext hash mismatch: {path}"
        )));
    }
    Ok(())
}

fn pack_entry_plaintext<'a>(
    packs: &'a BTreeMap<String, UnpackedPack>,
    content_ref: &CommitBodyContentRef,
) -> SyncResult<&'a [u8]> {
    packs
        .get(&content_ref.object_id)
        .ok_or_else(|| {
            SyncError::Integrity(format!(
                "content pack {} missing from commit",
                content_ref.object_id
            ))
        })?
        .entries
        .get(&content_ref.entry_id)
        .map(Vec::as_slice)
        .ok_or_else(|| {
            SyncError::Integrity(format!(
                "content pack entry {} missing from {}",
                content_ref.entry_id, content_ref.object_id
            ))
        })
}

fn validate_tree_id(tree_id: &str, entries: &[SyncTreeEntryRecord]) -> SyncResult<()> {
    let observed = tree_id_for_entries(entries)?;
    if observed != tree_id {
        return Err(SyncError::Integrity(format!(
            "commit tree id mismatch: expected {tree_id}, got {observed}"
        )));
    }
    Ok(())
}

fn tree_id_for_entries(entries: &[SyncTreeEntryRecord]) -> SyncResult<String> {
    let json = serde_json::to_vec(&tree_cache_entry_body(entries))?;
    let hash = blake3::hash(&json).to_hex().to_string();
    Ok(format!("tree_{}", &hash[..32]))
}

fn tree_json_for_entries(entries: &[SyncTreeEntryRecord]) -> SyncResult<String> {
    serde_json::to_string(&tree_cache_entry_body(entries)).map_err(Into::into)
}

fn tree_cache_entry_body(entries: &[SyncTreeEntryRecord]) -> Vec<TreeCacheEntryBody<'_>> {
    entries
        .iter()
        .map(|entry| TreeCacheEntryBody {
            file_id: &entry.file_id,
            normalized_path: &entry.normalized_path,
            plaintext_hash: entry.plaintext_hash.as_deref(),
            content_object_id: entry.content_object_id.as_deref(),
            pack_entry_id: entry.pack_entry_id.as_deref(),
            kind: &entry.kind,
        })
        .collect()
}

fn changed_file_ids(body: &CommitBody) -> Vec<String> {
    let mut seen = BTreeSet::new();
    for change in &body.changes {
        match change {
            CommitBodyFileOp::UpsertFile { file_id, .. }
            | CommitBodyFileOp::DeleteFile { file_id, .. } => {
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

fn pack_kind_for_object_kind(kind: SyncObjectKind) -> SyncResult<&'static str> {
    match kind {
        SyncObjectKind::SYNC_OBJECT_KIND_CONTENT_PACK => Ok(CONTENT_PACK_KIND),
        SyncObjectKind::SYNC_OBJECT_KIND_CHECKPOINT_PACK => Ok(CHECKPOINT_PACK_KIND),
        _ => Err(SyncError::InvalidArgument(
            "sync object is not a decryptable pack".into(),
        )),
    }
}

fn commit_kind_label(kind: SyncCommitKind) -> SyncResult<&'static str> {
    match kind {
        SyncCommitKind::SYNC_COMMIT_KIND_CHECKPOINT => Ok("checkpoint"),
        SyncCommitKind::SYNC_COMMIT_KIND_INCREMENTAL => Ok("incremental"),
        SyncCommitKind::SYNC_COMMIT_KIND_MERGE => Ok("merge"),
        _ => Err(SyncError::InvalidArgument(
            "unsupported sync commit kind".into(),
        )),
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

#[cfg(test)]
mod tests {
    use std::future::Future;
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    use async_trait::async_trait;
    use parking_lot::Mutex;
    use sha2::{Digest, Sha256};
    use tokio::runtime::Builder;

    use crate::models::{FileChangeEvent, IndexerStorageLocation};

    use super::super::client::{
        CompletedObjectUploadDescriptor, ObjectDownloadTargetDescriptor, ObjectReservationInput,
        ObjectUploadCompletion, ObjectUploadDescriptor, ObjectUploadTargetDescriptor,
        PublishCommitInput, PublishedCommit, ReservedObject,
    };
    use super::super::crypto::encrypt_commit_body;
    use super::super::keys::{Argon2idKdfParams, wrap_workspace_key_with_params};
    use super::super::packer::{PackEntryInput, encrypt_pack};
    use super::super::transfer::{
        ObjectGetRequest, ObjectGetResponse, ObjectHttpError, ObjectPutRequest, ObjectPutResponse,
        ObjectTransferHttp, TransferQueueConfig,
    };
    use super::*;

    #[test]
    fn pull_bootstraps_from_latest_checkpoint() {
        let root = temp_vault("bootstrap");
        let fixture = RemoteFixture::new().add_checkpoint(vec![("a.md", b"# A".to_vec())], true);
        let mut conn = db::open_memory_sync_db().unwrap();
        let pipeline = pipeline(&fixture);

        let result =
            block_on(pipeline.pull_remote_changes(input(&mut conn, &root, &fixture))).unwrap();

        assert_eq!(result.applied_commits, vec!["commit_1"]);
        assert!(result.bootstrapped_from_checkpoint);
        assert_eq!(std::fs::read_to_string(root.join("a.md")).unwrap(), "# A");
        let vault = db::get_vault(&conn, "vault_1").unwrap().unwrap();
        assert_eq!(vault.local_head_commit_id.as_deref(), Some("commit_1"));
        assert!(db::list_dirty_files(&conn).unwrap().is_empty());
        assert_eq!(db::list_tree_entries(&conn, "commit_1").unwrap().len(), 1);

        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn pull_bootstraps_multiple_checkpoint_shards() {
        let root = temp_vault("multi-shard");
        let fixture = RemoteFixture::new().add_checkpoint(
            vec![("a.md", b"# A".to_vec()), ("b.md", b"# B".to_vec())],
            true,
        );
        let mut conn = db::open_memory_sync_db().unwrap();
        let pipeline = pipeline(&fixture);

        let result =
            block_on(pipeline.pull_remote_changes(input(&mut conn, &root, &fixture))).unwrap();

        assert_eq!(result.applied_commits, vec!["commit_1"]);
        assert_eq!(std::fs::read_to_string(root.join("a.md")).unwrap(), "# A");
        assert_eq!(std::fs::read_to_string(root.join("b.md")).unwrap(), "# B");
        assert_eq!(db::list_tree_entries(&conn, "commit_1").unwrap().len(), 2);

        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn pull_replays_checkpoint_then_incremental() {
        let root = temp_vault("incremental");
        let fixture = RemoteFixture::new()
            .add_checkpoint(vec![("a.md", b"# A".to_vec())], true)
            .add_incremental(vec![RemoteChange::Upsert("a.md", b"# A2".to_vec())]);
        let mut conn = db::open_memory_sync_db().unwrap();
        let pipeline = pipeline(&fixture);

        let result =
            block_on(pipeline.pull_remote_changes(input(&mut conn, &root, &fixture))).unwrap();

        assert_eq!(result.applied_commits, vec!["commit_1", "commit_2"]);
        assert_eq!(std::fs::read_to_string(root.join("a.md")).unwrap(), "# A2");
        let vault = db::get_vault(&conn, "vault_1").unwrap().unwrap();
        assert_eq!(vault.local_head_commit_id.as_deref(), Some("commit_2"));
        assert!(db::list_dirty_files(&conn).unwrap().is_empty());

        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn pull_replays_from_genesis_when_no_checkpoint_pointer_exists() {
        let root = temp_vault("genesis");
        let fixture = RemoteFixture::new()
            .add_checkpoint(vec![("a.md", b"# A".to_vec())], false)
            .add_incremental(vec![RemoteChange::Upsert("b.md", b"# B".to_vec())]);
        let mut conn = db::open_memory_sync_db().unwrap();
        let pipeline = pipeline(&fixture);

        let result =
            block_on(pipeline.pull_remote_changes(input(&mut conn, &root, &fixture))).unwrap();

        assert_eq!(result.applied_commits, vec!["commit_1", "commit_2"]);
        assert!(!result.bootstrapped_from_checkpoint);
        assert_eq!(std::fs::read_to_string(root.join("a.md")).unwrap(), "# A");
        assert_eq!(std::fs::read_to_string(root.join("b.md")).unwrap(), "# B");

        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn pull_merges_different_files_without_conflict() {
        let root = temp_vault("merge-files");
        let mut fixture =
            RemoteFixture::new().add_checkpoint(vec![("a.md", b"# A".to_vec())], true);
        let mut conn = db::open_memory_sync_db().unwrap();
        let pipeline = pipeline(&fixture);
        block_on(pipeline.pull_remote_changes(input(&mut conn, &root, &fixture))).unwrap();
        write_file(&root.join("a.md"), b"# A local");
        fixture = fixture.add_incremental(vec![RemoteChange::Upsert("b.md", b"# B".to_vec())]);

        block_on(pipeline.pull_remote_changes(input(&mut conn, &root, &fixture))).unwrap();

        assert_eq!(
            std::fs::read_to_string(root.join("a.md")).unwrap(),
            "# A local"
        );
        assert_eq!(std::fs::read_to_string(root.join("b.md")).unwrap(), "# B");
        assert!(db::list_open_conflicts(&conn).unwrap().is_empty());
        assert_dirty_paths(&conn, &["a.md"]);

        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn pull_merges_same_file_different_lines_without_conflict() {
        let root = temp_vault("merge-lines");
        let mut fixture =
            RemoteFixture::new().add_checkpoint(vec![("a.md", b"a\nb\n".to_vec())], true);
        let mut conn = db::open_memory_sync_db().unwrap();
        let pipeline = pipeline(&fixture);
        block_on(pipeline.pull_remote_changes(input(&mut conn, &root, &fixture))).unwrap();
        write_file(&root.join("a.md"), b"A\nb\n");
        fixture = fixture.add_incremental(vec![RemoteChange::Upsert("a.md", b"a\nB\n".to_vec())]);

        block_on(pipeline.pull_remote_changes(input(&mut conn, &root, &fixture))).unwrap();

        assert_eq!(
            std::fs::read_to_string(root.join("a.md")).unwrap(),
            "A\nB\n"
        );
        assert!(db::list_open_conflicts(&conn).unwrap().is_empty());
        assert_dirty_paths(&conn, &["a.md"]);

        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn pull_merges_same_file_after_unchanged_intervening_commit() {
        let root = temp_vault("merge-lines-after-unchanged");
        let mut fixture = RemoteFixture::new().add_checkpoint(
            vec![
                ("a.md", b"a\nb\n".to_vec()),
                ("b.md", b"unchanged\n".to_vec()),
            ],
            true,
        );
        let mut conn = db::open_memory_sync_db().unwrap();
        let pipeline = pipeline(&fixture);
        block_on(pipeline.pull_remote_changes(input(&mut conn, &root, &fixture))).unwrap();

        fixture = fixture.add_incremental(vec![RemoteChange::Upsert(
            "b.md",
            b"remote changed b\n".to_vec(),
        )]);
        block_on(pipeline.pull_remote_changes(input(&mut conn, &root, &fixture))).unwrap();

        write_file(&root.join("a.md"), b"A\nb\n");
        fixture = fixture.add_incremental(vec![RemoteChange::Upsert("a.md", b"a\nB\n".to_vec())]);

        block_on(pipeline.pull_remote_changes(input(&mut conn, &root, &fixture))).unwrap();

        assert_eq!(
            std::fs::read_to_string(root.join("a.md")).unwrap(),
            "A\nB\n"
        );
        assert!(db::list_open_conflicts(&conn).unwrap().is_empty());
        assert_dirty_paths(&conn, &["a.md"]);

        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn pull_rematerializes_missing_base_tree_for_merge() {
        let root = temp_vault("missing-base");
        let mut fixture =
            RemoteFixture::new().add_checkpoint(vec![("a.md", b"a\nb\n".to_vec())], true);
        let mut conn = db::open_memory_sync_db().unwrap();
        let pipeline = pipeline(&fixture);
        block_on(pipeline.pull_remote_changes(input(&mut conn, &root, &fixture))).unwrap();
        conn.execute("DELETE FROM sync_tree_entries", []).unwrap();
        conn.execute("DELETE FROM sync_commit_trees", []).unwrap();
        write_file(&root.join("a.md"), b"A\nb\n");
        fixture = fixture.add_incremental(vec![RemoteChange::Upsert("a.md", b"a\nB\n".to_vec())]);

        block_on(pipeline.pull_remote_changes(input(&mut conn, &root, &fixture))).unwrap();

        assert_eq!(
            std::fs::read_to_string(root.join("a.md")).unwrap(),
            "A\nB\n"
        );
        assert!(db::list_open_conflicts(&conn).unwrap().is_empty());
        assert_dirty_paths(&conn, &["a.md"]);

        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn pull_creates_conflict_copy_for_same_line_conflict() {
        let root = temp_vault("same-line");
        let mut fixture =
            RemoteFixture::new().add_checkpoint(vec![("a.md", b"a\n".to_vec())], true);
        let mut conn = db::open_memory_sync_db().unwrap();
        let pipeline = pipeline(&fixture);
        block_on(pipeline.pull_remote_changes(input(&mut conn, &root, &fixture))).unwrap();
        write_file(&root.join("a.md"), b"local\n");
        fixture = fixture.add_incremental(vec![RemoteChange::Upsert("a.md", b"remote\n".to_vec())]);

        block_on(pipeline.pull_remote_changes(input(&mut conn, &root, &fixture))).unwrap();

        assert_eq!(
            std::fs::read_to_string(root.join("a.md")).unwrap(),
            "local\n"
        );
        assert_eq!(
            std::fs::read_to_string(root.join("a.conflict-19700101-000000.md")).unwrap(),
            "remote\n"
        );
        let conflicts = db::list_open_conflicts(&conn).unwrap();
        assert_eq!(conflicts.len(), 1);
        assert_eq!(conflicts[0].path, "a.md");
        assert_eq!(conflicts[0].conflict_path, "a.conflict-19700101-000000.md");
        assert_dirty_paths(&conn, &["a.conflict-19700101-000000.md", "a.md"]);

        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn pull_creates_conflict_copy_for_local_edit_remote_delete() {
        let root = temp_vault("edit-delete");
        let mut fixture =
            RemoteFixture::new().add_checkpoint(vec![("a.md", b"base\n".to_vec())], true);
        let mut conn = db::open_memory_sync_db().unwrap();
        let pipeline = pipeline(&fixture);
        block_on(pipeline.pull_remote_changes(input(&mut conn, &root, &fixture))).unwrap();
        write_file(&root.join("a.md"), b"local\n");
        fixture = fixture.add_incremental(vec![RemoteChange::Delete("a.md")]);

        block_on(pipeline.pull_remote_changes(input(&mut conn, &root, &fixture))).unwrap();

        assert!(!root.join("a.md").exists());
        assert_eq!(
            std::fs::read_to_string(root.join("a.conflict-19700101-000000.md")).unwrap(),
            "local\n"
        );
        assert_eq!(db::list_open_conflicts(&conn).unwrap().len(), 1);
        assert_dirty_paths(&conn, &["a.conflict-19700101-000000.md"]);

        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn pull_creates_conflict_copy_for_local_delete_remote_edit() {
        let root = temp_vault("delete-edit");
        let mut fixture =
            RemoteFixture::new().add_checkpoint(vec![("a.md", b"base\n".to_vec())], true);
        let mut conn = db::open_memory_sync_db().unwrap();
        let pipeline = pipeline(&fixture);
        block_on(pipeline.pull_remote_changes(input(&mut conn, &root, &fixture))).unwrap();
        std::fs::remove_file(root.join("a.md")).unwrap();
        fixture = fixture.add_incremental(vec![RemoteChange::Upsert("a.md", b"remote\n".to_vec())]);

        block_on(pipeline.pull_remote_changes(input(&mut conn, &root, &fixture))).unwrap();

        assert!(!root.join("a.md").exists());
        assert_eq!(
            std::fs::read_to_string(root.join("a.conflict-19700101-000000.md")).unwrap(),
            "remote\n"
        );
        assert_eq!(db::list_open_conflicts(&conn).unwrap().len(), 1);
        assert_dirty_paths(&conn, &["a.conflict-19700101-000000.md", "a.md"]);

        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn pull_treats_delete_delete_as_noop() {
        let root = temp_vault("delete-delete");
        let mut fixture =
            RemoteFixture::new().add_checkpoint(vec![("a.md", b"base\n".to_vec())], true);
        let mut conn = db::open_memory_sync_db().unwrap();
        let pipeline = pipeline(&fixture);
        block_on(pipeline.pull_remote_changes(input(&mut conn, &root, &fixture))).unwrap();
        std::fs::remove_file(root.join("a.md")).unwrap();
        fixture = fixture.add_incremental(vec![RemoteChange::Delete("a.md")]);

        block_on(pipeline.pull_remote_changes(input(&mut conn, &root, &fixture))).unwrap();

        assert!(!root.join("a.md").exists());
        assert!(db::list_open_conflicts(&conn).unwrap().is_empty());
        assert!(db::list_dirty_files(&conn).unwrap().is_empty());

        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn remote_apply_records_expected_mutation_for_watcher_suppression() {
        let root = temp_vault("watcher");
        let fixture =
            RemoteFixture::new().add_checkpoint(vec![("a.md", b"watcher".to_vec())], true);
        let mut conn = db::open_memory_sync_db().unwrap();
        let pipeline = pipeline(&fixture);
        let ledger = ExpectedMutationLedger::default();
        let mut input = input(&mut conn, &root, &fixture);
        input.hooks.expected_mutations = Some(&ledger);

        block_on(pipeline.pull_remote_changes(input)).unwrap();

        assert!(ledger.consume_matching(&FileChangeEvent {
            kind: "modify".into(),
            path: "a.md".into(),
            is_dir: false,
            old_path: None,
        }));
        assert!(!ledger.consume_matching(&FileChangeEvent {
            kind: "modify".into(),
            path: "a.md".into(),
            is_dir: false,
            old_path: None,
        }));

        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn remote_apply_notifies_search_index() {
        let root = temp_vault("search");
        let fixture = RemoteFixture::new().add_checkpoint(
            vec![("needle.md", b"# Search\n\nphaseelevenneedle".to_vec())],
            true,
        );
        let mut conn = db::open_memory_sync_db().unwrap();
        let pipeline = pipeline(&fixture);
        let search = SearchState::new();
        let mut config = search.get_config();
        config.storage_location = IndexerStorageLocation::VaultLocal;
        search.set_config(config).unwrap();
        search.switch_vault(root.clone()).unwrap();
        let mut input = input(&mut conn, &root, &fixture);
        input.hooks.search = Some(&search);

        block_on(pipeline.pull_remote_changes(input)).unwrap();

        assert_eventually_searches(&search, "phaseelevenneedle", "needle.md");
        search.close_runtime().unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn corrupted_downloaded_ciphertext_fails_before_apply() {
        let root = temp_vault("corrupt");
        let mut fixture =
            RemoteFixture::new().add_checkpoint(vec![("a.md", b"# A".to_vec())], true);
        fixture.tamper_object_id = Some("body_1".into());
        let mut conn = db::open_memory_sync_db().unwrap();
        let pipeline = pipeline(&fixture);

        let err =
            block_on(pipeline.pull_remote_changes(input(&mut conn, &root, &fixture))).unwrap_err();

        assert!(matches!(err, SyncError::Integrity(message) if message.contains("hash mismatch")));
        assert!(!root.join("a.md").exists());
        assert!(
            db::get_vault(&conn, "vault_1")
                .unwrap()
                .unwrap()
                .local_head_commit_id
                .is_none()
        );

        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn passphrase_envelope_metadata_unlocks_workspace_key() {
        let workspace_key = [7u8; 32];
        let envelope = wrap_workspace_key_with_params(
            "workspace_1",
            "envelope_1",
            1,
            &workspace_key,
            "correct passphrase",
            test_kdf_params(),
        )
        .unwrap();
        let metadata = SyncKeyEnvelopeMetadata {
            workspace_id: envelope.workspace_id.clone(),
            envelope_id: envelope.envelope_id.clone(),
            recipient_type: SyncKeyRecipientType::SYNC_KEY_RECIPIENT_TYPE_PASSPHRASE,
            recipient_device_id: String::new(),
            key_version: envelope.key_version,
            kdf_params_json: serde_json::to_string(&envelope.kdf).unwrap(),
            encrypted_envelope: serde_json::to_vec(&envelope.wrap).unwrap(),
            created_by_device_id: "device_1".into(),
        };

        let (unwrapped, source) =
            unlock_workspace_key_from_envelopes(&[metadata], "correct passphrase").unwrap();

        assert_eq!(unwrapped, workspace_key);
        assert_eq!(source, WorkspaceKeySource::Passphrase);
    }

    fn pipeline(fixture: &RemoteFixture) -> SyncPullPipeline {
        let api = Arc::new(FakeSyncApi {
            inner: fixture.inner.clone(),
        });
        let http = Arc::new(FakeObjectHttp {
            inner: fixture.inner.clone(),
            tamper_object_id: fixture.tamper_object_id.clone(),
        });
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
        SyncPullPipeline::new(api, transfer_queue)
    }

    fn input<'a>(
        conn: &'a mut Connection,
        root: &'a Path,
        fixture: &'a RemoteFixture,
    ) -> PullRemoteChangesInput<'a> {
        PullRemoteChangesInput {
            conn,
            vault_id: "vault_1",
            vault_root: root,
            workspace_id: "workspace_1",
            device_id: "device_local",
            workspace_key: &fixture.workspace_key,
            hooks: RemoteApplyHooks::default(),
            now_ms: 1,
        }
    }

    fn block_on<T>(future: impl Future<Output = T>) -> T {
        Builder::new_current_thread()
            .enable_time()
            .build()
            .unwrap()
            .block_on(future)
    }

    fn temp_vault(name: &str) -> PathBuf {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "kuku-sync-pull-{name}-{}-{stamp}",
            std::process::id()
        ));
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    fn write_file(path: &Path, bytes: &[u8]) {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(path, bytes).unwrap();
    }

    fn assert_dirty_paths(conn: &Connection, expected: &[&str]) {
        let mut observed = db::list_dirty_files(conn)
            .unwrap()
            .into_iter()
            .map(|file| file.path)
            .collect::<Vec<_>>();
        observed.sort();
        let mut expected = expected
            .iter()
            .map(|path| path.to_string())
            .collect::<Vec<_>>();
        expected.sort();
        assert_eq!(observed, expected);
    }

    fn assert_eventually_searches(search: &SearchState, query: &str, expected_doc: &str) {
        for _ in 0..80 {
            let result = search.query_simple(query, 20).unwrap();
            if result.items.iter().any(|item| item.doc_id == expected_doc) {
                return;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        panic!("search did not index {expected_doc}");
    }

    fn test_kdf_params() -> Argon2idKdfParams {
        Argon2idKdfParams {
            name: "argon2id".into(),
            salt: base64::Engine::encode(&base64::engine::general_purpose::STANDARD, [9u8; 16]),
            mem_kib: 1024,
            iterations: 1,
            parallelism: 1,
        }
    }

    enum RemoteChange<'a> {
        Upsert(&'a str, Vec<u8>),
        Delete(&'a str),
    }

    #[derive(Clone)]
    struct RemoteFixture {
        workspace_key: SymmetricKey,
        inner: Arc<Mutex<RemoteFixtureInner>>,
        tamper_object_id: Option<String>,
    }

    #[derive(Default)]
    struct RemoteFixtureInner {
        commits: Vec<SyncCommitHeader>,
        objects: BTreeMap<String, RemoteObject>,
        trees: BTreeMap<String, Vec<SyncTreeEntryRecord>>,
        head: String,
        latest_checkpoint: String,
    }

    #[derive(Clone)]
    struct RemoteObject {
        kind: SyncObjectKind,
        ciphertext: Vec<u8>,
    }

    impl RemoteFixture {
        fn new() -> Self {
            Self {
                workspace_key: [11u8; 32],
                inner: Arc::new(Mutex::new(RemoteFixtureInner::default())),
                tamper_object_id: None,
            }
        }

        fn add_checkpoint(self, files: Vec<(&str, Vec<u8>)>, mark_latest: bool) -> Self {
            let changes = files
                .into_iter()
                .map(|(path, bytes)| RemoteChange::Upsert(path, bytes))
                .collect::<Vec<_>>();
            self.add_commit(
                SyncCommitKind::SYNC_COMMIT_KIND_CHECKPOINT,
                changes,
                mark_latest,
            )
        }

        fn add_incremental(self, changes: Vec<RemoteChange<'_>>) -> Self {
            self.add_commit(SyncCommitKind::SYNC_COMMIT_KIND_INCREMENTAL, changes, false)
        }

        fn add_commit(
            self,
            commit_kind: SyncCommitKind,
            changes: Vec<RemoteChange<'_>>,
            mark_latest_checkpoint: bool,
        ) -> Self {
            let mut inner = self.inner.lock();
            let server_seq = inner.commits.len() as i64 + 1;
            let commit_id = format!("commit_{server_seq}");
            let body_object_id = format!("body_{server_seq}");
            let parent = inner.head.clone();
            let parent_ids = if parent.is_empty() {
                Vec::new()
            } else {
                vec![parent.clone()]
            };
            let commit_kind_label = commit_kind_label(commit_kind).unwrap();
            let pack_kind = if commit_kind == SyncCommitKind::SYNC_COMMIT_KIND_CHECKPOINT {
                CHECKPOINT_PACK_KIND
            } else {
                CONTENT_PACK_KIND
            };
            let mut pack_uploads: Vec<(CommitBodyPackRef, Vec<PackEntryInput>)> = Vec::new();
            let mut body_changes = Vec::new();
            for (index, change) in changes.into_iter().enumerate() {
                match change {
                    RemoteChange::Upsert(path, plaintext) => {
                        let normalized_path = normalize_vault_relative_path(path).unwrap();
                        let file_id = file_id_for_normalized_path(&normalized_path);
                        let plaintext_hash = blake3::hash(&plaintext).to_hex().to_string();
                        let size_bytes = plaintext.len() as i64;
                        let entry_id = format!("entry_{server_seq}_{index}");
                        let pack_object_id = format!("pack_{server_seq}_{index}");
                        pack_uploads.push((
                            CommitBodyPackRef {
                                pack_ref: format!("pack_ref_{server_seq}_{index}"),
                                object_id: pack_object_id.clone(),
                                pack_kind: pack_kind.into(),
                                shard_index: index,
                                entry_count: 1,
                            },
                            vec![PackEntryInput {
                                entry_id: entry_id.clone(),
                                plaintext,
                            }],
                        ));
                        body_changes.push(CommitBodyFileOp::UpsertFile {
                            file_id,
                            path: path.into(),
                            normalized_path,
                            plaintext_hash,
                            size_bytes,
                            content_ref: CommitBodyContentRef {
                                object_id: pack_object_id.clone(),
                                entry_id,
                            },
                        });
                    }
                    RemoteChange::Delete(path) => {
                        let normalized_path = normalize_vault_relative_path(path).unwrap();
                        body_changes.push(CommitBodyFileOp::DeleteFile {
                            file_id: file_id_for_normalized_path(&normalized_path),
                            path: path.into(),
                            normalized_path,
                        });
                    }
                }
            }
            let mut packs = Vec::new();
            for (pack_ref, pack_entries) in pack_uploads {
                let encrypted_pack = encrypt_pack(
                    &self.workspace_key,
                    "workspace_1",
                    &pack_ref.object_id,
                    pack_kind,
                    &commit_id,
                    pack_entries,
                )
                .unwrap();
                inner.objects.insert(
                    pack_ref.object_id.clone(),
                    RemoteObject {
                        kind: object_kind_for_pack_kind(pack_kind).unwrap(),
                        ciphertext: encrypted_pack.blob,
                    },
                );
                packs.push(pack_ref);
            }
            let tree_entries = materialize_fixture_tree(&inner, &commit_id, &body_changes);
            let tree_id = tree_id_for_entries(&tree_entries).unwrap();
            packs.sort_by(|left, right| left.object_id.cmp(&right.object_id));
            let body = CommitBody {
                format: "kuku.sync.commit-body".into(),
                version: 1,
                commit_id: commit_id.clone(),
                commit_kind: commit_kind_label.into(),
                parent_commit_ids: parent_ids.clone(),
                tree_id,
                changes: body_changes,
                packs,
            };
            let commit_key = keys::commit_body_key(&self.workspace_key, "workspace_1");
            let aad = CommitBodyAad::new(
                "workspace_1",
                &commit_id,
                commit_kind_label,
                parent_ids.clone(),
                "device_remote",
                server_seq,
                &body_object_id,
            );
            let body_ciphertext =
                encrypt_commit_body(&commit_key, &aad, &serde_json::to_vec(&body).unwrap())
                    .unwrap();
            let body_metadata = encrypted_blob_metadata(&body_ciphertext);
            inner.objects.insert(
                body_object_id.clone(),
                RemoteObject {
                    kind: SyncObjectKind::SYNC_OBJECT_KIND_COMMIT_BODY,
                    ciphertext: body_ciphertext,
                },
            );
            let referenced_object_ids = body
                .packs
                .iter()
                .map(|pack| pack.object_id.clone())
                .collect::<Vec<_>>();
            inner.commits.push(SyncCommitHeader {
                commit_id: commit_id.clone(),
                commit_kind,
                expected_head_commit_id: parent,
                parent_commit_ids: parent_ids,
                author_device_id: "device_remote".into(),
                device_seq: server_seq,
                body_object_id,
                body_ciphertext_sha256: body_metadata.ciphertext_sha256,
                body_size_bytes: body_metadata.size_bytes,
                referenced_object_ids,
                signature: Vec::new(),
                server_seq,
            });
            inner.trees.insert(commit_id.clone(), tree_entries);
            inner.head = commit_id.clone();
            if mark_latest_checkpoint {
                inner.latest_checkpoint = commit_id;
            }
            drop(inner);
            self
        }
    }

    fn materialize_fixture_tree(
        inner: &RemoteFixtureInner,
        commit_id: &str,
        changes: &[CommitBodyFileOp],
    ) -> Vec<SyncTreeEntryRecord> {
        let mut by_file_id = inner
            .trees
            .get(&inner.head)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .map(|entry| (entry.file_id.clone(), entry))
            .collect::<BTreeMap<_, _>>();
        for change in changes {
            match change {
                CommitBodyFileOp::UpsertFile {
                    file_id,
                    normalized_path,
                    plaintext_hash,
                    content_ref,
                    ..
                } => {
                    by_file_id.insert(
                        file_id.clone(),
                        SyncTreeEntryRecord {
                            commit_id: commit_id.into(),
                            file_id: file_id.clone(),
                            normalized_path: normalized_path.clone(),
                            plaintext_hash: Some(plaintext_hash.clone()),
                            content_object_id: Some(content_ref.object_id.clone()),
                            pack_entry_id: Some(content_ref.entry_id.clone()),
                            kind: FILE_KIND_MARKDOWN.into(),
                        },
                    );
                }
                CommitBodyFileOp::DeleteFile { file_id, .. } => {
                    by_file_id.remove(file_id);
                }
            }
        }
        let mut entries = by_file_id.into_values().collect::<Vec<_>>();
        entries.sort_by(|left, right| left.normalized_path.cmp(&right.normalized_path));
        entries
    }

    struct FakeSyncApi {
        inner: Arc<Mutex<RemoteFixtureInner>>,
    }

    #[async_trait]
    impl SyncCommitApi for FakeSyncApi {
        async fn get_head(&self, _workspace_id: &str) -> SyncResult<SyncHead> {
            let inner = self.inner.lock();
            Ok(SyncHead {
                current_head_commit_id: inner.head.clone(),
                head_version: inner.commits.len() as i64,
                latest_checkpoint_commit_id: inner.latest_checkpoint.clone(),
            })
        }

        async fn list_commits(
            &self,
            _workspace_id: &str,
            after_server_seq: i64,
            page_size: i32,
        ) -> SyncResult<ListCommitsOutput> {
            let inner = self.inner.lock();
            let commits = inner
                .commits
                .iter()
                .filter(|commit| commit.server_seq > after_server_seq)
                .take(page_size.max(0) as usize)
                .cloned()
                .collect::<Vec<_>>();
            let next_after_server_seq = commits
                .last()
                .map(|commit| commit.server_seq)
                .unwrap_or(after_server_seq);
            let has_more = inner
                .commits
                .iter()
                .any(|commit| commit.server_seq > next_after_server_seq);
            Ok(ListCommitsOutput {
                commits,
                has_more,
                next_after_server_seq,
            })
        }

        async fn publish_commit(&self, _input: PublishCommitInput) -> SyncResult<PublishedCommit> {
            Err(SyncError::Transport(
                "test pull fake does not publish commits".into(),
            ))
        }
    }

    #[async_trait]
    impl super::super::client::SyncTransferApi for FakeSyncApi {
        async fn reserve_object_ids(
            &self,
            _workspace_id: &str,
            _device_id: &str,
            _objects: Vec<ObjectReservationInput>,
        ) -> SyncResult<Vec<ReservedObject>> {
            unreachable!("reserve is not used by pull tests")
        }

        async fn create_object_upload_batch(
            &self,
            _workspace_id: &str,
            _device_id: &str,
            _upload_attempt_id: &str,
            _objects: Vec<ObjectUploadDescriptor>,
        ) -> SyncResult<Vec<ObjectUploadTargetDescriptor>> {
            unreachable!("upload is not used by pull tests")
        }

        async fn complete_object_upload_batch(
            &self,
            _workspace_id: &str,
            _device_id: &str,
            _upload_attempt_id: &str,
            _objects: Vec<CompletedObjectUploadDescriptor>,
        ) -> SyncResult<Vec<ObjectUploadCompletion>> {
            unreachable!("upload is not used by pull tests")
        }

        async fn create_object_download_batch(
            &self,
            _workspace_id: &str,
            _device_id: &str,
            object_ids: Vec<String>,
        ) -> SyncResult<Vec<ObjectDownloadTargetDescriptor>> {
            let inner = self.inner.lock();
            object_ids
                .into_iter()
                .map(|object_id| {
                    let object = inner.objects.get(&object_id).ok_or_else(|| {
                        SyncError::Transport(format!("missing test object {object_id}"))
                    })?;
                    let sha = sha256_hex(&object.ciphertext);
                    Ok(ObjectDownloadTargetDescriptor {
                        object_id: object_id.clone(),
                        kind: object.kind,
                        get_url: format!("memory://{object_id}"),
                        required_headers: Vec::new(),
                        ciphertext_sha256: sha,
                        size_bytes: object.ciphertext.len() as i64,
                    })
                })
                .collect()
        }
    }

    struct FakeObjectHttp {
        inner: Arc<Mutex<RemoteFixtureInner>>,
        tamper_object_id: Option<String>,
    }

    #[async_trait]
    impl ObjectTransferHttp for FakeObjectHttp {
        async fn put(
            &self,
            _request: ObjectPutRequest,
        ) -> Result<ObjectPutResponse, ObjectHttpError> {
            unreachable!("put is not used by pull tests")
        }

        async fn get(
            &self,
            request: ObjectGetRequest,
        ) -> Result<ObjectGetResponse, ObjectHttpError> {
            let object_id = request
                .url
                .strip_prefix("memory://")
                .ok_or_else(|| ObjectHttpError::Network("invalid memory url".into()))?;
            let mut body = self
                .inner
                .lock()
                .objects
                .get(object_id)
                .ok_or_else(|| ObjectHttpError::Status {
                    status: 404,
                    body: "missing".into(),
                })?
                .ciphertext
                .clone();
            if self.tamper_object_id.as_deref() == Some(object_id) {
                body.push(0);
            }
            Ok(ObjectGetResponse { body })
        }
    }

    fn sha256_hex(bytes: &[u8]) -> String {
        let mut hasher = Sha256::new();
        hasher.update(bytes);
        hex::encode(hasher.finalize())
    }
}
