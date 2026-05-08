use std::path::{Path, PathBuf};
use std::sync::Arc;

use ed25519_dalek::SigningKey;
use kuku_contract::proto::kuku::sync::v1::SyncKeyRecipientType;
use rusqlite::Connection;
use tauri::{AppHandle, Emitter, Manager, State, command};

use crate::search::SearchState;
use crate::vault::VaultState;
use crate::{auth, auth_commands, vault};

use super::SyncState;
use super::applier::{
    PullRemoteChangesInput, RemoteApplyHooks, SyncPullPipeline, unlock_workspace_key_from_envelopes,
};
use super::checkpoint::{
    CRYPTO_VERSION, PushLocalChangesInput, PushMergeCommitInput, SyncPushPipeline,
};
use super::client::{
    ConnectSyncClient, PutKeyEnvelopeInput, SyncCommitApi, SyncHead, SyncSetupApi, SyncTransferApi,
};
use super::crypto::SymmetricKey;
use super::db::{self, SyncVaultRecord};
use super::errors::command_error;
use super::errors::{SyncCommandError, SyncError, SyncResult};
use super::keys;
use super::planner::PlannerConfig;
use super::transfer::{
    ObjectTransferQueue, ReqwestObjectTransferHttp, TransferProgressEvent, TransferProgressSink,
    TransferQueueConfig,
};
use super::types::{
    SYNC_STATUS_EVENT, SyncConflictSummary, SyncPhase, SyncRemoteStatus, SyncRuntimeStatus,
    SyncStatusEvent, SyncVaultConfig,
};

const CORE_SYNC_PLUGIN_ID: &str = "core-sync";

#[command]
pub async fn sync_get_status(
    state: State<'_, SyncState>,
) -> Result<SyncRuntimeStatus, SyncCommandError> {
    status_with_conflicts(&state).map_err(command_error)
}

#[command]
pub async fn sync_get_remote_status(
    app: AppHandle,
    state: State<'_, SyncState>,
) -> Result<SyncRemoteStatus, SyncCommandError> {
    let status = state.status();
    let remote_status = get_remote_status_for_state(&status)
        .await
        .map_err(command_error)?;
    if let Ok(Some(status)) = state.clear_remote_status_error() {
        emit_status(&app, &status);
    }
    Ok(remote_status)
}

#[command]
pub async fn sync_configure_vault(
    app: AppHandle,
    state: State<'_, SyncState>,
    config: SyncVaultConfig,
) -> Result<SyncRuntimeStatus, SyncCommandError> {
    let config = prepare_sync_config(config).await.map_err(command_error)?;
    let status = state.configure_vault(config).map_err(command_error)?;
    emit_status(&app, &status);
    Ok(status)
}

#[command]
pub async fn sync_set_enabled(
    app: AppHandle,
    state: State<'_, SyncState>,
    enabled: bool,
) -> Result<SyncRuntimeStatus, SyncCommandError> {
    let status = state.set_enabled(enabled).map_err(command_error)?;
    emit_status(&app, &status);
    Ok(status)
}

#[command]
pub async fn sync_run_once(
    app: AppHandle,
    passphrase: Option<String>,
) -> Result<SyncRuntimeStatus, SyncCommandError> {
    let worker_app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|error| {
                SyncCommandError::server(format!("failed to create sync runtime: {error}"))
            })?;
        runtime.block_on(async move {
            let state = worker_app.state::<SyncState>();
            let vault_state = worker_app.state::<VaultState>();
            let search = worker_app.state::<SearchState>();
            let run_id = match state.begin_sync_run() {
                Ok(run_id) => run_id,
                Err(error) => return Err(command_error(error)),
            };
            let result = run_sync_once(
                &worker_app,
                &state,
                &vault_state,
                &search,
                passphrase,
                run_id,
            )
            .await;
            state.finish_sync_run(run_id);
            match result {
                Ok(status) => Ok(status),
                Err(error) => {
                    if let Ok(status) = state.set_error(&error) {
                        emit_status(&worker_app, &status);
                    }
                    Err(command_error(error))
                }
            }
        })
    })
    .await
    .map_err(|error| SyncCommandError::server(format!("sync worker failed: {error}")))?
}

#[command]
pub async fn sync_list_conflicts(
    state: State<'_, SyncState>,
) -> Result<Vec<SyncConflictSummary>, SyncCommandError> {
    list_open_conflicts_for_status(&state).map_err(command_error)
}

