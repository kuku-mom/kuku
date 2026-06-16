use std::collections::{BTreeMap, BTreeSet};

use kuku_sync_core::{
    FileCreate, ImportCandidate, ImportCandidateInput, ImportConfidence, LocalStore,
    ProjectedSnapshot, VaultCore, classify_import_candidate,
};

use crate::search::SearchState;

use super::errors::{SyncError, SyncResult};
use super::scanner::ScannedFile;

const AUTOMERGE_IMPORT_SOURCE: &str = "automerge-import";

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct AutomergeImportSummary {
    pub imported_creates: usize,
    pub imported_modifies: usize,
    pub imported_renames: usize,
    pub review_required: usize,
    pub unchanged: usize,
}

impl AutomergeImportSummary {
    pub(crate) fn imported_any(&self) -> bool {
        self.imported_creates > 0 || self.imported_modifies > 0 || self.imported_renames > 0
    }
}

pub(crate) fn classify_disk_scan_candidates(
    core: &mut VaultCore,
    scanned: &[ScannedFile],
    current_snapshots: &[ProjectedSnapshot],
    last_projected: &[ProjectedSnapshot],
) -> SyncResult<Vec<ImportCandidate>> {
    let materialized = core.materialize().map_err(map_sync_core_error)?;
    let materialized_files = materialized.files;
    let current_by_file_id = snapshots_by_file_id(current_snapshots);
    let last_by_file_id = snapshots_by_file_id(last_projected);
    let current_file_ids = scanned
        .iter()
        .map(|file| file.file_id.as_str())
        .collect::<BTreeSet<_>>();
    let mut candidates = Vec::new();

    for file in scanned {
        let current_snapshot = current_by_file_id
            .get(file.file_id.as_str())
            .copied()
            .cloned();
        let current_content = String::from_utf8(file.plaintext.clone()).ok();
        let previous = materialized_files.get(&file.file_id);
        let previous_content = previous.and_then(|file| file.content.clone());
        let last_snapshot = last_by_file_id.get(file.file_id.as_str()).copied().cloned();

        if previous
            .and_then(|file| file.content.as_deref())
            .zip(current_content.as_deref())
            .is_some_and(|(previous, current)| previous == current)
        {
            candidates.push(ImportCandidate::Unchanged {
                normalized_path: file.normalized_path.clone(),
            });
            continue;
        }

        candidates.push(classify_import_candidate(ImportCandidateInput {
            file_id: Some(file.file_id.clone()),
            previous_normalized_path: previous.map(|file| file.normalized_path.clone()).or_else(
                || {
                    last_snapshot
                        .as_ref()
                        .map(|snapshot| snapshot.normalized_path.clone())
                },
            ),
            current_normalized_path: Some(file.normalized_path.clone()),
            previous_snapshot: last_snapshot,
            current_snapshot,
            previous_content,
            current_content,
            expected_mutation: None,
            has_path_collision: has_path_collision(&materialized_files, file),
            encoding_issue: String::from_utf8(file.plaintext.clone()).is_err(),
        }));
    }

    for snapshot in last_projected {
        if !current_file_ids.contains(snapshot.file_id.as_str()) {
            let previous = materialized_files.get(&snapshot.file_id);
            candidates.push(classify_import_candidate(ImportCandidateInput {
                file_id: Some(snapshot.file_id.clone()),
                previous_normalized_path: previous
                    .map(|file| file.normalized_path.clone())
                    .or_else(|| Some(snapshot.normalized_path.clone())),
                current_normalized_path: None,
                previous_snapshot: Some(snapshot.clone()),
                current_snapshot: None,
                previous_content: previous.and_then(|file| file.content.clone()),
                current_content: None,
                expected_mutation: None,
                has_path_collision: false,
                encoding_issue: false,
            }));
        }
    }

    Ok(candidates)
}

