use std::path::{Path, PathBuf};

use kuku_sync_core::{
    EncryptedObjectCodec, FileCreate, FileLocalStore, LocalStore, MemoryObjectStore,
    ObjectCryptoKey, ProjectedSnapshot, SyncCoordinator, SyncOnceContext, SyncOnceOutcome,
    SyncOnceRequest, SyncReason, VaultCore,
};

use crate::search::SearchState;
use crate::vault::{self, VaultState};

use super::automerge_import::import_disk_scan;
use super::automerge_projection::apply_guarded_projection_plan;
use super::errors::{SyncError, SyncResult};
use super::scanner::{ScannedFile, scan_vault_stable};
use super::types::SyncRuntimeStatus;
use super::{SyncState, now_ms};

const EXPERIMENTAL_ENGINE_ENV: &str = "KUKU_SYNC_ENGINE";

pub(crate) fn experimental_automerge_enabled() -> bool {
    experimental_automerge_enabled_value(std::env::var(EXPERIMENTAL_ENGINE_ENV).ok().as_deref())
}

pub(crate) fn experimental_automerge_enabled_value(value: Option<&str>) -> bool {
    value
        .map(str::trim)
        .map(str::to_ascii_lowercase)
        .is_some_and(|value| matches!(value.as_str(), "automerge" | "1" | "true"))
}

pub(crate) fn run_experimental_sync_once(
    state: &SyncState,
    vault_state: &VaultState,
    search: Option<&SearchState>,
) -> SyncResult<SyncRuntimeStatus> {
    let status = state.status();
    validate_experimental_status(&status)?;
    let vault_id = required_status_value(status.vault_id.as_deref(), "vault_id")?.to_owned();
    let workspace_id =
        required_status_value(status.remote_workspace_id.as_deref(), "remote_workspace_id")?
            .to_owned();
    let device_id = required_status_value(status.device_id.as_deref(), "device_id")?.to_owned();
    let vault_root = status_vault_root(&status, vault_state)?;

    let scanned = scan_vault_stable(&vault_root)?;
    let mut store = FileLocalStore::new(experimental_store_dir(&vault_root))
        .map_err(map_sync_core_store_error)?;
    let generation = now_ms().max(0) as u64;
    let current_disk = scanned
        .iter()
        .map(|file| scanned_file_snapshot(file, generation))
        .collect::<Vec<_>>();

    let mut core = match VaultCore::load_from_store(device_id.as_bytes(), &store)
        .map_err(map_sync_core_store_error)?
        .core
    {
        Some(core) => core,
        None => {
            bootstrap_core_from_scan(device_id.as_bytes(), &scanned, &mut store, &current_disk)?
        }
    };

    let mut last_projected = store
        .list_projected_snapshots()
        .map_err(map_sync_core_store_error)?;
    let import_summary = import_disk_scan(
        &mut core,
        &mut store,
        &scanned,
        &current_disk,
        &last_projected,
        generation,
        search,
    )?;
    if import_summary.review_required > 0 {
        return Err(SyncError::InvalidArgument(format!(
            "experimental automerge import requires review: {import_summary:?}"
        )));
    }
    last_projected = store
        .list_projected_snapshots()
        .map_err(map_sync_core_store_error)?;

    let mut remote = MemoryObjectStore::new();
    let codec = EncryptedObjectCodec::new(ObjectCryptoKey::from_seed(
        format!("desktop-experimental:{vault_id}:{workspace_id}").as_bytes(),
    ));
    let mut coordinator = SyncCoordinator::new();
    let outcome = coordinator
        .sync_once(
            SyncOnceContext {
                core: &mut core,
                local_store: &mut store,
                remote: &mut remote,
                codec: &codec,
            },
            SyncOnceRequest {
                reason: SyncReason::Manual,
                workspace_id,
                head_pointer: "desktop-experimental/head".to_owned(),
                generation,
                deadline_ms: Some(now_ms()),
                current_disk,
                last_projected,
                crash_after_phase: None,
                fail_with: None,
            },
        )
        .map_err(map_sync_once_error)?;

    match outcome {
        SyncOnceOutcome::Completed {
            projection_plan, ..
        } => {
            let summary = apply_guarded_projection_plan(
                &vault_root,
                &mut store,
                &vault_state.expected_mutations,
                search,
                &projection_plan,
                generation,
            )?;
            if summary.blocked > 0 {
                return Err(SyncError::InvalidArgument(format!(
                    "experimental automerge projection did not fully apply: {summary:?}"
                )));
            }
            let status = state.complete_manual_sync(0)?;
            vault_state.external_events.clear();
            Ok(status)
        }
        SyncOnceOutcome::Noop => {
            let status = state.complete_manual_sync(0)?;
            vault_state.external_events.clear();
            Ok(status)
        }
        SyncOnceOutcome::ProjectionBlocked { .. } => Err(SyncError::InvalidArgument(
            "experimental automerge sync is blocked by local projection guard".into(),
        )),
        SyncOnceOutcome::Backoff { message, .. } | SyncOnceOutcome::Blocked { message, .. } => {
            Err(SyncError::InvalidArgument(format!(
                "experimental automerge sync did not complete: {message}"
            )))
        }
        other => Err(SyncError::InvalidArgument(format!(
            "experimental automerge sync did not complete: {other:?}"
        ))),
    }
}

