use std::collections::BTreeMap;
use std::fs;
use std::path::{Component, Path, PathBuf};

use kuku_sync_core::{
    FileLocalStore, GuardedProjectionPlan, GuardedProjectionStep, ImportCandidate,
    ImportConfidence, LocalStore, MaterializeIssue, MaterializedVault, ProjectedSnapshot,
    RecoveryRestoreInput, RecoverySnapshot, RecoverySnapshotSet, ReviewQueueSnapshot,
    ReviewResolutionCommand, ReviewResolutionRecord, SyncReviewItem, VaultCore,
    filter_resolved_review_items, import_review_item, materialize_review_item,
    preflight_projection_plan, projection_review_items, recovery_snapshot_set,
    review_item_fingerprint, review_queue_from_imports_and_projection,
};
use serde::{Deserialize, Serialize};

use crate::vault::VaultState;

use super::SyncState;
use super::automerge_experimental::{
    core_from_scan, experimental_store_dir, map_sync_core_error, map_sync_core_store_error,
    required_status_value, scanned_file_snapshot, status_vault_root, validate_experimental_status,
};
use super::automerge_import::{
    apply_auto_import_candidates_to_core, classify_disk_scan_candidates,
};
use super::errors::{SyncError, SyncResult};
use super::now_ms;
use super::scanner::{ScannedFile, normalize_vault_relative_path, scan_vault_stable};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomergeReviewDiffPayload {
    pub review_item_id: String,
    pub kind: AutomergeReviewDiffKind,
    pub path: String,
    pub old_markdown: String,
    pub new_markdown: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AutomergeReviewDiffKind {
    ImportCreate,
    ImportModify,
    ImportDelete,
    ImportRename,
    ProjectionWrite,
    ProjectionDelete,
    DeleteEditConflict,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomergeRecoveryRestoreRequest {
    pub snapshot_id: String,
    pub target_display_path: String,
}

pub(crate) fn build_experimental_review_queue(
    state: &SyncState,
    vault_state: &VaultState,
) -> SyncResult<ReviewQueueSnapshot> {
    Ok(build_review_context(state, vault_state)?.queue)
}

pub(crate) fn build_experimental_recovery_snapshot_set(
    state: &SyncState,
    vault_state: &VaultState,
) -> SyncResult<RecoverySnapshotSet> {
    Ok(recovery_snapshot_set(
        &build_review_context(state, vault_state)?.materialized,
    ))
}

pub(crate) fn restore_experimental_recovery_snapshot(
    state: &SyncState,
    vault_state: &VaultState,
    request: AutomergeRecoveryRestoreRequest,
) -> SyncResult<RecoverySnapshotSet> {
    let context = build_review_context(state, vault_state)?;
    let snapshot = recovery_snapshot_set(&context.materialized)
        .snapshots
        .into_iter()
        .find(|snapshot| snapshot.id == request.snapshot_id)
        .ok_or_else(|| {
            SyncError::InvalidArgument(format!(
                "sync recovery snapshot not found: {}",
                request.snapshot_id
            ))
        })?;
    let target_display_path = request.target_display_path.trim();
    validate_recovery_target_path(target_display_path)?;

    let mut store = FileLocalStore::new(experimental_store_dir(&context.vault_root))
        .map_err(map_sync_core_store_error)?;
    let mut core = load_review_core(state, vault_state, &store, &context.scanned)?;
    let generation = now_ms().max(0) as u64;
    let normalized_path = normalize_vault_relative_path(target_display_path)?;
    let file_id = recovery_restore_file_id(&snapshot, &normalized_path, generation);
    core.restore_recovery_snapshot(RecoveryRestoreInput {
        stable_file_id: file_id.clone(),
        incarnation_id: format!("recovery-restore-{generation}"),
        display_path: target_display_path.to_owned(),
        text_doc_id: format!("text:{file_id}"),
        content: snapshot.content,
    })
    .map_err(map_sync_core_error)?;
    core.save_to_store(&mut store)
        .map_err(map_sync_core_store_error)?;

    let materialized = core.materialize().map_err(map_sync_core_error)?;
    Ok(recovery_snapshot_set(&materialized))
}

pub(crate) fn build_experimental_review_diff(
    state: &SyncState,
    vault_state: &VaultState,
    review_item_id: &str,
) -> SyncResult<AutomergeReviewDiffPayload> {
    let context = build_review_context(state, vault_state)?;
    if let Some(payload) = import_review_diff(&context, review_item_id)? {
        return Ok(payload);
    }
    if let Some(payload) = projection_review_diff(&context, review_item_id)? {
        return Ok(payload);
    }
    if let Some(payload) = materialization_review_diff(&context, review_item_id) {
        return Ok(payload);
    }
    Err(SyncError::InvalidArgument(format!(
        "sync review item not found or has no diff payload: {review_item_id}"
    )))
}

pub(crate) fn resolve_experimental_review_item(
    state: &SyncState,
    vault_state: &VaultState,
    command: ReviewResolutionCommand,
) -> SyncResult<ReviewQueueSnapshot> {
    let context = build_review_context(state, vault_state)?;
    let review_item_id = command_review_item_id(&command);
    let item = context
        .queue
        .items
        .iter()
        .find(|item| review_item_id_for(item) == Some(review_item_id))
        .cloned()
        .ok_or_else(|| {
            SyncError::InvalidArgument(format!("sync review item not found: {review_item_id}"))
        })?;
    let mut store = FileLocalStore::new(experimental_store_dir(&context.vault_root))
        .map_err(map_sync_core_store_error)?;

    match &command {
        ReviewResolutionCommand::AcceptImport { .. } => {
            let SyncReviewItem::Import { .. } = item else {
                return Err(SyncError::InvalidArgument(
                    "accept import requires an import review item".into(),
                ));
            };
            let candidate = import_candidate_for_review_item(&context, review_item_id)?;
            let mut core = load_review_core(state, vault_state, &store, &context.scanned)?;
            apply_review_import_candidate(
                &mut core,
                &mut store,
                candidate,
                &context.scanned,
                &context.current_disk,
                now_ms().max(0) as u64,
            )?;
            core.save_to_store(&mut store)
                .map_err(map_sync_core_store_error)?;
        }
        ReviewResolutionCommand::RejectImport { .. } => {
            let SyncReviewItem::Import { .. } = item else {
                return Err(SyncError::InvalidArgument(
                    "reject import requires an import review item".into(),
                ));
            };
            let candidate = import_candidate_for_review_item(&context, review_item_id)?;
            store
                .save_review_resolution(ReviewResolutionRecord {
                    review_item_id: review_item_id.to_owned(),
                    item_fingerprint: review_item_fingerprint(&item),
                    command: command.clone(),
                    resolved_at_ms: now_ms(),
                })
                .map_err(map_sync_core_store_error)?;
            mark_rejected_import_projection_baseline(&mut store, &context, candidate)?;
        }
        ReviewResolutionCommand::KeepDelete { file_id, .. } => {
            ensure_delete_edit_review_item(&item, file_id, "keep delete")?;
            let mut core = load_review_core(state, vault_state, &store, &context.scanned)?;
            core.resolve_delete_edit_keep_delete(file_id)
                .map_err(map_sync_core_error)?;
            core.save_to_store(&mut store)
                .map_err(map_sync_core_store_error)?;
        }
        ReviewResolutionCommand::RestoreEditedVersion { file_id, .. } => {
            ensure_delete_edit_review_item(&item, file_id, "restore edited version")?;
            let mut core = load_review_core(state, vault_state, &store, &context.scanned)?;
            core.resolve_delete_edit_restore_edited(file_id)
                .map_err(map_sync_core_error)?;
            core.save_to_store(&mut store)
                .map_err(map_sync_core_store_error)?;
        }
        ReviewResolutionCommand::RenameFile {
            file_id,
            new_display_path,
            ..
        } => {
            ensure_rename_review_item(&item, file_id)?;
            let mut core = load_review_core(state, vault_state, &store, &context.scanned)?;
            core.rename_file(file_id, new_display_path.clone())
                .map_err(map_sync_core_error)?;
            core.save_to_store(&mut store)
                .map_err(map_sync_core_store_error)?;
        }
        ReviewResolutionCommand::RetryMissingObject { .. } => {
            store
                .remove_review_resolution(review_item_id)
                .map_err(map_sync_core_store_error)?;
        }
    }

    build_experimental_review_queue(state, vault_state)
}

fn ensure_delete_edit_review_item(
    item: &SyncReviewItem,
    expected_file_id: &str,
    action: &str,
) -> SyncResult<()> {
    match item {
        SyncReviewItem::Conflict {
            issue: MaterializeIssue::DeleteEditConflict { file_id, .. },
            ..
        } if file_id == expected_file_id => Ok(()),
        _ => Err(SyncError::InvalidArgument(format!(
            "{action} requires a delete/edit conflict review item"
        ))),
    }
}

fn ensure_rename_review_item(item: &SyncReviewItem, expected_file_id: &str) -> SyncResult<()> {
    match item {
        SyncReviewItem::Conflict {
            issue:
                MaterializeIssue::PathConflict { file_ids, .. }
                | MaterializeIssue::CaseConflict { file_ids, .. },
            ..
        } if file_ids.iter().any(|file_id| file_id == expected_file_id) => Ok(()),
        SyncReviewItem::ProjectionBlocked { file_id, .. } if file_id == expected_file_id => Ok(()),
        _ => Err(SyncError::InvalidArgument(
            "rename requires a path/case/projection review item for the file".into(),
        )),
    }
}

struct ReviewContext {
    vault_root: PathBuf,
    scanned: Vec<ScannedFile>,
    current_disk: Vec<ProjectedSnapshot>,
    import_candidates: Vec<ImportCandidate>,
    projection_plan: GuardedProjectionPlan,
    materialized: MaterializedVault,
    queue: ReviewQueueSnapshot,
}

fn build_review_context(state: &SyncState, vault_state: &VaultState) -> SyncResult<ReviewContext> {
    let status = state.status();
    validate_experimental_status(&status)?;
    let device_id = required_status_value(status.device_id.as_deref(), "device_id")?.to_owned();
    let vault_root = status_vault_root(&status, vault_state)?;
    let scanned = scan_vault_stable(&vault_root)?;
    let generation = now_ms().max(0) as u64;
    let current_disk = scanned
        .iter()
        .map(|file| scanned_file_snapshot(file, generation))
        .collect::<Vec<_>>();
    let store = FileLocalStore::new(experimental_store_dir(&vault_root))
        .map_err(map_sync_core_store_error)?;
    let resolutions = store
        .list_review_resolutions()
        .map_err(map_sync_core_store_error)?;
    let mut last_projected = store
        .list_projected_snapshots()
        .map_err(map_sync_core_store_error)?;
    let load = VaultCore::load_from_store(device_id.as_bytes(), &store)
        .map_err(map_sync_core_store_error)?;
    let Some(mut core) = load.core else {
        let materialized = core_from_scan(device_id.as_bytes(), &scanned)
            .and_then(|mut core| core.materialize().map_err(map_sync_core_error))?;
        return Ok(ReviewContext {
            vault_root,
            scanned,
            current_disk,
            import_candidates: Vec::new(),
            projection_plan: GuardedProjectionPlan {
                blocked: false,
                steps: Vec::new(),
            },
            materialized,
            queue: ReviewQueueSnapshot::from_items(Vec::new()),
        });
    };

    let import_candidates =
        classify_disk_scan_candidates(&mut core, &scanned, &current_disk, &last_projected)?;
    apply_auto_import_candidates_to_core(&mut core, &import_candidates, &scanned, generation)?;
    simulate_projected_snapshots_after_auto_imports(
        &mut last_projected,
        &import_candidates,
        &current_disk,
    );

    let materialized = core.materialize().map_err(map_sync_core_error)?;
    let projection_plan = preflight_projection_plan(
        &materialized.projection_plan,
        &current_disk,
        &last_projected,
    );
    let raw_queue =
        review_queue_from_imports_and_projection(&import_candidates, Some(&projection_plan));
    let queue = filter_resolved_review_items(raw_queue.items, &resolutions);

    Ok(ReviewContext {
        vault_root,
        scanned,
        current_disk,
        import_candidates,
        projection_plan,
        materialized,
        queue,
    })
}

fn validate_recovery_target_path(target_display_path: &str) -> SyncResult<()> {
    let normalized_path = normalize_vault_relative_path(target_display_path)?;
    if Path::new(&normalized_path)
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("md"))
    {
        return Ok(());
    }
    Err(SyncError::InvalidArgument(
        "recovery target path must be a markdown file".into(),
    ))
}

fn recovery_restore_file_id(
    snapshot: &RecoverySnapshot,
    normalized_path: &str,
    generation: u64,
) -> String {
    let mut hasher = blake3::Hasher::new();
    hasher.update(snapshot.id.as_bytes());
    hasher.update(normalized_path.as_bytes());
    hasher.update(&generation.to_le_bytes());
    let digest = hasher.finalize().to_hex().to_string();
    format!("recovery_{}", &digest[..32])
}

fn command_review_item_id(command: &ReviewResolutionCommand) -> &str {
    match command {
        ReviewResolutionCommand::AcceptImport { review_item_id }
        | ReviewResolutionCommand::RejectImport { review_item_id }
        | ReviewResolutionCommand::KeepDelete { review_item_id, .. }
        | ReviewResolutionCommand::RestoreEditedVersion { review_item_id, .. }
        | ReviewResolutionCommand::RenameFile { review_item_id, .. }
        | ReviewResolutionCommand::RetryMissingObject { review_item_id } => review_item_id,
    }
}

fn load_review_core(
    state: &SyncState,
    _vault_state: &VaultState,
    store: &FileLocalStore,
    scanned: &[ScannedFile],
) -> SyncResult<VaultCore> {
    let status = state.status();
    validate_experimental_status(&status)?;
    let device_id = required_status_value(status.device_id.as_deref(), "device_id")?;
    let load = VaultCore::load_from_store(device_id.as_bytes(), store)
        .map_err(map_sync_core_store_error)?;
    match load.core {
        Some(core) => Ok(core),
        None => core_from_scan(device_id.as_bytes(), scanned),
    }
}

fn import_candidate_for_review_item<'a>(
    context: &'a ReviewContext,
    review_item_id: &str,
) -> SyncResult<&'a ImportCandidate> {
    context
        .import_candidates
        .iter()
        .find(|candidate| {
            import_review_item(candidate)
                .as_ref()
                .is_some_and(|item| review_item_id_for(item) == Some(review_item_id))
        })
        .ok_or_else(|| {
            SyncError::InvalidArgument(format!(
                "import candidate not found for review item: {review_item_id}"
            ))
        })
}

