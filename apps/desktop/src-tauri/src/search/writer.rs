use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::mpsc::{self, Sender};
use std::time::{SystemTime, UNIX_EPOCH};

use parking_lot::Mutex;
use rusqlite::Connection;

use crate::models::{IndexerConfig, IndexerDebugStatus, IndexerStatus};
use crate::search::db::{
    IndexedChunkRow, IndexedDocument, IndexedWikilinkRow, StoredWikilinkRefRow,
    find_note_uid_by_doc_id, find_note_uid_by_doc_id_nocase, list_indexed_doc_ids,
    load_doc_identities, load_document_freshness, load_link_counts, load_wikilink_rows,
    open_connection, remove_document, replace_document, update_document_freshness,
    update_wikilink_resolution,
};
use crate::search::wikilink::{
    DocIndex, basename_from_normalized, normalize_link_target, resolve_wikilink,
};
use crate::search::{RebuildQueueState, is_markdown_path, to_relative_path};
use crate::vault::checksum::compute_checksum;
use crate::vault::should_ignore_path;

#[derive(Debug, Clone)]
pub enum WriterJob {
    FullRebuild {
        reason: String,
    },
    IndexFile {
        path: String,
        source: String,
    },
    RemoveFile {
        path: String,
        is_dir: bool,
        source: String,
    },
    RenameFile {
        old_path: String,
        new_path: String,
        is_dir: bool,
        source: String,
    },
    Shutdown,
}

#[derive(Debug, Default)]
struct ReResolutionPlan {
    source_note_uids: HashSet<i64>,
    normalized_targets: HashSet<String>,
    target_basenames: HashSet<String>,
    resolved_target_uids: HashSet<i64>,
}

