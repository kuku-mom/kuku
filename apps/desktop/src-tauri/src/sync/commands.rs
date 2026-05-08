use std::path::{Path, PathBuf};
use std::sync::Arc;

use chrono::{Local, SecondsFormat};
use ed25519_dalek::SigningKey;
use kuku_contract::proto::kuku::sync::v1::SyncAccountKeyRecipientType;
use rand_core::{OsRng, RngCore};
use rusqlite::Connection;
use tauri::{AppHandle, Emitter, Manager, State, command};
use tauri_plugin_dialog::DialogExt;

use crate::search::SearchState;
use crate::vault::VaultState;
use crate::{auth, auth_commands, vault};

use super::SyncState;
use super::account_keys::{
    self, AccountRecoveryKeyEnvelope, DeviceDisplayMetadata, WorkspaceDisplayMetadata,
};
use super::applier::{
    PullRemoteChangesInput, RemoteApplyHooks, SyncPullPipeline, unlock_workspace_key_from_envelopes,
};
use super::checkpoint::{
    CRYPTO_VERSION, PushLocalChangesInput, PushMergeCommitInput, SyncPushPipeline,
};
use super::client::{
    ConnectSyncClient, CreateAccountKeyInput, SyncAccountKeyEnvelopeMetadata, SyncCommitApi,
    SyncHead, SyncSetupApi, SyncTransferApi, SyncWorkspaceMetadata, UpdateDeviceMetadataInput,
    UpdateWorkspaceKeyInput, UpdateWorkspaceMetadataInput,
};
use super::crypto::SymmetricKey;
use super::db::{self, SyncVaultRecord};
use super::errors::command_error;
use super::errors::{SyncCommandError, SyncError, SyncResult};
use super::keys;
use super::planner::PlannerConfig;
use super::scanner::{ScannedFile, scan_vault};
use super::transfer::{
    ObjectTransferQueue, ReqwestObjectTransferHttp, TransferProgressEvent, TransferProgressSink,
    TransferQueueConfig,
};
use super::types::{
    SYNC_STATUS_EVENT, SyncAccountRecoveryState, SyncConflictSummary, SyncPhase, SyncRemoteStatus,
    SyncRenameWorkspaceRequest, SyncRuntimeStatus, SyncStatusEvent, SyncVaultConfig,
    SyncWorkspaceSummary,
};
use super::vault_config;

const CORE_SYNC_PLUGIN_ID: &str = "core-sync";
const ACCOUNT_RECOVERY_ENVELOPE_ID: &str = "recovery:v1";
const ACCOUNT_KEY_VERSION: i64 = 1;
const WORKSPACE_METADATA_VERSION: i64 = 1;
const WORKSPACE_KEY_VERSION: i64 = 1;
const DEVICE_METADATA_VERSION: i64 = 1;
const RECOVERY_PHRASE_EXPORT_FILE_NAME: &str = "kuku-sync-recovery-phrase.md";

#[command]
pub async fn sync_get_status(
    state: State<'_, SyncState>,
    scan_local: Option<bool>,
) -> Result<SyncRuntimeStatus, SyncCommandError> {
    status_with_conflicts(&state, scan_local.unwrap_or(false)).map_err(command_error)
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
    let status = match state.clear_remote_status_error() {
        Ok(Some(status)) => {
            emit_status(&app, &status);
            status
        }
        _ => status,
    };
    persist_remote_status_snapshot(&status, &remote_status).map_err(command_error)?;
    Ok(remote_status)
}

#[command]
pub async fn sync_get_cached_remote_status(
    state: State<'_, SyncState>,
) -> Result<Option<SyncRemoteStatus>, SyncCommandError> {
    cached_remote_status_for_state(&state.status()).map_err(command_error)
}

#[command]
pub async fn sync_get_saved_passphrase(
    vault_id: String,
) -> Result<Option<String>, SyncCommandError> {
    keys::read_remembered_passphrase(vault_id.trim()).map_err(command_error)
}

#[command]
pub async fn sync_generate_recovery_phrase() -> Result<String, SyncCommandError> {
    account_keys::generate_recovery_phrase().map_err(command_error)
}

#[command]
pub async fn sync_get_saved_recovery_phrase(
    account_key_id: String,
) -> Result<Option<String>, SyncCommandError> {
    keys::read_account_recovery_phrase(account_key_id.trim()).map_err(command_error)
}

#[command]
pub async fn sync_get_account_recovery_state() -> Result<SyncAccountRecoveryState, SyncCommandError>
{
    get_account_recovery_state().await.map_err(command_error)
}

#[command]
pub async fn sync_list_workspaces(
    state: State<'_, SyncState>,
    passphrase: Option<String>,
) -> Result<Vec<SyncWorkspaceSummary>, SyncCommandError> {
    let current_workspace_id = state.status().remote_workspace_id;
    list_account_workspaces(current_workspace_id.as_deref(), passphrase.as_deref())
        .await
        .map_err(command_error)
}

#[command]
pub async fn sync_rename_workspace(
    app: AppHandle,
    state: State<'_, SyncState>,
    request: SyncRenameWorkspaceRequest,
) -> Result<SyncWorkspaceSummary, SyncCommandError> {
    let current_workspace_id = state.status().remote_workspace_id;
    let summary = rename_account_workspace(&request, current_workspace_id.as_deref())
        .await
        .map_err(command_error)?;
    if let Some(status) = state
        .update_workspace_name(&summary.workspace_id, summary.name.clone())
        .map_err(command_error)?
    {
        persist_runtime_status(&status).map_err(command_error)?;
        emit_status(&app, &status);
    }
    Ok(summary)
}