fn apply_review_import_candidate(
    core: &mut VaultCore,
    store: &mut FileLocalStore,
    candidate: &ImportCandidate,
    scanned: &[ScannedFile],
    current_disk: &[ProjectedSnapshot],
    generation: u64,
) -> SyncResult<()> {
    match candidate {
        ImportCandidate::ExternalCreate {
            normalized_path, ..
        } => {
            let file = scanned_by_path(scanned, normalized_path)?;
            let content = scanned_content(file)?;
            core.create_markdown(kuku_sync_core::FileCreate {
                stable_file_id: file.file_id.clone(),
                incarnation_id: format!("desktop-review-import-{generation}"),
                display_path: file.path.clone(),
                text_doc_id: format!("text:{}", file.file_id),
                blob_ref: None,
                content,
            })
            .map_err(map_sync_core_error)?;
            save_current_snapshot_by_path(store, current_disk, normalized_path)?;
        }
        ImportCandidate::ExternalModify { file_id, .. } => {
            let file = scanned_by_file_id(scanned, file_id)?;
            let content = scanned_content(file)?;
            let materialized = core.materialize().map_err(map_sync_core_error)?;
            let previous = materialized_file(&materialized, file_id)?;
            core.edit_markdown(&previous.text_doc_id, content)
                .map_err(map_sync_core_error)?;
            save_current_snapshot_by_file_id(store, current_disk, file_id)?;
        }
        ImportCandidate::ExternalRename { file_id, .. } => {
            let file = scanned_by_file_id(scanned, file_id)?;
            let content = scanned_content(file)?;
            let materialized = core.materialize().map_err(map_sync_core_error)?;
            let previous = materialized_file(&materialized, file_id)?;
            let text_doc_id = previous.text_doc_id.clone();
            core.rename_file(file_id, file.path.clone())
                .map_err(map_sync_core_error)?;
            core.edit_markdown(&text_doc_id, content)
                .map_err(map_sync_core_error)?;
            save_current_snapshot_by_file_id(store, current_disk, file_id)?;
        }
        ImportCandidate::ExternalDelete { file_id, .. } => {
            core.tombstone_file(file_id).map_err(map_sync_core_error)?;
            store
                .remove_projected_snapshot(file_id)
                .map_err(map_sync_core_store_error)?;
        }
        ImportCandidate::Suppressed { .. } | ImportCandidate::Unchanged { .. } => {
            return Err(SyncError::InvalidArgument(
                "cannot accept a non-review import candidate".into(),
            ));
        }
    }
    Ok(())
}

