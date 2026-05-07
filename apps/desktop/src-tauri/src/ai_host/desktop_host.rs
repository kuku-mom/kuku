use std::path::Path;

use async_trait::async_trait;
use kuku_ai::{
    AiError, AiHostBindings, ConflictItem, MutationApplyResult, MutationOp, MutationPlan,
};
use tauri::{AppHandle, Manager, Wry};

use crate::auth_commands;
use crate::knowledge::protected_paths::guard_ai_raw_mutation_path;
use crate::search::SearchState;
use crate::vault::checksum::{
    compute_checksum, compute_directory_checksum, guarded_create, guarded_create_dir,
    guarded_delete, guarded_delete_dir, guarded_rename, guarded_write,
};
use crate::vault::mutation_sync::{AppMutation, AppMutationSync, RecordedAppMutation};
use crate::vault::{VaultState, get_vault_root, resolve_vault_path_strict};

pub struct DesktopAiHost {
    app: AppHandle<Wry>,
}

impl DesktopAiHost {
    pub fn new(app: AppHandle<Wry>) -> Self {
        Self { app }
    }
}

#[async_trait]
impl AiHostBindings for DesktopAiHost {
    async fn apply_mutation(&self, plan: MutationPlan) -> Result<MutationApplyResult, AiError> {
        let vault = self.app.state::<VaultState>();
        let search = self.app.state::<SearchState>();
        let root = get_vault_root(&vault).map_err(AiError::State)?;

        for op in &plan.operations {
            guard_mutation_op(&root, op).await.map_err(AiError::State)?;
        }

        let mut conflicts = Vec::new();
        for op in &plan.operations {
            match op {
                MutationOp::CreateFile { path, .. } => {
                    let resolved = resolve_vault_path_strict(&root, path)
                        .await
                        .map_err(AiError::State)?;
                    if tokio::fs::try_exists(&resolved).await? {
                        conflicts.push(conflict(path, "File already exists"));
                    }
                }
                MutationOp::CreateDirectory { path } => {
                    let resolved = resolve_vault_path_strict(&root, path)
                        .await
                        .map_err(AiError::State)?;
                    if tokio::fs::try_exists(&resolved).await? {
                        conflicts.push(conflict(path, "Directory already exists"));
                    }
                }
                MutationOp::ReplaceFile {
                    path,
                    expected_checksum,
                    ..
                } => {
                    let resolved = resolve_vault_path_strict(&root, path)
                        .await
                        .map_err(AiError::State)?;
                    match tokio::fs::read_to_string(&resolved).await {
                        Ok(current) => {
                            let actual = compute_checksum(&current);
                            if actual != *expected_checksum {
                                conflicts.push(checksum_conflict(path, expected_checksum, &actual));
                            }
                        }
                        Err(error) => {
                            conflicts.push(conflict(path, format!("Failed to read file: {error}")));
                        }
                    }
                }
                MutationOp::DeleteFile {
                    path,
                    expected_checksum,
                } => {
                    let resolved = resolve_vault_path_strict(&root, path)
                        .await
                        .map_err(AiError::State)?;
                    match tokio::fs::read_to_string(&resolved).await {
                        Ok(current) => {
                            let actual = compute_checksum(&current);
                            if actual != *expected_checksum {
                                conflicts.push(checksum_conflict(path, expected_checksum, &actual));
                            }
                        }
                        Err(error) => {
                            conflicts.push(conflict(path, format!("Failed to read file: {error}")));
                        }
                    }
                }
                MutationOp::DeleteDirectory {
                    path,
                    expected_checksum,
                } => {
                    let resolved = resolve_vault_path_strict(&root, path)
                        .await
                        .map_err(AiError::State)?;
                    match tokio::fs::metadata(&resolved).await {
                        Ok(metadata) => {
                            if !metadata.is_dir() {
                                conflicts.push(conflict(path, "Path is not a directory"));
                            } else {
                                match compute_directory_checksum(&resolved).await {
                                    Ok(actual) => {
                                        if actual != *expected_checksum {
                                            conflicts.push(checksum_conflict(
                                                path,
                                                expected_checksum,
                                                &actual,
                                            ));
                                        }
                                    }
                                    Err(error) => {
                                        conflicts.push(conflict(
                                            path,
                                            format!("Failed to checksum directory: {error}"),
                                        ));
                                    }
                                }
                            }
                        }
                        Err(error) => {
                            conflicts
                                .push(conflict(path, format!("Failed to stat directory: {error}")));
                        }
                    }
                }
                MutationOp::RenameFile { from, to } => {
                    let from_resolved = resolve_vault_path_strict(&root, from)
                        .await
                        .map_err(AiError::State)?;
                    let to_resolved = resolve_vault_path_strict(&root, to)
                        .await
                        .map_err(AiError::State)?;

                    if !tokio::fs::try_exists(&from_resolved).await? {
                        conflicts.push(conflict(from, "Source file does not exist"));
                    }
                    if tokio::fs::try_exists(&to_resolved).await? {
                        conflicts.push(conflict(to, "Destination file already exists"));
                    }
                }
            }
        }

        if !conflicts.is_empty() {
            return Ok(MutationApplyResult::Conflict {
                summary: format!(
                    "{} conflict(s) detected. No changes were applied.",
                    conflicts.len()
                ),
                conflicts,
            });
        }

        let mut applied = Vec::new();
        let mut warnings = Vec::new();
        let mutation_sync = AppMutationSync::new(&vault.expected_mutations, &search, "ai-mutation");

        for (index, op) in plan.operations.iter().enumerate() {
            let mutation = mutation_for_applied_op(&root, op)
                .await
                .map_err(AiError::State)?;
            let recorded = mutation_sync.record(mutation);
            let result = match op {
                MutationOp::CreateFile { path, content } => {
                    let resolved = resolve_vault_path_strict(&root, path)
                        .await
                        .map_err(AiError::State)?;
                    guarded_create(&resolved, content).await
                }
                MutationOp::CreateDirectory { path } => {
                    let resolved = resolve_vault_path_strict(&root, path)
                        .await
                        .map_err(AiError::State)?;
                    guarded_create_dir(&resolved).await
                }
                MutationOp::ReplaceFile {
                    path,
                    content,
                    expected_checksum,
                    ..
                } => {
                    let resolved = resolve_vault_path_strict(&root, path)
                        .await
                        .map_err(AiError::State)?;
                    guarded_write(&resolved, content, expected_checksum).await
                }
                MutationOp::DeleteFile {
                    path,
                    expected_checksum,
                } => {
                    let resolved = resolve_vault_path_strict(&root, path)
                        .await
                        .map_err(AiError::State)?;
                    guarded_delete(&resolved, expected_checksum).await
                }
                MutationOp::DeleteDirectory {
                    path,
                    expected_checksum,
                } => {
                    let resolved = resolve_vault_path_strict(&root, path)
                        .await
                        .map_err(AiError::State)?;
                    guarded_delete_dir(&resolved, expected_checksum).await
                }
                MutationOp::RenameFile { from, to } => {
                    let from_resolved = resolve_vault_path_strict(&root, from)
                        .await
                        .map_err(AiError::State)?;
                    let to_resolved = resolve_vault_path_strict(&root, to)
                        .await
                        .map_err(AiError::State)?;
                    guarded_rename(&from_resolved, &to_resolved).await
                }
            };

            match result {
                Ok(()) => {
                    if let Some(warning) = sync_search(&search, &mutation_sync, &recorded) {
                        warnings.push(warning);
                    }
                    applied.push(op_summary(op));
                }
                Err(conflict_item) => {
                    mutation_sync.cancel(&recorded);
                    let skipped = plan.operations[index + 1..]
                        .iter()
                        .map(op_summary)
                        .collect::<Vec<_>>();

                    if applied.is_empty() {
                        return Ok(MutationApplyResult::Conflict {
                            summary: "Commit-time conflict. No changes were applied.".into(),
                            conflicts: vec![conflict_item],
                        });
                    }

                    return Ok(MutationApplyResult::PartiallyApplied {
                        summary: format!(
                            "{} applied, 1 failed, {} skipped",
                            applied.len(),
                            skipped.len()
                        ),
                        applied,
                        failed: vec![format!("{}: {}", op_summary(op), conflict_item.reason)],
                        skipped,
                        warnings,
                    });
                }
            }
        }

        Ok(MutationApplyResult::Applied {
            summary: if plan.summary.trim().is_empty() {
                if applied.is_empty() {
                    "No operations".into()
                } else {
                    applied.join("; ")
                }
            } else {
                plan.summary
            },
            warnings,
        })
    }

