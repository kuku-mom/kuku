use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_directory: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub children: Option<Vec<FileEntry>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileChangeEvent {
    /// "create" | "modify" | "delete" | "rename"
    pub kind: String,
    /// For rename: the destination path
    pub path: String,
    pub is_dir: bool,
    /// For rename: the original path
    #[serde(skip_serializing_if = "Option::is_none")]
    pub old_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileReadResult {
    pub content: String,
    pub checksum: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "status")]
pub enum ChecksumWriteResult {
    Written { checksum: String },
    Conflict { expected: String, actual: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexerStatus {
    pub state: String,
    pub total_docs: usize,
    pub indexed_docs: usize,
    pub last_indexed_at: Option<i64>,
    pub resolved_links: usize,
    pub unresolved_links: usize,
    pub ambiguous_links: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl Default for IndexerStatus {
    fn default() -> Self {
        Self {
            state: "idle".to_string(),
            total_docs: 0,
            indexed_docs: 0,
            last_indexed_at: None,
            resolved_links: 0,
            unresolved_links: 0,
            ambiguous_links: 0,
            error: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexerDebugStatus {
    pub runtime_active: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub db_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_job_kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_job_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_job_source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_rebuild_reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub queued_rebuild_reason: Option<String>,
    pub coalesced_rebuild_count: usize,
    pub coalesced_index_count: usize,
    pub rebuild_queued: bool,
    pub rebuild_running: bool,
    pub rebuild_rerun: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_watcher_event_kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_watcher_event_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_watcher_event_source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_watcher_event_skipped: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_watcher_event_at: Option<i64>,
}

impl Default for IndexerDebugStatus {
    fn default() -> Self {
        Self {
            runtime_active: false,
            db_path: None,
            last_job_kind: None,
            last_job_path: None,
            last_job_source: None,
            last_rebuild_reason: None,
            queued_rebuild_reason: None,
            coalesced_rebuild_count: 0,
            coalesced_index_count: 0,
            rebuild_queued: false,
            rebuild_running: false,
            rebuild_rerun: false,
            last_watcher_event_kind: None,
            last_watcher_event_path: None,
            last_watcher_event_source: None,
            last_watcher_event_skipped: None,
            last_watcher_event_at: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexerConfig {
    #[serde(default)]
    pub storage_location: IndexerStorageLocation,
    pub incremental_updates: bool,
    pub reindex_on_vault_open: bool,
    pub resolution_policy: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "kebab-case")]
pub enum IndexerStorageLocation {
    #[default]
    AppGlobal,
    VaultLocal,
}

impl Default for IndexerConfig {
    fn default() -> Self {
        Self {
            storage_location: IndexerStorageLocation::AppGlobal,
            incremental_updates: true,
            reindex_on_vault_open: true,
            resolution_policy: "closest-folder".to_string(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SimpleSearchHit {
    pub doc_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    pub section_path: Vec<String>,
    pub section_ordinal: usize,
    pub snippet: String,
    pub kind: String,
    pub score: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SimpleSearchResult {
    pub query: String,
    pub total: usize,
    pub items: Vec<SimpleSearchHit>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdvancedQueryRequest {
    pub query: String,
    pub case_sensitive: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_results: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphNodeDto {
    pub id: String,
    pub name: String,
    pub file_path: String,
    pub folder: String,
    pub cluster_index: usize,
    pub link_count: usize,
    pub is_orphan: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphLinkDto {
    pub source: String,
    pub target: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphSnapshot {
    pub nodes: Vec<GraphNodeDto>,
    pub links: Vec<GraphLinkDto>,
    pub adjacency_map: std::collections::BTreeMap<String, Vec<String>>,
    pub unresolved_count: usize,
    pub ambiguous_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolveWikilinkResult {
    pub resolved_path: Option<String>,
    pub resolution_kind: String,
}
