use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::mpsc::Sender;

use blake3::Hash;
use kuku_indexer::{
    QueryRoute, build_fts_query, build_snippet, build_snippet_for_range, plan_simple_query,
};
use parking_lot::Mutex;
use regex::RegexBuilder;

use crate::models::{
    AdvancedQueryRequest, FileChangeEvent, GraphLinkDto, GraphNodeDto, GraphSnapshot,
    IndexerConfig, IndexerStatus, IndexerStorageLocation, ResolveWikilinkResult,
    SimpleSearchResult,
};

pub mod commands;
mod db;
mod wikilink;
mod writer;

use db::{
    load_doc_identities, load_wikilink_rows, open_connection, query_body_hits, query_metadata_hits,
    visit_advanced_body_rows, visit_advanced_title_rows,
};
use wikilink::{DocIndex, RESOLUTION_AMBIGUOUS, doc_display_name, folder_label, resolve_wikilink};
use writer::{WriterJob, queue_rebuild, start_writer_thread};

#[derive(Debug, Default)]
pub struct RebuildQueueState {
    pub queued: bool,
    pub running: bool,
    pub rerun: bool,
}

#[derive(Clone)]
pub struct SearchState {
    inner: Arc<Mutex<SearchManager>>,
}

struct SearchManager {
    runtime: Option<SearchRuntime>,
    config: IndexerConfig,
}