#[command]
pub async fn sync_delete_workspace(
    app: AppHandle,
    state: State<'_, SyncState>,
    workspace_id: String,
) -> Result<SyncRuntimeStatus, SyncCommandError> {
    let workspace_id = normalized_workspace_id(&workspace_id).map_err(command_error)?;
    let status = state.status();
    let deleting_current = status.remote_workspace_id.as_deref() == Some(workspace_id);
    if deleting_current && state.is_sync_running() {
        return Err(command_error(SyncError::InvalidArgument(
            "sync is already running".into(),
        )));
    }

    delete_account_workspace(workspace_id)
        .await
        .map_err(command_error)?;
    if deleting_current {
        return clear_current_workspace_binding(&app, &state, &status).map_err(command_error);
    }
    Ok(state.status())
}

#[command]
pub async fn sync_save_recovery_phrase_file(
    app: AppHandle,
    phrase: String,
) -> Result<bool, SyncCommandError> {
    let normalized_phrase = account_keys::normalize_recovery_phrase(&phrase);
    if normalized_phrase.is_empty() {
        return Err(command_error(SyncError::InvalidArgument(
            "recovery phrase is required".into(),
        )));
    }

    tauri::async_runtime::spawn_blocking(move || {
        let path = app
            .dialog()
            .file()
            .add_filter("Markdown", &["md", "markdown"])
            .set_file_name(RECOVERY_PHRASE_EXPORT_FILE_NAME)
            .blocking_save_file()
            .and_then(|path| path.into_path().ok());
        let Some(path) = path else {
            return Ok(false);
        };

        std::fs::write(&path, recovery_phrase_export_text(&normalized_phrase)).map_err(
            |error| {
                command_error(SyncError::Storage(format!(
                    "failed to save recovery phrase to {}: {error}",
                    path.display()
                )))
            },
        )?;

        Ok(true)
    })
    .await
    .map_err(|error| SyncCommandError::server(format!("save dialog worker failed: {error}")))?
}

#[command]
pub async fn sync_configure_vault(
    app: AppHandle,
    state: State<'_, SyncState>,
    config: SyncVaultConfig,
) -> Result<SyncRuntimeStatus, SyncCommandError> {
    let prepared = probe_sync_config(config).await.map_err(command_error)?;
    let config = commit_sync_config_probe(prepared).map_err(command_error)?;
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
    persist_runtime_status(&status).map_err(command_error)?;
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
                Ok(status) => {
                    if let Err(error) = persist_runtime_status(&status) {
                        return Err(command_error(error));
                    }
                    emit_status(&worker_app, &status);
                    Ok(status)
                }
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

pub(crate) fn emit_status(app: &AppHandle, status: &SyncRuntimeStatus) {
    let _ = app.emit(
        SYNC_STATUS_EVENT,
        SyncStatusEvent {
            status: status.clone(),
        },
    );
}

fn recovery_phrase_export_text(phrase: &str) -> String {
    let saved_at = Local::now().to_rfc3339_opts(SecondsFormat::Secs, false);
    [
        "# Kuku Sync Recovery Phrase",
        "",
        &format!("Saved at: {saved_at}"),
        "",
        "Keep this file private. Anyone with this recovery phrase and your account access can unlock your encrypted sync workspaces.",
        "",
        "```text",
        phrase,
        "```",
        "",
    ]
    .join("\n")
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

async fn probe_sync_config(mut config: SyncVaultConfig) -> SyncResult<SyncConfigProbe> {
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

    config.remote_workspace_id = prepared.workspace_id.clone();
    config.device_id = prepared.device_id.clone();
    config.account_key_id = Some(prepared.account_key_id.clone());
    config.workspace_name = Some(prepared.workspace_name.clone());
    config.device_name = Some(prepared.device_name.clone());

    Ok(SyncConfigProbe {
        config,
        account_key_id: prepared.account_key_id,
        account_root_key: prepared.account_root_key,
        recovery_phrase: prepared.recovery_phrase,
        workspace_key: prepared.workspace_key,
        device_signing_key: prepared.device_signing_key,
    })
}

fn commit_sync_config_probe(prepared: SyncConfigProbe) -> SyncResult<SyncVaultConfig> {
    let config = prepared.config;
    let mut conn = open_sync_db_for_vault(&config.vault_id)?;
    persist_configured_vault(&mut conn, &config, false)?;
    persist_local_keys(
        &config,
        &prepared.workspace_key,
        &prepared.device_signing_key,
        prepared.recovery_phrase.as_deref(),
        Some((&prepared.account_key_id, &prepared.account_root_key)),
    )?;
    vault_config::write_sync_config(
        Path::new(&config.root_path),
        &config,
        false,
        super::now_ms(),
    )?;
    Ok(config)
}

struct SyncConfigProbe {
    config: SyncVaultConfig,
    account_key_id: String,
    account_root_key: SymmetricKey,
    recovery_phrase: Option<String>,
    workspace_key: SymmetricKey,
    device_signing_key: SigningKey,
}

struct PreparedSyncConfig {
    account_key_id: String,
    account_root_key: SymmetricKey,
    recovery_phrase: Option<String>,
    workspace_id: String,
    workspace_name: String,
    workspace_key: SymmetricKey,
    device_id: String,
    device_name: String,
    device_signing_key: SigningKey,
}

struct PreparedAccountKey {
    account_key_id: String,
    account_root_key: SymmetricKey,
    recovery_phrase: Option<String>,
}

async fn prepare_new_workspace(
    config: &SyncVaultConfig,
    client: &Arc<ConnectSyncClient>,
) -> SyncResult<PreparedSyncConfig> {
    let account = prepare_account_key(config, client).await?;
    let workspace_name = workspace_display_name(config);
    let device_name = device_display_name(config);
    let workspace = client.create_workspace(CRYPTO_VERSION).await?;
    let workspace_key = keys::random_workspace_key();
    put_account_workspace_metadata(
        client,
        &account,
        &workspace.workspace_id,
        &workspace_name,
        &workspace_key,
    )
    .await?;
    let signing_key = keys::random_device_signing_key();
    let device = register_device_with_name(
        client,
        &account,
        &workspace.workspace_id,
        &signing_key,
        &device_name,
    )
    .await?;
    Ok(PreparedSyncConfig {
        account_key_id: account.account_key_id,
        account_root_key: account.account_root_key,
        recovery_phrase: account.recovery_phrase,
        workspace_id: workspace.workspace_id,
        workspace_name,
        workspace_key,
        device_id: device.device_id,
        device_name,
        device_signing_key: signing_key,
    })
}

async fn prepare_existing_workspace(
    config: &SyncVaultConfig,
    client: &Arc<ConnectSyncClient>,
    local_vault: Option<SyncVaultRecord>,
) -> SyncResult<PreparedSyncConfig> {
    let account = prepare_account_key(config, client).await?;
    let workspace_id = config.remote_workspace_id.trim().to_string();
    let workspace = workspace_by_id(client, &workspace_id).await?;
    let workspace_name = workspace_display_name_from_metadata(&account, &workspace)
        .unwrap_or_else(|_| workspace_display_name(config));
    let device_name = device_display_name(config);
    let workspace_key = workspace_key_from_account(&account, &workspace)?;

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
            let device = register_device_with_name(
                client,
                &account,
                &workspace_id,
                &signing_key,
                &device_name,
            )
            .await?;
            (device.device_id, signing_key)
        }
    };

    Ok(PreparedSyncConfig {
        account_key_id: account.account_key_id,
        account_root_key: account.account_root_key,
        recovery_phrase: account.recovery_phrase,
        workspace_id,
        workspace_name,
        workspace_key,
        device_id,
        device_name,
        device_signing_key: signing_key,
    })
}