fn emit_status(app: &AppHandle, status: &SyncRuntimeStatus) {
    let _ = app.emit(
        SYNC_STATUS_EVENT,
        SyncStatusEvent {
            status: status.clone(),
        },
    );
}

struct RuntimeTransferProgressSink {
    app: AppHandle,
    run_id: u64,
}

impl TransferProgressSink for RuntimeTransferProgressSink {
    fn on_transfer_progress(&self, event: TransferProgressEvent) {
        let state = self.app.state::<SyncState>();
        if let Ok(Some(status)) = state.apply_transfer_progress(self.run_id, event) {
            emit_status(&self.app, &status);
        }
    }
}

async fn prepare_sync_config(mut config: SyncVaultConfig) -> SyncResult<SyncVaultConfig> {
    validate_config_for_command(&config)?;
    let authorization = authorization_header().await?;
    let client = Arc::new(ConnectSyncClient::with_authorization_header(authorization));

    let workspace_id = config.remote_workspace_id.trim().to_string();
    let local_vault = if workspace_id.is_empty() {
        None
    } else {
        let conn = open_sync_db_for_vault(&config.vault_id)?;
        db::get_vault(&conn, &config.vault_id)?
    };
    let prepared = if workspace_id.is_empty() {
        prepare_new_workspace(&config, &client).await?
    } else {
        prepare_existing_workspace(&config, &client, local_vault).await?
    };

    config.remote_workspace_id = prepared.workspace_id;
    config.device_id = prepared.device_id;
    let mut conn = open_sync_db_for_vault(&config.vault_id)?;
    persist_configured_vault(&mut conn, &config)?;
    Ok(config)
}

struct PreparedSyncConfig {
    workspace_id: String,
    device_id: String,
}

async fn prepare_new_workspace(
    config: &SyncVaultConfig,
    client: &Arc<ConnectSyncClient>,
) -> SyncResult<PreparedSyncConfig> {
    let passphrase = required_passphrase(config)?;
    let workspace = client.create_workspace(CRYPTO_VERSION).await?;
    let workspace_key = keys::random_workspace_key();
    let signing_key = keys::random_device_signing_key();
    let device = register_device(client, &workspace.workspace_id, &signing_key).await?;
    put_passphrase_envelope(
        client,
        &workspace.workspace_id,
        &device.device_id,
        &workspace_key,
        passphrase,
    )
    .await?;
    persist_local_keys(config, &workspace_key, &signing_key)?;
    Ok(PreparedSyncConfig {
        workspace_id: workspace.workspace_id,
        device_id: device.device_id,
    })
}

async fn prepare_existing_workspace(
    config: &SyncVaultConfig,
    client: &Arc<ConnectSyncClient>,
    local_vault: Option<SyncVaultRecord>,
) -> SyncResult<PreparedSyncConfig> {
    let workspace_id = config.remote_workspace_id.trim().to_string();
    let workspace_key = match keys::read_remembered_workspace_key(&config.vault_id)? {
        Some(key) => key,
        None => {
            let passphrase = required_passphrase(config)?;
            let envelopes = client.list_key_envelopes(&workspace_id).await?;
            let (key, _) = unlock_workspace_key_from_envelopes(&envelopes, passphrase)?;
            key
        }
    };

    let signing_key = keys::read_device_signing_key(&config.vault_id)?;
    let (device_id, signing_key) = match (local_vault, signing_key) {
        (Some(vault), Some(signing_key)) if !vault.device_id.trim().is_empty() => {
            (vault.device_id, signing_key)
        }
        (_, Some(signing_key)) if !config.device_id.trim().is_empty() => {
            (config.device_id.trim().to_string(), signing_key)
        }
        _ => {
            let signing_key = keys::random_device_signing_key();
            let device = register_device(client, &workspace_id, &signing_key).await?;
            (device.device_id, signing_key)
        }
    };

    persist_local_keys(config, &workspace_key, &signing_key)?;
    Ok(PreparedSyncConfig {
        workspace_id,
        device_id,
    })
}

async fn register_device(
    client: &Arc<ConnectSyncClient>,
    workspace_id: &str,
    signing_key: &SigningKey,
) -> SyncResult<super::client::SyncDeviceMetadata> {
    client
        .register_device(
            workspace_id,
            signing_key.verifying_key().to_bytes().to_vec(),
            Vec::new(),
            Vec::new(),
        )
        .await
}

