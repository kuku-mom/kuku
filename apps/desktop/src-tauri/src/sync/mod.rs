pub mod account_keys;
pub mod applier;
pub mod checkpoint;
pub mod client;
pub mod commands;
pub mod crypto;
pub mod db;
pub mod errors;
pub mod keys;
pub mod merge;
pub mod packer;
pub mod planner;
pub mod scanner;
pub mod transfer;
pub mod types;
pub mod vault_config;

use std::time::{SystemTime, UNIX_EPOCH};

use parking_lot::Mutex;

use self::errors::{SyncError, SyncErrorCategory, SyncResult};
use self::transfer::{TransferDirection, TransferProgressEvent};
use self::types::{
    SyncPhase, SyncRuntimeStatus, SyncTransferDirection, SyncTransferStatus, SyncVaultConfig,
};

pub struct SyncState {
    inner: Mutex<SyncInner>,
}

struct SyncInner {
    status: SyncRuntimeStatus,
    active_run_id: Option<u64>,
    next_run_id: u64,
}

impl SyncState {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(SyncInner {
                status: SyncRuntimeStatus::not_configured(now_ms()),
                active_run_id: None,
                next_run_id: 1,
            }),
        }
    }

    pub fn status(&self) -> SyncRuntimeStatus {
        self.inner.lock().status.clone()
    }

    pub fn is_sync_running(&self) -> bool {
        self.inner.lock().active_run_id.is_some()
    }

    pub fn configure_vault(&self, config: SyncVaultConfig) -> SyncResult<SyncRuntimeStatus> {
        self.restore_vault_with_status(config, false, None)
    }

    pub fn restore_vault_with_status(
        &self,
        config: SyncVaultConfig,
        enabled: bool,
        last_synced_at_ms: Option<i64>,
    ) -> SyncResult<SyncRuntimeStatus> {
        validate_config(&config)?;
        let mut inner = self.inner.lock();
        inner.status = SyncRuntimeStatus {
            configured: true,
            enabled,
            phase: if enabled {
                SyncPhase::Idle
            } else {
                SyncPhase::Disabled
            },
            vault_id: Some(config.vault_id),
            vault_name: vault_name_from_root(&config.root_path),
            root_path: Some(config.root_path),
            account_key_id: config.account_key_id,
            remote_workspace_id: Some(config.remote_workspace_id),
            workspace_name: config.workspace_name,
            device_id: Some(config.device_id),
            device_name: config.device_name,
            remember_workspace_key: config.remember_workspace_key,
            last_error: None,
            last_error_category: None,
            last_synced_at_ms,
            pending_uploads: 0,
            pending_downloads: 0,
            transfer: SyncTransferStatus::default(),
            conflict_count: 0,
            updated_at_ms: now_ms(),
        };
        Ok(inner.status.clone())
    }

    pub fn reset(&self) -> SyncRuntimeStatus {
        let mut inner = self.inner.lock();
        inner.active_run_id = None;
        inner.status = SyncRuntimeStatus::not_configured(now_ms());
        inner.status.clone()
    }

    pub fn set_enabled(&self, enabled: bool) -> SyncResult<SyncRuntimeStatus> {
        let mut inner = self.inner.lock();
        if !inner.status.configured {
            return Err(SyncError::NotConfigured);
        }
        if enabled {
            inner.status.enabled = true;
            drop(inner);
            return self.set_phase(SyncPhase::Idle);
        }
        inner.status.enabled = enabled;
        inner.status.phase = SyncPhase::Disabled;
        inner.status.last_error = None;
        inner.status.last_error_category = None;
        inner.status.transfer = SyncTransferStatus::default();
        inner.status.updated_at_ms = now_ms();
        Ok(inner.status.clone())
    }

    pub fn begin_sync_run(&self) -> SyncResult<u64> {
        let mut inner = self.inner.lock();
        if !inner.status.configured {
            return Err(SyncError::NotConfigured);
        }
        if !inner.status.enabled {
            return Err(SyncError::InvalidArgument(
                "sync must be enabled before running sync now".into(),
            ));
        }
        if inner.active_run_id.is_some() {
            return Err(SyncError::InvalidArgument("sync is already running".into()));
        }
        let run_id = inner.next_run_id;
        inner.next_run_id = next_run_id(inner.next_run_id);
        inner.active_run_id = Some(run_id);
        Ok(run_id)
    }

    pub fn finish_sync_run(&self, run_id: u64) {
        let mut inner = self.inner.lock();
        if inner.active_run_id == Some(run_id) {
            inner.active_run_id = None;
        }
    }

    pub fn complete_manual_sync(&self, conflict_count: i64) -> SyncResult<SyncRuntimeStatus> {
        let mut inner = self.inner.lock();
        if !inner.status.configured {
            return Err(SyncError::NotConfigured);
        }
        if !inner.status.enabled {
            return Err(SyncError::InvalidArgument(
                "sync must be enabled before running sync now".into(),
            ));
        }
        let timestamp = now_ms();
        inner.status.phase = SyncPhase::Idle;
        inner.status.last_error = None;
        inner.status.last_error_category = None;
        inner.status.last_synced_at_ms = Some(timestamp);
        inner.status.pending_uploads = 0;
        inner.status.pending_downloads = 0;
        inner.status.transfer = SyncTransferStatus::default();
        inner.status.conflict_count = conflict_count;
        inner.status.updated_at_ms = timestamp;
        Ok(inner.status.clone())
    }

    pub fn set_pending_counts(
        &self,
        pending_uploads: i64,
        pending_downloads: i64,
    ) -> SyncResult<SyncRuntimeStatus> {
        let mut inner = self.inner.lock();
        if !inner.status.configured {
            return Err(SyncError::NotConfigured);
        }
        if inner.status.pending_uploads == pending_uploads
            && inner.status.pending_downloads == pending_downloads
        {
            return Ok(inner.status.clone());
        }

        inner.status.pending_uploads = pending_uploads.max(0);
        inner.status.pending_downloads = pending_downloads.max(0);
        inner.status.updated_at_ms = now_ms();
        Ok(inner.status.clone())
    }

    pub fn clear_remote_status_error(&self) -> SyncResult<Option<SyncRuntimeStatus>> {
        let mut inner = self.inner.lock();
        if !inner.status.configured {
            return Err(SyncError::NotConfigured);
        }
        if inner.active_run_id.is_some() {
            return Ok(None);
        }
        if !matches!(
            inner.status.last_error_category,
            Some(
                SyncErrorCategory::LoginRequired
                    | SyncErrorCategory::PermissionRequired
                    | SyncErrorCategory::SyncDisabled
                    | SyncErrorCategory::Offline
                    | SyncErrorCategory::Server
            )
        ) {
            return Ok(None);
        }

        inner.status.phase = if inner.status.enabled {
            SyncPhase::Idle
        } else {
            SyncPhase::Disabled
        };
        inner.status.last_error = None;
        inner.status.last_error_category = None;
        inner.status.transfer = SyncTransferStatus::default();
        inner.status.updated_at_ms = now_ms();
        Ok(Some(inner.status.clone()))
    }

    pub fn update_workspace_name(
        &self,
        workspace_id: &str,
        workspace_name: String,
    ) -> SyncResult<Option<SyncRuntimeStatus>> {
        let mut inner = self.inner.lock();
        if !inner.status.configured {
            return Ok(None);
        }
        if inner.status.remote_workspace_id.as_deref() != Some(workspace_id) {
            return Ok(None);
        }
        inner.status.workspace_name = Some(workspace_name);
        inner.status.updated_at_ms = now_ms();
        Ok(Some(inner.status.clone()))
    }

    pub fn set_phase(&self, phase: SyncPhase) -> SyncResult<SyncRuntimeStatus> {
        let mut inner = self.inner.lock();
        if !inner.status.configured {
            return Err(SyncError::NotConfigured);
        }
        if !inner.status.enabled && !matches!(phase, SyncPhase::Disabled) {
            return Err(SyncError::InvalidArgument(
                "sync must be enabled before entering an active phase".into(),
            ));
        }
        inner.status.phase = phase;
        inner.status.last_error = None;
        inner.status.last_error_category = None;
        if !matches!(inner.status.phase, SyncPhase::Transferring) {
            inner.status.transfer = SyncTransferStatus::default();
        }
        inner.status.updated_at_ms = now_ms();
        Ok(inner.status.clone())
    }

    pub fn apply_transfer_progress(
        &self,
        run_id: u64,
        event: TransferProgressEvent,
    ) -> SyncResult<Option<SyncRuntimeStatus>> {
        let mut inner = self.inner.lock();
        if inner.active_run_id != Some(run_id) {
            return Ok(None);
        }
        if !inner.status.configured {
            return Err(SyncError::NotConfigured);
        }
        if !inner.status.enabled {
            return Err(SyncError::InvalidArgument(
                "sync must be enabled before reporting transfer progress".into(),
            ));
        }

        let timestamp = now_ms();
        match event {
            TransferProgressEvent::BatchStarted {
                direction,
                total_objects,
                attempt,
                max_attempts,
            } => {
                let mut transfer = SyncTransferStatus {
                    active: true,
                    direction: sync_transfer_direction(direction),
                    retrying: false,
                    retry_attempt: Some(attempt),
                    max_attempts: Some(max_attempts),
                    ..SyncTransferStatus::default()
                };
                match direction {
                    TransferDirection::Upload => transfer.upload_total_objects = total_objects,
                    TransferDirection::Download => {
                        transfer.download_total_objects = total_objects;
                    }
                }
                inner.status.phase = SyncPhase::Transferring;
                inner.status.last_error = None;
                inner.status.last_error_category = None;
                inner.status.transfer = transfer;
            }
            TransferProgressEvent::ObjectCompleted { direction } => {
                increment_transfer_count(
                    &mut inner.status.transfer,
                    direction,
                    TransferCount::Completed,
                );
            }
            TransferProgressEvent::ObjectFailed { direction, message } => {
                increment_transfer_count(
                    &mut inner.status.transfer,
                    direction,
                    TransferCount::Failed,
                );
                inner.status.transfer.last_transfer_error = Some(message);
            }
            TransferProgressEvent::RetryScheduled {
                direction,
                next_attempt,
                max_attempts,
                next_retry_at_ms,
                message,
            } => {
                inner.status.transfer.active = true;
                inner.status.transfer.direction = sync_transfer_direction(direction);
                inner.status.transfer.retrying = true;
                inner.status.transfer.retry_attempt = Some(next_attempt);
                inner.status.transfer.max_attempts = Some(max_attempts);
                inner.status.transfer.next_retry_at_ms = Some(next_retry_at_ms);
                inner.status.transfer.last_transfer_error = Some(message);
            }
            TransferProgressEvent::BatchCompleted { direction } => {
                inner.status.phase = transfer_return_phase(direction);
                inner.status.transfer = SyncTransferStatus::default();
                inner.status.last_error = None;
                inner.status.last_error_category = None;
            }
            TransferProgressEvent::BatchFailed { message, .. } => {
                inner.status.transfer = SyncTransferStatus {
                    last_transfer_error: Some(message),
                    ..SyncTransferStatus::default()
                };
            }
        }
        inner.status.updated_at_ms = timestamp;
        Ok(Some(inner.status.clone()))
    }

    #[allow(dead_code)]
    pub fn set_error(&self, error: &SyncError) -> SyncResult<SyncRuntimeStatus> {
        let mut inner = self.inner.lock();
        if !inner.status.configured {
            return Err(SyncError::NotConfigured);
        }
        inner.status.phase = SyncPhase::Error;
        inner.status.last_error = Some(error.to_string());
        inner.status.last_error_category = Some(error.category());
        inner.status.transfer = SyncTransferStatus {
            last_transfer_error: inner
                .status
                .transfer
                .last_transfer_error
                .clone()
                .or_else(|| Some(error.to_string())),
            ..SyncTransferStatus::default()
        };
        inner.status.updated_at_ms = now_ms();
        Ok(inner.status.clone())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum TransferCount {
    Completed,
    Failed,
}

fn increment_transfer_count(
    transfer: &mut SyncTransferStatus,
    direction: TransferDirection,
    count: TransferCount,
) {
    let (completed, failed, total) = match direction {
        TransferDirection::Upload => (
            &mut transfer.upload_completed_objects,
            &mut transfer.upload_failed_objects,
            transfer.upload_total_objects,
        ),
        TransferDirection::Download => (
            &mut transfer.download_completed_objects,
            &mut transfer.download_failed_objects,
            transfer.download_total_objects,
        ),
    };
    let target = match count {
        TransferCount::Completed => completed,
        TransferCount::Failed => failed,
    };
    *target = target.saturating_add(1);
    if total > 0 {
        *target = (*target).min(total);
    }
}

fn sync_transfer_direction(direction: TransferDirection) -> SyncTransferDirection {
    match direction {
        TransferDirection::Upload => SyncTransferDirection::Upload,
        TransferDirection::Download => SyncTransferDirection::Download,
    }
}

fn transfer_return_phase(direction: TransferDirection) -> SyncPhase {
    match direction {
        TransferDirection::Upload => SyncPhase::Publishing,
        TransferDirection::Download => SyncPhase::Applying,
    }
}

fn next_run_id(current: u64) -> u64 {
    let next = current.wrapping_add(1);
    if next == 0 { 1 } else { next }
}

fn validate_config(config: &SyncVaultConfig) -> SyncResult<()> {
    if config.vault_id.trim().is_empty() {
        return Err(SyncError::InvalidArgument("vault_id is required".into()));
    }
    if config.root_path.trim().is_empty() {
        return Err(SyncError::InvalidArgument("root_path is required".into()));
    }
    Ok(())
}

fn vault_name_from_root(root_path: &str) -> Option<String> {
    std::path::Path::new(root_path)
        .file_name()
        .and_then(|value| value.to_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(i64::MAX as u128) as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::errors::SyncErrorCategory;
    use super::*;

    fn config() -> SyncVaultConfig {
        SyncVaultConfig {
            vault_id: "vault_1".into(),
            root_path: "/tmp/vault".into(),
            account_key_id: None,
            remote_workspace_id: "workspace_1".into(),
            workspace_name: None,
            device_id: "device_1".into(),
            device_name: None,
            remember_workspace_key: true,
            passphrase: None,
        }
    }

    #[test]
    fn state_starts_not_configured() {
        let state = SyncState::new();

        let status = state.status();

        assert!(!status.configured);
        assert!(!status.enabled);
        assert_eq!(status.phase, SyncPhase::NotConfigured);
        assert_eq!(status.conflict_count, 0);
        assert_eq!(status.transfer, SyncTransferStatus::default());
    }

    #[test]
    fn configure_then_enable_updates_status() {
        let state = SyncState::new();

        let configured = state.configure_vault(config()).unwrap();
        assert!(configured.configured);
        assert!(!configured.enabled);
        assert_eq!(configured.phase, SyncPhase::Disabled);

        let enabled = state.set_enabled(true).unwrap();
        assert!(enabled.enabled);
        assert_eq!(enabled.phase, SyncPhase::Idle);
        assert_eq!(enabled.pending_uploads, 0);
        assert_eq!(enabled.transfer, SyncTransferStatus::default());
    }

    #[test]
    fn update_workspace_name_updates_current_workspace_only() {
        let state = SyncState::new();
        state.configure_vault(config()).unwrap();

        let ignored = state
            .update_workspace_name("workspace_other", "Other".into())
            .unwrap();
        assert!(ignored.is_none());
        assert_eq!(state.status().workspace_name, None);

        let updated = state
            .update_workspace_name("workspace_1", "Renamed".into())
            .unwrap()
            .unwrap();

        assert_eq!(updated.workspace_name.as_deref(), Some("Renamed"));
        assert_eq!(state.status().workspace_name.as_deref(), Some("Renamed"));
    }

    #[test]
    fn enable_requires_configuration() {
        let state = SyncState::new();

        let err = state.set_enabled(true).unwrap_err();

        assert!(matches!(err, SyncError::NotConfigured));
    }

    #[test]
    fn phase_updates_require_enabled_sync() {
        let state = SyncState::new();
        state.configure_vault(config()).unwrap();

        let disabled_err = state.set_phase(SyncPhase::Planning).unwrap_err();
        assert!(matches!(disabled_err, SyncError::InvalidArgument(_)));

        state.set_enabled(true).unwrap();
        let planning = state.set_phase(SyncPhase::Planning).unwrap();
        assert_eq!(planning.phase, SyncPhase::Planning);

        let error = state
            .set_error(&SyncError::Transport("push failed".into()))
            .unwrap();
        assert_eq!(error.phase, SyncPhase::Error);
        assert_eq!(
            error.last_error.as_deref(),
            Some("sync transport error: push failed")
        );
        assert_eq!(error.last_error_category, Some(SyncErrorCategory::Unknown));
    }

    #[test]
    fn manual_sync_updates_last_synced_timestamp() {
        let state = SyncState::new();
        state.configure_vault(config()).unwrap();
        state.set_enabled(true).unwrap();

        let status = state.complete_manual_sync(2).unwrap();

        assert_eq!(status.phase, SyncPhase::Idle);
        assert_eq!(status.conflict_count, 2);
        assert!(status.last_synced_at_ms.is_some());
        assert_eq!(status.transfer, SyncTransferStatus::default());
    }

    #[test]
    fn pending_counts_update_runtime_status() {
        let state = SyncState::new();
        state.configure_vault(config()).unwrap();
        state.set_enabled(true).unwrap();

        let status = state.set_pending_counts(2, 1).unwrap();

        assert_eq!(status.pending_uploads, 2);
        assert_eq!(status.pending_downloads, 1);
        assert!(status.updated_at_ms > 0);
    }

    #[test]
    fn remote_status_success_clears_connectivity_error() {
        let state = SyncState::new();
        state.configure_vault(config()).unwrap();
        state.set_enabled(true).unwrap();
        state
            .set_error(&SyncError::Offline("network failed".into()))
            .unwrap();

        let status = state.clear_remote_status_error().unwrap().unwrap();

        assert_eq!(status.phase, SyncPhase::Idle);
        assert_eq!(status.last_error_category, None);
        assert_eq!(status.last_error, None);
    }

    #[test]
    fn begin_sync_run_prevents_overlapping_runs_without_status_mutation() {
        let state = SyncState::new();
        state.configure_vault(config()).unwrap();
        state.set_enabled(true).unwrap();

        let run_id = state.begin_sync_run().unwrap();
        let before = state.status();
        let err = state.begin_sync_run().unwrap_err();
        let after = state.status();

        assert!(
            matches!(err, SyncError::InvalidArgument(message) if message == "sync is already running")
        );
        assert_eq!(after, before);

        state.finish_sync_run(run_id);
        assert!(state.begin_sync_run().is_ok());
    }

    #[test]
    fn stale_transfer_progress_is_ignored() {
        let state = SyncState::new();
        state.configure_vault(config()).unwrap();
        state.set_enabled(true).unwrap();
        let run_id = state.begin_sync_run().unwrap();

        let status = state
            .apply_transfer_progress(
                run_id + 1,
                TransferProgressEvent::BatchStarted {
                    direction: TransferDirection::Upload,
                    total_objects: 1,
                    attempt: 1,
                    max_attempts: 3,
                },
            )
            .unwrap();

        assert!(status.is_none());
        assert_eq!(state.status().phase, SyncPhase::Idle);
    }

    #[test]
    fn transfer_progress_tracks_upload_retry_and_completion() {
        let state = SyncState::new();
        state.configure_vault(config()).unwrap();
        state.set_enabled(true).unwrap();
        let run_id = state.begin_sync_run().unwrap();

        let started = state
            .apply_transfer_progress(
                run_id,
                TransferProgressEvent::BatchStarted {
                    direction: TransferDirection::Upload,
                    total_objects: 3,
                    attempt: 1,
                    max_attempts: 3,
                },
            )
            .unwrap()
            .unwrap();
        assert_eq!(started.phase, SyncPhase::Transferring);
        assert!(started.transfer.active);
        assert_eq!(started.transfer.direction, SyncTransferDirection::Upload);
        assert_eq!(started.transfer.upload_total_objects, 3);

        let completed = state
            .apply_transfer_progress(
                run_id,
                TransferProgressEvent::ObjectCompleted {
                    direction: TransferDirection::Upload,
                },
            )
            .unwrap()
            .unwrap();
        assert_eq!(completed.transfer.upload_completed_objects, 1);

        let retrying = state
            .apply_transfer_progress(
                run_id,
                TransferProgressEvent::RetryScheduled {
                    direction: TransferDirection::Upload,
                    next_attempt: 2,
                    max_attempts: 3,
                    next_retry_at_ms: 123,
                    message: "expired".into(),
                },
            )
            .unwrap()
            .unwrap();
        assert!(retrying.transfer.retrying);
        assert_eq!(retrying.transfer.retry_attempt, Some(2));
        assert_eq!(retrying.transfer.next_retry_at_ms, Some(123));
        assert_eq!(
            retrying.transfer.last_transfer_error.as_deref(),
            Some("expired")
        );

        let published = state
            .apply_transfer_progress(
                run_id,
                TransferProgressEvent::BatchCompleted {
                    direction: TransferDirection::Upload,
                },
            )
            .unwrap()
            .unwrap();
        assert_eq!(published.phase, SyncPhase::Publishing);
        assert_eq!(published.transfer, SyncTransferStatus::default());
    }

    #[test]
    fn transfer_progress_restores_applying_after_download_completion() {
        let state = SyncState::new();
        state.configure_vault(config()).unwrap();
        state.set_enabled(true).unwrap();
        let run_id = state.begin_sync_run().unwrap();

        state
            .apply_transfer_progress(
                run_id,
                TransferProgressEvent::BatchStarted {
                    direction: TransferDirection::Download,
                    total_objects: 2,
                    attempt: 1,
                    max_attempts: 3,
                },
            )
            .unwrap();
        let applying = state
            .apply_transfer_progress(
                run_id,
                TransferProgressEvent::BatchCompleted {
                    direction: TransferDirection::Download,
                },
            )
            .unwrap()
            .unwrap();

        assert_eq!(applying.phase, SyncPhase::Applying);
        assert_eq!(applying.transfer, SyncTransferStatus::default());
    }

    #[test]
    fn transfer_failure_leaves_inactive_status_with_error_message() {
        let state = SyncState::new();
        state.configure_vault(config()).unwrap();
        state.set_enabled(true).unwrap();
        let run_id = state.begin_sync_run().unwrap();

        state
            .apply_transfer_progress(
                run_id,
                TransferProgressEvent::BatchStarted {
                    direction: TransferDirection::Download,
                    total_objects: 1,
                    attempt: 1,
                    max_attempts: 3,
                },
            )
            .unwrap();
        let failed = state
            .apply_transfer_progress(
                run_id,
                TransferProgressEvent::BatchFailed {
                    direction: TransferDirection::Download,
                    message: "network failed".into(),
                },
            )
            .unwrap()
            .unwrap();

        assert!(!failed.transfer.active);
        assert_eq!(failed.transfer.direction, SyncTransferDirection::Idle);
        assert_eq!(
            failed.transfer.last_transfer_error.as_deref(),
            Some("network failed")
        );

        let error = state
            .set_error(&SyncError::Offline("network failed".into()))
            .unwrap();
        assert_eq!(error.phase, SyncPhase::Error);
        assert!(!error.transfer.active);
        assert_eq!(
            error.transfer.last_transfer_error.as_deref(),
            Some("network failed")
        );
    }
}