async fn prepare_account_key(
    config: &SyncVaultConfig,
    client: &Arc<ConnectSyncClient>,
) -> SyncResult<PreparedAccountKey> {
    if let Some(account_key) = client.get_account_key_state().await? {
        if let Some(account_root_key) = keys::read_account_root_key(&account_key.account_key_id)? {
            return Ok(PreparedAccountKey {
                account_key_id: account_key.account_key_id,
                account_root_key,
                recovery_phrase: None,
            });
        }
        let recovery_phrase = required_passphrase(config)?;
        let account_root_key =
            unlock_account_root_key(client, &account_key.account_key_id, recovery_phrase).await?;
        let normalized_phrase = account_keys::normalize_recovery_phrase(recovery_phrase);
        return Ok(PreparedAccountKey {
            account_key_id: account_key.account_key_id,
            account_root_key,
            recovery_phrase: Some(normalized_phrase),
        });
    }

    let recovery_phrase = required_passphrase(config)?;
    let normalized_phrase = account_keys::normalize_recovery_phrase(recovery_phrase);
    let account_key_id = config
        .account_key_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .unwrap_or_else(random_account_key_id);
    let account_root_key = account_keys::random_account_root_key();
    let envelope = account_keys::wrap_account_root_key_with_recovery_phrase(
        &account_key_id,
        ACCOUNT_RECOVERY_ENVELOPE_ID,
        ACCOUNT_KEY_VERSION,
        &account_root_key,
        &normalized_phrase,
    )?;
    client
        .create_account_key(CreateAccountKeyInput {
            account_key_id: account_key_id.clone(),
            crypto_version: CRYPTO_VERSION.into(),
            envelope_id: envelope.envelope_id,
            recipient_type:
                SyncAccountKeyRecipientType::SYNC_ACCOUNT_KEY_RECIPIENT_TYPE_RECOVERY_PHRASE,
            key_version: envelope.key_version,
            kdf_params_json: serde_json::to_string(&envelope.kdf)?,
            encrypted_envelope: serde_json::to_vec(&envelope.wrap)?,
        })
        .await?;
    Ok(PreparedAccountKey {
        account_key_id,
        account_root_key,
        recovery_phrase: Some(normalized_phrase),
    })
}

async fn unlock_existing_account_key(
    client: &Arc<ConnectSyncClient>,
    recovery_phrase: Option<&str>,
) -> SyncResult<Option<PreparedAccountKey>> {
    let Some(account_key) = client.get_account_key_state().await? else {
        return Ok(None);
    };
    if let Some(account_root_key) = keys::read_account_root_key(&account_key.account_key_id)? {
        return Ok(Some(PreparedAccountKey {
            account_key_id: account_key.account_key_id,
            account_root_key,
            recovery_phrase: None,
        }));
    }

    let recovery_phrase = recovery_phrase
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            SyncError::Crypto("recovery phrase is required to unlock account sync state".into())
        })?;
    let account_root_key =
        unlock_account_root_key(client, &account_key.account_key_id, recovery_phrase).await?;
    let normalized_phrase = account_keys::normalize_recovery_phrase(recovery_phrase);
    keys::remember_account_root_key(&account_key.account_key_id, &account_root_key)?;
    keys::remember_account_recovery_phrase(&account_key.account_key_id, &normalized_phrase)?;
    Ok(Some(PreparedAccountKey {
        account_key_id: account_key.account_key_id,
        account_root_key,
        recovery_phrase: Some(normalized_phrase),
    }))
}