async fn put_passphrase_envelope(
    client: &Arc<ConnectSyncClient>,
    workspace_id: &str,
    device_id: &str,
    workspace_key: &SymmetricKey,
    passphrase: &str,
) -> SyncResult<()> {
    let envelope = keys::wrap_workspace_key_with_passphrase(
        workspace_id,
        "passphrase:v1",
        1,
        workspace_key,
        passphrase,
    )?;
    client
        .put_key_envelope(PutKeyEnvelopeInput {
            workspace_id: workspace_id.into(),
            envelope_id: envelope.envelope_id,
            recipient_type: SyncKeyRecipientType::SYNC_KEY_RECIPIENT_TYPE_PASSPHRASE,
            recipient_device_id: None,
            key_version: envelope.key_version,
            kdf_params_json: serde_json::to_string(&envelope.kdf)?,
            encrypted_envelope: serde_json::to_vec(&envelope.wrap)?,
            created_by_device_id: device_id.into(),
        })
        .await?;
    Ok(())
}

fn persist_local_keys(
    config: &SyncVaultConfig,
    workspace_key: &SymmetricKey,
    signing_key: &SigningKey,
) -> SyncResult<()> {
    if config.remember_workspace_key {
        keys::remember_workspace_key(&config.vault_id, workspace_key)?;
    } else {
        keys::forget_workspace_key(&config.vault_id)?;
    }
    keys::remember_device_signing_key(&config.vault_id, signing_key)
}

fn persist_configured_vault(conn: &mut Connection, config: &SyncVaultConfig) -> SyncResult<()> {
    let now_ms = super::now_ms();
    let existing = db::get_vault(conn, &config.vault_id)?;
    let vault = match existing {
        Some(mut vault) => {
            vault.root_path = config.root_path.clone();
            vault.remote_workspace_id = config.remote_workspace_id.clone();
            vault.device_id = config.device_id.clone();
            vault.enabled = true;
            vault.updated_at_ms = now_ms;
            vault
        }
        None => SyncVaultRecord {
            vault_id: config.vault_id.clone(),
            root_path: config.root_path.clone(),
            remote_workspace_id: config.remote_workspace_id.clone(),
            remote_head_commit_id: None,
            local_head_commit_id: None,
            device_id: config.device_id.clone(),
            next_device_seq: 1,
            enabled: true,
            created_at_ms: now_ms,
            updated_at_ms: now_ms,
        },
    };
    db::upsert_vault(conn, &vault)
}