fn mark_rejected_import_projection_baseline(
    store: &mut FileLocalStore,
    context: &ReviewContext,
    candidate: &ImportCandidate,
) -> SyncResult<()> {
    match candidate {
        ImportCandidate::ExternalModify { file_id, .. }
        | ImportCandidate::ExternalRename { file_id, .. } => {
            save_current_snapshot_by_file_id(store, &context.current_disk, file_id)
        }
        ImportCandidate::ExternalDelete { file_id, .. } => store
            .remove_projected_snapshot(file_id)
            .map_err(map_sync_core_store_error),
        ImportCandidate::ExternalCreate { .. } => Ok(()),
        ImportCandidate::Suppressed { .. } | ImportCandidate::Unchanged { .. } => Ok(()),
    }
}

fn save_current_snapshot_by_path(
    store: &mut FileLocalStore,
    current_disk: &[ProjectedSnapshot],
    normalized_path: &str,
) -> SyncResult<()> {
    let snapshot = current_disk
        .iter()
        .find(|snapshot| snapshot.normalized_path == normalized_path)
        .ok_or_else(|| {
            SyncError::InvalidArgument(format!(
                "current disk snapshot not found for path: {normalized_path}"
            ))
        })?;
    store
        .save_projected_snapshot(snapshot.clone())
        .map_err(map_sync_core_store_error)
}