struct SearchRuntime {
    vault_root: PathBuf,
    db_path: PathBuf,
    job_tx: Sender<WriterJob>,
    status: Arc<Mutex<IndexerStatus>>,
    rebuild_state: Arc<Mutex<RebuildQueueState>>,
    config: Arc<Mutex<IndexerConfig>>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ConfigChangeEffect {
    Noop,
    RuntimeOnly,
    Rebuild,
    RestartAndRebuild,
}

fn config_change_effect(previous: &IndexerConfig, next: &IndexerConfig) -> ConfigChangeEffect {
    if previous == next {
        return ConfigChangeEffect::Noop;
    }

    if previous.storage_location != next.storage_location {
        return ConfigChangeEffect::RestartAndRebuild;
    }

    if previous.resolution_policy != next.resolution_policy {
        return ConfigChangeEffect::Rebuild;
    }

    ConfigChangeEffect::RuntimeOnly
}

impl SearchState {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(SearchManager {
                runtime: None,
                config: IndexerConfig::default(),
            })),
        }
    }

    pub fn switch_vault(&self, vault_root: PathBuf) -> Result<(), String> {
        self.switch_vault_internal(vault_root, true)
    }

    fn switch_vault_internal(
        &self,
        vault_root: PathBuf,
        request_reindex_on_open: bool,
    ) -> Result<(), String> {
        let canonical_root = fs::canonicalize(&vault_root)
            .map_err(|e| format!("Failed to canonicalize vault root: {e}"))?;
        let config = self.get_config();
        let db_path = search_db_path(&canonical_root, &config.storage_location)?;
        if let Some(parent) = db_path.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create search directory: {e}"))?;
        }

        let status = Arc::new(Mutex::new(IndexerStatus::default()));
        let rebuild_state = Arc::new(Mutex::new(RebuildQueueState::default()));
        let runtime_config = Arc::new(Mutex::new(config.clone()));
        let job_tx = start_writer_thread(
            canonical_root.clone(),
            db_path.clone(),
            status.clone(),
            rebuild_state.clone(),
            runtime_config.clone(),
        );
        let runtime = SearchRuntime {
            vault_root: canonical_root,
            db_path,
            job_tx,
            status,
            rebuild_state,
            config: runtime_config,
        };

        let mut manager = self.inner.lock();
        if let Some(existing) = manager.runtime.take() {
            let _ = existing.job_tx.send(WriterJob::Shutdown);
        }
        manager.runtime = Some(runtime);
        drop(manager);

        if request_reindex_on_open && config.reindex_on_vault_open {
            self.request_rebuild()?;
        }

        Ok(())
    }

    pub fn close_runtime(&self) -> Result<(), String> {
        let mut manager = self.inner.lock();
        if let Some(runtime) = manager.runtime.take() {
            let _ = runtime.job_tx.send(WriterJob::Shutdown);
        }
        Ok(())
    }

    pub fn get_status(&self) -> IndexerStatus {
        self.with_runtime(|runtime| runtime.status.lock().clone())
            .unwrap_or_default()
    }

    pub fn get_config(&self) -> IndexerConfig {
        let manager = self.inner.lock();
        manager.config.clone()
    }

    pub fn set_config(&self, config: IndexerConfig) -> Result<(), String> {
        let (effect, restart_vault_root) = {
            let mut manager = self.inner.lock();
            let effect = config_change_effect(&manager.config, &config);
            if effect == ConfigChangeEffect::Noop {
                return Ok(());
            }

            manager.config = config.clone();
            let restart_vault_root = if let Some(runtime) = manager.runtime.as_ref() {
                match effect {
                    ConfigChangeEffect::RestartAndRebuild => Some(runtime.vault_root.clone()),
                    ConfigChangeEffect::RuntimeOnly | ConfigChangeEffect::Rebuild => {
                        *runtime.config.lock() = config.clone();
                        None
                    }
                    ConfigChangeEffect::Noop => None,
                }
            } else {
                None
            };
            (effect, restart_vault_root)
        };

        if let Some(vault_root) = restart_vault_root {
            self.switch_vault_internal(vault_root, false)?;
        }

        if matches!(
            effect,
            ConfigChangeEffect::Rebuild | ConfigChangeEffect::RestartAndRebuild
        ) {
            self.request_rebuild()?;
        }

        Ok(())
    }

    pub fn request_rebuild(&self) -> Result<(), String> {
        {
            let manager = self.inner.lock();
            let Some(runtime) = manager.runtime.as_ref() else {
                return Ok(());
            };
            queue_rebuild(&runtime.rebuild_state, &runtime.job_tx);
        }
        Ok(())
    }

    pub fn notify_written(&self, path: &str) -> Result<(), String> {
        self.with_runtime_result(|runtime| {
            if !is_markdown_path(path) {
                return Ok(());
            }
            if !runtime.config.lock().incremental_updates {
                queue_rebuild(&runtime.rebuild_state, &runtime.job_tx);
                return Ok(());
            }
            runtime
                .job_tx
                .send(WriterJob::IndexFile {
                    path: path.to_string(),
                })
                .map_err(|e| format!("Failed to enqueue index job: {e}"))?;
            Ok(())
        })
    }

    pub fn notify_removed(&self, path: &str, is_dir: bool) -> Result<(), String> {
        self.with_runtime_result(|runtime| {
            if !runtime.config.lock().incremental_updates {
                queue_rebuild(&runtime.rebuild_state, &runtime.job_tx);
                return Ok(());
            }
            runtime
                .job_tx
                .send(WriterJob::RemoveFile {
                    path: path.to_string(),
                    is_dir,
                })
                .map_err(|e| format!("Failed to enqueue remove job: {e}"))?;
            Ok(())
        })
    }

    pub fn notify_renamed(
        &self,
        old_path: &str,
        new_path: &str,
        is_dir: bool,
    ) -> Result<(), String> {
        self.with_runtime_result(|runtime| {
            if !runtime.config.lock().incremental_updates {
                queue_rebuild(&runtime.rebuild_state, &runtime.job_tx);
                return Ok(());
            }
            runtime
                .job_tx
                .send(WriterJob::RenameFile {
                    old_path: old_path.to_string(),
                    new_path: new_path.to_string(),
                    is_dir,
                })
                .map_err(|e| format!("Failed to enqueue rename job: {e}"))?;
            Ok(())
        })
    }

    pub fn handle_watcher_event(&self, event: &FileChangeEvent) -> Result<(), String> {
        match event.kind.as_str() {
            "create" | "modify" => self.notify_written(&event.path),
            "delete" => self.notify_removed(&event.path, event.is_dir),
            "rename" => self.notify_renamed(
                event.old_path.as_deref().unwrap_or_default(),
                &event.path,
                event.is_dir,
            ),
            _ => Ok(()),
        }
    }

    pub fn query_simple(
        &self,
        query: &str,
        max_results: usize,
    ) -> Result<SimpleSearchResult, String> {
        let plan = plan_simple_query(query);
        if plan.route == QueryRoute::None {
            return Ok(SimpleSearchResult {
                query: plan.original_query,
                total: 0,
                items: Vec::new(),
            });
        }

        let runtime = match self.runtime_snapshot() {
            Some(runtime) => runtime,
            None => {
                return Ok(SimpleSearchResult {
                    query: plan.original_query,
                    total: 0,
                    items: Vec::new(),
                });
            }
        };

        let conn = open_connection(&runtime.db_path)?;
        let mut hits = query_metadata_hits(&conn, &plan.normalized_query, max_results)?;

        if let Some(fts_query) = build_fts_query(&plan) {
            hits.extend(query_body_hits(&conn, &fts_query, max_results, |raw| {
                build_snippet(raw, &plan.original_query)
            })?);
        }

        let mut dedup = HashSet::new();
        hits.retain(|hit| {
            dedup.insert((
                hit.doc_id.clone(),
                hit.section_path.clone(),
                hit.section_ordinal,
                hit.kind.clone(),
                hit.snippet.clone(),
            ))
        });
        hits.sort_by(|left, right| {
            right
                .score
                .partial_cmp(&left.score)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| left.doc_id.cmp(&right.doc_id))
        });
        hits.truncate(max_results);

        Ok(SimpleSearchResult {
            query: plan.original_query,
            total: hits.len(),
            items: hits,
        })
    }

    pub fn query_advanced(
        &self,
        request: &AdvancedQueryRequest,
    ) -> Result<SimpleSearchResult, String> {
        let query = request.query.trim().to_string();
        if query.is_empty() {
            return Ok(SimpleSearchResult {
                query,
                total: 0,
                items: Vec::new(),
            });
        }

        let runtime = match self.runtime_snapshot() {
            Some(runtime) => runtime,
            None => {
                return Ok(SimpleSearchResult {
                    query,
                    total: 0,
                    items: Vec::new(),
                });
            }
        };

        let regex = RegexBuilder::new(&query)
            .case_insensitive(!request.case_sensitive)
            .build()
            .map_err(|error| format!("Invalid regex: {error}"))?;
        let max_results = request.max_results.unwrap_or(20);
        if max_results == 0 {
            return Ok(SimpleSearchResult {
                query,
                total: 0,
                items: Vec::new(),
            });
        }

        let conn = open_connection(&runtime.db_path)?;
        let mut hits = Vec::new();
        visit_advanced_title_rows(&conn, |row| {
            if regex.is_match(&row.title) {
                hits.push(crate::models::SimpleSearchHit {
                    doc_id: row.doc_id,
                    title: Some(row.title.clone()),
                    section_path: Vec::new(),
                    section_ordinal: 0,
                    snippet: row.title,
                    kind: "Title".to_string(),
                    score: 1.0,
                });
            }
            Ok(hits.len() < max_results)
        })?;

        if hits.len() < max_results {
            visit_advanced_body_rows(&conn, |row| {
                let trimmed = row.raw_text.trim();
                let Some(found) = regex.find(trimmed) else {
                    return Ok(true);
                };
                hits.push(crate::models::SimpleSearchHit {
                    doc_id: row.doc_id,
                    title: row.title,
                    section_path: row.section_path,
                    section_ordinal: row.section_ordinal,
                    snippet: build_snippet_for_range(trimmed, found.start(), found.end()),
                    kind: row.kind,
                    score: 0.0,
                });
                Ok(hits.len() < max_results)
            })?;
        }

        Ok(SimpleSearchResult {
            query,
            total: hits.len(),
            items: hits,
        })
    }

    pub fn get_graph_snapshot(&self) -> Result<GraphSnapshot, String> {
        let runtime = match self.runtime_snapshot() {
            Some(runtime) => runtime,
            None => {
                return Ok(GraphSnapshot {
                    nodes: vec![],
                    links: vec![],
                    adjacency_map: BTreeMap::new(),
                    unresolved_count: 0,
                    ambiguous_count: 0,
                });
            }
        };

        let conn = open_connection(&runtime.db_path)?;
        let docs = load_doc_identities(&conn)?;
        let refs = load_wikilink_rows(&conn)?;

        let mut adjacency: HashMap<String, HashSet<String>> = HashMap::new();
        let mut links = Vec::new();
        let mut link_keys = HashSet::new();
        let mut unresolved_count = 0usize;
        let mut ambiguous_count = 0usize;
        let doc_by_uid = docs
            .iter()
            .map(|doc| (doc.note_uid, doc.doc_id.clone()))
            .collect::<HashMap<_, _>>();

        for row in refs {
            if row.resolution_kind == RESOLUTION_AMBIGUOUS {
                ambiguous_count += 1;
                continue;
            }
            if row.resolved_target_uid.is_none() {
                unresolved_count += 1;
                continue;
            }

            let Some(target_uid) = row.resolved_target_uid else {
                continue;
            };
            let Some(target_doc_id) = doc_by_uid.get(&target_uid) else {
                continue;
            };
            if row.source_doc_id == *target_doc_id {
                continue;
            }

            let link_key = (row.source_doc_id.clone(), target_doc_id.clone());
            if link_keys.insert(link_key.clone()) {
                links.push(GraphLinkDto {
                    source: link_key.0.clone(),
                    target: link_key.1.clone(),
                });
            }
            adjacency
                .entry(link_key.0.clone())
                .or_default()
                .insert(link_key.1.clone());
            adjacency
                .entry(link_key.1.clone())
                .or_default()
                .insert(link_key.0.clone());
        }

        let mut folders = docs
            .iter()
            .map(|doc| folder_label(&doc.doc_id))
            .collect::<Vec<_>>();
        folders.sort();
        folders.dedup();
        let cluster_map = folders
            .iter()
            .enumerate()
            .map(|(idx, folder)| (folder.clone(), idx))
            .collect::<HashMap<_, _>>();

        let mut nodes = docs
            .iter()
            .map(|doc| {
                let folder = folder_label(&doc.doc_id);
                let neighbours = adjacency
                    .get(&doc.doc_id)
                    .map(|items| items.len())
                    .unwrap_or(0);
                GraphNodeDto {
                    id: doc.doc_id.clone(),
                    name: doc_display_name(&doc.doc_id),
                    file_path: doc.doc_id.clone(),
                    folder: folder.clone(),
                    cluster_index: *cluster_map.get(&folder).unwrap_or(&0),
                    link_count: neighbours,
                    is_orphan: neighbours == 0,
                }
            })
            .collect::<Vec<_>>();
        nodes.sort_by(|left, right| left.file_path.cmp(&right.file_path));
        links.sort_by(|left, right| {
            left.source
                .cmp(&right.source)
                .then_with(|| left.target.cmp(&right.target))
        });

        let mut adjacency_map = BTreeMap::new();
        for doc in &docs {
            let mut neighbours = adjacency
                .remove(&doc.doc_id)
                .unwrap_or_default()
                .into_iter()
                .collect::<Vec<_>>();
            neighbours.sort();
            adjacency_map.insert(doc.doc_id.clone(), neighbours);
        }

        Ok(GraphSnapshot {
            nodes,
            links,
            adjacency_map,
            unresolved_count,
            ambiguous_count,
        })
    }

    pub fn resolve_wikilink(
        &self,
        source_path: &str,
        raw_target: &str,
    ) -> Result<ResolveWikilinkResult, String> {
        let runtime = match self.runtime_snapshot() {
            Some(runtime) => runtime,
            None => {
                return Ok(ResolveWikilinkResult {
                    resolved_path: None,
                    resolution_kind: "unresolved".to_string(),
                });
            }
        };

        let conn = open_connection(&runtime.db_path)?;
        let docs = load_doc_identities(&conn)?;
        let index = DocIndex::new(&docs);
        let resolution = resolve_wikilink(source_path, raw_target, &index);
        Ok(ResolveWikilinkResult {
            resolved_path: resolution.resolved_doc_id,
            resolution_kind: resolution.resolution_kind,
        })
    }

    fn with_runtime<T>(&self, f: impl FnOnce(&SearchRuntime) -> T) -> Option<T> {
        let manager = self.inner.lock();
        manager.runtime.as_ref().map(f)
    }

    fn with_runtime_result(
        &self,
        f: impl FnOnce(&SearchRuntime) -> Result<(), String>,
    ) -> Result<(), String> {
        let manager = self.inner.lock();
        let Some(runtime) = manager.runtime.as_ref() else {
            return Ok(());
        };
        f(runtime)
    }

    fn runtime_snapshot(&self) -> Option<RuntimeSnapshot> {
        self.with_runtime(|runtime| RuntimeSnapshot {
            db_path: runtime.db_path.clone(),
        })
    }
}