async fn run_sync_once(
    app: &AppHandle,
    state: &SyncState,
    vault_state: &VaultState,
    search: &SearchState,
    passphrase: Option<String>,
    run_id: u64,
) -> SyncResult<SyncRuntimeStatus> {
    let status = state.status();
    validate_enabled_status(&status)?;
    let vault_id = required_status_value(status.vault_id.as_deref(), "vault_id")?.to_string();
    let workspace_id =
        required_status_value(status.remote_workspace_id.as_deref(), "remote_workspace_id")?
            .to_string();
    let device_id = required_status_value(status.device_id.as_deref(), "device_id")?.to_string();
    let vault_root = status_vault_root(&status, vault_state)?;
    let authorization = authorization_header().await?;
    let (client, transfer_queue) = sync_client_and_queue(app, run_id, authorization)?;
    let mut conn = open_sync_db_for_vault(&vault_id)?;
    let workspace_key = workspace_key_for_run(
        &vault_id,
        &workspace_id,
        status.remember_workspace_key,
        passphrase.as_deref(),
        client.as_ref(),
    )
    .await?;
    let signing_key = keys::read_device_signing_key(&vault_id)?.ok_or_else(|| {
        SyncError::Crypto("device signing key is missing; configure sync again".into())
    })?;

    emit_status(app, &state.set_phase(SyncPhase::Applying)?);
    let pull_pipeline = SyncPullPipeline::new(client.clone(), transfer_queue.clone());
    pull_pipeline
        .pull_remote_changes(PullRemoteChangesInput {
            conn: &mut conn,
            vault_id: &vault_id,
            vault_root: &vault_root,
            workspace_id: &workspace_id,
            device_id: &device_id,
            workspace_key: &workspace_key,
            hooks: RemoteApplyHooks {
                expected_mutations: Some(&vault_state.expected_mutations),
                search: Some(search),
            },
            now_ms: super::now_ms(),
        })
        .await?;

    emit_status(app, &state.set_phase(SyncPhase::Planning)?);
    let local_parent = db::get_vault(&conn, &vault_id)?
        .and_then(|vault| vault.local_head_commit_id)
        .unwrap_or_default();
    let push_pipeline = SyncPushPipeline::new(
        client.clone(),
        client,
        transfer_queue,
        PlannerConfig::default(),
    );
    let push_result = push_pipeline
        .push_local_changes(PushLocalChangesInput {
            conn: &mut conn,
            vault_id: &vault_id,
            vault_root: &vault_root,
            workspace_id: &workspace_id,
            device_id: &device_id,
            workspace_key: &workspace_key,
            signing_key: &signing_key,
            now_ms: super::now_ms(),
        })
        .await;
    match push_result {
        Ok(_) => finish_sync_run(state),
        Err(error) if is_head_conflict(&error) => {
            emit_status(app, &state.set_phase(SyncPhase::Applying)?);
            pull_pipeline
                .pull_remote_changes(PullRemoteChangesInput {
                    conn: &mut conn,
                    vault_id: &vault_id,
                    vault_root: &vault_root,
                    workspace_id: &workspace_id,
                    device_id: &device_id,
                    workspace_key: &workspace_key,
                    hooks: RemoteApplyHooks {
                        expected_mutations: Some(&vault_state.expected_mutations),
                        search: Some(search),
                    },
                    now_ms: super::now_ms(),
                })
                .await?;
            emit_status(app, &state.set_phase(SyncPhase::Publishing)?);
            if local_parent.is_empty() {
                push_pipeline
                    .push_local_changes(PushLocalChangesInput {
                        conn: &mut conn,
                        vault_id: &vault_id,
                        vault_root: &vault_root,
                        workspace_id: &workspace_id,
                        device_id: &device_id,
                        workspace_key: &workspace_key,
                        signing_key: &signing_key,
                        now_ms: super::now_ms(),
                    })
                    .await?;
            } else {
                push_pipeline
                    .push_merge_commit(PushMergeCommitInput {
                        conn: &mut conn,
                        vault_id: &vault_id,
                        vault_root: &vault_root,
                        workspace_id: &workspace_id,
                        device_id: &device_id,
                        workspace_key: &workspace_key,
                        signing_key: &signing_key,
                        local_parent_commit_id: &local_parent,
                        now_ms: super::now_ms(),
                    })
                    .await?;
            }
            finish_sync_run(state)
        }
        Err(error) => Err(error),
    }
}

async fn workspace_key_for_run(
    vault_id: &str,
    workspace_id: &str,
    remember_workspace_key: bool,
    passphrase: Option<&str>,
    client: &ConnectSyncClient,
) -> SyncResult<SymmetricKey> {
    if let Some(key) = keys::read_remembered_workspace_key(vault_id)? {
        return Ok(key);
    }
    let passphrase = passphrase
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            SyncError::Crypto("passphrase is required to unlock workspace key".into())
        })?;
    let envelopes = client.list_key_envelopes(workspace_id).await?;
    let (workspace_key, _) = unlock_workspace_key_from_envelopes(&envelopes, passphrase)?;
    if remember_workspace_key {
        keys::remember_workspace_key(vault_id, &workspace_key)?;
    }
    Ok(workspace_key)
}

fn finish_sync_run(state: &SyncState) -> SyncResult<SyncRuntimeStatus> {
    let conflict_count = list_open_conflicts_for_status(state)?
        .len()
        .try_into()
        .unwrap_or(i64::MAX);
    state.complete_manual_sync(conflict_count)
}

fn sync_client_and_queue(
    app: &AppHandle,
    run_id: u64,
    authorization: String,
) -> SyncResult<(Arc<ConnectSyncClient>, ObjectTransferQueue)> {
    let client = Arc::new(ConnectSyncClient::with_authorization_header(authorization));
    let transfer_api: Arc<dyn SyncTransferApi> = client.clone();
    let queue = ObjectTransferQueue::new(
        transfer_api,
        Arc::new(ReqwestObjectTransferHttp::new()),
        TransferQueueConfig::default(),
    )?
    .with_progress_sink(Arc::new(RuntimeTransferProgressSink {
        app: app.clone(),
        run_id,
    }));
    Ok((client, queue))
}

async fn authorization_header() -> SyncResult<String> {
    let authorized = auth::is_plugin_authorized(CORE_SYNC_PLUGIN_ID)
        .map_err(|error| SyncError::Transport(error.to_string()))?;
    if !authorized {
        return Err(SyncError::PermissionRequired);
    }
    auth_commands::authorization_header_for_plugin(CORE_SYNC_PLUGIN_ID)
        .await
        .map_err(SyncError::Transport)?
        .ok_or(SyncError::LoginRequired)
}