pub fn start_writer_thread(
    vault_root: PathBuf,
    db_path: PathBuf,
    pending_index_paths: Arc<Mutex<HashSet<String>>>,
    status: Arc<Mutex<IndexerStatus>>,
    rebuild_state: Arc<Mutex<RebuildQueueState>>,
    debug_status: Arc<Mutex<IndexerDebugStatus>>,
    _config: Arc<Mutex<IndexerConfig>>,
) -> Sender<WriterJob> {
    let (job_tx, job_rx) = mpsc::channel::<WriterJob>();
    let loop_tx = job_tx.clone();

    std::thread::spawn(move || {
        let mut conn = match open_connection(&db_path) {
            Ok(conn) => conn,
            Err(error) => {
                let mut guard = status.lock();
                guard.state = "error".to_string();
                guard.error = Some(error);
                return;
            }
        };

        while let Ok(job) = job_rx.recv() {
            if matches!(job, WriterJob::Shutdown) {
                break;
            }

            let is_full_rebuild = matches!(&job, WriterJob::FullRebuild { .. });
            let result = match job {
                WriterJob::FullRebuild { reason } => handle_full_rebuild(
                    &mut conn,
                    &vault_root,
                    &status,
                    &rebuild_state,
                    &debug_status,
                    &loop_tx,
                    &reason,
                ),
                WriterJob::IndexFile { path, source } => {
                    pending_index_paths.lock().remove(&path);
                    handle_index_file(
                        &mut conn,
                        &vault_root,
                        &path,
                        &source,
                        &status,
                        &debug_status,
                    )
                }
                WriterJob::RemoveFile {
                    path,
                    is_dir,
                    source,
                } => handle_remove_file(
                    &mut conn,
                    &path,
                    is_dir,
                    &source,
                    &status,
                    &rebuild_state,
                    &debug_status,
                    &loop_tx,
                ),
                WriterJob::RenameFile {
                    old_path,
                    new_path,
                    is_dir,
                    source,
                } => handle_rename_file(
                    &mut conn,
                    &vault_root,
                    &old_path,
                    &new_path,
                    is_dir,
                    &source,
                    &status,
                    &rebuild_state,
                    &debug_status,
                    &loop_tx,
                ),
                WriterJob::Shutdown => Ok(()),
            };

            if let Err(error) = result {
                if is_full_rebuild {
                    reset_rebuild_state_after_error(&rebuild_state);
                }
                let mut guard = status.lock();
                guard.state = "error".to_string();
                guard.error = Some(error);
            }
        }
    });

    job_tx
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

fn set_indexing_status(status: &Arc<Mutex<IndexerStatus>>, total_docs: usize, indexed_docs: usize) {
    let mut guard = status.lock();
    guard.state = "indexing".to_string();
    guard.total_docs = total_docs;
    guard.indexed_docs = indexed_docs;
    guard.error = None;
}

fn set_idle_status(
    status: &Arc<Mutex<IndexerStatus>>,
    total_docs: usize,
    resolved_links: usize,
    unresolved_links: usize,
    ambiguous_links: usize,
) {
    let mut guard = status.lock();
    guard.state = "idle".to_string();
    guard.total_docs = total_docs;
    guard.indexed_docs = total_docs;
    guard.last_indexed_at = Some(now_ms());
    guard.resolved_links = resolved_links;
    guard.unresolved_links = unresolved_links;
    guard.ambiguous_links = ambiguous_links;
    guard.error = None;
}

fn status_progress(status: &Arc<Mutex<IndexerStatus>>) -> (usize, usize) {
    let guard = status.lock();
    (guard.total_docs, guard.indexed_docs)
}

fn reset_rebuild_state_after_error(rebuild_state: &Arc<Mutex<RebuildQueueState>>) {
    let mut guard = rebuild_state.lock();
    guard.queued = false;
    guard.running = false;
    guard.rerun = false;
}

fn record_last_job(
    debug_status: &Arc<Mutex<IndexerDebugStatus>>,
    kind: &str,
    path: Option<&str>,
    source: &str,
) {
    let mut guard = debug_status.lock();
    guard.last_job_kind = Some(kind.to_string());
    guard.last_job_path = path.map(ToString::to_string);
    guard.last_job_source = Some(source.to_string());
}

fn refresh_document_freshness_only(
    conn: &mut Connection,
    doc: &IndexedDocument,
) -> Result<(), String> {
    let tx = conn
        .transaction()
        .map_err(|e| format!("Failed to open freshness refresh transaction: {e}"))?;
    update_document_freshness(&tx, &doc.doc_id, doc.mtime_ms, &doc.content_checksum)?;
    tx.commit()
        .map_err(|e| format!("Failed to commit freshness refresh transaction: {e}"))?;
    Ok(())
}

fn collect_markdown_files(dir: &Path, root: &Path, out: &mut Vec<String>) -> Result<(), String> {
    let entries = fs::read_dir(dir).map_err(|e| format!("Failed to read vault directory: {e}"))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("Failed to read vault entry: {e}"))?;
        let path = entry.path();
        let rel = path
            .strip_prefix(root)
            .map_err(|e| format!("Failed to strip root prefix: {e}"))?;
        if should_ignore_path(rel) {
            continue;
        }
        if path.is_dir() {
            collect_markdown_files(&path, root, out)?;
            continue;
        }

        let rel_string = to_relative_path(root, &path);
        if is_markdown_path(&rel_string) {
            out.push(rel_string);
        }
    }
    Ok(())
}

fn mtime_ms(path: &Path) -> i64 {
    fs::metadata(path)
        .ok()
        .and_then(|meta| meta.modified().ok())
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or_else(now_ms)
}