pub(crate) fn scanned_file_snapshot(
    file: &ScannedFile,
    projection_generation: u64,
) -> ProjectedSnapshot {
    ProjectedSnapshot {
        file_id: file.file_id.clone(),
        normalized_path: file.normalized_path.clone(),
        content_hash: file.plaintext_hash.clone(),
        mtime_ms: file.mtime_ms,
        size: file.size_bytes.max(0) as u64,
        projection_generation,
    }
}

fn bootstrap_core_from_scan(
    actor: &[u8],
    scanned: &[ScannedFile],
    store: &mut FileLocalStore,
    snapshots: &[ProjectedSnapshot],
) -> SyncResult<VaultCore> {
    let mut core = core_from_scan(actor, scanned)?;
    core.save_to_store(store)
        .map_err(map_sync_core_store_error)?;
    for snapshot in snapshots {
        store
            .save_projected_snapshot(snapshot.clone())
            .map_err(map_sync_core_store_error)?;
    }
    Ok(core)
}

pub(crate) fn core_from_scan(actor: &[u8], scanned: &[ScannedFile]) -> SyncResult<VaultCore> {
    let mut core = VaultCore::new(actor).map_err(map_sync_core_error)?;
    for file in scanned {
        let content = String::from_utf8(file.plaintext.clone()).map_err(|error| {
            SyncError::InvalidArgument(format!(
                "experimental automerge sync only supports utf-8 markdown: {}",
                error
            ))
        })?;
        core.create_markdown(FileCreate {
            stable_file_id: file.file_id.clone(),
            incarnation_id: "desktop-import-v1".to_owned(),
            display_path: file.path.clone(),
            text_doc_id: format!("text:{}", file.file_id),
            blob_ref: None,
            content,
        })
        .map_err(map_sync_core_error)?;
    }
    Ok(core)
}

pub(crate) fn validate_experimental_status(status: &SyncRuntimeStatus) -> SyncResult<()> {
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

pub(crate) fn status_vault_root(
    status: &SyncRuntimeStatus,
    vault_state: &VaultState,
) -> SyncResult<PathBuf> {
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

fn same_path(left: &Path, right: &Path) -> bool {
    match (left.canonicalize(), right.canonicalize()) {
        (Ok(left), Ok(right)) => left == right,
        _ => left == right,
    }
}

pub(crate) fn experimental_store_dir(vault_root: &Path) -> PathBuf {
    vault_root.join(".kuku").join("automerge-sync")
}

pub(crate) fn required_status_value<'a>(
    value: Option<&'a str>,
    field: &str,
) -> SyncResult<&'a str> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            SyncError::InvalidArgument(format!("{field} is required before running sync"))
        })
}

