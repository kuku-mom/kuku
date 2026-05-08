#![allow(dead_code)]

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use super::db::{FILE_KIND_MARKDOWN, ScanApplyResult, SyncFileRecord, SyncTreeEntryRecord};
use super::errors::{SyncError, SyncResult};
use super::packer::PackEntryInput;
use super::scanner::ScannedFile;

pub const CONTENT_PACK_KIND: &str = "content_pack";
pub const CHECKPOINT_PACK_KIND: &str = "checkpoint_pack";
pub const DEFAULT_MAX_PACK_PLAINTEXT_BYTES: i64 = 28 * 1024 * 1024;

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CommitPlanKind {
    Checkpoint,
    Incremental,
    Merge,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PlannerConfig {
    pub max_pack_plaintext_bytes: i64,
}

impl Default for PlannerConfig {
    fn default() -> Self {
        Self {
            max_pack_plaintext_bytes: DEFAULT_MAX_PACK_PLAINTEXT_BYTES,
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SyncPlan {
    pub commit_kind: CommitPlanKind,
    pub tree_id: String,
    pub tree_entries: Vec<PlannedTreeEntry>,
    pub file_ops: Vec<PlanFileOp>,
    pub pack_shards: Vec<PackShardPlan>,
}

impl SyncPlan {
    pub fn is_empty(&self) -> bool {
        self.file_ops.is_empty() && self.pack_shards.is_empty()
    }
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PlannedTreeEntry {
    pub file_id: String,
    pub path: String,
    pub normalized_path: String,
    pub plaintext_hash: String,
    pub size_bytes: i64,
    pub kind: String,
    pub pack_ref: Option<String>,
    pub pack_entry_id: Option<String>,
}

impl PlannedTreeEntry {
    pub fn cache_record(
        &self,
        commit_id: &str,
        content_object_id: Option<String>,
    ) -> SyncTreeEntryRecord {
        SyncTreeEntryRecord {
            commit_id: commit_id.into(),
            file_id: self.file_id.clone(),
            normalized_path: self.normalized_path.clone(),
            plaintext_hash: Some(self.plaintext_hash.clone()),
            content_object_id,
            pack_entry_id: self.pack_entry_id.clone(),
            kind: self.kind.clone(),
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", tag = "op")]
pub enum PlanFileOp {
    Upsert {
        file_id: String,
        path: String,
        normalized_path: String,
        plaintext_hash: String,
        size_bytes: i64,
        pack_ref: String,
        pack_entry_id: String,
    },
    Delete {
        file_id: String,
        path: String,
        normalized_path: String,
    },
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PackShardPlan {
    pub pack_ref: String,
    pub pack_kind: String,
    pub shard_index: usize,
    pub total_plaintext_bytes: i64,
    pub entries: Vec<PackEntryPlan>,
}

impl PackShardPlan {
    pub fn pack_entries(&self) -> Vec<PackEntryInput> {
        self.entries
            .iter()
            .map(|entry| PackEntryInput {
                entry_id: entry.entry_id.clone(),
                plaintext: entry.plaintext.clone(),
            })
            .collect()
    }
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PackEntryPlan {
    pub entry_id: String,
    pub file_id: String,
    pub normalized_path: String,
    pub plaintext_hash: String,
    pub size_bytes: i64,
    #[serde(skip)]
    pub plaintext: Vec<u8>,
}

pub fn plan_checkpoint(
    scanned_files: &[ScannedFile],
    config: &PlannerConfig,
) -> SyncResult<SyncPlan> {
    validate_config(config)?;
    let pack_assignments = assign_pack_entries(scanned_files, CHECKPOINT_PACK_KIND, config)?;
    build_plan(
        CommitPlanKind::Checkpoint,
        scanned_files,
        &[],
        pack_assignments,
    )
}

pub fn plan_incremental(
    scan_result: &ScanApplyResult,
    scanned_files: &[ScannedFile],
    config: &PlannerConfig,
) -> SyncResult<SyncPlan> {
    validate_config(config)?;
    let scanned_by_path = scanned_files
        .iter()
        .map(|file| (file.normalized_path.as_str(), file))
        .collect::<BTreeMap<_, _>>();
    let mut upserts = Vec::new();
    for row in &scan_result.upserts {
        if !row.dirty || row.deleted {
            continue;
        }
        let scanned = scanned_by_path
            .get(row.normalized_path.as_str())
            .ok_or_else(|| {
                SyncError::InvalidArgument(format!(
                    "dirty sync file missing scanner content: {}",
                    row.normalized_path
                ))
            })?;
        upserts.push((*scanned).clone());
    }

    let pack_assignments = assign_pack_entries(&upserts, CONTENT_PACK_KIND, config)?;
    build_plan(
        CommitPlanKind::Incremental,
        &upserts,
        &scan_result.deletions,
        pack_assignments,
    )
}

fn build_plan(
    commit_kind: CommitPlanKind,
    upserts: &[ScannedFile],
    deletions: &[SyncFileRecord],
    pack_shards: Vec<PackShardPlan>,
) -> SyncResult<SyncPlan> {
    let mut entry_refs = BTreeMap::new();
    for shard in &pack_shards {
        for entry in &shard.entries {
            entry_refs.insert(
                entry.normalized_path.clone(),
                (shard.pack_ref.clone(), entry.entry_id.clone()),
            );
        }
    }

    let mut tree_entries = Vec::new();
    let mut file_ops = Vec::new();
    for file in upserts {
        let (pack_ref, pack_entry_id) =
            entry_refs
                .get(&file.normalized_path)
                .cloned()
                .ok_or_else(|| {
                    SyncError::InvalidArgument(format!(
                        "missing pack assignment for {}",
                        file.normalized_path
                    ))
                })?;
        tree_entries.push(PlannedTreeEntry {
            file_id: file.file_id.clone(),
            path: file.path.clone(),
            normalized_path: file.normalized_path.clone(),
            plaintext_hash: file.plaintext_hash.clone(),
            size_bytes: file.size_bytes,
            kind: FILE_KIND_MARKDOWN.into(),
            pack_ref: Some(pack_ref.clone()),
            pack_entry_id: Some(pack_entry_id.clone()),
        });
        file_ops.push(PlanFileOp::Upsert {
            file_id: file.file_id.clone(),
            path: file.path.clone(),
            normalized_path: file.normalized_path.clone(),
            plaintext_hash: file.plaintext_hash.clone(),
            size_bytes: file.size_bytes,
            pack_ref,
            pack_entry_id,
        });
    }

    for deleted in deletions {
        file_ops.push(PlanFileOp::Delete {
            file_id: deleted.file_id.clone(),
            path: deleted.path.clone(),
            normalized_path: deleted.normalized_path.clone(),
        });
    }

    tree_entries.sort_by(|left, right| left.normalized_path.cmp(&right.normalized_path));
    file_ops.sort_by(|left, right| plan_file_op_sort_key(left).cmp(&plan_file_op_sort_key(right)));
    let tree_id = compute_tree_id(&tree_entries)?;

    Ok(SyncPlan {
        commit_kind,
        tree_id,
        tree_entries,
        file_ops,
        pack_shards,
    })
}

fn assign_pack_entries(
    files: &[ScannedFile],
    pack_kind: &str,
    config: &PlannerConfig,
) -> SyncResult<Vec<PackShardPlan>> {
    let mut files = files.to_vec();
    files.sort_by(|left, right| left.normalized_path.cmp(&right.normalized_path));

    let mut shards = Vec::new();
    let mut current_entries = Vec::new();
    let mut current_bytes = 0;

    for file in files {
        if file.size_bytes > config.max_pack_plaintext_bytes {
            return Err(SyncError::QuotaExceeded(format!(
                "file exceeds sync size limit: {} ({} MB, limit {} MB)",
                file.path,
                format_size_mb(file.size_bytes),
                format_size_mb(config.max_pack_plaintext_bytes)
            )));
        }
        if !current_entries.is_empty()
            && current_bytes + file.size_bytes > config.max_pack_plaintext_bytes
        {
            shards.push(pack_shard(
                pack_kind,
                shards.len(),
                current_bytes,
                std::mem::take(&mut current_entries),
            ));
            current_bytes = 0;
        }

        current_bytes += file.size_bytes;
        current_entries.push(PackEntryPlan {
            entry_id: pack_entry_id(&file.file_id, &file.plaintext_hash),
            file_id: file.file_id,
            normalized_path: file.normalized_path,
            plaintext_hash: file.plaintext_hash,
            size_bytes: file.size_bytes,
            plaintext: file.plaintext,
        });
    }

    if !current_entries.is_empty() {
        shards.push(pack_shard(
            pack_kind,
            shards.len(),
            current_bytes,
            current_entries,
        ));
    }

    Ok(shards)
}

fn pack_shard(
    pack_kind: &str,
    shard_index: usize,
    total_plaintext_bytes: i64,
    entries: Vec<PackEntryPlan>,
) -> PackShardPlan {
    PackShardPlan {
        pack_ref: format!("{pack_kind}-{shard_index}"),
        pack_kind: pack_kind.into(),
        shard_index,
        total_plaintext_bytes,
        entries,
    }
}

fn pack_entry_id(file_id: &str, plaintext_hash: &str) -> String {
    let mut hasher = blake3::Hasher::new();
    hasher.update(file_id.as_bytes());
    hasher.update(b"\0");
    hasher.update(plaintext_hash.as_bytes());
    let hash = hasher.finalize().to_hex().to_string();
    format!("entry_{}", &hash[..32])
}

fn compute_tree_id(entries: &[PlannedTreeEntry]) -> SyncResult<String> {
    let json = serde_json::to_vec(entries)?;
    let hash = blake3::hash(&json).to_hex().to_string();
    Ok(format!("tree_{}", &hash[..32]))
}

fn validate_config(config: &PlannerConfig) -> SyncResult<()> {
    if config.max_pack_plaintext_bytes <= 0 {
        return Err(SyncError::InvalidArgument(
            "max_pack_plaintext_bytes must be positive".into(),
        ));
    }
    Ok(())
}

fn plan_file_op_sort_key(value: &PlanFileOp) -> (&str, &str) {
    match value {
        PlanFileOp::Upsert {
            normalized_path, ..
        } => ("0", normalized_path.as_str()),
        PlanFileOp::Delete {
            normalized_path, ..
        } => ("1", normalized_path.as_str()),
    }
}

fn format_size_mb(bytes: i64) -> String {
    format!("{:.1}", bytes.max(0) as f64 / 1024.0 / 1024.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checkpoint_planner_creates_checkpoint_pack_shards() {
        let files = vec![
            scanned("b.md", b"bbbb"),
            scanned("a.md", b"aaaa"),
            scanned("c.md", b"cccc"),
        ];
        let config = PlannerConfig {
            max_pack_plaintext_bytes: 8,
        };

        let plan = plan_checkpoint(&files, &config).unwrap();
        let repeat = plan_checkpoint(&files, &config).unwrap();

        assert_eq!(plan.commit_kind, CommitPlanKind::Checkpoint);
        assert_eq!(plan.pack_shards.len(), 2);
        assert_eq!(plan.pack_shards[0].pack_kind, CHECKPOINT_PACK_KIND);
        assert_eq!(plan.pack_shards[0].entries.len(), 2);
        assert_eq!(plan.tree_entries[0].normalized_path, "a.md");
        assert_eq!(plan.tree_id, repeat.tree_id);
    }

    #[test]
    fn incremental_planner_creates_content_pack_and_delete_op() {
        let scanned = vec![scanned("changed.md", b"new")];
        let scan_result = ScanApplyResult {
            upserts: vec![SyncFileRecord {
                file_id: scanned[0].file_id.clone(),
                path: "changed.md".into(),
                normalized_path: "changed.md".into(),
                kind: FILE_KIND_MARKDOWN.into(),
                plaintext_hash: Some(scanned[0].plaintext_hash.clone()),
                size_bytes: Some(scanned[0].size_bytes),
                mtime_ms: Some(1),
                last_synced_commit_id: Some("commit-1".into()),
                dirty: true,
                deleted: false,
            }],
            deletions: vec![SyncFileRecord {
                file_id: "file_deleted".into(),
                path: "deleted.md".into(),
                normalized_path: "deleted.md".into(),
                kind: FILE_KIND_MARKDOWN.into(),
                plaintext_hash: Some("old".into()),
                size_bytes: Some(3),
                mtime_ms: Some(1),
                last_synced_commit_id: Some("commit-1".into()),
                dirty: true,
                deleted: true,
            }],
        };

        let plan = plan_incremental(&scan_result, &scanned, &PlannerConfig::default()).unwrap();

        assert_eq!(plan.commit_kind, CommitPlanKind::Incremental);
        assert_eq!(plan.pack_shards.len(), 1);
        assert_eq!(plan.pack_shards[0].pack_kind, CONTENT_PACK_KIND);
        assert!(matches!(plan.file_ops[0], PlanFileOp::Upsert { .. }));
        assert!(matches!(plan.file_ops[1], PlanFileOp::Delete { .. }));
    }

    #[test]
    fn planner_rejects_file_larger_than_pack_cap() {
        let files = vec![scanned("large.md", b"large")];
        let config = PlannerConfig {
            max_pack_plaintext_bytes: 4,
        };

        let err = plan_checkpoint(&files, &config).unwrap_err();

        assert!(
            matches!(err, SyncError::QuotaExceeded(message) if message.contains("large.md") && message.contains("MB") && !message.contains("bytes"))
        );
    }

    fn scanned(path: &str, plaintext: &[u8]) -> ScannedFile {
        let plaintext_hash = blake3::hash(plaintext).to_hex().to_string();
        ScannedFile {
            file_id: format!("file_{path}"),
            path: path.into(),
            normalized_path: path.to_ascii_lowercase(),
            plaintext_hash,
            size_bytes: plaintext.len().try_into().unwrap(),
            mtime_ms: 1,
            plaintext: plaintext.to_vec(),
        }
    }
}
