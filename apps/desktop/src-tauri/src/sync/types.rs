use serde::{Deserialize, Serialize};

pub const SYNC_STATUS_EVENT: &str = "sync:status-changed";

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SyncVaultConfig {
    pub vault_id: String,
    pub root_path: String,
    pub remote_workspace_id: String,
    pub device_id: String,
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
    pub remote_workspace_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub device_id: Option<String>,
    pub remember_workspace_key: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_synced_at_ms: Option<i64>,
    pub pending_uploads: i64,
    pub pending_downloads: i64,
    pub conflict_count: i64,
    pub updated_at_ms: i64,
}

impl SyncRuntimeStatus {
    pub fn not_configured(updated_at_ms: i64) -> Self {
        Self {
            configured: false,
            enabled: false,
            phase: SyncPhase::NotConfigured,
            vault_id: None,
            root_path: None,
            remote_workspace_id: None,
            device_id: None,
            remember_workspace_key: true,
            last_error: None,
            last_synced_at_ms: None,
            pending_uploads: 0,
            pending_downloads: 0,
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
pub struct SyncStatusEvent {
    pub status: SyncRuntimeStatus,
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