fn build_document(
    conn: &Connection,
    root: &Path,
    rel_path: &str,
) -> Result<Option<IndexedDocument>, String> {
    if !is_markdown_path(rel_path) {
        return Ok(None);
    }

    let absolute = root.join(rel_path);
    if !absolute.exists() {
        return Ok(None);
    }

    let markdown =
        fs::read_to_string(&absolute).map_err(|e| format!("Failed to read markdown file: {e}"))?;
    let content_checksum = compute_checksum(&markdown);
    let extracted = kuku_indexer::extract_document(&markdown);
    let meta_json = serde_json::to_string(
        &extracted
            .frontmatter
            .iter()
            .map(|entry| (entry.key.clone(), entry.value.clone()))
            .collect::<std::collections::BTreeMap<_, _>>(),
    )
    .map_err(|e| format!("Failed to serialize frontmatter: {e}"))?;

    let mut chunks = Vec::new();
    for section in extracted.sections {
        let section_path_json = serde_json::to_string(&section.path)
            .map_err(|e| format!("Failed to encode section path: {e}"))?;
        for chunk in section.chunks {
            chunks.push(IndexedChunkRow {
                section_path_json: section_path_json.clone(),
                kind: chunk.kind.as_str().to_string(),
                text: chunk.text,
                raw_text: chunk.raw_text,
                global_start: chunk.global_start as i64,
                global_end: chunk.global_end as i64,
            });
        }
    }

    let wikilink_refs = extracted
        .wikilinks
        .into_iter()
        .map(|link| {
            let normalized_target = normalize_link_target(&link.target);
            IndexedWikilinkRow {
                raw_target: link.target,
                alias: link.alias,
                target_basename: basename_from_normalized(&normalized_target),
                normalized_target,
                ordinal: link.ordinal as i64,
            }
        })
        .collect::<Vec<_>>();

    Ok(Some(IndexedDocument {
        note_uid: find_note_uid_by_doc_id(conn, rel_path)?
            .or(find_note_uid_by_doc_id_nocase(conn, rel_path)?),
        doc_id: rel_path.to_string(),
        title: extracted.title,
        mtime_ms: mtime_ms(&absolute),
        content_checksum,
        meta_json,
        chunks,
        wikilink_refs,
    }))
}

fn handle_full_rebuild(
    conn: &mut Connection,
    vault_root: &Path,
    status: &Arc<Mutex<IndexerStatus>>,
    rebuild_state: &Arc<Mutex<RebuildQueueState>>,
    debug_status: &Arc<Mutex<IndexerDebugStatus>>,
    loop_tx: &Sender<WriterJob>,
    reason: &str,
) -> Result<(), String> {
    {
        let mut guard = rebuild_state.lock();
        guard.queued = false;
        guard.running = true;
    }
    {
        let mut guard = debug_status.lock();
        guard.queued_rebuild_reason = None;
        guard.last_rebuild_reason = Some(reason.to_string());
    }

    let mut files = Vec::new();
    collect_markdown_files(vault_root, vault_root, &mut files)?;
    files.sort();

    set_indexing_status(status, files.len(), 0);

    for (batch_idx, batch) in files.chunks(50).enumerate() {
        let mut docs = Vec::new();
        for rel_path in batch {
            if let Some(doc) = build_document(conn, vault_root, rel_path)? {
                docs.push(doc);
            }
        }

        let tx = conn
            .transaction()
            .map_err(|e| format!("Failed to open rebuild transaction: {e}"))?;
        for doc in &docs {
            replace_document(&tx, doc)?;
        }
        tx.commit()
            .map_err(|e| format!("Failed to commit rebuild batch: {e}"))?;

        set_indexing_status(
            status,
            files.len(),
            usize::min((batch_idx + 1) * 50, files.len()),
        );
    }

    let current_doc_ids: HashSet<String> = files.iter().cloned().collect();
    let indexed_doc_ids = list_indexed_doc_ids(conn)?;
    let stale_doc_ids = indexed_doc_ids
        .into_iter()
        .filter(|doc_id| !current_doc_ids.contains(doc_id))
        .collect::<Vec<_>>();

    if !stale_doc_ids.is_empty() {
        let tx = conn
            .transaction()
            .map_err(|e| format!("Failed to open stale cleanup transaction: {e}"))?;
        for doc_id in stale_doc_ids {
            remove_document(&tx, &doc_id)?;
        }
        tx.commit()
            .map_err(|e| format!("Failed to commit stale cleanup transaction: {e}"))?;
    }

    resolve_all_wikilinks(conn)?;
    refresh_idle_status(conn, status)?;
    record_last_job(debug_status, "full-rebuild", None, reason);

    let should_rerun = {
        let mut guard = rebuild_state.lock();
        guard.running = false;
        if guard.rerun {
            guard.rerun = false;
            guard.queued = true;
            true
        } else {
            false
        }
    };

    if should_rerun {
        let _ = loop_tx.send(WriterJob::FullRebuild {
            reason: "rebuild-rerun".to_string(),
        });
    }

    Ok(())
}