pub(crate) fn apply_auto_import_candidates_to_core(
    core: &mut VaultCore,
    candidates: &[ImportCandidate],
    scanned: &[ScannedFile],
    generation: u64,
) -> SyncResult<usize> {
    let scanned_by_file_id = scanned
        .iter()
        .map(|file| (file.file_id.as_str(), file))
        .collect::<BTreeMap<_, _>>();
    let mut applied = 0;

    for candidate in candidates {
        match candidate {
            ImportCandidate::ExternalCreate {
                normalized_path,
                confidence,
                ..
            } if is_auto_import(confidence) => {
                let Some(file) = scanned
                    .iter()
                    .find(|file| file.normalized_path == *normalized_path)
                else {
                    continue;
                };
                let content = String::from_utf8(file.plaintext.clone()).map_err(|error| {
                    SyncError::InvalidArgument(format!(
                        "experimental automerge import only supports utf-8 markdown: {error}"
                    ))
                })?;
                core.create_markdown(FileCreate {
                    stable_file_id: file.file_id.clone(),
                    incarnation_id: format!("desktop-import-{generation}"),
                    display_path: file.path.clone(),
                    text_doc_id: format!("text:{}", file.file_id),
                    blob_ref: None,
                    content,
                })
                .map_err(map_sync_core_error)?;
                applied += 1;
            }
            ImportCandidate::ExternalModify {
                file_id,
                confidence,
                ..
            } if is_auto_import(confidence) => {
                let Some(file) = scanned_by_file_id.get(file_id.as_str()) else {
                    continue;
                };
                let content = String::from_utf8(file.plaintext.clone()).map_err(|error| {
                    SyncError::InvalidArgument(format!(
                        "experimental automerge import only supports utf-8 markdown: {error}"
                    ))
                })?;
                let materialized = core.materialize().map_err(map_sync_core_error)?;
                let Some(previous) = materialized.files.get(file_id) else {
                    continue;
                };
                core.edit_markdown(&previous.text_doc_id, content)
                    .map_err(map_sync_core_error)?;
                applied += 1;
            }
            ImportCandidate::ExternalRename {
                file_id,
                confidence,
                ..
            } if is_auto_import(confidence) => {
                let Some(file) = scanned_by_file_id.get(file_id.as_str()) else {
                    continue;
                };
                let content = String::from_utf8(file.plaintext.clone()).map_err(|error| {
                    SyncError::InvalidArgument(format!(
                        "experimental automerge import only supports utf-8 markdown: {error}"
                    ))
                })?;
                let materialized = core.materialize().map_err(map_sync_core_error)?;
                let Some(previous) = materialized.files.get(file_id) else {
                    continue;
                };
                let text_doc_id = previous.text_doc_id.clone();
                core.rename_file(file_id, file.path.clone())
                    .map_err(map_sync_core_error)?;
                core.edit_markdown(&text_doc_id, content)
                    .map_err(map_sync_core_error)?;
                applied += 1;
            }
            _ => {}
        }
    }

    Ok(applied)
}