fn open_sync_db_for_vault(vault_id: &str) -> SyncResult<Connection> {
    let home = dirs::home_dir()
        .ok_or_else(|| SyncError::Storage("home directory is unavailable".into()))?;
    let path = db::sync_db_path(&home, vault_id)?;
    db::open_sync_db(&path)
}

fn validate_config_for_command(config: &SyncVaultConfig) -> SyncResult<()> {
    if config.vault_id.trim().is_empty() {
        return Err(SyncError::InvalidArgument("vault_id is required".into()));
    }
    if config.root_path.trim().is_empty() {
        return Err(SyncError::InvalidArgument("root_path is required".into()));
    }
    Ok(())
}

fn required_passphrase(config: &SyncVaultConfig) -> SyncResult<&str> {
    config
        .passphrase
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| SyncError::Crypto("passphrase is required to configure sync".into()))
}

fn validate_enabled_status(status: &SyncRuntimeStatus) -> SyncResult<()> {
    if !status.configured {
        return Err(SyncError::NotConfigured);
    }
    if !status.enabled {
        return Err(SyncError::InvalidArgument(
            "sync must be enabled before running sync now".into(),
        ));
    }
    Ok(())
}

fn required_status_value<'a>(value: Option<&'a str>, field: &str) -> SyncResult<&'a str> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            SyncError::InvalidArgument(format!("{field} is required before running sync"))
        })
}

fn status_vault_root(status: &SyncRuntimeStatus, vault_state: &VaultState) -> SyncResult<PathBuf> {
    let configured = required_status_value(status.root_path.as_deref(), "root_path")?;
    let configured_path = PathBuf::from(configured);
    match vault::get_vault_root(vault_state) {
        Ok(open_root) if same_path(&open_root, &configured_path) => Ok(open_root),
        Ok(_) => Err(SyncError::InvalidArgument(
            "configured sync vault is not the currently open vault".into(),
        )),
        Err(_) => Ok(configured_path),
    }
}

fn same_path(a: &Path, b: &Path) -> bool {
    match (a.canonicalize(), b.canonicalize()) {
        (Ok(a), Ok(b)) => a == b,
        _ => a == b,
    }
}

fn is_head_conflict(error: &SyncError) -> bool {
    matches!(error, SyncError::Transport(message) if message.to_lowercase().contains("head conflict"))
}

fn status_with_conflicts(state: &SyncState) -> super::errors::SyncResult<SyncRuntimeStatus> {
    let mut status = state.status();
    let conflicts = list_open_conflicts(&status)?;
    status.conflict_count = conflicts.len().try_into().unwrap_or(i64::MAX);
    Ok(status)
}

async fn get_remote_status_for_state(status: &SyncRuntimeStatus) -> SyncResult<SyncRemoteStatus> {
    if !status.configured {
        return Err(SyncError::NotConfigured);
    }
    let workspace_id =
        required_status_value(status.remote_workspace_id.as_deref(), "remote_workspace_id")?
            .to_string();
    let authorization = authorization_header().await?;
    let client = ConnectSyncClient::with_authorization_header(authorization);
    let head = client.get_head(&workspace_id).await?;
    let local_vault = match status.vault_id.as_deref() {
        Some(vault_id) => {
            let conn = open_sync_db_for_vault(vault_id)?;
            db::get_vault(&conn, vault_id)?
        }
        None => None,
    };

    Ok(remote_status_from_head(
        &workspace_id,
        local_vault.as_ref(),
        head,
        super::now_ms(),
    ))
}

fn remote_status_from_head(
    workspace_id: &str,
    local_vault: Option<&SyncVaultRecord>,
    head: SyncHead,
    checked_at_ms: i64,
) -> SyncRemoteStatus {
    let local_remote_head = local_vault.and_then(|vault| vault.remote_head_commit_id.clone());
    let has_remote_changes = !head.current_head_commit_id.is_empty()
        && local_remote_head.as_deref() != Some(&head.current_head_commit_id);

    SyncRemoteStatus {
        workspace_id: workspace_id.to_string(),
        remote_head_commit_id: head.current_head_commit_id,
        remote_head_version: head.head_version,
        latest_checkpoint_commit_id: head.latest_checkpoint_commit_id,
        local_remote_head_commit_id: local_remote_head,
        local_head_commit_id: local_vault.and_then(|vault| vault.local_head_commit_id.clone()),
        has_remote_changes,
        checked_at_ms,
    }
}