fn handle_index_file(
    conn: &mut Connection,
    vault_root: &Path,
    path: &str,
    source: &str,
    status: &Arc<Mutex<IndexerStatus>>,
    debug_status: &Arc<Mutex<IndexerDebugStatus>>,
) -> Result<(), String> {
    if !is_markdown_path(path) {
        return Ok(());
    }

    let (total_docs, indexed_docs) = status_progress(status);
    set_indexing_status(status, total_docs, indexed_docs);

    let mut plan = ReResolutionPlan::default();
    let maybe_doc = build_document(conn, vault_root, path)?;
    if let Some(doc) = maybe_doc.as_ref() {
        if let Some(stored) = load_document_freshness(conn, path)?
            && stored.content_checksum.as_deref() == Some(doc.content_checksum.as_str())
        {
            refresh_document_freshness_only(conn, doc)?;
            refresh_idle_status(conn, status)?;
            record_last_job(debug_status, "index-file-skip", Some(path), source);
            return Ok(());
        }
    }

    let tx = conn
        .transaction()
        .map_err(|e| format!("Failed to open index transaction: {e}"))?;
    match maybe_doc {
        Some(doc) => {
            let normalized = normalize_link_target(path);
            let basename = basename_from_normalized(&normalized);
            let note_uid = replace_document(&tx, &doc)?;
            plan.source_note_uids.insert(note_uid);
            plan.normalized_targets.insert(normalized);
            plan.target_basenames.insert(basename);
        }
        None => {
            if let Some(note_uid) = remove_document(&tx, path)? {
                let normalized = normalize_link_target(path);
                let basename = basename_from_normalized(&normalized);
                plan.normalized_targets.insert(normalized);
                plan.target_basenames.insert(basename);
                plan.resolved_target_uids.insert(note_uid);
            }
        }
    }
    tx.commit()
        .map_err(|e| format!("Failed to commit index transaction: {e}"))?;

    rereresolve_wikilinks(conn, &plan)?;
    refresh_idle_status(conn, status)?;
    record_last_job(debug_status, "index-file", Some(path), source);
    Ok(())
}

fn handle_remove_file(
    conn: &mut Connection,
    path: &str,
    is_dir: bool,
    source: &str,
    status: &Arc<Mutex<IndexerStatus>>,
    rebuild_state: &Arc<Mutex<RebuildQueueState>>,
    debug_status: &Arc<Mutex<IndexerDebugStatus>>,
    loop_tx: &Sender<WriterJob>,
) -> Result<(), String> {
    if is_dir {
        queue_rebuild(rebuild_state, loop_tx, debug_status, "directory-mutation");
        return Ok(());
    }

    if !is_markdown_path(path) {
        return Ok(());
    }

    let mut plan = ReResolutionPlan::default();
    let normalized = normalize_link_target(path);
    let basename = basename_from_normalized(&normalized);

    let tx = conn
        .transaction()
        .map_err(|e| format!("Failed to open remove transaction: {e}"))?;
    if let Some(note_uid) = remove_document(&tx, path)? {
        plan.resolved_target_uids.insert(note_uid);
    }
    tx.commit()
        .map_err(|e| format!("Failed to commit remove transaction: {e}"))?;

    plan.normalized_targets.insert(normalized);
    plan.target_basenames.insert(basename);
    rereresolve_wikilinks(conn, &plan)?;
    refresh_idle_status(conn, status)?;
    record_last_job(debug_status, "remove-file", Some(path), source);
    Ok(())
}