pub(crate) fn import_disk_scan(
    core: &mut VaultCore,
    store: &mut impl LocalStore,
    scanned: &[ScannedFile],
    current_snapshots: &[ProjectedSnapshot],
    last_projected: &[ProjectedSnapshot],
    generation: u64,
    search: Option<&SearchState>,
) -> SyncResult<AutomergeImportSummary> {
    let materialized = core.materialize().map_err(map_sync_core_error)?;
    let materialized_files = materialized.files;
    let current_by_file_id = snapshots_by_file_id(current_snapshots);
    let last_by_file_id = snapshots_by_file_id(last_projected);
    let current_file_ids = scanned
        .iter()
        .map(|file| file.file_id.as_str())
        .collect::<BTreeSet<_>>();
    let mut summary = AutomergeImportSummary::default();

    for file in scanned {
        let Some(current_snapshot) = current_by_file_id.get(file.file_id.as_str()).copied() else {
            summary.review_required += 1;
            continue;
        };
        let Ok(current_content) = String::from_utf8(file.plaintext.clone()) else {
            summary.review_required += 1;
            continue;
        };
        let previous = materialized_files.get(&file.file_id);
        let previous_content = previous.and_then(|file| file.content.clone());
        let last_snapshot = last_by_file_id.get(file.file_id.as_str()).copied().cloned();

        if previous
            .and_then(|file| file.content.as_deref())
            .is_some_and(|content| content == current_content)
        {
            store
                .save_projected_snapshot(current_snapshot.clone())
                .map_err(map_sync_core_store_error)?;
            summary.unchanged += 1;
            continue;
        }

        let candidate = classify_import_candidate(ImportCandidateInput {
            file_id: Some(file.file_id.clone()),
            previous_normalized_path: previous.map(|file| file.normalized_path.clone()).or_else(
                || {
                    last_snapshot
                        .as_ref()
                        .map(|snapshot| snapshot.normalized_path.clone())
                },
            ),
            current_normalized_path: Some(file.normalized_path.clone()),
            previous_snapshot: last_snapshot.clone(),
            current_snapshot: Some(current_snapshot.clone()),
            previous_content,
            current_content: Some(current_content.clone()),
            expected_mutation: None,
            has_path_collision: has_path_collision(&materialized_files, file),
            encoding_issue: false,
        });

        match candidate {
            ImportCandidate::ExternalCreate { confidence, .. }
                if is_auto_import(&confidence) && previous.is_none() =>
            {
                core.create_markdown(FileCreate {
                    stable_file_id: file.file_id.clone(),
                    incarnation_id: format!("desktop-import-{generation}"),
                    display_path: file.path.clone(),
                    text_doc_id: format!("text:{}", file.file_id),
                    blob_ref: None,
                    content: current_content,
                })
                .map_err(map_sync_core_error)?;
                store
                    .save_projected_snapshot(current_snapshot.clone())
                    .map_err(map_sync_core_store_error)?;
                notify_written(search, &file.path)?;
                summary.imported_creates += 1;
            }
            ImportCandidate::ExternalModify { confidence, .. } if is_auto_import(&confidence) => {
                let Some(previous) = previous else {
                    summary.review_required += 1;
                    continue;
                };
                core.edit_markdown(&previous.text_doc_id, current_content)
                    .map_err(map_sync_core_error)?;
                store
                    .save_projected_snapshot(current_snapshot.clone())
                    .map_err(map_sync_core_store_error)?;
                notify_written(search, &file.path)?;
                summary.imported_modifies += 1;
            }
            ImportCandidate::ExternalRename { confidence, .. } if is_auto_import(&confidence) => {
                let Some(previous) = previous else {
                    summary.review_required += 1;
                    continue;
                };
                let text_doc_id = previous.text_doc_id.clone();
                core.rename_file(&file.file_id, file.path.clone())
                    .map_err(map_sync_core_error)?;
                core.edit_markdown(&text_doc_id, current_content)
                    .map_err(map_sync_core_error)?;
                store
                    .save_projected_snapshot(current_snapshot.clone())
                    .map_err(map_sync_core_store_error)?;
                notify_written(search, &file.path)?;
                summary.imported_renames += 1;
            }
            ImportCandidate::Unchanged { .. } => {
                store
                    .save_projected_snapshot(current_snapshot.clone())
                    .map_err(map_sync_core_store_error)?;
                summary.unchanged += 1;
            }
            _ => {
                summary.review_required += 1;
            }
        }
    }

    for snapshot in last_projected {
        if !current_file_ids.contains(snapshot.file_id.as_str()) {
            summary.review_required += 1;
        }
    }

    if summary.imported_any() {
        core.save_to_store(store)
            .map_err(map_sync_core_store_error)?;
    }

    Ok(summary)
}

fn snapshots_by_file_id(snapshots: &[ProjectedSnapshot]) -> BTreeMap<&str, &ProjectedSnapshot> {
    snapshots
        .iter()
        .map(|snapshot| (snapshot.file_id.as_str(), snapshot))
        .collect()
}

fn has_path_collision(
    materialized_files: &BTreeMap<String, kuku_sync_core::MaterializedFile>,
    scanned: &ScannedFile,
) -> bool {
    materialized_files.values().any(|file| {
        file.stable_file_id != scanned.file_id && file.normalized_path == scanned.normalized_path
    })
}

fn is_auto_import(confidence: &ImportConfidence) -> bool {
    matches!(confidence, ImportConfidence::AutoImport { .. })
}

fn notify_written(search: Option<&SearchState>, path: &str) -> SyncResult<()> {
    let Some(search) = search else {
        return Ok(());
    };
    search
        .notify_written_with_source(path, AUTOMERGE_IMPORT_SOURCE)
        .map_err(SyncError::Storage)
}

fn map_sync_core_error(error: kuku_sync_core::SyncCoreError) -> SyncError {
    SyncError::Storage(format!("experimental automerge import error: {error}"))
}

fn map_sync_core_store_error(error: kuku_sync_core::StoreError) -> SyncError {
    SyncError::Storage(format!(
        "experimental automerge import store error: {error}"
    ))
}

#[cfg(test)]
mod tests {
    use super::super::db::file_id_for_normalized_path;
    use super::*;
    use kuku_sync_core::MemoryLocalStore;