fn list_open_conflicts_for_status(
    state: &SyncState,
) -> super::errors::SyncResult<Vec<SyncConflictSummary>> {
    let status = state.status();
    list_open_conflicts(&status)
}

fn list_open_conflicts(
    status: &SyncRuntimeStatus,
) -> super::errors::SyncResult<Vec<SyncConflictSummary>> {
    let Some(vault_id) = status.vault_id.as_deref() else {
        return Ok(Vec::new());
    };
    let Some(home) = dirs::home_dir() else {
        return Ok(Vec::new());
    };
    let path = db::sync_db_path(&home, vault_id)?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let conn = db::open_sync_db(&path)?;
    db::list_open_conflicts(&conn).map(|conflicts| {
        conflicts
            .into_iter()
            .map(|conflict| SyncConflictSummary {
                conflict_id: conflict.conflict_id,
                path: conflict.path,
                conflict_path: conflict.conflict_path,
                base_commit_id: conflict.base_commit_id,
                remote_commit_id: conflict.remote_commit_id,
                status: conflict.status,
                created_at_ms: conflict.created_at_ms,
            })
            .collect()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(passphrase: Option<&str>) -> SyncVaultConfig {
        SyncVaultConfig {
            vault_id: "vault_1".into(),
            root_path: "/tmp/vault".into(),
            remote_workspace_id: String::new(),
            device_id: String::new(),
            remember_workspace_key: true,
            passphrase: passphrase.map(str::to_string),
        }
    }

    #[test]
    fn required_passphrase_trims_and_rejects_empty_values() {
        assert_eq!(
            required_passphrase(&config(Some("  secret  "))).unwrap(),
            "secret"
        );
        assert!(matches!(
            required_passphrase(&config(Some("   "))),
            Err(SyncError::Crypto(message)) if message.contains("passphrase")
        ));
        assert!(matches!(
            required_passphrase(&config(None)),
            Err(SyncError::Crypto(message)) if message.contains("passphrase")
        ));
    }

    #[test]
    fn head_conflict_detection_matches_transport_error_text() {
        assert!(is_head_conflict(&SyncError::Transport(
            "PublishCommit failed: aborted: sync head conflict".into()
        )));
        assert!(!is_head_conflict(&SyncError::Transport(
            "PublishCommit failed: unavailable".into()
        )));
    }

    #[test]
    fn remote_status_marks_changed_remote_head() {
        let local = SyncVaultRecord {
            vault_id: "vault_1".into(),
            root_path: "/tmp/vault".into(),
            remote_workspace_id: "workspace_1".into(),
            remote_head_commit_id: Some("commit_local_remote".into()),
            local_head_commit_id: Some("commit_local".into()),
            device_id: "device_1".into(),
            next_device_seq: 1,
            enabled: true,
            created_at_ms: 1,
            updated_at_ms: 1,
        };

        let status = remote_status_from_head(
            "workspace_1",
            Some(&local),
            SyncHead {
                current_head_commit_id: "commit_remote".into(),
                head_version: 3,
                latest_checkpoint_commit_id: "checkpoint_1".into(),
            },
            42,
        );

        assert!(status.has_remote_changes);
        assert_eq!(
            status.local_remote_head_commit_id.as_deref(),
            Some("commit_local_remote")
        );
        assert_eq!(status.local_head_commit_id.as_deref(), Some("commit_local"));
        assert_eq!(status.remote_head_version, 3);
        assert_eq!(status.checked_at_ms, 42);
    }

    #[test]
    fn remote_status_is_current_when_known_head_matches() {
        let local = SyncVaultRecord {
            vault_id: "vault_1".into(),
            root_path: "/tmp/vault".into(),
            remote_workspace_id: "workspace_1".into(),
            remote_head_commit_id: Some("commit_1".into()),
            local_head_commit_id: Some("commit_1".into()),
            device_id: "device_1".into(),
            next_device_seq: 1,
            enabled: true,
            created_at_ms: 1,
            updated_at_ms: 1,
        };

        let status = remote_status_from_head(
            "workspace_1",
            Some(&local),
            SyncHead {
                current_head_commit_id: "commit_1".into(),
                head_version: 1,
                latest_checkpoint_commit_id: "commit_1".into(),
            },
            42,
        );

        assert!(!status.has_remote_changes);
    }
}