fn handle_rename_file(
    conn: &mut Connection,
    vault_root: &Path,
    old_path: &str,
    new_path: &str,
    is_dir: bool,
    source: &str,
    status: &Arc<Mutex<IndexerStatus>>,
    rebuild_state: &Arc<Mutex<RebuildQueueState>>,
    debug_status: &Arc<Mutex<IndexerDebugStatus>>,
    loop_tx: &Sender<WriterJob>,
) -> Result<(), String> {
    if is_dir {
        queue_rebuild(rebuild_state, loop_tx, debug_status, "directory-mutation");
        return Ok(());
    }

    let mut plan = ReResolutionPlan::default();
    let old_uid = find_note_uid_by_doc_id(conn, old_path)?;
    let old_normalized = normalize_link_target(old_path);
    let old_basename = basename_from_normalized(&old_normalized);
    let new_normalized = normalize_link_target(new_path);
    let new_basename = basename_from_normalized(&new_normalized);
    let maybe_new_doc = if is_markdown_path(new_path) {
        build_document(conn, vault_root, new_path)?
    } else {
        None
    };

    let tx = conn
        .transaction()
        .map_err(|e| format!("Failed to open rename transaction: {e}"))?;
    let preserved_uid = old_uid;
    if is_markdown_path(old_path) {
        remove_document(&tx, old_path)?;
    }
    if let Some(mut doc) = maybe_new_doc {
        doc.note_uid = preserved_uid;
        let note_uid = replace_document(&tx, &doc)?;
        plan.source_note_uids.insert(note_uid);
        plan.resolved_target_uids.insert(note_uid);
    }
    tx.commit()
        .map_err(|e| format!("Failed to commit rename transaction: {e}"))?;

    plan.normalized_targets.insert(old_normalized);
    plan.normalized_targets.insert(new_normalized);
    plan.target_basenames.insert(old_basename);
    plan.target_basenames.insert(new_basename);
    if let Some(old_uid) = old_uid {
        plan.resolved_target_uids.insert(old_uid);
    }
    rereresolve_wikilinks(conn, &plan)?;
    refresh_idle_status(conn, status)?;
    record_last_job(debug_status, "rename-file", Some(new_path), source);
    Ok(())
}

fn resolve_all_wikilinks(conn: &mut Connection) -> Result<(), String> {
    let docs = load_doc_identities(conn)?;
    let refs = load_wikilink_rows(conn)?;
    let index = DocIndex::new(&docs);

    let tx = conn
        .transaction()
        .map_err(|e| format!("Failed to open resolve-all transaction: {e}"))?;
    for row in refs {
        let resolution = resolve_wikilink(&row.source_doc_id, &row.raw_target, &index);
        update_wikilink_resolution(&tx, row.rowid, &resolution)?;
    }
    tx.commit()
        .map_err(|e| format!("Failed to commit resolve-all transaction: {e}"))?;
    Ok(())
}

fn rereresolve_wikilinks(conn: &mut Connection, plan: &ReResolutionPlan) -> Result<(), String> {
    if plan.source_note_uids.is_empty()
        && plan.normalized_targets.is_empty()
        && plan.target_basenames.is_empty()
        && plan.resolved_target_uids.is_empty()
    {
        return Ok(());
    }

    let docs = load_doc_identities(conn)?;
    let refs = load_wikilink_rows(conn)?;
    let index = DocIndex::new(&docs);

    let tx = conn
        .transaction()
        .map_err(|e| format!("Failed to open selective resolve transaction: {e}"))?;
    for row in refs.iter().filter(|row| should_reresolve_row(row, plan)) {
        let resolution = resolve_wikilink(&row.source_doc_id, &row.raw_target, &index);
        update_wikilink_resolution(&tx, row.rowid, &resolution)?;
    }
    tx.commit()
        .map_err(|e| format!("Failed to commit selective resolve transaction: {e}"))?;
    Ok(())
}