pub(crate) fn map_sync_core_error(error: kuku_sync_core::SyncCoreError) -> SyncError {
    SyncError::Storage(format!("experimental automerge core error: {error}"))
}

pub(crate) fn map_sync_core_store_error(error: kuku_sync_core::StoreError) -> SyncError {
    SyncError::Storage(format!("experimental automerge store error: {error}"))
}

fn map_sync_once_error(error: kuku_sync_core::SyncOnceError) -> SyncError {
    SyncError::Storage(format!("experimental automerge sync error: {error}"))
}

#[cfg(test)]
mod tests {
    use crate::models::FileChangeEvent;

    use super::super::types::SyncVaultConfig;
    use super::*;
    use kuku_sync_core::FileLocalStore;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn scanned_file() -> ScannedFile {
        ScannedFile {
            file_id: "file-1".to_owned(),
            path: "Notes/A.md".to_owned(),
            normalized_path: "notes/a.md".to_owned(),
            plaintext_hash: "hash-1".to_owned(),
            size_bytes: 42,
            mtime_ms: 123,
            plaintext: b"# A".to_vec(),
        }
    }

    #[test]
    fn experimental_engine_flag_is_opt_in() {
        assert!(!experimental_automerge_enabled_value(None));
        assert!(!experimental_automerge_enabled_value(Some("legacy")));
        assert!(experimental_automerge_enabled_value(Some("automerge")));
        assert!(experimental_automerge_enabled_value(Some("true")));
        assert!(experimental_automerge_enabled_value(Some("1")));
    }

    #[test]
    fn scanned_file_maps_to_projected_snapshot() {
        let snapshot = scanned_file_snapshot(&scanned_file(), 7);

        assert_eq!(snapshot.file_id, "file-1");
        assert_eq!(snapshot.normalized_path, "notes/a.md");
        assert_eq!(snapshot.content_hash, "hash-1");
        assert_eq!(snapshot.mtime_ms, 123);
        assert_eq!(snapshot.size, 42);
        assert_eq!(snapshot.projection_generation, 7);
    }