    async fn authorization_header(
        &self,
        requester_plugin_id: &str,
    ) -> Result<Option<String>, AiError> {
        auth_commands::authorization_header_for_plugin(requester_plugin_id)
            .await
            .map_err(AiError::State)
    }

    async fn refresh_authorization_header(
        &self,
        requester_plugin_id: &str,
    ) -> Result<Option<String>, AiError> {
        auth_commands::refresh_authorization_header_for_plugin(requester_plugin_id)
            .await
            .map_err(AiError::State)
    }
}

async fn guard_mutation_op(root: &Path, op: &MutationOp) -> Result<(), String> {
    match op {
        MutationOp::CreateFile { path, .. }
        | MutationOp::CreateDirectory { path }
        | MutationOp::ReplaceFile { path, .. }
        | MutationOp::DeleteFile { path, .. }
        | MutationOp::DeleteDirectory { path, .. } => guard_ai_raw_mutation_path(root, path)
            .await
            .map(|_| ())
            .map_err(|error| error.message),
        MutationOp::RenameFile { from, to } => {
            guard_ai_raw_mutation_path(root, from)
                .await
                .map_err(|error| error.message)?;
            guard_ai_raw_mutation_path(root, to)
                .await
                .map_err(|error| error.message)?;
            Ok(())
        }
    }
}

