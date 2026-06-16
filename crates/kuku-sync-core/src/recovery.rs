use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};

use crate::error::Result;
use crate::model::FileCreate;
use crate::model::{FileState, MaterializeIssue, MaterializedFile, MaterializedVault};
use crate::vault::VaultCore;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RecoverySnapshotSet {
    pub snapshots: Vec<RecoverySnapshot>,
    pub unavailable: Vec<RecoveryUnavailable>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RecoverySnapshot {
    pub id: String,
    pub kind: RecoverySnapshotKind,
    pub reason: RecoverySnapshotReason,
    pub file_id: String,
    pub incarnation_id: String,
    pub display_path: String,
    pub normalized_path: String,
    pub text_doc_id: String,
    pub content_hash: String,
    pub size_bytes: u64,
    pub content: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RecoveryRestoreInput {
    pub stable_file_id: String,
    pub incarnation_id: String,
    pub display_path: String,
    pub text_doc_id: String,
    pub content: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RecoverySnapshotKind {
    Current,
    Tombstone,
    DeleteEditTombstone,
    DeleteEditCurrent,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RecoverySnapshotReason {
    ActiveMaterialized,
    TombstonedFile,
    DeleteEditConflict,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RecoveryUnavailable {
    pub id: String,
    pub reason: RecoveryUnavailableReason,
    pub file_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub normalized_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text_doc_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blob_ref: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RecoveryUnavailableReason {
    MissingTextDoc,
    MissingBlob,
}

impl VaultCore {
    pub fn restore_recovery_snapshot(&mut self, input: RecoveryRestoreInput) -> Result<()> {
        self.create_markdown(FileCreate {
            stable_file_id: input.stable_file_id,
            incarnation_id: input.incarnation_id,
            display_path: input.display_path,
            text_doc_id: input.text_doc_id,
            blob_ref: None,
            content: input.content,
        })
    }
}

pub fn recovery_snapshot_set(vault: &MaterializedVault) -> RecoverySnapshotSet {
    let delete_edit_file_ids = delete_edit_conflict_file_ids(&vault.issues);
    let mut snapshots = Vec::new();
    let mut unavailable = Vec::new();

    snapshots.extend(delete_edit_snapshots(vault));

    for file in vault.files.values() {
        if delete_edit_file_ids.contains(file.stable_file_id.as_str()) {
            continue;
        }

        match file.state {
            FileState::Active => {
                if let Some(content) = &file.content {
                    snapshots.push(snapshot_from_file(
                        file,
                        RecoverySnapshotKind::Current,
                        RecoverySnapshotReason::ActiveMaterialized,
                        content.clone(),
                    ));
                }
            }
            FileState::Tombstoned => {
                if let Some(content) = tombstone_recovery_content(file) {
                    snapshots.push(snapshot_from_file(
                        file,
                        RecoverySnapshotKind::Tombstone,
                        RecoverySnapshotReason::TombstonedFile,
                        content,
                    ));
                }
            }
        }
    }

    unavailable.extend(unavailable_recovery_items(vault));

    RecoverySnapshotSet {
        snapshots,
        unavailable,
    }
}

fn delete_edit_conflict_file_ids(issues: &[MaterializeIssue]) -> BTreeSet<&str> {
    issues
        .iter()
        .filter_map(|issue| match issue {
            MaterializeIssue::DeleteEditConflict { file_id, .. } => Some(file_id.as_str()),
            _ => None,
        })
        .collect()
}

fn delete_edit_snapshots(vault: &MaterializedVault) -> Vec<RecoverySnapshot> {
    vault
        .issues
        .iter()
        .filter_map(|issue| match issue {
            MaterializeIssue::DeleteEditConflict {
                file_id,
                display_path,
                text_doc_id,
                tombstone_content,
                current_content,
            } => {
                let file = vault.files.get(file_id);
                let incarnation_id = file
                    .map(|file| file.incarnation_id.clone())
                    .unwrap_or_default();
                let normalized_path = file
                    .map(|file| file.normalized_path.clone())
                    .unwrap_or_else(|| crate::normalize_path(display_path));

                Some(vec![
                    snapshot_from_parts(
                        format!("recovery:delete-edit:tombstone:{file_id}"),
                        RecoverySnapshotKind::DeleteEditTombstone,
                        RecoverySnapshotReason::DeleteEditConflict,
                        file_id.clone(),
                        incarnation_id.clone(),
                        display_path.clone(),
                        normalized_path.clone(),
                        text_doc_id.clone(),
                        tombstone_content.clone(),
                    ),
                    snapshot_from_parts(
                        format!("recovery:delete-edit:current:{file_id}"),
                        RecoverySnapshotKind::DeleteEditCurrent,
                        RecoverySnapshotReason::DeleteEditConflict,
                        file_id.clone(),
                        incarnation_id,
                        display_path.clone(),
                        normalized_path,
                        text_doc_id.clone(),
                        current_content.clone(),
                    ),
                ])
            }
            _ => None,
        })
        .flatten()
        .collect()
}

fn unavailable_recovery_items(vault: &MaterializedVault) -> Vec<RecoveryUnavailable> {
    vault
        .issues
        .iter()
        .filter_map(|issue| match issue {
            MaterializeIssue::MissingTextDoc {
                file_id,
                text_doc_id,
            } => {
                let file = vault.files.get(file_id);
                Some(RecoveryUnavailable {
                    id: format!("recovery:missing-text-doc:{file_id}:{text_doc_id}"),
                    reason: RecoveryUnavailableReason::MissingTextDoc,
                    file_id: file_id.clone(),
                    display_path: file.map(|file| file.display_path.clone()),
                    normalized_path: file.map(|file| file.normalized_path.clone()),
                    text_doc_id: Some(text_doc_id.clone()),
                    blob_ref: None,
                })
            }
            MaterializeIssue::MissingBlob { file_id, blob_ref } => {
                let file = vault.files.get(file_id);
                Some(RecoveryUnavailable {
                    id: format!("recovery:missing-blob:{file_id}:{blob_ref}"),
                    reason: RecoveryUnavailableReason::MissingBlob,
                    file_id: file_id.clone(),
                    display_path: file.map(|file| file.display_path.clone()),
                    normalized_path: file.map(|file| file.normalized_path.clone()),
                    text_doc_id: file.map(|file| file.text_doc_id.clone()),
                    blob_ref: Some(blob_ref.clone()),
                })
            }
            _ => None,
        })
        .collect()
}

fn tombstone_recovery_content(file: &MaterializedFile) -> Option<String> {
    file.tombstone_content
        .clone()
        .or_else(|| file.content.clone())
}

fn snapshot_from_file(
    file: &MaterializedFile,
    kind: RecoverySnapshotKind,
    reason: RecoverySnapshotReason,
    content: String,
) -> RecoverySnapshot {
    let label = match kind {
        RecoverySnapshotKind::Current => "current",
        RecoverySnapshotKind::Tombstone => "tombstone",
        RecoverySnapshotKind::DeleteEditTombstone => "delete-edit:tombstone",
        RecoverySnapshotKind::DeleteEditCurrent => "delete-edit:current",
    };

    snapshot_from_parts(
        format!("recovery:{label}:{}", file.stable_file_id),
        kind,
        reason,
        file.stable_file_id.clone(),
        file.incarnation_id.clone(),
        file.display_path.clone(),
        file.normalized_path.clone(),
        file.text_doc_id.clone(),
        content,
    )
}

fn snapshot_from_parts(
    id: String,
    kind: RecoverySnapshotKind,
    reason: RecoverySnapshotReason,
    file_id: String,
    incarnation_id: String,
    display_path: String,
    normalized_path: String,
    text_doc_id: String,
    content: String,
) -> RecoverySnapshot {
    RecoverySnapshot {
        id,
        kind,
        reason,
        file_id,
        incarnation_id,
        display_path,
        normalized_path,
        text_doc_id,
        content_hash: blake3::hash(content.as_bytes()).to_hex().to_string(),
        size_bytes: content.len() as u64,
        content,
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::*;
    use crate::model::{ProjectionPlan, ProjectionStep};
    use crate::vault::VaultCore;

    fn create_note(
        core: &mut VaultCore,
        file_id: &str,
        incarnation_id: &str,
        path: &str,
        text_doc_id: &str,
        content: &str,
    ) {
        core.create_markdown(FileCreate {
            stable_file_id: file_id.to_owned(),
            incarnation_id: incarnation_id.to_owned(),
            display_path: path.to_owned(),
            text_doc_id: text_doc_id.to_owned(),
            blob_ref: None,
            content: content.to_owned(),
        })
        .unwrap();
    }

    #[test]
    fn active_file_exposes_current_recovery_snapshot() {
        let mut core = VaultCore::new(b"a").unwrap();
        create_note(&mut core, "file-1", "inc-1", "note.md", "text-1", "body");

        let set = recovery_snapshot_set(&core.materialize().unwrap());

        assert_eq!(set.unavailable, vec![]);
        assert_eq!(set.snapshots.len(), 1);
        assert_eq!(set.snapshots[0].kind, RecoverySnapshotKind::Current);
        assert_eq!(
            set.snapshots[0].reason,
            RecoverySnapshotReason::ActiveMaterialized
        );
        assert_eq!(set.snapshots[0].content, "body");
        assert_eq!(set.snapshots[0].size_bytes, 4);
    }

    #[test]
    fn tombstoned_file_exposes_delete_time_recovery_snapshot() {
        let mut core = VaultCore::new(b"a").unwrap();
        create_note(&mut core, "file-1", "inc-1", "note.md", "text-1", "body");

        core.tombstone_file("file-1").unwrap();
        let set = recovery_snapshot_set(&core.materialize().unwrap());

        assert_eq!(set.snapshots.len(), 1);
        assert_eq!(set.snapshots[0].kind, RecoverySnapshotKind::Tombstone);
        assert_eq!(
            set.snapshots[0].reason,
            RecoverySnapshotReason::TombstonedFile
        );
        assert_eq!(set.snapshots[0].content, "body");
    }

    #[test]
    fn delete_edit_conflict_exposes_tombstone_and_current_versions() {
        let mut base = VaultCore::new(b"base").unwrap();
        create_note(&mut base, "file-1", "inc-1", "note.md", "text-1", "base");
        let mut a = base.fork_for_actor(b"a").unwrap();
        let mut b = base.fork_for_actor(b"b").unwrap();

        a.tombstone_file("file-1").unwrap();
        b.edit_markdown("text-1", "edited after delete").unwrap();
        a.merge_from(&mut b).unwrap();

        let set = recovery_snapshot_set(&a.materialize().unwrap());

        assert_eq!(set.snapshots.len(), 2);
        assert_eq!(
            set.snapshots
                .iter()
                .map(|snapshot| (snapshot.kind, snapshot.content.as_str()))
                .collect::<Vec<_>>(),
            vec![
                (RecoverySnapshotKind::DeleteEditTombstone, "base"),
                (
                    RecoverySnapshotKind::DeleteEditCurrent,
                    "edited after delete"
                ),
            ]
        );
    }

    #[test]
    fn missing_text_doc_is_reported_as_unavailable_recovery_item() {
        let mut files = BTreeMap::new();
        files.insert(
            "file-1".to_owned(),
            MaterializedFile {
                stable_file_id: "file-1".to_owned(),
                incarnation_id: "inc-1".to_owned(),
                display_path: "note.md".to_owned(),
                normalized_path: "note.md".to_owned(),
                state: FileState::Active,
                text_doc_id: "text-1".to_owned(),
                blob_ref: None,
                content: None,
                tombstone_content: None,
            },
        );
        let vault = MaterializedVault {
            files,
            issues: vec![MaterializeIssue::MissingTextDoc {
                file_id: "file-1".to_owned(),
                text_doc_id: "text-1".to_owned(),
            }],
            projection_plan: ProjectionPlan {
                blocked: true,
                steps: vec![],
            },
        };

        let set = recovery_snapshot_set(&vault);

        assert_eq!(set.snapshots, vec![]);
        assert_eq!(set.unavailable.len(), 1);
        assert_eq!(
            set.unavailable[0].reason,
            RecoveryUnavailableReason::MissingTextDoc
        );
        assert_eq!(set.unavailable[0].display_path.as_deref(), Some("note.md"));
    }

    #[test]
    fn restore_recovery_snapshot_creates_new_active_file() {
        let mut core = VaultCore::new(b"a").unwrap();
        create_note(&mut core, "file-1", "inc-1", "note.md", "text-1", "body");
        core.tombstone_file("file-1").unwrap();
        let snapshot = recovery_snapshot_set(&core.materialize().unwrap()).snapshots[0].clone();

        core.restore_recovery_snapshot(RecoveryRestoreInput {
            stable_file_id: "file-2".to_owned(),
            incarnation_id: "inc-2".to_owned(),
            display_path: "restored.md".to_owned(),
            text_doc_id: "text-2".to_owned(),
            content: snapshot.content,
        })
        .unwrap();
        let vault = core.materialize().unwrap();

        let restored = vault.files.get("file-2").unwrap();
        assert_eq!(restored.state, FileState::Active);
        assert_eq!(restored.content.as_deref(), Some("body"));
        assert!(vault.projection_plan.steps.iter().any(|step| matches!(
            step,
            ProjectionStep::Write {
                file_id,
                path,
                content,
                ..
            } if file_id == "file-2" && path == "restored.md" && content == "body"
        )));
    }
}
