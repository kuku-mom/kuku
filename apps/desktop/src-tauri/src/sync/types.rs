use serde::{Deserialize, Serialize};

use super::errors::SyncErrorCategory;

pub const SYNC_STATUS_EVENT: &str = "sync:status-changed";

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SyncVaultConfig {
    pub vault_id: String,
    pub root_path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_key_id: Option<String>,
    pub remote_workspace_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_name: Option<String>,
    pub device_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device_name: Option<String>,
    pub remember_workspace_key: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub passphrase: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SyncRuntimeStatus {
    pub configured: bool,
    pub enabled: bool,
    pub phase: SyncPhase,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vault_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub root_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vault_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub account_key_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remote_workspace_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub device_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub device_name: Option<String>,
    pub remember_workspace_key: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error_category: Option<SyncErrorCategory>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_synced_at_ms: Option<i64>,
    pub pending_uploads: i64,
    pub pending_downloads: i64,
    pub transfer: SyncTransferStatus,
    pub conflict_count: i64,
    pub updated_at_ms: i64,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SyncWorkspaceSummary {
    pub workspace_id: String,
    pub name: String,
    pub current: bool,
    pub head_version: i64,
    pub metadata_version: i64,
    pub workspace_key_version: i64,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SyncAccountRecoveryState {
    pub configured: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub account_key_id: Option<String>,
    pub recovery_phrase_configured: bool,
    pub applied: bool,
    pub recovery_phrase_saved: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SyncRenameWorkspaceRequest {
    pub workspace_id: String,
    pub name: String,
    pub expected_metadata_version: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub passphrase: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SyncCreateWorkspaceRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub passphrase: Option<String>,
}

impl SyncRuntimeStatus {
    pub fn not_configured(updated_at_ms: i64) -> Self {
        Self {
            configured: false,
            enabled: false,
            phase: SyncPhase::NotConfigured,
            vault_id: None,
            root_path: None,
            vault_name: None,
            account_key_id: None,
            remote_workspace_id: None,
            workspace_name: None,
            device_id: None,
            device_name: None,
            remember_workspace_key: true,
            last_error: None,
            last_error_category: None,
            last_synced_at_ms: None,
            pending_uploads: 0,
            pending_downloads: 0,
            transfer: SyncTransferStatus::default(),
            conflict_count: 0,
            updated_at_ms,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SyncPhase {
    NotConfigured,
    Disabled,
    Idle,
    Planning,
    Packing,
    Transferring,
    Publishing,
    Applying,
    Error,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SyncTransferStatus {
    pub active: bool,
    pub direction: SyncTransferDirection,
    pub retrying: bool,
    pub upload_total_objects: i64,
    pub upload_completed_objects: i64,
    pub upload_failed_objects: i64,
    pub download_total_objects: i64,
    pub download_completed_objects: i64,
    pub download_failed_objects: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_attempt: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_attempts: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_retry_at_ms: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_transfer_error: Option<String>,
}

impl Default for SyncTransferStatus {
    fn default() -> Self {
        Self {
            active: false,
            direction: SyncTransferDirection::Idle,
            retrying: false,
            upload_total_objects: 0,
            upload_completed_objects: 0,
            upload_failed_objects: 0,
            download_total_objects: 0,
            download_completed_objects: 0,
            download_failed_objects: 0,
            retry_attempt: None,
            max_attempts: None,
            next_retry_at_ms: None,
            last_transfer_error: None,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SyncTransferDirection {
    Idle,
    Upload,
    Download,
    Both,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatusEvent {
    pub status: SyncRuntimeStatus,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SyncRemoteStatus {
    pub workspace_id: String,
    pub remote_head_commit_id: String,
    pub remote_head_version: i64,
    pub latest_checkpoint_commit_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub local_remote_head_commit_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub local_head_commit_id: Option<String>,
    pub has_remote_changes: bool,
    pub checked_at_ms: i64,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SyncConflictSummary {
    pub conflict_id: String,
    pub path: String,
    pub conflict_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_commit_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remote_commit_id: Option<String>,
    pub status: String,
    pub created_at_ms: i64,
}
