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

use std::time::{SystemTime, UNIX_EPOCH};

use parking_lot::Mutex;

use self::errors::{SyncError, SyncResult};
use self::types::{SyncPhase, SyncRuntimeStatus, SyncVaultConfig};

pub struct SyncState {
    inner: Mutex<SyncInner>,
}

struct SyncInner {
    status: SyncRuntimeStatus,
}

impl SyncState {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(SyncInner {
                status: SyncRuntimeStatus::not_configured(now_ms()),
            }),
        }
    }

    pub fn status(&self) -> SyncRuntimeStatus {
        self.inner.lock().status.clone()
    }

    pub fn configure_vault(&self, config: SyncVaultConfig) -> SyncResult<SyncRuntimeStatus> {
        validate_config(&config)?;
        let mut inner = self.inner.lock();
        inner.status = SyncRuntimeStatus {
            configured: true,
            enabled: false,
            phase: SyncPhase::Disabled,
            vault_id: Some(config.vault_id),
            root_path: Some(config.root_path),
            remote_workspace_id: Some(config.remote_workspace_id),
            device_id: Some(config.device_id),
            remember_workspace_key: config.remember_workspace_key,
            last_error: None,
            last_synced_at_ms: None,
            pending_uploads: 0,
            pending_downloads: 0,
            conflict_count: 0,
            updated_at_ms: now_ms(),
        };
        Ok(inner.status.clone())
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
        inner.status.updated_at_ms = now_ms();
        Ok(inner.status.clone())
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
        inner.status.last_synced_at_ms = Some(timestamp);
        inner.status.pending_uploads = 0;
        inner.status.pending_downloads = 0;
        inner.status.conflict_count = conflict_count;
        inner.status.updated_at_ms = timestamp;
        Ok(inner.status.clone())
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
        inner.status.updated_at_ms = now_ms();
        Ok(inner.status.clone())
    }

    #[allow(dead_code)]
    pub fn set_error(&self, message: impl Into<String>) -> SyncResult<SyncRuntimeStatus> {
        let mut inner = self.inner.lock();
        if !inner.status.configured {
            return Err(SyncError::NotConfigured);
        }
        inner.status.phase = SyncPhase::Error;
        inner.status.last_error = Some(message.into());
        inner.status.updated_at_ms = now_ms();
        Ok(inner.status.clone())
    }
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

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(i64::MAX as u128) as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config() -> SyncVaultConfig {
        SyncVaultConfig {
            vault_id: "vault_1".into(),
            root_path: "/tmp/vault".into(),
            remote_workspace_id: "workspace_1".into(),
            device_id: "device_1".into(),
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

        let error = state.set_error("push failed").unwrap();
        assert_eq!(error.phase, SyncPhase::Error);
        assert_eq!(error.last_error.as_deref(), Some("push failed"));
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
    }
}