    #[test]
    fn experimental_sync_bootstraps_local_store_without_rewriting_files() {
        let root = unique_temp_dir("automerge-experimental");
        fs::create_dir_all(root.join("Notes")).unwrap();
        fs::write(root.join("Notes").join("A.md"), "# A").unwrap();
        let state = SyncState::new();
        state
            .restore_vault_with_status(
                SyncVaultConfig {
                    vault_id: "vault_1".to_owned(),
                    root_path: root.to_string_lossy().to_string(),
                    account_key_id: Some("account_1".to_owned()),
                    remote_workspace_id: "workspace_1".to_owned(),
                    workspace_name: Some("Workspace".to_owned()),
                    device_id: "device_1".to_owned(),
                    device_name: Some("Device".to_owned()),
                    remember_workspace_key: true,
                    passphrase: None,
                },
                true,
                None,
            )
            .unwrap();
        let vault_state = VaultState::new();
        vault_state.inner.lock().path = Some(root.clone());

        let status = run_experimental_sync_once(&state, &vault_state, None).unwrap();

        assert_eq!(status.phase, super::super::types::SyncPhase::Idle);
        assert!(status.last_synced_at_ms.is_some());
        assert_eq!(
            fs::read_to_string(root.join("Notes").join("A.md")).unwrap(),
            "# A"
        );
        assert!(experimental_store_dir(&root).join("manifest.bin").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn experimental_sync_projects_changed_canonical_content_to_disk() {
        let root = unique_temp_dir("automerge-experimental-project");
        fs::create_dir_all(root.join("Notes")).unwrap();
        fs::write(root.join("Notes").join("A.md"), "# A").unwrap();
        let state = configured_state(&root);
        let vault_state = VaultState::new();
        vault_state.inner.lock().path = Some(root.clone());
        run_experimental_sync_once(&state, &vault_state, None).unwrap();

        let store_dir = experimental_store_dir(&root);
        let mut store = FileLocalStore::new(&store_dir).unwrap();
        let mut core = VaultCore::load_from_store(b"device_1", &store)
            .unwrap()
            .core
            .unwrap();
        let vault = core.materialize().unwrap();
        let text_doc_id = vault.files.values().next().unwrap().text_doc_id.clone();
        core.edit_markdown(&text_doc_id, "# B").unwrap();
        core.save_to_store(&mut store).unwrap();

        let status = run_experimental_sync_once(&state, &vault_state, None).unwrap();

        assert!(status.last_synced_at_ms.is_some());
        assert_eq!(
            fs::read_to_string(root.join("Notes").join("A.md")).unwrap(),
            "# B"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn experimental_sync_imports_small_external_edit_to_core() {
        let root = unique_temp_dir("automerge-experimental-import");
        fs::create_dir_all(root.join("Notes")).unwrap();
        fs::write(root.join("Notes").join("A.md"), "# A\n\nbody\n").unwrap();
        let state = configured_state(&root);
        let vault_state = VaultState::new();
        vault_state.inner.lock().path = Some(root.clone());
        run_experimental_sync_once(&state, &vault_state, None).unwrap();

        fs::write(root.join("Notes").join("A.md"), "# A\n\nbody edited\n").unwrap();
        vault_state.external_events.record_if_external(
            &FileChangeEvent {
                kind: "modify".to_owned(),
                path: "Notes/A.md".to_owned(),
                is_dir: false,
                old_path: None,
            },
            false,
        );
        let status = run_experimental_sync_once(&state, &vault_state, None).unwrap();

        assert!(status.last_synced_at_ms.is_some());
        assert!(vault_state.external_events.snapshot().is_empty());
        let store = FileLocalStore::new(experimental_store_dir(&root)).unwrap();
        let mut core = VaultCore::load_from_store(b"device_1", &store)
            .unwrap()
            .core
            .unwrap();
        assert_eq!(
            core.materialize()
                .unwrap()
                .files
                .values()
                .next()
                .unwrap()
                .content
                .as_deref(),
            Some("# A\n\nbody edited\n")
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn experimental_sync_blocks_large_external_rewrite() {
        let root = unique_temp_dir("automerge-experimental-review");
        fs::create_dir_all(&root).unwrap();
        fs::write(
            root.join("A.md"),
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        )
        .unwrap();
        let state = configured_state(&root);
        let vault_state = VaultState::new();
        vault_state.inner.lock().path = Some(root.clone());
        run_experimental_sync_once(&state, &vault_state, None).unwrap();

        fs::write(
            root.join("A.md"),
            "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        )
        .unwrap();
        let error = run_experimental_sync_once(&state, &vault_state, None).unwrap_err();

        assert!(
            matches!(error, SyncError::InvalidArgument(message) if message.contains("requires review"))
        );
        fs::remove_dir_all(root).unwrap();
    }

    fn configured_state(root: &Path) -> SyncState {
        let state = SyncState::new();
        state
            .restore_vault_with_status(
                SyncVaultConfig {
                    vault_id: "vault_1".to_owned(),
                    root_path: root.to_string_lossy().to_string(),
                    account_key_id: Some("account_1".to_owned()),
                    remote_workspace_id: "workspace_1".to_owned(),
                    workspace_name: Some("Workspace".to_owned()),
                    device_id: "device_1".to_owned(),
                    device_name: Some("Device".to_owned()),
                    remember_workspace_key: true,
                    passphrase: None,
                },
                true,
                None,
            )
            .unwrap();
        state
    }

    fn unique_temp_dir(name: &str) -> PathBuf {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("kuku-{name}-{}-{stamp}", std::process::id()))
    }
}