fn save_current_snapshot_by_file_id(
    store: &mut FileLocalStore,
    current_disk: &[ProjectedSnapshot],
    file_id: &str,
) -> SyncResult<()> {
    let snapshot = current_disk
        .iter()
        .find(|snapshot| snapshot.file_id == file_id)
        .ok_or_else(|| {
            SyncError::InvalidArgument(format!(
                "current disk snapshot not found for file: {file_id}"
            ))
        })?;
    store
        .save_projected_snapshot(snapshot.clone())
        .map_err(map_sync_core_store_error)
}

fn simulate_projected_snapshots_after_auto_imports(
    last_projected: &mut Vec<ProjectedSnapshot>,
    candidates: &[ImportCandidate],
    current_disk: &[ProjectedSnapshot],
) {
    let current_by_file_id = current_disk
        .iter()
        .map(|snapshot| (snapshot.file_id.as_str(), snapshot))
        .collect::<BTreeMap<_, _>>();
    let current_by_path = current_disk
        .iter()
        .map(|snapshot| (snapshot.normalized_path.as_str(), snapshot))
        .collect::<BTreeMap<_, _>>();
    let mut projected_by_file_id = last_projected
        .iter()
        .cloned()
        .map(|snapshot| (snapshot.file_id.clone(), snapshot))
        .collect::<BTreeMap<_, _>>();

    for candidate in candidates {
        let snapshot = match candidate {
            ImportCandidate::ExternalCreate {
                normalized_path,
                confidence,
                ..
            } if is_auto_import(confidence) => current_by_path.get(normalized_path.as_str()),
            ImportCandidate::ExternalModify {
                file_id,
                confidence,
                ..
            }
            | ImportCandidate::ExternalRename {
                file_id,
                confidence,
                ..
            } if is_auto_import(confidence) => current_by_file_id.get(file_id.as_str()),
            ImportCandidate::Unchanged { normalized_path } => {
                current_by_path.get(normalized_path.as_str())
            }
            _ => None,
        };
        if let Some(snapshot) = snapshot {
            projected_by_file_id.insert(snapshot.file_id.clone(), (*snapshot).clone());
        }
    }

    *last_projected = projected_by_file_id.into_values().collect();
}

