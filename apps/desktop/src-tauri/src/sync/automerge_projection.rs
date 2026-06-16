use std::fs;
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::time::UNIX_EPOCH;

use kuku_sync_core::{
    GuardedProjectionPlan, GuardedProjectionStep, LocalStore, ProjectedSnapshot,
    ProjectedSnapshotUpdate, ProjectionApplyResult, ProjectionPreflightDecision,
    confirm_projection_result,
};

use crate::search::SearchState;
use crate::vault::watcher::ExpectedMutationLedger;

use super::errors::{SyncError, SyncResult};
use super::scanner::normalize_vault_relative_path;

const AUTOMERGE_PROJECTION_SOURCE: &str = "automerge-projection";

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ProjectionApplySummary {
    pub applied_writes: usize,
    pub applied_tombstones: usize,
    pub blocked: usize,
}

pub(crate) fn apply_guarded_projection_plan(
    vault_root: &Path,
    store: &mut impl LocalStore,
    expected_mutations: &ExpectedMutationLedger,
    search: Option<&SearchState>,
    plan: &GuardedProjectionPlan,
    generation: u64,
) -> SyncResult<ProjectionApplySummary> {
    let mut summary = ProjectionApplySummary {
        applied_writes: 0,
        applied_tombstones: 0,
        blocked: 0,
    };

    for step in &plan.steps {
        match step {
            GuardedProjectionStep::Write {
                file_id,
                path,
                normalized_path,
                content,
                preflight,
                ..
            } => match apply_write(
                vault_root,
                expected_mutations,
                file_id,
                path,
                normalized_path,
                content,
                preflight,
                generation,
            ) {
                Ok((result, search_event)) => {
                    update_projected_snapshot(store, result)?;
                    notify_search(search, search_event)?;
                    summary.applied_writes += 1;
                }
                Err(error) => {
                    let _ = update_projected_snapshot(
                        store,
                        ProjectionApplyResult::RetryableFailure {
                            file_id: file_id.clone(),
                            normalized_path: normalized_path.clone(),
                            message: error.to_string(),
                        },
                    );
                    return Err(error);
                }
            },
            GuardedProjectionStep::Tombstone {
                file_id,
                path,
                normalized_path,
                ..
            } => match apply_tombstone(
                vault_root,
                expected_mutations,
                file_id,
                path,
                normalized_path,
                generation,
            ) {
                Ok((result, search_event)) => {
                    update_projected_snapshot(store, result)?;
                    notify_search(search, search_event)?;
                    summary.applied_tombstones += 1;
                }
                Err(error) => {
                    let _ = update_projected_snapshot(
                        store,
                        ProjectionApplyResult::RetryableFailure {
                            file_id: file_id.clone(),
                            normalized_path: normalized_path.clone(),
                            message: error.to_string(),
                        },
                    );
                    return Err(error);
                }
            },
            GuardedProjectionStep::BlockedMaterialization { .. }
            | GuardedProjectionStep::BlockedByLiveDiskChange { .. } => {
                summary.blocked += 1;
            }
        }
    }

    Ok(summary)
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum ProjectionSearchEvent {
    Written { path: String },
    Removed { path: String },
}

fn apply_write(
    vault_root: &Path,
    expected_mutations: &ExpectedMutationLedger,
    file_id: &str,
    path: &str,
    normalized_path: &str,
    content: &str,
    preflight: &ProjectionPreflightDecision,
    generation: u64,
) -> SyncResult<(ProjectionApplyResult, Option<ProjectionSearchEvent>)> {
    let destination = resolve_projection_path(vault_root, path)?;
    let content_hash = blake3::hash(content.as_bytes()).to_hex().to_string();
    if let Some(current) = &preflight.current_disk
        && current.content_hash == content_hash
    {
        let mut snapshot = current.clone();
        snapshot.file_id = file_id.to_owned();
        snapshot.normalized_path = normalized_path.to_owned();
        snapshot.projection_generation = generation;
        return Ok((ProjectionApplyResult::WriteApplied { snapshot }, None));
    }

    if let Some(parent) = destination.parent() {
        reject_symlink_chain(vault_root, parent)?;
        fs::create_dir_all(parent).map_err(|error| {
            SyncError::Storage(format!(
                "failed to create projection parent {}: {error}",
                parent.display()
            ))
        })?;
    }
    reject_existing_symlink(&destination)?;

    let temp_path = projection_temp_path(&destination, generation);
    let token = expected_mutations.record_write(path, false);
    let write_result = write_temp_and_rename(&temp_path, &destination, content.as_bytes());
    if write_result.is_err() {
        expected_mutations.cancel(token);
    }
    write_result?;

    let snapshot = snapshot_for_file(file_id, normalized_path, &destination, generation)?;
    Ok((
        ProjectionApplyResult::WriteApplied { snapshot },
        Some(ProjectionSearchEvent::Written {
            path: path.to_owned(),
        }),
    ))
}

fn apply_tombstone(
    vault_root: &Path,
    expected_mutations: &ExpectedMutationLedger,
    file_id: &str,
    path: &str,
    normalized_path: &str,
    generation: u64,
) -> SyncResult<(ProjectionApplyResult, Option<ProjectionSearchEvent>)> {
    let destination = resolve_projection_path(vault_root, path)?;
    reject_existing_symlink(&destination)?;
    let token = expected_mutations.record_delete(path, false);
    match fs::remove_file(&destination) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            expected_mutations.cancel(token);
        }
        Err(error) => {
            expected_mutations.cancel(token);
            return Err(SyncError::Storage(format!(
                "failed to delete projected file {}: {error}",
                destination.display()
            )));
        }
    }

    Ok((
        ProjectionApplyResult::TombstoneApplied {
            file_id: file_id.to_owned(),
            normalized_path: normalized_path.to_owned(),
            projection_generation: generation,
        },
        Some(ProjectionSearchEvent::Removed {
            path: path.to_owned(),
        }),
    ))
}