async fn mutation_for_applied_op(root: &Path, op: &MutationOp) -> Result<AppMutation, String> {
    match op {
        MutationOp::CreateFile { path, .. } | MutationOp::ReplaceFile { path, .. } => {
            Ok(AppMutation::Write {
                path: path.clone(),
                is_dir: false,
            })
        }
        MutationOp::CreateDirectory { path } => Ok(AppMutation::Write {
            path: path.clone(),
            is_dir: true,
        }),
        MutationOp::DeleteFile { path, .. } => Ok(AppMutation::Delete {
            path: path.clone(),
            is_dir: false,
        }),
        MutationOp::DeleteDirectory { path, .. } => Ok(AppMutation::Delete {
            path: path.clone(),
            is_dir: true,
        }),
        MutationOp::RenameFile { from, to } => {
            let from_resolved = resolve_vault_path_strict(root, from).await?;
            let is_dir = tokio::fs::metadata(&from_resolved)
                .await
                .map(|metadata| metadata.is_dir())
                .unwrap_or(false);
            Ok(AppMutation::Rename {
                old_path: from.clone(),
                new_path: to.clone(),
                is_dir,
            })
        }
    }
}

fn conflict(path: &str, reason: impl Into<String>) -> ConflictItem {
    ConflictItem {
        path: path.to_string(),
        reason: reason.into(),
        expected: None,
        actual: None,
    }
}

fn checksum_conflict(path: &str, expected: &str, actual: &str) -> ConflictItem {
    ConflictItem {
        path: path.to_string(),
        reason: format!("Checksum mismatch: expected {expected}, actual {actual}"),
        expected: Some(expected.to_string()),
        actual: Some(actual.to_string()),
    }
}