async fn get_account_recovery_state() -> SyncResult<SyncAccountRecoveryState> {
    let authorization = authorization_header().await?;
    let client = ConnectSyncClient::with_authorization_header(authorization);
    let Some(account_key) = client.get_account_key_state().await? else {
        return Ok(SyncAccountRecoveryState::default());
    };

    let account_key_id = account_key.account_key_id;
    let recovery_phrase_configured =
        client
            .list_account_key_envelopes()
            .await?
            .iter()
            .any(|envelope| {
                envelope.account_key_id == account_key_id
                && envelope.recipient_type
                    == SyncAccountKeyRecipientType::SYNC_ACCOUNT_KEY_RECIPIENT_TYPE_RECOVERY_PHRASE
            });
    let applied = keys::read_account_root_key(&account_key_id)?.is_some();
    let recovery_phrase_saved = keys::read_account_recovery_phrase(&account_key_id)?.is_some();
    Ok(SyncAccountRecoveryState {
        configured: true,
        account_key_id: Some(account_key_id),
        recovery_phrase_configured,
        applied,
        recovery_phrase_saved,
    })
}

async fn unlock_account_root_key(
    client: &Arc<ConnectSyncClient>,
    account_key_id: &str,
    recovery_phrase: &str,
) -> SyncResult<SymmetricKey> {
    let envelopes = client.list_account_key_envelopes().await?;
    let envelope = envelopes
        .iter()
        .find(|envelope| {
            envelope.account_key_id == account_key_id
                && envelope.recipient_type
                    == SyncAccountKeyRecipientType::SYNC_ACCOUNT_KEY_RECIPIENT_TYPE_RECOVERY_PHRASE
        })
        .ok_or_else(|| SyncError::Crypto("account recovery envelope is missing".into()))?;
    let envelope = account_recovery_envelope_from_metadata(envelope)?;
    account_keys::unwrap_account_root_key_with_recovery_phrase(&envelope, recovery_phrase)
}

fn account_recovery_envelope_from_metadata(
    metadata: &SyncAccountKeyEnvelopeMetadata,
) -> SyncResult<AccountRecoveryKeyEnvelope> {
    Ok(AccountRecoveryKeyEnvelope {
        account_key_id: metadata.account_key_id.clone(),
        envelope_id: metadata.envelope_id.clone(),
        recipient_type: "recovery_phrase".into(),
        key_version: metadata.key_version,
        kdf: serde_json::from_str(&metadata.kdf_params_json)?,
        wrap: serde_json::from_slice(&metadata.encrypted_envelope)?,
    })
}

async fn put_account_workspace_metadata(
    client: &Arc<ConnectSyncClient>,
    account: &PreparedAccountKey,
    workspace_id: &str,
    workspace_name: &str,
    workspace_key: &SymmetricKey,
) -> SyncResult<()> {
    let encrypted_metadata = account_keys::encrypt_workspace_metadata(
        &account.account_root_key,
        &account.account_key_id,
        workspace_id,
        WORKSPACE_METADATA_VERSION,
        &WorkspaceDisplayMetadata::new(workspace_name),
    )?;
    client
        .update_workspace_metadata(UpdateWorkspaceMetadataInput {
            workspace_id: workspace_id.into(),
            encrypted_metadata,
            metadata_version: WORKSPACE_METADATA_VERSION,
            expected_metadata_version: 0,
        })
        .await?;

    let encrypted_workspace_key = account_keys::encrypt_workspace_key_for_account(
        &account.account_root_key,
        &account.account_key_id,
        workspace_id,
        WORKSPACE_KEY_VERSION,
        workspace_key,
    )?;
    client
        .update_workspace_key(UpdateWorkspaceKeyInput {
            workspace_id: workspace_id.into(),
            encrypted_workspace_key,
            workspace_key_version: WORKSPACE_KEY_VERSION,
            expected_workspace_key_version: 0,
        })
        .await?;
    Ok(())
}

async fn workspace_by_id(
    client: &Arc<ConnectSyncClient>,
    workspace_id: &str,
) -> SyncResult<SyncWorkspaceMetadata> {
    client
        .list_workspaces()
        .await?
        .into_iter()
        .find(|workspace| workspace.workspace_id == workspace_id)
        .ok_or_else(|| {
            SyncError::InvalidArgument("workspace was not found for this account".into())
        })
}

async fn list_account_workspaces(
    current_workspace_id: Option<&str>,
    recovery_phrase: Option<&str>,
) -> SyncResult<Vec<SyncWorkspaceSummary>> {
    let authorization = authorization_header().await?;
    let client = Arc::new(ConnectSyncClient::with_authorization_header(authorization));
    let Some(account) = unlock_existing_account_key(&client, recovery_phrase).await? else {
        return Ok(Vec::new());
    };
    client
        .list_workspaces()
        .await?
        .iter()
        .map(|workspace| workspace_summary_from_metadata(&account, workspace, current_workspace_id))
        .collect()
}

