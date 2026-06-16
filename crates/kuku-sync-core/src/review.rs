use serde::{Deserialize, Serialize};

use crate::import::{ImportCandidate, ImportConfidence, ImportReviewReason};
use crate::model::MaterializeIssue;
use crate::projection::{
    GuardedProjectionPlan, GuardedProjectionStep, ProjectionOperation, ProjectionPreflightDecision,
};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReviewQueueSnapshot {
    pub blocks_fully_synced: bool,
    pub items: Vec<SyncReviewItem>,
}

impl ReviewQueueSnapshot {
    pub fn from_items(items: Vec<SyncReviewItem>) -> Self {
        Self {
            blocks_fully_synced: !items.is_empty(),
            items,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SyncReviewItem {
    Import {
        id: String,
        reason: ImportReviewReason,
        candidate: ImportCandidate,
    },
    ProjectionBlocked {
        id: String,
        file_id: String,
        normalized_path: String,
        operation: ProjectionOperation,
        preflight: ProjectionPreflightDecision,
    },
    Conflict {
        id: String,
        issue: MaterializeIssue,
    },
    MissingObject {
        id: String,
        issue: MaterializeIssue,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ReviewResolutionCommand {
    AcceptImport {
        review_item_id: String,
    },
    RejectImport {
        review_item_id: String,
    },
    KeepDelete {
        review_item_id: String,
        file_id: String,
    },
    RestoreEditedVersion {
        review_item_id: String,
        file_id: String,
    },
    RenameFile {
        review_item_id: String,
        file_id: String,
        new_display_path: String,
    },
    RetryMissingObject {
        review_item_id: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReviewResolutionRecord {
    pub review_item_id: String,
    pub item_fingerprint: String,
    pub command: ReviewResolutionCommand,
    pub resolved_at_ms: i64,
}

pub fn review_queue_from_imports_and_projection(
    import_candidates: &[ImportCandidate],
    projection_plan: Option<&GuardedProjectionPlan>,
) -> ReviewQueueSnapshot {
    let mut items = Vec::new();
    items.extend(import_candidates.iter().filter_map(import_review_item));
    if let Some(plan) = projection_plan {
        items.extend(projection_review_items(plan));
    }
    ReviewQueueSnapshot::from_items(items)
}

pub fn filter_resolved_review_items(
    items: Vec<SyncReviewItem>,
    resolutions: &[ReviewResolutionRecord],
) -> ReviewQueueSnapshot {
    let filtered = items
        .into_iter()
        .filter(|item| !review_item_is_resolved(item, resolutions))
        .collect();
    ReviewQueueSnapshot::from_items(filtered)
}

pub fn import_review_item(candidate: &ImportCandidate) -> Option<SyncReviewItem> {
    let reason = import_review_reason(candidate)?;
    Some(SyncReviewItem::Import {
        id: import_review_id(candidate),
        reason,
        candidate: candidate.clone(),
    })
}

pub fn review_item_id(item: &SyncReviewItem) -> &str {
    match item {
        SyncReviewItem::Import { id, .. }
        | SyncReviewItem::ProjectionBlocked { id, .. }
        | SyncReviewItem::Conflict { id, .. }
        | SyncReviewItem::MissingObject { id, .. } => id,
    }
}

pub fn review_item_fingerprint(item: &SyncReviewItem) -> String {
    let bytes = serde_json::to_vec(item).expect("sync review item should serialize");
    blake3::hash(&bytes).to_hex().to_string()
}

fn review_item_is_resolved(item: &SyncReviewItem, resolutions: &[ReviewResolutionRecord]) -> bool {
    let id = review_item_id(item);
    let fingerprint = review_item_fingerprint(item);
    resolutions
        .iter()
        .any(|record| record.review_item_id == id && record.item_fingerprint == fingerprint)
}

pub fn projection_review_items(plan: &GuardedProjectionPlan) -> Vec<SyncReviewItem> {
    plan.steps
        .iter()
        .filter_map(|step| match step {
            GuardedProjectionStep::BlockedByLiveDiskChange {
                file_id,
                normalized_path,
                operation,
                preflight,
                ..
            } => Some(SyncReviewItem::ProjectionBlocked {
                id: format!("projection:{file_id}:{normalized_path}:{operation:?}"),
                file_id: file_id.clone(),
                normalized_path: normalized_path.clone(),
                operation: *operation,
                preflight: preflight.clone(),
            }),
            GuardedProjectionStep::BlockedMaterialization { issue } => {
                Some(materialize_review_item(issue))
            }
            GuardedProjectionStep::Write { .. } | GuardedProjectionStep::Tombstone { .. } => None,
        })
        .collect()
}

pub fn materialize_review_item(issue: &MaterializeIssue) -> SyncReviewItem {
    match issue {
        MaterializeIssue::MissingTextDoc {
            file_id,
            text_doc_id,
        } => SyncReviewItem::MissingObject {
            id: format!("missing-text-doc:{file_id}:{text_doc_id}"),
            issue: issue.clone(),
        },
        MaterializeIssue::MissingBlob { file_id, blob_ref } => SyncReviewItem::MissingObject {
            id: format!("missing-blob:{file_id}:{blob_ref}"),
            issue: issue.clone(),
        },
        MaterializeIssue::PathConflict {
            normalized_path, ..
        }
        | MaterializeIssue::CaseConflict {
            normalized_path, ..
        } => SyncReviewItem::Conflict {
            id: format!("path-conflict:{normalized_path}"),
            issue: issue.clone(),
        },
        MaterializeIssue::DeleteEditConflict { file_id, .. } => SyncReviewItem::Conflict {
            id: format!("delete-edit-conflict:{file_id}"),
            issue: issue.clone(),
        },
        MaterializeIssue::ScalarConflict { file_id, field, .. } => SyncReviewItem::Conflict {
            id: format!("scalar-conflict:{file_id}:{field}"),
            issue: issue.clone(),
        },
    }
}

fn import_review_reason(candidate: &ImportCandidate) -> Option<ImportReviewReason> {
    match candidate {
        ImportCandidate::ExternalCreate { confidence, .. }
        | ImportCandidate::ExternalModify { confidence, .. }
        | ImportCandidate::ExternalDelete { confidence, .. }
        | ImportCandidate::ExternalRename { confidence, .. } => {
            confidence_review_reason(confidence)
        }
        ImportCandidate::Suppressed { .. } | ImportCandidate::Unchanged { .. } => None,
    }
}

fn confidence_review_reason(confidence: &ImportConfidence) -> Option<ImportReviewReason> {
    match confidence {
        ImportConfidence::AutoImport { .. } => None,
        ImportConfidence::ReviewRequired { reason } | ImportConfidence::DeleteGrace { reason } => {
            Some(*reason)
        }
    }
}

fn import_review_id(candidate: &ImportCandidate) -> String {
    match candidate {
        ImportCandidate::ExternalCreate {
            normalized_path, ..
        } => format!("import:create:{normalized_path}"),
        ImportCandidate::ExternalModify {
            file_id,
            normalized_path,
            ..
        } => format!("import:modify:{file_id}:{normalized_path}"),
        ImportCandidate::ExternalDelete {
            file_id,
            normalized_path,
            ..
        } => format!("import:delete:{file_id}:{normalized_path}"),
        ImportCandidate::ExternalRename {
            file_id,
            from_normalized_path,
            to_normalized_path,
            ..
        } => format!("import:rename:{file_id}:{from_normalized_path}:{to_normalized_path}"),
        ImportCandidate::Suppressed {
            mutation_token,
            normalized_path,
        } => format!("import:suppressed:{mutation_token}:{normalized_path}"),
        ImportCandidate::Unchanged { normalized_path } => {
            format!("import:unchanged:{normalized_path}")
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::import::{ImportAutoReason, ImportConfidence};
    use crate::projection::{
        ProjectedSnapshot, ProjectionOperation, ProjectionPreflightStatus, preflight_projection,
    };

    fn snapshot(hash: &str) -> ProjectedSnapshot {
        ProjectedSnapshot {
            file_id: "file-1".to_owned(),
            normalized_path: "note.md".to_owned(),
            content_hash: hash.to_owned(),
            mtime_ms: 1,
            size: 1,
            projection_generation: 1,
        }
    }

    #[test]
    fn review_queue_ignores_auto_import_and_includes_review_required_import() {
        let auto = ImportCandidate::ExternalModify {
            file_id: "file-1".to_owned(),
            normalized_path: "note.md".to_owned(),
            content_hash: "hash-2".to_owned(),
            confidence: ImportConfidence::AutoImport {
                reason: ImportAutoReason::SmallLocalizedEdit,
            },
        };
        let review = ImportCandidate::ExternalModify {
            file_id: "file-1".to_owned(),
            normalized_path: "note.md".to_owned(),
            content_hash: "hash-3".to_owned(),
            confidence: ImportConfidence::ReviewRequired {
                reason: ImportReviewReason::LargeRewrite,
            },
        };

        let queue = review_queue_from_imports_and_projection(&[auto, review], None);

        assert!(queue.blocks_fully_synced);
        assert_eq!(queue.items.len(), 1);
        assert!(matches!(
            &queue.items[0],
            SyncReviewItem::Import {
                reason: ImportReviewReason::LargeRewrite,
                ..
            }
        ));
    }

    #[test]
    fn delete_grace_import_becomes_review_item() {
        let candidate = ImportCandidate::ExternalDelete {
            file_id: "file-1".to_owned(),
            normalized_path: "note.md".to_owned(),
            confidence: ImportConfidence::DeleteGrace {
                reason: ImportReviewReason::ExternalDelete,
            },
        };

        let item = import_review_item(&candidate).expect("delete should require review");

        assert!(matches!(
            item,
            SyncReviewItem::Import {
                id,
                reason: ImportReviewReason::ExternalDelete,
                ..
            } if id == "import:delete:file-1:note.md"
        ));
    }

    #[test]
    fn projection_live_disk_block_becomes_review_item() {
        let current = snapshot("external-hash");
        let last = snapshot("projected-hash");
        let preflight = preflight_projection(
            ProjectionOperation::Write,
            "file-1",
            "note.md",
            Some(&current),
            Some(&last),
        );
        let plan = GuardedProjectionPlan {
            blocked: true,
            steps: vec![GuardedProjectionStep::BlockedByLiveDiskChange {
                file_id: "file-1".to_owned(),
                path: "Note.md".to_owned(),
                normalized_path: "note.md".to_owned(),
                operation: ProjectionOperation::Write,
                preflight,
            }],
        };

        let queue = review_queue_from_imports_and_projection(&[], Some(&plan));

        assert!(queue.blocks_fully_synced);
        assert!(matches!(
            &queue.items[0],
            SyncReviewItem::ProjectionBlocked {
                file_id,
                normalized_path,
                preflight,
                ..
            } if file_id == "file-1"
                && normalized_path == "note.md"
                && preflight.status == ProjectionPreflightStatus::DirtyMismatch
        ));
    }

    #[test]
    fn materialization_issues_are_split_between_conflict_and_missing_object() {
        let conflict = MaterializeIssue::DeleteEditConflict {
            file_id: "file-1".to_owned(),
            display_path: "Note.md".to_owned(),
            text_doc_id: "text-1".to_owned(),
            tombstone_content: "old".to_owned(),
            current_content: "new".to_owned(),
        };
        let missing = MaterializeIssue::MissingBlob {
            file_id: "file-2".to_owned(),
            blob_ref: "blob-1".to_owned(),
        };

        assert!(matches!(
            materialize_review_item(&conflict),
            SyncReviewItem::Conflict { id, .. } if id == "delete-edit-conflict:file-1"
        ));
        assert!(matches!(
            materialize_review_item(&missing),
            SyncReviewItem::MissingObject { id, .. } if id == "missing-blob:file-2:blob-1"
        ));
    }

    #[test]
    fn empty_queue_allows_fully_synced_status() {
        let queue = review_queue_from_imports_and_projection(&[], None);

        assert!(!queue.blocks_fully_synced);
        assert!(queue.items.is_empty());
    }

    #[test]
    fn matching_resolution_record_filters_only_same_fingerprint() {
        let original = SyncReviewItem::Import {
            id: "import:modify:file-1:note.md".to_owned(),
            reason: ImportReviewReason::LargeRewrite,
            candidate: ImportCandidate::ExternalModify {
                file_id: "file-1".to_owned(),
                normalized_path: "note.md".to_owned(),
                content_hash: "hash-1".to_owned(),
                confidence: ImportConfidence::ReviewRequired {
                    reason: ImportReviewReason::LargeRewrite,
                },
            },
        };
        let changed_same_id = SyncReviewItem::Import {
            id: "import:modify:file-1:note.md".to_owned(),
            reason: ImportReviewReason::LargeRewrite,
            candidate: ImportCandidate::ExternalModify {
                file_id: "file-1".to_owned(),
                normalized_path: "note.md".to_owned(),
                content_hash: "hash-2".to_owned(),
                confidence: ImportConfidence::ReviewRequired {
                    reason: ImportReviewReason::LargeRewrite,
                },
            },
        };
        let record = ReviewResolutionRecord {
            review_item_id: review_item_id(&original).to_owned(),
            item_fingerprint: review_item_fingerprint(&original),
            command: ReviewResolutionCommand::RejectImport {
                review_item_id: review_item_id(&original).to_owned(),
            },
            resolved_at_ms: 1,
        };

        let queue = filter_resolved_review_items(
            vec![original.clone(), changed_same_id.clone()],
            std::slice::from_ref(&record),
        );

        assert_eq!(queue.items, vec![changed_same_id]);
        assert!(queue.blocks_fully_synced);
        assert_ne!(
            review_item_fingerprint(&original),
            review_item_fingerprint(&queue.items[0])
        );
    }
}