fn update_projected_snapshot(
    store: &mut impl LocalStore,
    result: ProjectionApplyResult,
) -> SyncResult<()> {
    match confirm_projection_result(result).snapshot_update {
        ProjectedSnapshotUpdate::Set { snapshot } => store
            .save_projected_snapshot(snapshot)
            .map_err(map_sync_core_store_error),
        ProjectedSnapshotUpdate::Clear { file_id, .. } => store
            .remove_projected_snapshot(&file_id)
            .map_err(map_sync_core_store_error),
        ProjectedSnapshotUpdate::Unchanged => Ok(()),
    }
}

fn notify_search(
    search: Option<&SearchState>,
    event: Option<ProjectionSearchEvent>,
) -> SyncResult<()> {
    let Some(search) = search else {
        return Ok(());
    };
    let Some(event) = event else {
        return Ok(());
    };
    match event {
        ProjectionSearchEvent::Written { path } => search
            .notify_written_with_source(&path, AUTOMERGE_PROJECTION_SOURCE)
            .map_err(SyncError::Storage),
        ProjectionSearchEvent::Removed { path } => search
            .notify_removed_with_source(&path, false, AUTOMERGE_PROJECTION_SOURCE)
            .map_err(SyncError::Storage),
    }
}

fn write_temp_and_rename(temp_path: &Path, destination: &Path, bytes: &[u8]) -> SyncResult<()> {
    {
        let mut file = fs::File::create(temp_path).map_err(|error| {
            SyncError::Storage(format!(
                "failed to create projection temp file {}: {error}",
                temp_path.display()
            ))
        })?;
        file.write_all(bytes).map_err(|error| {
            SyncError::Storage(format!(
                "failed to write projection temp file {}: {error}",
                temp_path.display()
            ))
        })?;
        file.sync_all().map_err(|error| {
            SyncError::Storage(format!(
                "failed to sync projection temp file {}: {error}",
                temp_path.display()
            ))
        })?;
    }
    fs::rename(temp_path, destination).map_err(|error| {
        let _ = fs::remove_file(temp_path);
        SyncError::Storage(format!(
            "failed to rename projection temp file {} to {}: {error}",
            temp_path.display(),
            destination.display()
        ))
    })
}

fn snapshot_for_file(
    file_id: &str,
    normalized_path: &str,
    path: &Path,
    generation: u64,
) -> SyncResult<ProjectedSnapshot> {
    let bytes = fs::read(path).map_err(|error| {
        SyncError::Storage(format!(
            "failed to read projected file {}: {error}",
            path.display()
        ))
    })?;
    let metadata = fs::metadata(path).map_err(|error| {
        SyncError::Storage(format!(
            "failed to read projected file metadata {}: {error}",
            path.display()
        ))
    })?;
    let modified = metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .map(|value| value.as_millis().min(i64::MAX as u128) as i64)
        .unwrap_or_default();
    Ok(ProjectedSnapshot {
        file_id: file_id.to_owned(),
        normalized_path: normalized_path.to_owned(),
        content_hash: blake3::hash(&bytes).to_hex().to_string(),
        mtime_ms: modified,
        size: bytes.len() as u64,
        projection_generation: generation,
    })
}