fn op_summary(op: &MutationOp) -> String {
    match op {
        MutationOp::CreateFile { path, .. } => format!("Created {path}"),
        MutationOp::CreateDirectory { path } => format!("Created directory {path}"),
        MutationOp::ReplaceFile { path, .. } => format!("Modified {path}"),
        MutationOp::DeleteFile { path, .. } => format!("Deleted {path}"),
        MutationOp::DeleteDirectory { path, .. } => format!("Deleted directory {path}"),
        MutationOp::RenameFile { from, to } => format!("Renamed {from} -> {to}"),
    }
}

fn sync_search(
    search: &SearchState,
    mutation_sync: &AppMutationSync<'_>,
    recorded: &RecordedAppMutation,
) -> Option<String> {
    if let Err(error) = mutation_sync.notify_applied(recorded) {
        let _ = search.request_rebuild_with_reason("sync-error");
        return Some(format!("Search sync fallback: {error}"));
    }

    None
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    use kuku_ai::MutationOp;
    use tauri::async_runtime;

    use crate::vault::mutation_sync::AppMutation;

    use super::{guard_mutation_op, mutation_for_applied_op};

    static TEST_COUNTER: AtomicU64 = AtomicU64::new(0);

    #[test]
    fn mutation_for_applied_op_maps_file_write() {
        let root = temp_vault();
        let op = MutationOp::ReplaceFile {
            path: "notes/a.md".to_string(),
            content: "next".to_string(),
            expected_checksum: "checksum".to_string(),
            before_excerpt: None,
        };

        let mutation = async_runtime::block_on(mutation_for_applied_op(&root, &op)).unwrap();

        assert_eq!(
            mutation,
            AppMutation::Write {
                path: "notes/a.md".to_string(),
                is_dir: false
            }
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn mutation_for_applied_op_maps_directory_create() {
        let root = temp_vault();
        let op = MutationOp::CreateDirectory {
            path: "notes/archive".to_string(),
        };

        let mutation = async_runtime::block_on(mutation_for_applied_op(&root, &op)).unwrap();

        assert_eq!(
            mutation,
            AppMutation::Write {
                path: "notes/archive".to_string(),
                is_dir: true
            }
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn mutation_for_applied_op_detects_file_rename_kind() {
        let root = temp_vault();
        fs::create_dir_all(root.join("notes")).unwrap();
        fs::write(root.join("notes/a.md"), "hello").unwrap();
        let op = MutationOp::RenameFile {
            from: "notes/a.md".to_string(),
            to: "notes/b.md".to_string(),
        };

        let mutation = async_runtime::block_on(mutation_for_applied_op(&root, &op)).unwrap();

        assert_eq!(
            mutation,
            AppMutation::Rename {
                old_path: "notes/a.md".to_string(),
                new_path: "notes/b.md".to_string(),
                is_dir: false
            }
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn mutation_for_applied_op_detects_directory_rename_kind() {
        let root = temp_vault();
        fs::create_dir_all(root.join("notes/archive")).unwrap();
        let op = MutationOp::RenameFile {
            from: "notes/archive".to_string(),
            to: "archive".to_string(),
        };

        let mutation = async_runtime::block_on(mutation_for_applied_op(&root, &op)).unwrap();

        assert_eq!(
            mutation,
            AppMutation::Rename {
                old_path: "notes/archive".to_string(),
                new_path: "archive".to_string(),
                is_dir: true
            }
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn guard_mutation_op_rejects_protected_knowledge_paths() {
        let root = temp_vault();
        let op = MutationOp::ReplaceFile {
            path: "Knowledge/decisions/doc_auth.md".to_string(),
            content: "next".to_string(),
            expected_checksum: "checksum".to_string(),
            before_excerpt: None,
        };

        let error = async_runtime::block_on(guard_mutation_op(&root, &op)).unwrap_err();

        assert!(error.contains("protected Knowledge path"));
        let _ = fs::remove_dir_all(root);
    }

    fn temp_vault() -> PathBuf {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let suffix = TEST_COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("kuku-ai-host-test-{now}-{suffix}"));
        fs::create_dir_all(&dir).unwrap();
        dir
    }
}
