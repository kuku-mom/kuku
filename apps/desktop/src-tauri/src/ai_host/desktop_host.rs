use async_trait::async_trait;
use tauri::{AppHandle, Manager, Wry};
use tauri_plugin_ai::{
    AiError, AiHostBindings, ConflictItem, MutationApplyResult, MutationOp, MutationPlan,
};

use crate::auth_commands;
use crate::search::SearchState;
use crate::vault::checksum::{
    compute_checksum, compute_directory_checksum, guarded_create, guarded_create_dir,
    guarded_delete, guarded_delete_dir, guarded_rename, guarded_write,
};
use crate::vault::{VaultState, get_vault_root, resolve_vault_path};

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

        let mut conflicts = Vec::new();
        for op in &plan.operations {
            match op {
                MutationOp::CreateFile { path, .. } => {
                    let resolved = resolve_vault_path(&root, path).map_err(AiError::State)?;
                    if tokio::fs::try_exists(&resolved).await? {
                        conflicts.push(conflict(path, "File already exists"));
                    }
                }
                MutationOp::CreateDirectory { path } => {
                    let resolved = resolve_vault_path(&root, path).map_err(AiError::State)?;
                    if tokio::fs::try_exists(&resolved).await? {
                        conflicts.push(conflict(path, "Directory already exists"));
                    }
                }
                MutationOp::ReplaceFile {
                    path,
                    expected_checksum,
                    ..
                } => {
                    let resolved = resolve_vault_path(&root, path).map_err(AiError::State)?;
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
                    let resolved = resolve_vault_path(&root, path).map_err(AiError::State)?;
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
                    let resolved = resolve_vault_path(&root, path).map_err(AiError::State)?;
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
                    let from_resolved = resolve_vault_path(&root, from).map_err(AiError::State)?;
                    let to_resolved = resolve_vault_path(&root, to).map_err(AiError::State)?;

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

        for (index, op) in plan.operations.iter().enumerate() {
            let result = match op {
                MutationOp::CreateFile { path, content } => {
                    let resolved = resolve_vault_path(&root, path).map_err(AiError::State)?;
                    guarded_create(&resolved, content).await
                }
                MutationOp::CreateDirectory { path } => {
                    let resolved = resolve_vault_path(&root, path).map_err(AiError::State)?;
                    guarded_create_dir(&resolved).await
                }
                MutationOp::ReplaceFile {
                    path,
                    content,
                    expected_checksum,
                    ..
                } => {
                    let resolved = resolve_vault_path(&root, path).map_err(AiError::State)?;
                    guarded_write(&resolved, content, expected_checksum).await
                }
                MutationOp::DeleteFile {
                    path,
                    expected_checksum,
                } => {
                    let resolved = resolve_vault_path(&root, path).map_err(AiError::State)?;
                    guarded_delete(&resolved, expected_checksum).await
                }
                MutationOp::DeleteDirectory {
                    path,
                    expected_checksum,
                } => {
                    let resolved = resolve_vault_path(&root, path).map_err(AiError::State)?;
                    guarded_delete_dir(&resolved, expected_checksum).await
                }
                MutationOp::RenameFile { from, to } => {
                    let from_resolved = resolve_vault_path(&root, from).map_err(AiError::State)?;
                    let to_resolved = resolve_vault_path(&root, to).map_err(AiError::State)?;
                    guarded_rename(&from_resolved, &to_resolved).await
                }
            };

            match result {
                Ok(()) => {
                    if let Some(warning) = sync_search(&search, op).await {
                        warnings.push(warning);
                    }
                    applied.push(op_summary(op));
                }
                Err(conflict_item) => {
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

async fn sync_search(search: &SearchState, op: &MutationOp) -> Option<String> {
    let result = match op {
        MutationOp::CreateFile { path, .. } | MutationOp::ReplaceFile { path, .. } => {
            search.notify_written(path)
        }
        MutationOp::CreateDirectory { .. } => return None,
        MutationOp::DeleteFile { path, .. } => search.notify_removed(path, false),
        MutationOp::DeleteDirectory { path, .. } => search.notify_removed(path, true),
        MutationOp::RenameFile { from, to } => search.notify_renamed(from, to, false),
    };

    if let Err(error) = result {
        let _ = search.request_rebuild();
        return Some(format!("Search sync fallback: {error}"));
    }

    None
}