fn should_reresolve_row(row: &StoredWikilinkRefRow, plan: &ReResolutionPlan) -> bool {
    plan.source_note_uids.contains(&row.source_note_uid)
        || plan.normalized_targets.contains(&row.normalized_target)
        || plan.target_basenames.contains(&row.target_basename)
        || row
            .resolved_target_uid
            .is_some_and(|target_uid| plan.resolved_target_uids.contains(&target_uid))
}

fn refresh_idle_status(
    conn: &Connection,
    status: &Arc<Mutex<IndexerStatus>>,
) -> Result<(), String> {
    let total = list_indexed_doc_ids(conn)?.len();
    let (resolved, unresolved, ambiguous) = load_link_counts(conn)?;
    set_idle_status(status, total, resolved, unresolved, ambiguous);
    Ok(())
}

pub fn queue_rebuild(
    rebuild_state: &Arc<Mutex<RebuildQueueState>>,
    job_tx: &Sender<WriterJob>,
    debug_status: &Arc<Mutex<IndexerDebugStatus>>,
    reason: &str,
) {
    let should_send = {
        let mut guard = rebuild_state.lock();
        if guard.running {
            guard.rerun = true;
            let mut debug = debug_status.lock();
            debug.coalesced_rebuild_count += 1;
            debug.queued_rebuild_reason = Some(reason.to_string());
            false
        } else if guard.queued {
            let mut debug = debug_status.lock();
            debug.coalesced_rebuild_count += 1;
            debug.queued_rebuild_reason = Some(reason.to_string());
            false
        } else {
            guard.queued = true;
            debug_status.lock().queued_rebuild_reason = Some(reason.to_string());
            true
        }
    };

    if should_send {
        let _ = job_tx.send(WriterJob::FullRebuild {
            reason: reason.to_string(),
        });
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::thread;
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    use super::*;

    static TEST_COUNTER: AtomicU64 = AtomicU64::new(0);

    fn unique_path(prefix: &str) -> PathBuf {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let suffix = TEST_COUNTER.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!("{prefix}-{now}-{suffix}"))
    }

    #[test]
    fn failed_rebuild_does_not_leave_queue_stuck() {
        let missing_root = unique_path("kuku-missing-root");
        let db_path = unique_path("kuku-search-db").with_extension("sqlite3");
        let status = Arc::new(Mutex::new(IndexerStatus::default()));
        let rebuild_state = Arc::new(Mutex::new(RebuildQueueState::default()));
        let debug_status = Arc::new(Mutex::new(IndexerDebugStatus::default()));
        let job_tx = start_writer_thread(
            missing_root,
            db_path,
            Arc::new(Mutex::new(HashSet::new())),
            status.clone(),
            rebuild_state.clone(),
            debug_status.clone(),
            Arc::new(Mutex::new(IndexerConfig::default())),
        );

        queue_rebuild(&rebuild_state, &job_tx, &debug_status, "manual-rebuild");

        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        while std::time::Instant::now() < deadline {
            if status.lock().state == "error" {
                break;
            }
            thread::sleep(Duration::from_millis(20));
        }

        assert_eq!(status.lock().state, "error");
        let guard = rebuild_state.lock();
        assert!(!guard.running);
        assert!(!guard.queued);
        assert!(!guard.rerun);

        let _ = job_tx.send(WriterJob::Shutdown);
    }

    #[test]
    fn index_file_job_completes_for_new_file() {
        let root = unique_path("kuku-index-root");
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("note.md"), "# Title\nhello [[world]]").unwrap();

        let db_path = unique_path("kuku-index-db").with_extension("sqlite3");
        let status = Arc::new(Mutex::new(IndexerStatus::default()));
        let rebuild_state = Arc::new(Mutex::new(RebuildQueueState::default()));
        let debug_status = Arc::new(Mutex::new(IndexerDebugStatus::default()));
        let job_tx = start_writer_thread(
            root.clone(),
            db_path,
            Arc::new(Mutex::new(HashSet::new())),
            status.clone(),
            rebuild_state,
            debug_status,
            Arc::new(Mutex::new(IndexerConfig::default())),
        );

        job_tx
            .send(WriterJob::IndexFile {
                path: "note.md".to_string(),
                source: "test".to_string(),
            })
            .unwrap();

        let deadline = std::time::Instant::now() + Duration::from_secs(2);
        while std::time::Instant::now() < deadline {
            let current = status.lock().clone();
            if current.state == "idle" && current.total_docs == 1 {
                break;
            }
            thread::sleep(Duration::from_millis(20));
        }

        let current = status.lock().clone();
        assert_eq!(current.state, "idle");
        assert_eq!(current.total_docs, 1);
        assert_eq!(current.indexed_docs, 1);

        let _ = job_tx.send(WriterJob::Shutdown);
    }

    #[test]
    fn index_file_reuses_note_uid_for_case_only_path_change() {
        let root = unique_path("kuku-index-root");
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("BAse.md"), "# Old\nhello [[Target]]").unwrap();

        let db_path = unique_path("kuku-index-db").with_extension("sqlite3");
        let mut conn = open_connection(&db_path).unwrap();
        let status = Arc::new(Mutex::new(IndexerStatus::default()));
        let debug_status = Arc::new(Mutex::new(IndexerDebugStatus::default()));

        handle_index_file(&mut conn, &root, "BAse.md", "test", &status, &debug_status).unwrap();
        let old_uid = find_note_uid_by_doc_id(&conn, "BAse.md").unwrap().unwrap();

        fs::rename(root.join("BAse.md"), root.join("Base.md")).unwrap();
        handle_index_file(&mut conn, &root, "Base.md", "test", &status, &debug_status).unwrap();

        assert_eq!(list_indexed_doc_ids(&conn).unwrap(), vec!["Base.md"]);
        assert_eq!(
            find_note_uid_by_doc_id(&conn, "Base.md").unwrap(),
            Some(old_uid)
        );
        assert_eq!(find_note_uid_by_doc_id(&conn, "BAse.md").unwrap(), None);
    }

    #[test]
    fn index_file_skip_refreshes_mtime_when_checksum_matches() {
        let root = unique_path("kuku-index-root");
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("note.md"), "# Title\nhello").unwrap();

        let db_path = unique_path("kuku-index-db").with_extension("sqlite3");
        let mut conn = open_connection(&db_path).unwrap();
        let status = Arc::new(Mutex::new(IndexerStatus::default()));
        let debug_status = Arc::new(Mutex::new(IndexerDebugStatus::default()));

        handle_index_file(&mut conn, &root, "note.md", "test", &status, &debug_status).unwrap();
        let first = load_document_freshness(&conn, "note.md").unwrap().unwrap();

        thread::sleep(Duration::from_millis(20));
        let content = fs::read_to_string(root.join("note.md")).unwrap();
        fs::write(root.join("note.md"), content).unwrap();

        handle_index_file(
            &mut conn,
            &root,
            "note.md",
            "load-stale-reconcile",
            &status,
            &debug_status,
        )
        .unwrap();

        let refreshed = load_document_freshness(&conn, "note.md").unwrap().unwrap();
        assert_eq!(refreshed.content_checksum, first.content_checksum);
        assert!(refreshed.mtime_ms >= first.mtime_ms);

        let debug = debug_status.lock().clone();
        assert_eq!(debug.last_job_kind.as_deref(), Some("index-file-skip"));
        assert_eq!(
            debug.last_job_source.as_deref(),
            Some("load-stale-reconcile")
        );
    }
}