fn resolve_projection_path(vault_root: &Path, relative_path: &str) -> SyncResult<PathBuf> {
    normalize_vault_relative_path(relative_path)?;
    let relative = Path::new(relative_path);
    if relative.is_absolute() {
        return Err(SyncError::InvalidArgument(
            "projection path must be vault-relative".into(),
        ));
    }

    let mut resolved = vault_root.to_path_buf();
    for component in relative.components() {
        match component {
            Component::Normal(part) => resolved.push(part),
            Component::CurDir => {}
            Component::ParentDir => {
                return Err(SyncError::InvalidArgument(
                    "projection path traversal is not allowed".into(),
                ));
            }
            Component::RootDir | Component::Prefix(_) => {
                return Err(SyncError::InvalidArgument(
                    "projection path must be vault-relative".into(),
                ));
            }
        }
    }
    Ok(resolved)
}

fn reject_symlink_chain(vault_root: &Path, path: &Path) -> SyncResult<()> {
    let relative = path.strip_prefix(vault_root).map_err(|_| {
        SyncError::InvalidArgument(format!(
            "projection path escapes vault root: {}",
            path.display()
        ))
    })?;
    let mut current = vault_root.to_path_buf();
    for component in relative.components() {
        let Component::Normal(part) = component else {
            continue;
        };
        current.push(part);
        reject_existing_symlink(&current)?;
    }
    Ok(())
}

fn reject_existing_symlink(path: &Path) -> SyncResult<()> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => Err(SyncError::InvalidArgument(
            format!("projection refuses to follow symlink: {}", path.display()),
        )),
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(SyncError::Storage(format!(
            "failed to inspect projection path {}: {error}",
            path.display()
        ))),
    }
}

fn projection_temp_path(destination: &Path, generation: u64) -> PathBuf {
    let file_name = destination
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("projection");
    destination.with_file_name(format!(".{file_name}.kuku-sync-{generation}.tmp"))
}