fn import_review_diff(
    context: &ReviewContext,
    review_item_id: &str,
) -> SyncResult<Option<AutomergeReviewDiffPayload>> {
    for candidate in &context.import_candidates {
        let Some(SyncReviewItem::Import { id, .. }) = import_review_item(candidate) else {
            continue;
        };
        if id != review_item_id {
            continue;
        }
        return Ok(Some(match candidate {
            ImportCandidate::ExternalCreate {
                normalized_path, ..
            } => {
                let file = scanned_by_path(&context.scanned, normalized_path)?;
                AutomergeReviewDiffPayload {
                    review_item_id: id,
                    kind: AutomergeReviewDiffKind::ImportCreate,
                    path: file.path.clone(),
                    old_markdown: String::new(),
                    new_markdown: scanned_content(file)?,
                }
            }
            ImportCandidate::ExternalModify { file_id, .. } => {
                let file = scanned_by_file_id(&context.scanned, file_id)?;
                let previous = materialized_file(&context.materialized, file_id)?;
                AutomergeReviewDiffPayload {
                    review_item_id: id,
                    kind: AutomergeReviewDiffKind::ImportModify,
                    path: file.path.clone(),
                    old_markdown: previous.content.clone().unwrap_or_default(),
                    new_markdown: scanned_content(file)?,
                }
            }
            ImportCandidate::ExternalDelete {
                file_id,
                normalized_path,
                ..
            } => {
                let previous = materialized_file(&context.materialized, file_id)?;
                AutomergeReviewDiffPayload {
                    review_item_id: id,
                    kind: AutomergeReviewDiffKind::ImportDelete,
                    path: previous.display_path.clone(),
                    old_markdown: previous.content.clone().unwrap_or_default(),
                    new_markdown: String::new(),
                }
                .with_fallback_path(normalized_path)
            }
            ImportCandidate::ExternalRename {
                file_id,
                to_normalized_path,
                ..
            } => {
                let file = scanned_by_file_id(&context.scanned, file_id)?;
                let previous = materialized_file(&context.materialized, file_id)?;
                AutomergeReviewDiffPayload {
                    review_item_id: id,
                    kind: AutomergeReviewDiffKind::ImportRename,
                    path: file.path.clone(),
                    old_markdown: previous.content.clone().unwrap_or_default(),
                    new_markdown: scanned_content(file)?,
                }
                .with_fallback_path(to_normalized_path)
            }
            ImportCandidate::Suppressed { .. } | ImportCandidate::Unchanged { .. } => {
                unreachable!("suppressed/unchanged candidates do not create import review items")
            }
        }));
    }

    Ok(None)
}

fn projection_review_diff(
    context: &ReviewContext,
    review_item_id: &str,
) -> SyncResult<Option<AutomergeReviewDiffPayload>> {
    for step in &context.projection_plan.steps {
        let item = projection_review_item_for_step(step);
        let Some(item) = item else {
            continue;
        };
        if review_item_id_for(&item) != Some(review_item_id) {
            continue;
        }
        return match step {
            GuardedProjectionStep::BlockedByLiveDiskChange {
                path, operation, ..
            } => {
                let current = read_vault_markdown(&context.vault_root, path)?;
                let new_markdown = match step {
                    GuardedProjectionStep::BlockedByLiveDiskChange { .. }
                        if matches!(operation, kuku_sync_core::ProjectionOperation::Tombstone) =>
                    {
                        String::new()
                    }
                    _ => projection_content_for_path(&context.projection_plan, path)
                        .unwrap_or_default(),
                };
                Ok(Some(AutomergeReviewDiffPayload {
                    review_item_id: review_item_id.to_owned(),
                    kind: if matches!(operation, kuku_sync_core::ProjectionOperation::Tombstone) {
                        AutomergeReviewDiffKind::ProjectionDelete
                    } else {
                        AutomergeReviewDiffKind::ProjectionWrite
                    },
                    path: path.clone(),
                    old_markdown: current,
                    new_markdown,
                }))
            }
            GuardedProjectionStep::BlockedMaterialization { .. }
            | GuardedProjectionStep::Write { .. }
            | GuardedProjectionStep::Tombstone { .. } => Ok(None),
        };
    }

    Ok(None)
}

fn materialization_review_diff(
    context: &ReviewContext,
    review_item_id: &str,
) -> Option<AutomergeReviewDiffPayload> {
    for issue in &context.materialized.issues {
        let item = materialize_review_item(issue);
        if review_item_id_for(&item) != Some(review_item_id) {
            continue;
        }
        if let MaterializeIssue::DeleteEditConflict {
            display_path,
            tombstone_content,
            current_content,
            ..
        } = issue
        {
            return Some(AutomergeReviewDiffPayload {
                review_item_id: review_item_id.to_owned(),
                kind: AutomergeReviewDiffKind::DeleteEditConflict,
                path: display_path.clone(),
                old_markdown: tombstone_content.clone(),
                new_markdown: current_content.clone(),
            });
        }
    }

    None
}