async fn rename_account_workspace(
    request: &SyncRenameWorkspaceRequest,
    current_workspace_id: Option<&str>,
) -> SyncResult<SyncWorkspaceSummary> {
    let workspace_id = normalized_workspace_id(&request.workspace_id)?;
    let workspace_name = normalized_workspace_name(&request.name)?;
    let authorization = authorization_header().await?;
    let client = Arc::new(ConnectSyncClient::with_authorization_header(authorization));
    let account = unlock_existing_account_key(&client, request.passphrase.as_deref())
        .await?
        .ok_or(SyncError::NotConfigured)?;
    let next_metadata_version = request
        .expected_metadata_version
        .checked_add(1)
        .ok_or_else(|| SyncError::InvalidArgument("workspace metadata version overflow".into()))?;
    let encrypted_metadata = account_keys::encrypt_workspace_metadata(
        &account.account_root_key,
        &account.account_key_id,
        workspace_id,
        next_metadata_version,
        &WorkspaceDisplayMetadata::new(workspace_name),
    )?;
    let workspace = client
        .update_workspace_metadata(UpdateWorkspaceMetadataInput {
            workspace_id: workspace_id.into(),
            encrypted_metadata,
            metadata_version: next_metadata_version,
            expected_metadata_version: request.expected_metadata_version,
        })
        .await?;
    workspace_summary_from_metadata(&account, &workspace, current_workspace_id)
}

async fn delete_account_workspace(workspace_id: &str) -> SyncResult<()> {
    let authorization = authorization_header().await?;
    let client = ConnectSyncClient::with_authorization_header(authorization);
    client.delete_workspace(workspace_id).await
}

fn clear_current_workspace_binding(
    app: &AppHandle,
    state: &SyncState,
    status: &SyncRuntimeStatus,
) -> SyncResult<SyncRuntimeStatus> {
    let vault_id = status
        .vault_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or(SyncError::NotConfigured)?;
    keys::forget_workspace_key(vault_id)?;
    keys::forget_passphrase(vault_id)?;
    keys::forget_device_signing_key(vault_id)?;
    if let Some(root_path) = status
        .root_path
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        vault_config::delete_sync_config(Path::new(root_path))?;
    }
    let conn = open_sync_db_for_vault(vault_id)?;
    db::delete_vault(&conn, vault_id)?;
    let status = state.reset();
    emit_status(app, &status);
    Ok(status)
}

fn workspace_key_from_account(
    account: &PreparedAccountKey,
    workspace: &SyncWorkspaceMetadata,
) -> SyncResult<SymmetricKey> {
    if workspace.encrypted_workspace_key.is_empty() || workspace.workspace_key_version <= 0 {
        return Err(SyncError::Crypto(
            "workspace account key envelope is missing".into(),
        ));
    }
    account_keys::decrypt_workspace_key_for_account(
        &account.account_root_key,
        &account.account_key_id,
        &workspace.workspace_id,
        workspace.workspace_key_version,
        &workspace.encrypted_workspace_key,
    )
}

fn workspace_display_name_from_metadata(
    account: &PreparedAccountKey,
    workspace: &SyncWorkspaceMetadata,
) -> SyncResult<String> {
    if workspace.encrypted_metadata.is_empty() || workspace.metadata_version <= 0 {
        return Err(SyncError::Crypto("workspace metadata is missing".into()));
    }
    Ok(account_keys::decrypt_workspace_metadata(
        &account.account_root_key,
        &account.account_key_id,
        &workspace.workspace_id,
        workspace.metadata_version,
        &workspace.encrypted_metadata,
    )?
    .name)
}

fn workspace_summary_from_metadata(
    account: &PreparedAccountKey,
    workspace: &SyncWorkspaceMetadata,
    current_workspace_id: Option<&str>,
) -> SyncResult<SyncWorkspaceSummary> {
    let name = workspace_display_name_from_metadata(account, workspace)?;
    let _workspace_key = workspace_key_from_account(account, workspace)?;
    Ok(SyncWorkspaceSummary {
        workspace_id: workspace.workspace_id.clone(),
        name,
        current: current_workspace_id == Some(workspace.workspace_id.as_str()),
        head_version: workspace.head_version,
        metadata_version: workspace.metadata_version,
        workspace_key_version: workspace.workspace_key_version,
    })
}

fn normalized_workspace_id(workspace_id: &str) -> SyncResult<&str> {
    let workspace_id = workspace_id.trim();
    if workspace_id.is_empty() {
        return Err(SyncError::InvalidArgument(
            "workspace id is required".into(),
        ));
    }
    Ok(workspace_id)
}

fn normalized_workspace_name(name: &str) -> SyncResult<&str> {
    let name = name.trim();
    if name.is_empty() {
        return Err(SyncError::InvalidArgument(
            "workspace name is required".into(),
        ));
    }
    if name.chars().count() > 120 {
        return Err(SyncError::InvalidArgument(
            "workspace name is too long".into(),
        ));
    }
    Ok(name)
}

async fn register_device_with_name(
    client: &Arc<ConnectSyncClient>,
    account: &PreparedAccountKey,
    workspace_id: &str,
    signing_key: &SigningKey,
    device_name: &str,
) -> SyncResult<super::client::SyncDeviceMetadata> {
    let device = client
        .register_device(
            workspace_id,
            signing_key.verifying_key().to_bytes().to_vec(),
            Vec::new(),
            Vec::new(),
        )
        .await?;
    let encrypted_device_name = account_keys::encrypt_device_metadata(
        &account.account_root_key,
        &account.account_key_id,
        workspace_id,
        &device.device_id,
        DEVICE_METADATA_VERSION,
        &DeviceDisplayMetadata::new(device_name),
    )?;
    client
        .update_device_metadata(UpdateDeviceMetadataInput {
            workspace_id: workspace_id.into(),
            device_id: device.device_id,
            encrypted_device_name,
            metadata_version: DEVICE_METADATA_VERSION,
            expected_metadata_version: 0,
        })
        .await
}