fn map_sync_core_store_error(error: kuku_sync_core::StoreError) -> SyncError {
    SyncError::Storage(format!("experimental automerge store error: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{FileChangeEvent, IndexerStorageLocation};
    use crate::search::SearchState;
    use kuku_sync_core::{FileLocalStore, LocalStore};
    use kuku_sync_core::{
        GuardedProjectionPlan, GuardedProjectionStep, ProjectionOperation,
        ProjectionPreflightDecision, ProjectionPreflightStatus,
    };
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    fn allowed_preflight(
        file_id: &str,
        normalized_path: &str,
        operation: ProjectionOperation,
    ) -> ProjectionPreflightDecision {
        ProjectionPreflightDecision {
            file_id: file_id.to_owned(),
            normalized_path: normalized_path.to_owned(),
            operation,
            status: ProjectionPreflightStatus::MissingCurrentDiskSnapshot,
            allowed: true,
            current_disk: None,
            last_projected: None,
        }
    }

    #[test]
    fn write_projection_uses_temp_rename_and_updates_snapshot() {
        let root = unique_temp_dir("projection-write");
        fs::create_dir_all(&root).unwrap();
        let mut store = FileLocalStore::new(root.join(".store")).unwrap();
        let expected = ExpectedMutationLedger::default();
        let plan = GuardedProjectionPlan {
            blocked: false,
            steps: vec![GuardedProjectionStep::Write {
                file_id: "file-1".to_owned(),
                path: "Notes/A.md".to_owned(),
                normalized_path: "notes/a.md".to_owned(),
                text_doc_id: "text-1".to_owned(),
                content: "# A".to_owned(),
                preflight: allowed_preflight("file-1", "notes/a.md", ProjectionOperation::Write),
            }],
        };

        let summary =
            apply_guarded_projection_plan(&root, &mut store, &expected, None, &plan, 7).unwrap();

        assert_eq!(summary.applied_writes, 1);
        assert_eq!(
            fs::read_to_string(root.join("Notes").join("A.md")).unwrap(),
            "# A"
        );
        let snapshots = store.list_projected_snapshots().unwrap();
        assert_eq!(snapshots.len(), 1);
        assert_eq!(
            snapshots[0].content_hash,
            blake3::hash(b"# A").to_hex().to_string()
        );
        assert!(expected.consume_matching(&FileChangeEvent {
            kind: "modify".to_owned(),
            path: "Notes/A.md".to_owned(),
            is_dir: false,
            old_path: None,
        }));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn write_projection_notifies_search_index() {
        let root = unique_temp_dir("projection-search");
        fs::create_dir_all(&root).unwrap();
        let mut store = FileLocalStore::new(root.join(".store")).unwrap();
        let expected = ExpectedMutationLedger::default();
        let search = SearchState::new();
        let mut config = search.get_config();
        config.storage_location = IndexerStorageLocation::VaultLocal;
        search.set_config(config).unwrap();
        search.switch_vault(root.clone()).unwrap();
        let plan = GuardedProjectionPlan {
            blocked: false,
            steps: vec![GuardedProjectionStep::Write {
                file_id: "file-1".to_owned(),
                path: "Needle.md".to_owned(),
                normalized_path: "needle.md".to_owned(),
                text_doc_id: "text-1".to_owned(),
                content: "# Search\n\nphasefiveautomerge".to_owned(),
                preflight: allowed_preflight("file-1", "needle.md", ProjectionOperation::Write),
            }],
        };

        apply_guarded_projection_plan(&root, &mut store, &expected, Some(&search), &plan, 7)
            .unwrap();

        assert_eventually_searches(&search, "phasefiveautomerge", "Needle.md");
        search.close_runtime().unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn tombstone_projection_deletes_file_and_clears_snapshot() {
        let root = unique_temp_dir("projection-delete");
        fs::create_dir_all(root.join("Notes")).unwrap();
        fs::write(root.join("Notes").join("A.md"), "# A").unwrap();
        let mut store = FileLocalStore::new(root.join(".store")).unwrap();
        store
            .save_projected_snapshot(ProjectedSnapshot {
                file_id: "file-1".to_owned(),
                normalized_path: "notes/a.md".to_owned(),
                content_hash: blake3::hash(b"# A").to_hex().to_string(),
                mtime_ms: 1,
                size: 3,
                projection_generation: 1,
            })
            .unwrap();
        let expected = ExpectedMutationLedger::default();
        let plan = GuardedProjectionPlan {
            blocked: false,
            steps: vec![GuardedProjectionStep::Tombstone {
                file_id: "file-1".to_owned(),
                path: "Notes/A.md".to_owned(),
                normalized_path: "notes/a.md".to_owned(),
                preflight: allowed_preflight(
                    "file-1",
                    "notes/a.md",
                    ProjectionOperation::Tombstone,
                ),
            }],
        };

        let summary =
            apply_guarded_projection_plan(&root, &mut store, &expected, None, &plan, 8).unwrap();

        assert_eq!(summary.applied_tombstones, 1);
        assert!(!root.join("Notes").join("A.md").exists());
        assert_eq!(store.list_projected_snapshots().unwrap(), vec![]);
        assert!(expected.consume_matching(&FileChangeEvent {
            kind: "delete".to_owned(),
            path: "Notes/A.md".to_owned(),
            is_dir: false,
            old_path: None,
        }));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn projection_rejects_traversal_paths() {
        let root = unique_temp_dir("projection-traversal");
        fs::create_dir_all(&root).unwrap();
        let mut store = FileLocalStore::new(root.join(".store")).unwrap();
        let expected = ExpectedMutationLedger::default();
        let plan = GuardedProjectionPlan {
            blocked: false,
            steps: vec![GuardedProjectionStep::Write {
                file_id: "file-1".to_owned(),
                path: "../outside.md".to_owned(),
                normalized_path: "outside.md".to_owned(),
                text_doc_id: "text-1".to_owned(),
                content: "bad".to_owned(),
                preflight: allowed_preflight("file-1", "outside.md", ProjectionOperation::Write),
            }],
        };

        let error = apply_guarded_projection_plan(&root, &mut store, &expected, None, &plan, 9)
            .unwrap_err();

        assert!(
            matches!(error, SyncError::InvalidArgument(message) if message.contains("traversal"))
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn projection_rejects_existing_symlink_target() {
        use std::os::unix::fs::symlink;

        let root = unique_temp_dir("projection-symlink");
        fs::create_dir_all(&root).unwrap();
        symlink("/tmp/outside", root.join("A.md")).unwrap();
        let mut store = FileLocalStore::new(root.join(".store")).unwrap();
        let expected = ExpectedMutationLedger::default();
        let plan = GuardedProjectionPlan {
            blocked: false,
            steps: vec![GuardedProjectionStep::Write {
                file_id: "file-1".to_owned(),
                path: "A.md".to_owned(),
                normalized_path: "a.md".to_owned(),
                text_doc_id: "text-1".to_owned(),
                content: "safe".to_owned(),
                preflight: allowed_preflight("file-1", "a.md", ProjectionOperation::Write),
            }],
        };

        let error = apply_guarded_projection_plan(&root, &mut store, &expected, None, &plan, 10)
            .unwrap_err();

        assert!(
            matches!(error, SyncError::InvalidArgument(message) if message.contains("symlink"))
        );
        fs::remove_dir_all(root).unwrap();
    }

    fn unique_temp_dir(name: &str) -> PathBuf {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("kuku-{name}-{}-{stamp}", std::process::id()))
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
}