fn projection_review_item_for_step(step: &GuardedProjectionStep) -> Option<SyncReviewItem> {
    let plan = GuardedProjectionPlan {
        blocked: true,
        steps: vec![step.clone()],
    };
    projection_review_items(&plan).into_iter().next()
}

fn review_item_id_for(item: &SyncReviewItem) -> Option<&str> {
    match item {
        SyncReviewItem::Import { id, .. }
        | SyncReviewItem::ProjectionBlocked { id, .. }
        | SyncReviewItem::Conflict { id, .. }
        | SyncReviewItem::MissingObject { id, .. } => Some(id),
    }
}

fn projection_content_for_path(plan: &GuardedProjectionPlan, path: &str) -> Option<String> {
    plan.steps.iter().find_map(|step| match step {
        GuardedProjectionStep::Write {
            path: step_path,
            content,
            ..
        } if step_path == path => Some(content.clone()),
        _ => None,
    })
}

fn scanned_by_file_id<'a>(
    scanned: &'a [ScannedFile],
    file_id: &str,
) -> SyncResult<&'a ScannedFile> {
    scanned
        .iter()
        .find(|file| file.file_id == file_id)
        .ok_or_else(|| SyncError::InvalidArgument(format!("scanned file not found: {file_id}")))
}

fn scanned_by_path<'a>(scanned: &'a [ScannedFile], path: &str) -> SyncResult<&'a ScannedFile> {
    scanned
        .iter()
        .find(|file| file.normalized_path == path)
        .ok_or_else(|| SyncError::InvalidArgument(format!("scanned file not found: {path}")))
}

fn materialized_file<'a>(
    vault: &'a MaterializedVault,
    file_id: &str,
) -> SyncResult<&'a kuku_sync_core::MaterializedFile> {
    vault.files.get(file_id).ok_or_else(|| {
        SyncError::InvalidArgument(format!("materialized file not found: {file_id}"))
    })
}

fn scanned_content(file: &ScannedFile) -> SyncResult<String> {
    String::from_utf8(file.plaintext.clone()).map_err(|error| {
        SyncError::InvalidArgument(format!("review diff only supports utf-8 markdown: {error}"))
    })
}

fn read_vault_markdown(vault_root: &Path, relative_path: &str) -> SyncResult<String> {
    let path = resolve_vault_read_path(vault_root, relative_path)?;
    fs::read_to_string(&path).map_err(|error| {
        SyncError::Storage(format!(
            "failed to read review diff file {}: {error}",
            path.display()
        ))
    })
}

fn resolve_vault_read_path(vault_root: &Path, relative_path: &str) -> SyncResult<PathBuf> {
    let mut resolved = vault_root.to_path_buf();
    for component in Path::new(relative_path).components() {
        match component {
            Component::Normal(segment) => {
                resolved.push(segment);
                reject_symlink(&resolved)?;
            }
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err(SyncError::InvalidArgument(format!(
                    "review diff path escapes vault: {relative_path}"
                )));
            }
        }
    }
    Ok(resolved)
}

fn reject_symlink(path: &Path) -> SyncResult<()> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => Err(SyncError::InvalidArgument(
            format!("review diff path contains symlink: {}", path.display()),
        )),
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(SyncError::Storage(format!(
            "failed to inspect review diff path {}: {error}",
            path.display()
        ))),
    }
}

fn is_auto_import(confidence: &ImportConfidence) -> bool {
    matches!(confidence, ImportConfidence::AutoImport { .. })
}

trait DiffPayloadExt {
    fn with_fallback_path(self, fallback: &str) -> Self;
}

impl DiffPayloadExt for AutomergeReviewDiffPayload {
    fn with_fallback_path(mut self, fallback: &str) -> Self {
        if self.path.is_empty() {
            self.path = fallback.to_owned();
        }
        self
    }
}

#[cfg(test)]
mod tests {
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::super::automerge_experimental::run_experimental_sync_once;
    use super::super::types::SyncVaultConfig;
    use super::*;