struct RuntimeSnapshot {
    db_path: PathBuf,
}

pub fn search_db_path(
    vault_root: &Path,
    storage_location: &IndexerStorageLocation,
) -> Result<PathBuf, String> {
    let canonical = fs::canonicalize(vault_root)
        .map_err(|e| format!("Failed to canonicalize vault path for hashing: {e}"))?;
    match storage_location {
        IndexerStorageLocation::AppGlobal => {
            let home = dirs::home_dir().ok_or("Cannot resolve home directory")?;
            let app_root = home.join(".kuku").join("search");
            let hash = hash_path(&canonical);
            Ok(app_root.join(format!("{hash}.sqlite3")))
        }
        IndexerStorageLocation::VaultLocal => Ok(canonical.join(".kuku").join("search.sqlite3")),
    }
}

fn hash_path(path: &Path) -> String {
    let hash: Hash = blake3::hash(path.to_string_lossy().as_bytes());
    hash.to_hex().to_string()
}

pub fn is_markdown_path(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    lower.ends_with(".md") || lower.ends_with(".markdown")
}

pub fn to_relative_path(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::mpsc;
    use std::time::{SystemTime, UNIX_EPOCH};

    use crate::search::db::{IndexedChunkRow, IndexedDocument};

    static TEST_COUNTER: AtomicU64 = AtomicU64::new(0);

    fn unique_path(prefix: &str) -> PathBuf {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let suffix = TEST_COUNTER.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!("{prefix}-{now}-{suffix}"))
    }

    fn build_state(docs: Vec<IndexedDocument>) -> SearchState {
        let vault_root = unique_path("kuku-search-root");
        fs::create_dir_all(&vault_root).unwrap();
        let db_path = unique_path("kuku-search-db").with_extension("sqlite3");
        let mut conn = open_connection(&db_path).unwrap();
        let tx = conn.transaction().unwrap();
        for doc in &docs {
            db::replace_document(&tx, doc).unwrap();
        }
        tx.commit().unwrap();

        let (job_tx, _job_rx) = mpsc::channel();
        SearchState {
            inner: Arc::new(Mutex::new(SearchManager {
                runtime: Some(SearchRuntime {
                    vault_root,
                    db_path,
                    job_tx,
                    status: Arc::new(Mutex::new(IndexerStatus::default())),
                    rebuild_state: Arc::new(Mutex::new(RebuildQueueState::default())),
                    config: Arc::new(Mutex::new(IndexerConfig::default())),
                }),
                config: IndexerConfig::default(),
            })),
        }
    }

    fn build_state_with_job_rx(config: IndexerConfig) -> (SearchState, mpsc::Receiver<WriterJob>) {
        let vault_root = unique_path("kuku-search-root");
        fs::create_dir_all(&vault_root).unwrap();
        let db_path = unique_path("kuku-search-db").with_extension("sqlite3");
        let (job_tx, job_rx) = mpsc::channel();
        let state = SearchState {
            inner: Arc::new(Mutex::new(SearchManager {
                runtime: Some(SearchRuntime {
                    vault_root,
                    db_path,
                    job_tx,
                    status: Arc::new(Mutex::new(IndexerStatus::default())),
                    rebuild_state: Arc::new(Mutex::new(RebuildQueueState::default())),
                    config: Arc::new(Mutex::new(config.clone())),
                }),
                config,
            })),
        };
        (state, job_rx)
    }

    fn make_doc(
        doc_id: &str,
        title: Option<&str>,
        chunks: Vec<(&[&str], &str, &str, i64)>,
    ) -> IndexedDocument {
        IndexedDocument {
            note_uid: None,
            doc_id: doc_id.to_string(),
            title: title.map(ToString::to_string),
            mtime_ms: 1,
            meta_json: "{}".to_string(),
            chunks: chunks
                .into_iter()
                .map(
                    |(section_path, kind, raw_text, global_start)| IndexedChunkRow {
                        section_path_json: serde_json::to_string(
                            &section_path
                                .iter()
                                .map(|segment| segment.to_string())
                                .collect::<Vec<_>>(),
                        )
                        .unwrap(),
                        kind: kind.to_string(),
                        text: raw_text.to_lowercase(),
                        raw_text: raw_text.to_string(),
                        global_start,
                        global_end: global_start + raw_text.chars().count() as i64,
                    },
                )
                .collect(),
            wikilink_refs: vec![],
        }
    }

    fn make_linked_doc(doc_id: &str, wikilinks: &[&str]) -> IndexedDocument {
        IndexedDocument {
            note_uid: None,
            doc_id: doc_id.to_string(),
            title: None,
            mtime_ms: 1,
            meta_json: "{}".to_string(),
            chunks: vec![],
            wikilink_refs: wikilinks
                .iter()
                .enumerate()
                .map(|(idx, target)| db::IndexedWikilinkRow {
                    raw_target: (*target).to_string(),
                    alias: None,
                    normalized_target: wikilink::normalize_link_target(target),
                    target_basename: wikilink::basename_from_normalized(
                        &wikilink::normalize_link_target(target),
                    ),
                    ordinal: idx as i64,
                })
                .collect(),
        }
    }

    #[test]
    fn markdown_extensions_are_detected() {
        assert!(is_markdown_path("notes/a.md"));
        assert!(is_markdown_path("notes/a.markdown"));
        assert!(!is_markdown_path("notes/a.png"));
    }

    #[test]
    fn search_db_path_is_stable_for_same_root() {
        let root = unique_path("kuku-search-root");
        fs::create_dir_all(&root).unwrap();
        let first = search_db_path(&root, &IndexerStorageLocation::AppGlobal).unwrap();
        let second = search_db_path(&root, &IndexerStorageLocation::AppGlobal).unwrap();
        assert_eq!(first, second);
    }

    #[test]
    fn search_db_path_supports_vault_local_storage() {
        let root = unique_path("kuku-search-root");
        fs::create_dir_all(&root).unwrap();
        let db_path = search_db_path(&root, &IndexerStorageLocation::VaultLocal).unwrap();
        let canonical_root = fs::canonicalize(&root).unwrap();
        assert_eq!(db_path, canonical_root.join(".kuku").join("search.sqlite3"));
    }

    #[test]
    fn search_db_path_changes_with_storage_location() {
        let root = unique_path("kuku-search-root");
        fs::create_dir_all(&root).unwrap();
        let app_global = search_db_path(&root, &IndexerStorageLocation::AppGlobal).unwrap();
        let vault_local = search_db_path(&root, &IndexerStorageLocation::VaultLocal).unwrap();
        assert_ne!(app_global, vault_local);
    }

    #[test]
    fn config_change_effect_ignores_unchanged_config() {
        let config = IndexerConfig::default();

        assert_eq!(
            config_change_effect(&config, &config),
            ConfigChangeEffect::Noop
        );
    }

    #[test]
    fn config_change_effect_does_not_rebuild_for_runtime_only_toggles() {
        let previous = IndexerConfig::default();

        let mut incremental = previous.clone();
        incremental.incremental_updates = !incremental.incremental_updates;
        assert_eq!(
            config_change_effect(&previous, &incremental),
            ConfigChangeEffect::RuntimeOnly
        );

        let mut open = previous.clone();
        open.reindex_on_vault_open = !open.reindex_on_vault_open;
        assert_eq!(
            config_change_effect(&previous, &open),
            ConfigChangeEffect::RuntimeOnly
        );
    }

    #[test]
    fn config_change_effect_rebuilds_for_index_affecting_changes() {
        let previous = IndexerConfig::default();

        let mut resolution = previous.clone();
        resolution.resolution_policy = "different".to_string();
        assert_eq!(
            config_change_effect(&previous, &resolution),
            ConfigChangeEffect::Rebuild
        );

        let mut storage = previous.clone();
        storage.storage_location = IndexerStorageLocation::VaultLocal;
        assert_eq!(
            config_change_effect(&previous, &storage),
            ConfigChangeEffect::RestartAndRebuild
        );
    }

    #[test]
    fn set_config_does_not_queue_rebuild_for_runtime_only_changes() {
        let previous = IndexerConfig::default();
        let (state, job_rx) = build_state_with_job_rx(previous.clone());
        let mut next = previous;
        next.incremental_updates = !next.incremental_updates;

        state.set_config(next.clone()).unwrap();

        assert!(job_rx.try_recv().is_err());
        let runtime_config = state.with_runtime(|runtime| runtime.config.lock().clone());
        assert_eq!(runtime_config, Some(next));
    }

    #[test]
    fn set_config_queues_rebuild_for_resolution_policy_changes() {
        let previous = IndexerConfig::default();
        let (state, job_rx) = build_state_with_job_rx(previous);
        let mut next = IndexerConfig::default();
        next.resolution_policy = "different".to_string();

        state.set_config(next).unwrap();

        assert!(matches!(job_rx.try_recv(), Ok(WriterJob::FullRebuild)));
    }

    #[test]
    fn advanced_query_matches_title_and_body() {
        let state = build_state(vec![make_doc(
            "note.md",
            Some("Alpha Title"),
            vec![(&["Section"], "Prose", "Body has RegexNeedle here.", 12)],
        )]);

        let title_hits = state
            .query_advanced(&AdvancedQueryRequest {
                query: "Alpha".to_string(),
                case_sensitive: false,
                max_results: Some(20),
            })
            .unwrap();
        assert_eq!(title_hits.items.len(), 1);
        assert_eq!(title_hits.items[0].kind, "Title");

        let body_hits = state
            .query_advanced(&AdvancedQueryRequest {
                query: "RegexNeedle".to_string(),
                case_sensitive: false,
                max_results: Some(20),
            })
            .unwrap();
        assert_eq!(body_hits.items.len(), 1);
        assert_eq!(body_hits.items[0].section_path, vec!["Section".to_string()]);
    }

    #[test]
    fn advanced_query_respects_case_sensitivity() {
        let state = build_state(vec![make_doc(
            "note.md",
            Some("Alpha"),
            vec![(&["Alpha"], "Prose", "Alpha body", 0)],
        )]);

        let insensitive = state
            .query_advanced(&AdvancedQueryRequest {
                query: "alpha".to_string(),
                case_sensitive: false,
                max_results: Some(20),
            })
            .unwrap();
        let sensitive = state
            .query_advanced(&AdvancedQueryRequest {
                query: "alpha".to_string(),
                case_sensitive: true,
                max_results: Some(20),
            })
            .unwrap();

        assert!(!insensitive.items.is_empty());
        assert!(sensitive.items.is_empty());
    }

    #[test]
    fn invalid_regex_does_not_break_following_queries() {
        let state = build_state(vec![make_doc(
            "note.md",
            Some("Alpha"),
            vec![(&["Alpha"], "Prose", "body needle", 0)],
        )]);

        let error = state.query_advanced(&AdvancedQueryRequest {
            query: "(".to_string(),
            case_sensitive: false,
            max_results: Some(20),
        });
        assert!(error.is_err());

        let simple = state.query_simple("needle", 20).unwrap();
        assert_eq!(simple.total, 1);
    }

    #[test]
    fn simple_query_keeps_repeated_section_paths_distinct() {
        let state = build_state(vec![make_doc(
            "note.md",
            None,
            vec![
                (&["Repeat"], "Heading", "Repeat", 0),
                (&["Repeat"], "Prose", "first body", 8),
                (&["Repeat"], "Heading", "Repeat", 20),
                (&["Repeat"], "Prose", "second body", 28),
            ],
        )]);

        let result = state.query_simple("Repeat", 20).unwrap();
        let heading_ordinals = result
            .items
            .iter()
            .filter(|hit| hit.kind == "Heading")
            .map(|hit| hit.section_ordinal)
            .collect::<Vec<_>>();
        assert_eq!(heading_ordinals, vec![0, 1]);
    }

    #[test]
    fn advanced_query_tracks_repeated_section_path_ordinals() {
        let state = build_state(vec![make_doc(
            "note.md",
            Some("Doc"),
            vec![
                (&["Repeat"], "Heading", "Repeat", 0),
                (&["Repeat"], "Prose", "needle first", 8),
                (&["Repeat"], "Heading", "Repeat", 24),
                (&["Repeat"], "Prose", "needle second", 32),
            ],
        )]);

        let result = state
            .query_advanced(&AdvancedQueryRequest {
                query: "needle".to_string(),
                case_sensitive: false,
                max_results: Some(20),
            })
            .unwrap();
        let ordinals = result
            .items
            .iter()
            .map(|hit| hit.section_ordinal)
            .collect::<Vec<_>>();
        assert_eq!(ordinals, vec![0, 1]);
    }

    #[test]
    fn advanced_query_sorts_title_hits_before_body_hits() {
        let state = build_state(vec![
            make_doc(
                "a.md",
                Some("Match Alpha"),
                vec![
                    (&["Match Alpha"], "Heading", "Match Alpha", 0),
                    (&["Match Alpha"], "Prose", "Alpha body", 12),
                ],
            ),
            make_doc(
                "b.md",
                Some("Alpha Title"),
                vec![(&["Section"], "Prose", "body", 0)],
            ),
        ]);

        let result = state
            .query_advanced(&AdvancedQueryRequest {
                query: "Alpha".to_string(),
                case_sensitive: false,
                max_results: Some(20),
            })
            .unwrap();
        let ordered = result
            .items
            .iter()
            .map(|hit| format!("{}:{}", hit.doc_id, hit.kind))
            .collect::<Vec<_>>();
        assert_eq!(
            ordered,
            vec![
                "a.md:Title".to_string(),
                "b.md:Title".to_string(),
                "a.md:Heading".to_string(),
                "a.md:Prose".to_string(),
            ]
        );
    }

    #[test]
    fn graph_snapshot_uses_resolved_links() {
        let state = build_state(vec![
            make_linked_doc("notes/alpha.md", &["beta"]),
            make_linked_doc("notes/beta.md", &[]),
        ]);
        state.request_rebuild().unwrap();

        let snapshot = state.get_graph_snapshot().unwrap();
        assert_eq!(snapshot.nodes.len(), 2);
        assert_eq!(snapshot.links.len(), 0);
    }
}