    #[test]
    fn small_external_modify_imports_to_core_and_snapshot() {
        let mut core = VaultCore::new(b"device").unwrap();
        let file_id = file_id_for_normalized_path("note.md");
        core.create_markdown(FileCreate {
            stable_file_id: file_id.clone(),
            incarnation_id: "inc-1".to_owned(),
            display_path: "note.md".to_owned(),
            text_doc_id: format!("text:{file_id}"),
            blob_ref: None,
            content: "alpha\nbeta\ngamma\n".to_owned(),
        })
        .unwrap();
        let mut store = MemoryLocalStore::new();
        let previous = snapshot(&file_id, "note.md", "alpha\nbeta\ngamma\n", 1);
        store.save_projected_snapshot(previous.clone()).unwrap();
        let scanned = scanned_file("note.md", "alpha\nbeta edited\ngamma\n");
        let current = snapshot(&file_id, "note.md", "alpha\nbeta edited\ngamma\n", 2);

        let summary = import_disk_scan(
            &mut core,
            &mut store,
            &[scanned],
            std::slice::from_ref(&current),
            &[previous],
            2,
            None,
        )
        .unwrap();

        assert_eq!(summary.imported_modifies, 1);
        assert_eq!(
            core.materialize()
                .unwrap()
                .files
                .get(&file_id)
                .unwrap()
                .content
                .as_deref(),
            Some("alpha\nbeta edited\ngamma\n")
        );
        assert_eq!(
            store
                .list_projected_snapshots()
                .unwrap()
                .first()
                .unwrap()
                .content_hash,
            current.content_hash
        );
    }

    #[test]
    fn large_external_rewrite_requires_review_without_core_change() {
        let mut core = VaultCore::new(b"device").unwrap();
        let file_id = file_id_for_normalized_path("note.md");
        core.create_markdown(FileCreate {
            stable_file_id: file_id.clone(),
            incarnation_id: "inc-1".to_owned(),
            display_path: "note.md".to_owned(),
            text_doc_id: format!("text:{file_id}"),
            blob_ref: None,
            content: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".to_owned(),
        })
        .unwrap();
        let mut store = MemoryLocalStore::new();
        let previous = snapshot(
            &file_id,
            "note.md",
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            1,
        );
        store.save_projected_snapshot(previous.clone()).unwrap();
        let scanned = scanned_file("note.md", "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
        let current = snapshot(
            &file_id,
            "note.md",
            "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            2,
        );

        let summary = import_disk_scan(
            &mut core,
            &mut store,
            &[scanned],
            &[current],
            &[previous],
            2,
            None,
        )
        .unwrap();

        assert_eq!(summary.review_required, 1);
        assert_eq!(
            core.materialize()
                .unwrap()
                .files
                .get(&file_id)
                .unwrap()
                .content
                .as_deref(),
            Some("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
        );
    }

    #[test]
    fn external_create_imports_new_markdown() {
        let mut core = VaultCore::new(b"device").unwrap();
        let mut store = MemoryLocalStore::new();
        let file_id = file_id_for_normalized_path("new.md");
        let scanned = scanned_file("new.md", "# New");
        let current = snapshot(&file_id, "new.md", "# New", 1);

        let summary = import_disk_scan(
            &mut core,
            &mut store,
            &[scanned],
            std::slice::from_ref(&current),
            &[],
            1,
            None,
        )
        .unwrap();

        assert_eq!(summary.imported_creates, 1);
        assert_eq!(
            core.materialize()
                .unwrap()
                .files
                .get(&file_id)
                .unwrap()
                .content
                .as_deref(),
            Some("# New")
        );
        assert_eq!(store.list_projected_snapshots().unwrap(), vec![current]);
    }

    fn scanned_file(path: &str, content: &str) -> ScannedFile {
        let normalized_path = path.to_ascii_lowercase();
        ScannedFile {
            file_id: file_id_for_normalized_path(&normalized_path),
            path: path.to_owned(),
            normalized_path,
            plaintext_hash: blake3::hash(content.as_bytes()).to_hex().to_string(),
            size_bytes: content.len() as i64,
            mtime_ms: 1,
            plaintext: content.as_bytes().to_vec(),
        }
    }

    fn snapshot(
        file_id: &str,
        normalized_path: &str,
        content: &str,
        generation: u64,
    ) -> ProjectedSnapshot {
        ProjectedSnapshot {
            file_id: file_id.to_owned(),
            normalized_path: normalized_path.to_owned(),
            content_hash: blake3::hash(content.as_bytes()).to_hex().to_string(),
            mtime_ms: generation as i64,
            size: content.len() as u64,
            projection_generation: generation,
        }
    }
}