    #[test]
    fn review_queue_exposes_large_external_rewrite_and_diff_payload() {
        let root = unique_temp_dir("automerge-review");
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
        let queue = build_experimental_review_queue(&state, &vault_state).unwrap();

        assert!(queue.blocks_fully_synced);
        let import_item = queue
            .items
            .iter()
            .find_map(|item| match item {
                SyncReviewItem::Import { id, .. } => Some(id.clone()),
                _ => None,
            })
            .expect("large rewrite should create import review");
        let diff = build_experimental_review_diff(&state, &vault_state, &import_item).unwrap();

        assert_eq!(diff.kind, AutomergeReviewDiffKind::ImportModify);
        assert_eq!(diff.path, "A.md");
        assert_eq!(
            diff.old_markdown,
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        );
        assert_eq!(
            diff.new_markdown,
            "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn accept_import_resolution_updates_core_and_clears_review_item() {
        let root = unique_temp_dir("automerge-review-accept");
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
        let queue = build_experimental_review_queue(&state, &vault_state).unwrap();
        let review_item_id = first_import_review_item_id(&queue);

        let resolved = resolve_experimental_review_item(
            &state,
            &vault_state,
            ReviewResolutionCommand::AcceptImport {
                review_item_id: review_item_id.clone(),
            },
        )
        .unwrap();

        assert!(!resolved.blocks_fully_synced);
        assert!(resolved.items.is_empty());
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
            Some("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb")
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn reject_import_resolution_hides_only_same_fingerprint() {
        let root = unique_temp_dir("automerge-review-reject");
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
        let queue = build_experimental_review_queue(&state, &vault_state).unwrap();
        let review_item_id = first_import_review_item_id(&queue);

        let resolved = resolve_experimental_review_item(
            &state,
            &vault_state,
            ReviewResolutionCommand::RejectImport {
                review_item_id: review_item_id.clone(),
            },
        )
        .unwrap();

        assert!(!resolved.blocks_fully_synced);
        assert!(resolved.items.is_empty());

        fs::write(
            root.join("A.md"),
            "cccccccccccccccccccccccccccccccccccccccc",
        )
        .unwrap();
        let changed = build_experimental_review_queue(&state, &vault_state).unwrap();

        assert!(changed.blocks_fully_synced);
        assert_eq!(first_import_review_item_id(&changed), review_item_id);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn keep_delete_resolution_updates_delete_edit_conflict() {
        let root = unique_temp_dir("automerge-review-keep-delete");
        fs::create_dir_all(&root).unwrap();
        let state = configured_state(&root);
        let vault_state = configured_vault_state(&root);
        let mut core = delete_edit_conflict_core();
        save_core_to_experimental_store(&root, &mut core);

        let queue = build_experimental_review_queue(&state, &vault_state).unwrap();
        let (review_item_id, file_id) = first_delete_edit_review_item(&queue);
        let resolved = resolve_experimental_review_item(
            &state,
            &vault_state,
            ReviewResolutionCommand::KeepDelete {
                review_item_id,
                file_id: file_id.clone(),
            },
        )
        .unwrap();

        assert!(!resolved.blocks_fully_synced);
        assert!(resolved.items.is_empty());
        let file = materialized_file_from_store(&root, &file_id);
        assert_eq!(file.state, kuku_sync_core::FileState::Tombstoned);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn restore_edited_resolution_updates_delete_edit_conflict() {
        let root = unique_temp_dir("automerge-review-restore-edited");
        fs::create_dir_all(&root).unwrap();
        let state = configured_state(&root);
        let vault_state = configured_vault_state(&root);
        let mut core = delete_edit_conflict_core();
        save_core_to_experimental_store(&root, &mut core);

        let queue = build_experimental_review_queue(&state, &vault_state).unwrap();
        let (review_item_id, file_id) = first_delete_edit_review_item(&queue);
        let resolved = resolve_experimental_review_item(
            &state,
            &vault_state,
            ReviewResolutionCommand::RestoreEditedVersion {
                review_item_id,
                file_id: file_id.clone(),
            },
        )
        .unwrap();

        assert!(!resolved.blocks_fully_synced);
        assert!(resolved.items.is_empty());
        let file = materialized_file_from_store(&root, &file_id);
        assert_eq!(file.state, kuku_sync_core::FileState::Active);
        assert_eq!(file.content.as_deref(), Some("edited after delete"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn recovery_snapshot_restore_creates_new_core_file() {
        let root = unique_temp_dir("automerge-review-recovery-restore");
        fs::create_dir_all(&root).unwrap();
        let state = configured_state(&root);
        let vault_state = configured_vault_state(&root);
        let mut core = delete_edit_conflict_core();
        save_core_to_experimental_store(&root, &mut core);

        let snapshots = build_experimental_recovery_snapshot_set(&state, &vault_state).unwrap();
        let snapshot = snapshots
            .snapshots
            .iter()
            .find(|snapshot| {
                snapshot.kind == kuku_sync_core::RecoverySnapshotKind::DeleteEditCurrent
            })
            .unwrap();
        let restored = restore_experimental_recovery_snapshot(
            &state,
            &vault_state,
            AutomergeRecoveryRestoreRequest {
                snapshot_id: snapshot.id.clone(),
                target_display_path: "Recovered.md".to_owned(),
            },
        )
        .unwrap();

        assert!(
            restored
                .snapshots
                .iter()
                .any(|snapshot| snapshot.display_path == "Recovered.md"
                    && snapshot.content == "edited after delete")
        );
        let store = FileLocalStore::new(experimental_store_dir(&root)).unwrap();
        let mut core = VaultCore::load_from_store(b"device_1", &store)
            .unwrap()
            .core
            .unwrap();
        let vault = core.materialize().unwrap();
        assert!(vault.files.values().any(|file| {
            file.display_path == "Recovered.md"
                && file.state == kuku_sync_core::FileState::Active
                && file.content.as_deref() == Some("edited after delete")
        }));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rename_resolution_updates_path_conflict() {
        let root = unique_temp_dir("automerge-review-rename-conflict");
        fs::create_dir_all(&root).unwrap();
        let state = configured_state(&root);
        let vault_state = configured_vault_state(&root);
        let mut core = path_conflict_core();
        save_core_to_experimental_store(&root, &mut core);

        let queue = build_experimental_review_queue(&state, &vault_state).unwrap();
        let (review_item_id, file_id) = first_path_conflict_review_item(&queue);
        let resolved = resolve_experimental_review_item(
            &state,
            &vault_state,
            ReviewResolutionCommand::RenameFile {
                review_item_id,
                file_id: file_id.clone(),
                new_display_path: "renamed.md".to_owned(),
            },
        )
        .unwrap();

        assert!(!resolved.blocks_fully_synced);
        assert!(resolved.items.is_empty());
        let store = FileLocalStore::new(experimental_store_dir(&root)).unwrap();
        let mut core = VaultCore::load_from_store(b"device_1", &store)
            .unwrap()
            .core
            .unwrap();
        let vault = core.materialize().unwrap();
        assert!(vault.issues.is_empty());
        assert_eq!(
            vault.files.get(&file_id).unwrap().display_path.as_str(),
            "renamed.md"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn auto_importable_external_edit_does_not_create_review_item() {
        let root = unique_temp_dir("automerge-review-auto");
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("A.md"), "# A\n\nbody\n").unwrap();
        let state = configured_state(&root);
        let vault_state = VaultState::new();
        vault_state.inner.lock().path = Some(root.clone());
        run_experimental_sync_once(&state, &vault_state, None).unwrap();

        fs::write(root.join("A.md"), "# A\n\nbody edited\n").unwrap();
        let queue = build_experimental_review_queue(&state, &vault_state).unwrap();

        assert!(!queue.blocks_fully_synced);
        assert!(queue.items.is_empty());
        fs::remove_dir_all(root).unwrap();
    }

    fn first_import_review_item_id(queue: &ReviewQueueSnapshot) -> String {
        queue
            .items
            .iter()
            .find_map(|item| match item {
                SyncReviewItem::Import { id, .. } => Some(id.clone()),
                _ => None,
            })
            .expect("expected import review item")
    }

    fn first_delete_edit_review_item(queue: &ReviewQueueSnapshot) -> (String, String) {
        queue
            .items
            .iter()
            .find_map(|item| match item {
                SyncReviewItem::Conflict {
                    id,
                    issue: MaterializeIssue::DeleteEditConflict { file_id, .. },
                } => Some((id.clone(), file_id.clone())),
                _ => None,
            })
            .expect("expected delete/edit review item")
    }

    fn first_path_conflict_review_item(queue: &ReviewQueueSnapshot) -> (String, String) {
        queue
            .items
            .iter()
            .find_map(|item| match item {
                SyncReviewItem::Conflict {
                    id,
                    issue:
                        MaterializeIssue::PathConflict { file_ids, .. }
                        | MaterializeIssue::CaseConflict { file_ids, .. },
                } => file_ids
                    .first()
                    .map(|file_id| (id.clone(), file_id.clone())),
                _ => None,
            })
            .expect("expected path conflict review item")
    }

    fn save_core_to_experimental_store(root: &Path, core: &mut VaultCore) {
        let mut store = FileLocalStore::new(experimental_store_dir(root)).unwrap();
        core.save_to_store(&mut store).unwrap();
    }

    fn materialized_file_from_store(
        root: &Path,
        file_id: &str,
    ) -> kuku_sync_core::MaterializedFile {
        let store = FileLocalStore::new(experimental_store_dir(root)).unwrap();
        let mut core = VaultCore::load_from_store(b"device_1", &store)
            .unwrap()
            .core
            .unwrap();
        core.materialize()
            .unwrap()
            .files
            .get(file_id)
            .unwrap()
            .clone()
    }

    fn delete_edit_conflict_core() -> VaultCore {
        let mut base = VaultCore::new(b"base").unwrap();
        create_note(&mut base, "file-1", "inc-1", "note.md", "text-1", "base");
        let mut local = base.fork_for_actor(b"device_1").unwrap();
        let mut remote = base.fork_for_actor(b"other").unwrap();

        local.tombstone_file("file-1").unwrap();
        remote
            .edit_markdown("text-1", "edited after delete")
            .unwrap();
        local.merge_from(&mut remote).unwrap();
        local
    }

    fn path_conflict_core() -> VaultCore {
        let mut base = VaultCore::new(b"base").unwrap();
        let mut local = base.fork_for_actor(b"device_1").unwrap();
        let mut remote = base.fork_for_actor(b"other").unwrap();

        create_note(&mut local, "file-1", "inc-1", "same.md", "text-1", "one");
        create_note(&mut remote, "file-2", "inc-2", "same.md", "text-2", "two");
        local.merge_from(&mut remote).unwrap();
        local
    }

    fn create_note(
        core: &mut VaultCore,
        stable_file_id: &str,
        incarnation_id: &str,
        display_path: &str,
        text_doc_id: &str,
        content: &str,
    ) {
        core.create_markdown(kuku_sync_core::FileCreate {
            stable_file_id: stable_file_id.to_owned(),
            incarnation_id: incarnation_id.to_owned(),
            display_path: display_path.to_owned(),
            text_doc_id: text_doc_id.to_owned(),
            blob_ref: None,
            content: content.to_owned(),
        })
        .unwrap();
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

    fn configured_vault_state(root: &Path) -> VaultState {
        let vault_state = VaultState::new();
        vault_state.inner.lock().path = Some(root.to_path_buf());
        vault_state
    }

    fn unique_temp_dir(name: &str) -> PathBuf {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("kuku-{name}-{}-{stamp}", std::process::id()))
    }
}
