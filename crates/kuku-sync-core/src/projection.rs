use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::model::{MaterializeIssue, ProjectionPlan, ProjectionStep};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProjectedSnapshot {
    pub file_id: String,
    pub normalized_path: String,
    pub content_hash: String,
    pub mtime_ms: i64,
    pub size: u64,
    pub projection_generation: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ProjectionOperation {
    Write,
    Tombstone,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ProjectionPreflightStatus {
    CleanMatch,
    MissingCurrentDiskSnapshot,
    MissingLastProjectedSnapshot,
    DirtyMismatch,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProjectionPreflightDecision {
    pub file_id: String,
    pub normalized_path: String,
    pub operation: ProjectionOperation,
    pub status: ProjectionPreflightStatus,
    pub allowed: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_disk: Option<ProjectedSnapshot>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_projected: Option<ProjectedSnapshot>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GuardedProjectionPlan {
    pub blocked: bool,
    pub steps: Vec<GuardedProjectionStep>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum GuardedProjectionStep {
    Write {
        file_id: String,
        path: String,
        normalized_path: String,
        text_doc_id: String,
        content: String,
        preflight: ProjectionPreflightDecision,
    },
    Tombstone {
        file_id: String,
        path: String,
        normalized_path: String,
        preflight: ProjectionPreflightDecision,
    },
    BlockedMaterialization {
        issue: MaterializeIssue,
    },
    BlockedByLiveDiskChange {
        file_id: String,
        path: String,
        normalized_path: String,
        operation: ProjectionOperation,
        preflight: ProjectionPreflightDecision,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ProjectionApplyResult {
    WriteApplied {
        snapshot: ProjectedSnapshot,
    },
    TombstoneApplied {
        file_id: String,
        normalized_path: String,
        projection_generation: u64,
    },
    BlockedByLiveDiskChange {
        file_id: String,
        normalized_path: String,
        preflight: ProjectionPreflightDecision,
    },
    RetryableFailure {
        file_id: String,
        normalized_path: String,
        message: String,
    },
    PermanentFailure {
        file_id: String,
        normalized_path: String,
        message: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProjectionConfirmation {
    pub result: ProjectionApplyResult,
    pub snapshot_update: ProjectedSnapshotUpdate,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ProjectedSnapshotUpdate {
    Set {
        snapshot: ProjectedSnapshot,
    },
    Clear {
        file_id: String,
        normalized_path: String,
        projection_generation: u64,
    },
    Unchanged,
}

pub fn preflight_projection(
    operation: ProjectionOperation,
    file_id: impl Into<String>,
    normalized_path: impl Into<String>,
    current_disk: Option<&ProjectedSnapshot>,
    last_projected: Option<&ProjectedSnapshot>,
) -> ProjectionPreflightDecision {
    let file_id = file_id.into();
    let normalized_path = normalized_path.into();
    let status = match (current_disk, last_projected) {
        (Some(current), Some(last)) if current.content_hash == last.content_hash => {
            ProjectionPreflightStatus::CleanMatch
        }
        (Some(_), Some(_)) => ProjectionPreflightStatus::DirtyMismatch,
        (None, Some(_)) => ProjectionPreflightStatus::MissingCurrentDiskSnapshot,
        (Some(_), None) => ProjectionPreflightStatus::MissingLastProjectedSnapshot,
        (None, None) => ProjectionPreflightStatus::MissingCurrentDiskSnapshot,
    };
    let allowed = match (current_disk, last_projected, status) {
        (Some(_), Some(_), ProjectionPreflightStatus::CleanMatch) => true,
        (None, None, ProjectionPreflightStatus::MissingCurrentDiskSnapshot) => true,
        _ => false,
    };

    ProjectionPreflightDecision {
        file_id,
        normalized_path,
        operation,
        status,
        allowed,
        current_disk: current_disk.cloned(),
        last_projected: last_projected.cloned(),
    }
}

pub fn preflight_projection_plan(
    plan: &ProjectionPlan,
    current_disk: &[ProjectedSnapshot],
    last_projected: &[ProjectedSnapshot],
) -> GuardedProjectionPlan {
    let current_by_file_id = snapshots_by_file_id(current_disk);
    let current_by_path = snapshots_by_path(current_disk);
    let last_by_file_id = snapshots_by_file_id(last_projected);
    let last_by_path = snapshots_by_path(last_projected);

    let mut guarded_steps = Vec::new();
    for step in &plan.steps {
        match step {
            ProjectionStep::Write {
                file_id,
                path,
                normalized_path,
                text_doc_id,
                content,
            } => {
                let current = find_snapshot(
                    file_id,
                    normalized_path,
                    &current_by_file_id,
                    &current_by_path,
                );
                let last = find_snapshot(file_id, normalized_path, &last_by_file_id, &last_by_path);
                let preflight = preflight_projection(
                    ProjectionOperation::Write,
                    file_id.clone(),
                    normalized_path.clone(),
                    current,
                    last,
                );
                if preflight.allowed {
                    guarded_steps.push(GuardedProjectionStep::Write {
                        file_id: file_id.clone(),
                        path: path.clone(),
                        normalized_path: normalized_path.clone(),
                        text_doc_id: text_doc_id.clone(),
                        content: content.clone(),
                        preflight,
                    });
                } else {
                    guarded_steps.push(GuardedProjectionStep::BlockedByLiveDiskChange {
                        file_id: file_id.clone(),
                        path: path.clone(),
                        normalized_path: normalized_path.clone(),
                        operation: ProjectionOperation::Write,
                        preflight,
                    });
                }
            }
            ProjectionStep::Tombstone {
                file_id,
                path,
                normalized_path,
            } => {
                let current = find_snapshot(
                    file_id,
                    normalized_path,
                    &current_by_file_id,
                    &current_by_path,
                );
                let last = find_snapshot(file_id, normalized_path, &last_by_file_id, &last_by_path);
                let preflight = preflight_projection(
                    ProjectionOperation::Tombstone,
                    file_id.clone(),
                    normalized_path.clone(),
                    current,
                    last,
                );
                if preflight.allowed {
                    guarded_steps.push(GuardedProjectionStep::Tombstone {
                        file_id: file_id.clone(),
                        path: path.clone(),
                        normalized_path: normalized_path.clone(),
                        preflight,
                    });
                } else {
                    guarded_steps.push(GuardedProjectionStep::BlockedByLiveDiskChange {
                        file_id: file_id.clone(),
                        path: path.clone(),
                        normalized_path: normalized_path.clone(),
                        operation: ProjectionOperation::Tombstone,
                        preflight,
                    });
                }
            }
            ProjectionStep::Blocked { issue } => {
                guarded_steps.push(GuardedProjectionStep::BlockedMaterialization {
                    issue: issue.clone(),
                });
            }
        }
    }

    let blocked = plan.blocked
        || guarded_steps.iter().any(|step| {
            matches!(
                step,
                GuardedProjectionStep::BlockedMaterialization { .. }
                    | GuardedProjectionStep::BlockedByLiveDiskChange { .. }
            )
        });

    GuardedProjectionPlan {
        blocked,
        steps: guarded_steps,
    }
}

pub fn confirm_projection_result(result: ProjectionApplyResult) -> ProjectionConfirmation {
    let snapshot_update = match &result {
        ProjectionApplyResult::WriteApplied { snapshot } => ProjectedSnapshotUpdate::Set {
            snapshot: snapshot.clone(),
        },
        ProjectionApplyResult::TombstoneApplied {
            file_id,
            normalized_path,
            projection_generation,
        } => ProjectedSnapshotUpdate::Clear {
            file_id: file_id.clone(),
            normalized_path: normalized_path.clone(),
            projection_generation: *projection_generation,
        },
        ProjectionApplyResult::BlockedByLiveDiskChange { .. }
        | ProjectionApplyResult::RetryableFailure { .. }
        | ProjectionApplyResult::PermanentFailure { .. } => ProjectedSnapshotUpdate::Unchanged,
    };

    ProjectionConfirmation {
        result,
        snapshot_update,
    }
}

fn snapshots_by_file_id(snapshots: &[ProjectedSnapshot]) -> BTreeMap<&str, &ProjectedSnapshot> {
    snapshots
        .iter()
        .map(|snapshot| (snapshot.file_id.as_str(), snapshot))
        .collect()
}

fn snapshots_by_path(snapshots: &[ProjectedSnapshot]) -> BTreeMap<&str, &ProjectedSnapshot> {
    snapshots
        .iter()
        .map(|snapshot| (snapshot.normalized_path.as_str(), snapshot))
        .collect()
}

fn find_snapshot<'a>(
    file_id: &str,
    normalized_path: &str,
    by_file_id: &BTreeMap<&str, &'a ProjectedSnapshot>,
    by_path: &BTreeMap<&str, &'a ProjectedSnapshot>,
) -> Option<&'a ProjectedSnapshot> {
    by_file_id
        .get(file_id)
        .copied()
        .or_else(|| by_path.get(normalized_path).copied())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{MaterializeIssue, ProjectionPlan, ProjectionStep};
    use crate::path::normalize_path;

    fn snapshot(file_id: &str, path: &str, hash: &str, generation: u64) -> ProjectedSnapshot {
        ProjectedSnapshot {
            file_id: file_id.to_owned(),
            normalized_path: normalize_path(path),
            content_hash: hash.to_owned(),
            mtime_ms: generation as i64 * 1000,
            size: hash.len() as u64,
            projection_generation: generation,
        }
    }

    fn write_plan() -> ProjectionPlan {
        ProjectionPlan {
            blocked: false,
            steps: vec![ProjectionStep::Write {
                file_id: "file-1".to_owned(),
                path: "note.md".to_owned(),
                normalized_path: "note.md".to_owned(),
                text_doc_id: "text-1".to_owned(),
                content: "next".to_owned(),
            }],
        }
    }

    fn tombstone_plan() -> ProjectionPlan {
        ProjectionPlan {
            blocked: false,
            steps: vec![ProjectionStep::Tombstone {
                file_id: "file-1".to_owned(),
                path: "note.md".to_owned(),
                normalized_path: "note.md".to_owned(),
            }],
        }
    }

    #[test]
    fn clean_projected_file_write_preflight_is_allowed() {
        let current = snapshot("file-1", "note.md", "hash-1", 1);
        let last = snapshot("file-1", "note.md", "hash-1", 1);

        let guarded = preflight_projection_plan(&write_plan(), &[current], &[last]);

        assert!(!guarded.blocked);
        match &guarded.steps[0] {
            GuardedProjectionStep::Write { preflight, .. } => {
                assert!(preflight.allowed);
                assert_eq!(preflight.status, ProjectionPreflightStatus::CleanMatch);
            }
            other => panic!("expected guarded write, got {other:?}"),
        }
    }

    #[test]
    fn current_disk_hash_mismatch_blocks_write_preflight() {
        let current = snapshot("file-1", "note.md", "external-edit", 2);
        let last = snapshot("file-1", "note.md", "hash-1", 1);

        let guarded = preflight_projection_plan(&write_plan(), &[current], &[last]);

        assert!(guarded.blocked);
        match &guarded.steps[0] {
            GuardedProjectionStep::BlockedByLiveDiskChange {
                operation,
                preflight,
                ..
            } => {
                assert_eq!(*operation, ProjectionOperation::Write);
                assert!(!preflight.allowed);
                assert_eq!(preflight.status, ProjectionPreflightStatus::DirtyMismatch);
            }
            other => panic!("expected live disk block, got {other:?}"),
        }
    }

    #[test]
    fn tombstone_projection_is_blocked_on_live_disk_mismatch() {
        let current = snapshot("file-1", "note.md", "external-edit", 2);
        let last = snapshot("file-1", "note.md", "hash-1", 1);

        let guarded = preflight_projection_plan(&tombstone_plan(), &[current], &[last]);

        assert!(guarded.blocked);
        match &guarded.steps[0] {
            GuardedProjectionStep::BlockedByLiveDiskChange {
                operation,
                preflight,
                ..
            } => {
                assert_eq!(*operation, ProjectionOperation::Tombstone);
                assert_eq!(preflight.status, ProjectionPreflightStatus::DirtyMismatch);
            }
            other => panic!("expected live disk block, got {other:?}"),
        }
    }

    #[test]
    fn missing_current_disk_snapshot_allows_create_write() {
        let guarded = preflight_projection_plan(&write_plan(), &[], &[]);

        assert!(!guarded.blocked);
        match &guarded.steps[0] {
            GuardedProjectionStep::Write { preflight, .. } => {
                assert!(preflight.allowed);
                assert_eq!(
                    preflight.status,
                    ProjectionPreflightStatus::MissingCurrentDiskSnapshot
                );
                assert_eq!(preflight.current_disk, None);
                assert_eq!(preflight.last_projected, None);
            }
            other => panic!("expected create write, got {other:?}"),
        }
    }

    #[test]
    fn missing_last_projected_snapshot_with_current_file_blocks_overwrite() {
        let current = snapshot("file-1", "note.md", "external-file", 3);

        let guarded = preflight_projection_plan(&write_plan(), &[current], &[]);

        assert!(guarded.blocked);
        match &guarded.steps[0] {
            GuardedProjectionStep::BlockedByLiveDiskChange { preflight, .. } => {
                assert!(!preflight.allowed);
                assert_eq!(
                    preflight.status,
                    ProjectionPreflightStatus::MissingLastProjectedSnapshot
                );
            }
            other => panic!("expected missing-last block, got {other:?}"),
        }
    }

    #[test]
    fn already_conflict_blocked_projection_plan_skips_disk_preflight() {
        let issue = MaterializeIssue::PathConflict {
            normalized_path: "same.md".to_owned(),
            file_ids: vec!["file-a".to_owned(), "file-b".to_owned()],
        };
        let plan = ProjectionPlan {
            blocked: true,
            steps: vec![ProjectionStep::Blocked {
                issue: issue.clone(),
            }],
        };

        let guarded = preflight_projection_plan(&plan, &[], &[]);

        assert!(guarded.blocked);
        assert_eq!(
            guarded.steps,
            vec![GuardedProjectionStep::BlockedMaterialization { issue }]
        );
    }

    #[test]
    fn projection_confirmation_updates_next_projected_snapshot() {
        let next = snapshot("file-1", "note.md", "hash-2", 2);

        let confirmation =
            confirm_projection_result(ProjectionApplyResult::WriteApplied { snapshot: next });

        match confirmation.snapshot_update {
            ProjectedSnapshotUpdate::Set { snapshot } => {
                assert_eq!(snapshot.content_hash, "hash-2");
                assert_eq!(snapshot.projection_generation, 2);
            }
            other => panic!("expected set snapshot update, got {other:?}"),
        }
    }

    #[test]
    fn tombstone_confirmation_clears_projected_snapshot() {
        let confirmation = confirm_projection_result(ProjectionApplyResult::TombstoneApplied {
            file_id: "file-1".to_owned(),
            normalized_path: "note.md".to_owned(),
            projection_generation: 3,
        });

        assert_eq!(
            confirmation.snapshot_update,
            ProjectedSnapshotUpdate::Clear {
                file_id: "file-1".to_owned(),
                normalized_path: "note.md".to_owned(),
                projection_generation: 3,
            }
        );
    }

    #[test]
    fn projection_failures_do_not_mark_projected_snapshot_clean() {
        let retryable = confirm_projection_result(ProjectionApplyResult::RetryableFailure {
            file_id: "file-1".to_owned(),
            normalized_path: "note.md".to_owned(),
            message: "disk busy".to_owned(),
        });
        let permanent = confirm_projection_result(ProjectionApplyResult::PermanentFailure {
            file_id: "file-1".to_owned(),
            normalized_path: "note.md".to_owned(),
            message: "permission denied".to_owned(),
        });

        assert_eq!(
            retryable.snapshot_update,
            ProjectedSnapshotUpdate::Unchanged
        );
        assert_eq!(
            permanent.snapshot_update,
            ProjectedSnapshotUpdate::Unchanged
        );
    }
}