fn persist_local_keys(
    config: &SyncVaultConfig,
    workspace_key: &SymmetricKey,
    signing_key: &SigningKey,
    verified_passphrase: Option<&str>,
    account_root_key: Option<(&str, &SymmetricKey)>,
) -> SyncResult<()> {
    if let Some((account_key_id, account_root_key)) = account_root_key {
        keys::remember_account_root_key(account_key_id, account_root_key)?;
        if let Some(passphrase) = verified_passphrase {
            keys::remember_account_recovery_phrase(account_key_id, passphrase)?;
        }
    }
    if config.remember_workspace_key {
        keys::remember_workspace_key(&config.vault_id, workspace_key)?;
        if let Some(passphrase) = verified_passphrase {
            keys::remember_passphrase(&config.vault_id, passphrase)?;
        }
    } else {
        keys::forget_workspace_key(&config.vault_id)?;
        keys::forget_passphrase(&config.vault_id)?;
    }
    keys::remember_device_signing_key(&config.vault_id, signing_key)
}

fn persist_configured_vault(
    conn: &mut Connection,
    config: &SyncVaultConfig,
    enabled: bool,
) -> SyncResult<()> {
    let now_ms = super::now_ms();
    let existing = db::get_vault(conn, &config.vault_id)?;
    let vault = match existing {
        Some(mut vault) => {
            vault.root_path = config.root_path.clone();
            vault.remote_workspace_id = config.remote_workspace_id.clone();
            vault.device_id = config.device_id.clone();
            vault.enabled = enabled;
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
            enabled,
            created_at_ms: now_ms,
            updated_at_ms: now_ms,
        },
    };
    db::upsert_vault(conn, &vault)
}

pub fn restore_vault_config_for_root(
    app: &AppHandle,
    state: &SyncState,
    vault_root: &Path,
) -> SyncResult<SyncRuntimeStatus> {
    let config_file = match vault_config::read_sync_config(vault_root) {
        Ok(Some(config_file)) => config_file,
        Ok(None) => {
            let status = state.reset();
            emit_status(app, &status);
            return Ok(status);
        }
        Err(error @ SyncError::UnsupportedVersion(_)) => {
            vault_config::reset_sync_config(vault_root)?;
            let status = state.reset();
            emit_status(app, &status);
            return Err(error);
        }
        Err(error) => return Err(error),
    };

    let config = vault_config::runtime_config_from_file(vault_root, &config_file);
    let mut conn = open_sync_db_for_vault(&config.vault_id)?;
    persist_configured_vault(&mut conn, &config, config_file.enabled)?;
    let status = state.restore_vault_with_status(
        config,
        config_file.enabled,
        config_file.status.last_synced_at_ms,
    )?;
    emit_status(app, &status);
    Ok(status)
}

pub fn reset_vault_config_runtime(app: &AppHandle, state: &SyncState) -> SyncRuntimeStatus {
    let status = state.reset();
    emit_status(app, &status);
    status
}

fn persist_runtime_status(status: &SyncRuntimeStatus) -> SyncResult<()> {
    if !status.configured {
        return Ok(());
    }
    let config = config_from_status(status)?;
    let root_path = PathBuf::from(&config.root_path);
    let mut conn = open_sync_db_for_vault(&config.vault_id)?;
    persist_configured_vault(&mut conn, &config, status.enabled)?;
    let remote = cached_remote_status_for_config(&root_path, &config.remote_workspace_id)?;
    let status_file = vault_config::SyncVaultStatusFile {
        last_synced_at_ms: status.last_synced_at_ms,
        remote,
    };
    vault_config::write_sync_config_with_status(
        &root_path,
        &config,
        status.enabled,
        status.updated_at_ms,
        status_file,
    )?;
    Ok(())
}

fn persist_remote_status_snapshot(
    status: &SyncRuntimeStatus,
    remote_status: &SyncRemoteStatus,
) -> SyncResult<()> {
    if !status.configured {
        return Ok(());
    }
    let config = config_from_status(status)?;
    let root_path = PathBuf::from(&config.root_path);
    let status_file = vault_config::SyncVaultStatusFile {
        last_synced_at_ms: status.last_synced_at_ms,
        remote: Some(remote_status.clone()),
    };
    vault_config::write_sync_config_with_status(
        &root_path,
        &config,
        status.enabled,
        remote_status.checked_at_ms,
        status_file,
    )?;
    Ok(())
}

fn cached_remote_status_for_state(
    status: &SyncRuntimeStatus,
) -> SyncResult<Option<SyncRemoteStatus>> {
    if !status.configured {
        return Ok(None);
    }
    let root_path = required_status_value(status.root_path.as_deref(), "root_path")?;
    let workspace_id =
        required_status_value(status.remote_workspace_id.as_deref(), "remote_workspace_id")?;
    cached_remote_status_for_config(Path::new(root_path), workspace_id)
}

fn cached_remote_status_for_config(
    root_path: &Path,
    workspace_id: &str,
) -> SyncResult<Option<SyncRemoteStatus>> {
    Ok(vault_config::read_sync_config(root_path)?
        .filter(|config| config.remote_workspace_id == workspace_id)
        .and_then(|config| config.status.remote))
}

