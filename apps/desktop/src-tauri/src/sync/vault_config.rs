use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::errors::{SyncError, SyncResult};
use super::keys;
use super::types::{SyncRemoteStatus, SyncVaultConfig};

const CONFIG_DIR_NAME: &str = ".kuku";
const CONFIG_FILE_NAME: &str = "sync.json";
const SCHEMA_VERSION: u32 = 2;

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct SyncVaultConfigVersion {
    schema_version: u32,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SyncVaultConfigFile {
    pub schema_version: u32,
    pub vault_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_key_id: Option<String>,
    pub remote_workspace_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_name: Option<String>,
    pub device_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device_name: Option<String>,
    pub enabled: bool,
    pub remember_workspace_key: bool,
    pub secure: SyncVaultSecureRefs,
    #[serde(default, skip_serializing_if = "SyncVaultStatusFile::is_empty")]
    pub status: SyncVaultStatusFile,
    pub updated_at_ms: i64,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SyncVaultSecureRefs {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_root_key_account: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_recovery_phrase_account: Option<String>,
    pub workspace_key_account: String,
    pub passphrase_account: String,
    pub device_signing_key_account: String,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SyncVaultStatusFile {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_synced_at_ms: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remote: Option<SyncRemoteStatus>,
}

impl SyncVaultStatusFile {
    fn is_empty(&self) -> bool {
        self.last_synced_at_ms.is_none() && self.remote.is_none()
    }
}

pub fn sync_config_path(vault_root: &Path) -> PathBuf {
    vault_root.join(CONFIG_DIR_NAME).join(CONFIG_FILE_NAME)
}

pub fn delete_sync_config(vault_root: &Path) -> SyncResult<()> {
    let path = sync_config_path(vault_root);
    match fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(SyncError::Storage(format!(
            "failed to delete vault sync config {}: {error}",
            path.display()
        ))),
    }
}

pub fn read_sync_config(vault_root: &Path) -> SyncResult<Option<SyncVaultConfigFile>> {
    let Some((bytes, _path)) = read_sync_config_bytes(vault_root)? else {
        return Ok(None);
    };
    let version: SyncVaultConfigVersion = serde_json::from_slice(&bytes)?;
    if version.schema_version != SCHEMA_VERSION {
        return Err(SyncError::UnsupportedVersion(
            version.schema_version.min(u8::MAX as u32) as u8,
        ));
    }
    let config: SyncVaultConfigFile = serde_json::from_slice(&bytes)?;
    validate_config_file(&config)?;
    Ok(Some(config))
}

pub fn reset_sync_config(vault_root: &Path) -> SyncResult<()> {
    if let Ok(Some(config)) = read_sync_config_file_unchecked(vault_root)
        && let Some(vault_id) = trimmed_optional(Some(&config.vault_id))
    {
        keys::forget_workspace_key(&vault_id)?;
        keys::forget_passphrase(&vault_id)?;
        keys::forget_device_signing_key(&vault_id)?;
    }
    delete_sync_config(vault_root)
}

fn read_sync_config_file_unchecked(vault_root: &Path) -> SyncResult<Option<SyncVaultConfigFile>> {
    let Some((bytes, _path)) = read_sync_config_bytes(vault_root)? else {
        return Ok(None);
    };
    serde_json::from_slice(&bytes).map(Some).map_err(Into::into)
}

fn read_sync_config_bytes(vault_root: &Path) -> SyncResult<Option<(Vec<u8>, PathBuf)>> {
    let path = sync_config_path(vault_root);
    if !path.exists() {
        return Ok(None);
    }

    let bytes = fs::read(&path).map_err(|error| {
        SyncError::Storage(format!(
            "failed to read vault sync config {}: {error}",
            path.display()
        ))
    })?;
    Ok(Some((bytes, path)))
}

pub fn write_sync_config(
    vault_root: &Path,
    config: &SyncVaultConfig,
    enabled: bool,
    updated_at_ms: i64,
) -> SyncResult<SyncVaultConfigFile> {
    let status = read_sync_config(vault_root)?
        .filter(|existing| existing.remote_workspace_id == config.remote_workspace_id.trim())
        .map(|existing| existing.status)
        .unwrap_or_default();
    write_sync_config_with_status(vault_root, config, enabled, updated_at_ms, status)
}

pub fn write_sync_config_with_status(
    vault_root: &Path,
    config: &SyncVaultConfig,
    enabled: bool,
    updated_at_ms: i64,
    status: SyncVaultStatusFile,
) -> SyncResult<SyncVaultConfigFile> {
    let config_file = config_file_from_runtime(config, enabled, updated_at_ms, status)?;
    let path = sync_config_path(vault_root);
    let parent = path
        .parent()
        .ok_or_else(|| SyncError::Storage("vault sync config path has no parent".into()))?;
    fs::create_dir_all(parent).map_err(|error| {
        SyncError::Storage(format!(
            "failed to create vault sync config directory {}: {error}",
            parent.display()
        ))
    })?;
    let bytes = serde_json::to_vec_pretty(&config_file)?;
    fs::write(&path, bytes).map_err(|error| {
        SyncError::Storage(format!(
            "failed to write vault sync config {}: {error}",
            path.display()
        ))
    })?;
    Ok(config_file)
}

pub fn runtime_config_from_file(
    vault_root: &Path,
    config: &SyncVaultConfigFile,
) -> SyncVaultConfig {
    SyncVaultConfig {
        vault_id: config.vault_id.clone(),
        root_path: vault_root.to_string_lossy().to_string(),
        account_key_id: config.account_key_id.clone(),
        remote_workspace_id: config.remote_workspace_id.clone(),
        workspace_name: config.workspace_name.clone(),
        device_id: config.device_id.clone(),
        device_name: config.device_name.clone(),
        remember_workspace_key: config.remember_workspace_key,
        passphrase: None,
    }
}

fn config_file_from_runtime(
    config: &SyncVaultConfig,
    enabled: bool,
    updated_at_ms: i64,
    status: SyncVaultStatusFile,
) -> SyncResult<SyncVaultConfigFile> {
    if config.vault_id.trim().is_empty() {
        return Err(SyncError::InvalidArgument("vault_id is required".into()));
    }
    if config.remote_workspace_id.trim().is_empty() {
        return Err(SyncError::InvalidArgument(
            "remote_workspace_id is required".into(),
        ));
    }
    if config.device_id.trim().is_empty() {
        return Err(SyncError::InvalidArgument("device_id is required".into()));
    }

    let workspace_id = config.remote_workspace_id.trim();
    let status = status_for_workspace(status, workspace_id);
    let account_key_id = trimmed_optional(config.account_key_id.as_deref());

    Ok(SyncVaultConfigFile {
        schema_version: SCHEMA_VERSION,
        vault_id: config.vault_id.trim().to_string(),
        account_key_id: account_key_id.clone(),
        remote_workspace_id: workspace_id.to_string(),
        workspace_name: trimmed_optional(config.workspace_name.as_deref()),
        device_id: config.device_id.trim().to_string(),
        device_name: trimmed_optional(config.device_name.as_deref()),
        enabled,
        remember_workspace_key: config.remember_workspace_key,
        secure: SyncVaultSecureRefs {
            account_root_key_account: account_key_id
                .as_deref()
                .map(keys::account_root_key_account),
            account_recovery_phrase_account: account_key_id
                .as_deref()
                .map(keys::account_recovery_phrase_account),
            workspace_key_account: keys::workspace_key_account(config.vault_id.trim()),
            passphrase_account: keys::passphrase_account(config.vault_id.trim()),
            device_signing_key_account: keys::device_signing_key_account(config.vault_id.trim()),
        },
        status,
        updated_at_ms,
    })
}

fn status_for_workspace(status: SyncVaultStatusFile, workspace_id: &str) -> SyncVaultStatusFile {
    match status.remote.as_ref() {
        Some(remote) if remote.workspace_id == workspace_id => status,
        Some(_) => SyncVaultStatusFile::default(),
        None => status,
    }
}

fn validate_config_file(config: &SyncVaultConfigFile) -> SyncResult<()> {
    if config.schema_version != SCHEMA_VERSION {
        return Err(SyncError::UnsupportedVersion(
            config.schema_version.min(u8::MAX as u32) as u8,
        ));
    }
    if config.vault_id.trim().is_empty() {
        return Err(SyncError::InvalidArgument(
            "vault sync config is missing vault_id".into(),
        ));
    }
    if config.remote_workspace_id.trim().is_empty() {
        return Err(SyncError::InvalidArgument(
            "vault sync config is missing remote_workspace_id".into(),
        ));
    }
    if config.device_id.trim().is_empty() {
        return Err(SyncError::InvalidArgument(
            "vault sync config is missing device_id".into(),
        ));
    }
    if let Some(account_key_id) = &config.account_key_id
        && account_key_id.trim().is_empty()
    {
        return Err(SyncError::InvalidArgument(
            "vault sync config has empty account_key_id".into(),
        ));
    }
    if let Some(remote) = &config.status.remote
        && remote.workspace_id != config.remote_workspace_id
    {
        return Err(SyncError::InvalidArgument(
            "vault sync status remote workspace does not match config".into(),
        ));
    }
    Ok(())
}

fn trimmed_optional(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sync_config_roundtrips_non_secret_vault_settings() {
        let root = temp_vault("roundtrip");
        let config = SyncVaultConfig {
            vault_id: "vault_1".into(),
            root_path: root.to_string_lossy().to_string(),
            account_key_id: Some("account_1".into()),
            remote_workspace_id: "workspace_1".into(),
            workspace_name: Some("Personal Notes".into()),
            device_id: "device_1".into(),
            device_name: Some("Mansuiki Mac".into()),
            remember_workspace_key: true,
            passphrase: Some("super-secret-passphrase".into()),
        };

        let written = write_sync_config(&root, &config, true, 123).unwrap();
        let raw = fs::read_to_string(sync_config_path(&root)).unwrap();
        let loaded = read_sync_config(&root).unwrap().unwrap();
        let runtime = runtime_config_from_file(&root, &loaded);

        assert_eq!(written, loaded);
        assert!(loaded.enabled);
        assert_eq!(runtime.vault_id, "vault_1");
        assert_eq!(runtime.account_key_id.as_deref(), Some("account_1"));
        assert_eq!(runtime.remote_workspace_id, "workspace_1");
        assert_eq!(runtime.workspace_name.as_deref(), Some("Personal Notes"));
        assert_eq!(runtime.device_id, "device_1");
        assert_eq!(runtime.device_name.as_deref(), Some("Mansuiki Mac"));
        assert_eq!(runtime.passphrase, None);
        assert!(!raw.contains("super-secret-passphrase"));
        assert!(raw.contains("sync-account:account_1:root-key:v1"));
        assert!(raw.contains("sync-account:account_1:recovery-phrase:v1"));
        assert!(raw.contains("vault:vault_1:workspace-key:v1"));

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn sync_config_roundtrips_status_snapshot() {
        let root = temp_vault("status");
        let config = SyncVaultConfig {
            vault_id: "vault_1".into(),
            root_path: root.to_string_lossy().to_string(),
            account_key_id: None,
            remote_workspace_id: "workspace_1".into(),
            workspace_name: None,
            device_id: "device_1".into(),
            device_name: None,
            remember_workspace_key: true,
            passphrase: None,
        };
        let status = SyncVaultStatusFile {
            last_synced_at_ms: Some(456),
            remote: Some(SyncRemoteStatus {
                workspace_id: "workspace_1".into(),
                remote_head_commit_id: "remote_head".into(),
                remote_head_version: 7,
                latest_checkpoint_commit_id: "checkpoint_1".into(),
                local_remote_head_commit_id: Some("remote_base".into()),
                local_head_commit_id: Some("local_head".into()),
                has_remote_changes: true,
                checked_at_ms: 789,
            }),
        };

        write_sync_config_with_status(&root, &config, true, 123, status.clone()).unwrap();
        let raw = fs::read_to_string(sync_config_path(&root)).unwrap();
        let loaded = read_sync_config(&root).unwrap().unwrap();

        assert_eq!(loaded.status, status);
        assert!(raw.contains("\"status\""));
        assert!(raw.contains("\"lastSyncedAtMs\": 456"));
        assert!(raw.contains("\"remoteHeadVersion\": 7"));

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn legacy_schema_v1_config_is_rejected_for_reset() {
        let root = temp_vault("schema-v1");
        let json = r#"{
  "schemaVersion": 1,
  "vaultId": "vault_1",
  "remoteWorkspaceId": "workspace_1",
  "deviceId": "device_1",
  "enabled": true,
  "rememberWorkspaceKey": true,
  "secure": {
    "workspaceKeyAccount": "vault:vault_1:workspace-key:v1",
    "passphraseAccount": "vault:vault_1:passphrase:v1",
    "deviceSigningKeyAccount": "vault:vault_1:device-signing-key:v1"
  },
  "status": {
    "lastSyncedAtMs": 456,
    "remote": {
      "workspaceId": "workspace_1",
      "remoteHeadCommitId": "remote_head",
      "remoteHeadVersion": 7,
      "latestCheckpointCommitId": "checkpoint_1",
      "localRemoteHeadCommitId": "remote_base",
      "localHeadCommitId": "local_head",
      "hasRemoteChanges": false,
      "checkedAtMs": 789
    }
  },
  "updatedAtMs": 123
}"#;
        fs::create_dir_all(sync_config_path(&root).parent().unwrap()).unwrap();
        fs::write(sync_config_path(&root), json).unwrap();

        assert!(matches!(
            read_sync_config(&root),
            Err(SyncError::UnsupportedVersion(1))
        ));
        reset_sync_config(&root).unwrap();
        assert!(!sync_config_path(&root).exists());

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn missing_sync_config_returns_none() {
        let root = temp_vault("missing");

        assert!(read_sync_config(&root).unwrap().is_none());

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn delete_sync_config_removes_file_and_ignores_missing_file() {
        let root = temp_vault("delete");
        let config = SyncVaultConfig {
            vault_id: "vault_1".into(),
            root_path: root.to_string_lossy().to_string(),
            account_key_id: None,
            remote_workspace_id: "workspace_1".into(),
            workspace_name: None,
            device_id: "device_1".into(),
            device_name: None,
            remember_workspace_key: true,
            passphrase: None,
        };

        write_sync_config(&root, &config, true, 123).unwrap();
        delete_sync_config(&root).unwrap();
        delete_sync_config(&root).unwrap();

        assert!(read_sync_config(&root).unwrap().is_none());
        fs::remove_dir_all(root).unwrap();
    }

    fn temp_vault(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "kuku-sync-vault-config-{name}-{}-{}",
            std::process::id(),
            crate::sync::now_ms()
        ));
        fs::create_dir_all(&root).unwrap();
        root
    }
}