fn config_from_status(status: &SyncRuntimeStatus) -> SyncResult<SyncVaultConfig> {
    Ok(SyncVaultConfig {
        vault_id: required_status_value(status.vault_id.as_deref(), "vault_id")?.to_string(),
        root_path: required_status_value(status.root_path.as_deref(), "root_path")?.to_string(),
        account_key_id: status.account_key_id.clone(),
        remote_workspace_id: required_status_value(
            status.remote_workspace_id.as_deref(),
            "remote_workspace_id",
        )?
        .to_string(),
        workspace_name: status.workspace_name.clone(),
        device_id: required_status_value(status.device_id.as_deref(), "device_id")?.to_string(),
        device_name: status.device_name.clone(),
        remember_workspace_key: status.remember_workspace_key,
        passphrase: None,
    })
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
        status.account_key_id.as_deref(),
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
    account_key_id: Option<&str>,
    remember_workspace_key: bool,
    passphrase: Option<&str>,
    client: &ConnectSyncClient,
) -> SyncResult<SymmetricKey> {
    if let Some(key) = keys::read_remembered_workspace_key(vault_id)? {
        return Ok(key);
    }
    if let Some(account_key_id) = account_key_id
        && let Some(account_root_key) = keys::read_account_root_key(account_key_id)?
    {
        let account = PreparedAccountKey {
            account_key_id: account_key_id.to_string(),
            account_root_key,
            recovery_phrase: None,
        };
        if let Ok(workspace) = workspace_by_id(&Arc::new(client.clone()), workspace_id).await {
            let workspace_key = workspace_key_from_account(&account, &workspace)?;
            if remember_workspace_key {
                keys::remember_workspace_key(vault_id, &workspace_key)?;
            }
            return Ok(workspace_key);
        }
    }
    if let Some(account_key_id) = account_key_id
        && let Some(recovery_phrase) = passphrase.map(str::trim).filter(|value| !value.is_empty())
    {
        let client = Arc::new(client.clone());
        let account_root_key =
            unlock_account_root_key(&client, account_key_id, recovery_phrase).await?;
        let normalized_phrase = account_keys::normalize_recovery_phrase(recovery_phrase);
        keys::remember_account_root_key(account_key_id, &account_root_key)?;
        keys::remember_account_recovery_phrase(account_key_id, &normalized_phrase)?;
        let account = PreparedAccountKey {
            account_key_id: account_key_id.to_string(),
            account_root_key,
            recovery_phrase: Some(normalized_phrase),
        };
        let workspace = workspace_by_id(&client, workspace_id).await?;
        let workspace_key = workspace_key_from_account(&account, &workspace)?;
        if remember_workspace_key {
            keys::remember_workspace_key(vault_id, &workspace_key)?;
            keys::remember_passphrase(vault_id, recovery_phrase)?;
        }
        return Ok(workspace_key);
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
        keys::remember_passphrase(vault_id, passphrase)?;
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

fn workspace_display_name(config: &SyncVaultConfig) -> String {
    config
        .workspace_name
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or_else(|| {
            Path::new(&config.root_path)
                .file_name()
                .and_then(|value| value.to_str())
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
        })
        .unwrap_or_else(|| "Workspace".into())
}

fn device_display_name(config: &SyncVaultConfig) -> String {
    config
        .device_name
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or_else(|| std::env::var("COMPUTERNAME").ok())
        .or_else(|| std::env::var("HOSTNAME").ok())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "This device".into())
}

fn random_account_key_id() -> String {
    let mut bytes = [0u8; 16];
    OsRng.fill_bytes(&mut bytes);
    let mut out = String::with_capacity("account_".len() + bytes.len() * 2);
    out.push_str("account_");
    for byte in bytes {
        use std::fmt::Write as _;
        let _ = write!(out, "{byte:02x}");
    }
    out
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

fn status_with_conflicts(
    state: &SyncState,
    scan_local: bool,
) -> super::errors::SyncResult<SyncRuntimeStatus> {
    let mut status = state.status();
    if scan_local
        && let Some((pending_uploads, pending_downloads)) =
            pending_counts_for_status(&status, state.is_sync_running())?
    {
        status = state.set_pending_counts(pending_uploads, pending_downloads)?;
    }
    let conflicts = list_open_conflicts(&status)?;
    status.conflict_count = conflicts.len().try_into().unwrap_or(i64::MAX);
    Ok(status)
}

fn pending_counts_for_status(
    status: &SyncRuntimeStatus,
    sync_running: bool,
) -> SyncResult<Option<(i64, i64)>> {
    if sync_running
        || !status.configured
        || !status.enabled
        || !matches!(status.phase, SyncPhase::Idle)
    {
        return Ok(None);
    }

    let Some(vault_id) = status.vault_id.as_deref() else {
        return Ok(None);
    };
    let Some(root_path) = status.root_path.as_deref() else {
        return Ok(None);
    };
    let vault_root = PathBuf::from(root_path);
    if !vault_root.is_dir() {
        return Ok(None);
    }

    let Some(home) = dirs::home_dir() else {
        return Ok(None);
    };
    let db_path = db::sync_db_path(&home, vault_id)?;
    if !db_path.exists() {
        return Ok(None);
    }

    let mut conn = db::open_sync_db(&db_path)?;
    let pending_uploads = pending_upload_count(&mut conn, &vault_root, super::now_ms())?;
    Ok(Some((pending_uploads, status.pending_downloads)))
}

fn pending_upload_count(conn: &mut Connection, vault_root: &Path, now_ms: i64) -> SyncResult<i64> {
    let scanned_files = scan_vault(vault_root)?;
    let scan_inputs = scanned_files
        .iter()
        .map(ScannedFile::file_input)
        .collect::<Vec<_>>();
    db::apply_scan(conn, &scan_inputs, now_ms)?;
    Ok(db::list_dirty_files(conn)?
        .len()
        .try_into()
        .unwrap_or(i64::MAX))
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
    use std::fs;
    use std::io::Write;
    use std::path::{Path, PathBuf};

    fn config(passphrase: Option<&str>) -> SyncVaultConfig {
        SyncVaultConfig {
            vault_id: "vault_1".into(),
            root_path: "/tmp/vault".into(),
            account_key_id: None,
            remote_workspace_id: String::new(),
            workspace_name: None,
            device_id: String::new(),
            device_name: None,
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
    fn normalized_workspace_name_trims_and_validates() {
        assert_eq!(
            normalized_workspace_name("  Team Notes  ").unwrap(),
            "Team Notes"
        );
        assert!(matches!(
            normalized_workspace_name("   "),
            Err(SyncError::InvalidArgument(message)) if message.contains("required")
        ));
        assert!(matches!(
            normalized_workspace_name(&"a".repeat(121)),
            Err(SyncError::InvalidArgument(message)) if message.contains("too long")
        ));
    }

    #[test]
    fn normalized_workspace_id_trims_and_rejects_empty_values() {
        assert_eq!(
            normalized_workspace_id("  workspace_1  ").unwrap(),
            "workspace_1"
        );
        assert!(matches!(
            normalized_workspace_id("   "),
            Err(SyncError::InvalidArgument(message)) if message.contains("required")
        ));
    }

    #[test]
    fn workspace_summary_decrypts_name_and_marks_current() {
        let account_root_key = [7u8; 32];
        let workspace_key = [9u8; 32];
        let account = PreparedAccountKey {
            account_key_id: "account_key_1".into(),
            account_root_key,
            recovery_phrase: None,
        };
        let workspace = encrypted_workspace_for_account(
            &account.account_root_key,
            &account.account_key_id,
            "workspace_1",
            "Team Notes",
            &workspace_key,
        );

        let summary =
            workspace_summary_from_metadata(&account, &workspace, Some("workspace_1")).unwrap();

        assert_eq!(summary.workspace_id, "workspace_1");
        assert_eq!(summary.name, "Team Notes");
        assert!(summary.current);
        assert_eq!(summary.head_version, 12);
        assert_eq!(summary.metadata_version, WORKSPACE_METADATA_VERSION);
        assert_eq!(summary.workspace_key_version, WORKSPACE_KEY_VERSION);
    }

    #[test]
    fn workspace_summary_rejects_wrong_account_key() {
        let account = PreparedAccountKey {
            account_key_id: "account_key_1".into(),
            account_root_key: [7u8; 32],
            recovery_phrase: None,
        };
        let workspace = encrypted_workspace_for_account(
            &[8u8; 32],
            "account_key_1",
            "workspace_1",
            "Team Notes",
            &[9u8; 32],
        );

        assert!(matches!(
            workspace_summary_from_metadata(&account, &workspace, None),
            Err(SyncError::Crypto(_))
        ));
    }

    fn encrypted_workspace_for_account(
        account_root_key: &SymmetricKey,
        account_key_id: &str,
        workspace_id: &str,
        workspace_name: &str,
        workspace_key: &SymmetricKey,
    ) -> SyncWorkspaceMetadata {
        SyncWorkspaceMetadata {
            workspace_id: workspace_id.into(),
            current_head_commit_id: "commit_1".into(),
            head_version: 12,
            crypto_version: CRYPTO_VERSION.into(),
            encrypted_metadata: account_keys::encrypt_workspace_metadata(
                account_root_key,
                account_key_id,
                workspace_id,
                WORKSPACE_METADATA_VERSION,
                &WorkspaceDisplayMetadata::new(workspace_name),
            )
            .unwrap(),
            metadata_version: WORKSPACE_METADATA_VERSION,
            encrypted_workspace_key: account_keys::encrypt_workspace_key_for_account(
                account_root_key,
                account_key_id,
                workspace_id,
                WORKSPACE_KEY_VERSION,
                workspace_key,
            )
            .unwrap(),
            workspace_key_version: WORKSPACE_KEY_VERSION,
        }
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

    #[test]
    fn pending_upload_count_scans_dirty_local_changes() {
        let root = temp_vault("pending-upload-count");
        write_file(&root.join("a.md"), b"# A");
        let mut conn = db::open_memory_sync_db().unwrap();

        let first_count = pending_upload_count(&mut conn, &root, 1).unwrap();
        let file_ids = db::list_dirty_files(&conn)
            .unwrap()
            .into_iter()
            .map(|file| file.file_id)
            .collect::<Vec<_>>();
        db::mark_files_synced(&mut conn, "commit_1", &file_ids).unwrap();
        write_file(&root.join("a.md"), b"# A changed");

        let changed_count = pending_upload_count(&mut conn, &root, 2).unwrap();

        assert_eq!(first_count, 1);
        assert_eq!(changed_count, 1);
        fs::remove_dir_all(root).unwrap();
    }

    fn temp_vault(name: &str) -> PathBuf {
        let mut path = std::env::temp_dir();
        path.push(format!(
            "kuku-sync-commands-{name}-{}",
            super::super::now_ms()
        ));
        fs::create_dir_all(&path).unwrap();
        path
    }

    fn write_file(path: &Path, bytes: &[u8]) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        let mut file = fs::File::create(path).unwrap();
        file.write_all(bytes).unwrap();
    }
}
