use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KnowledgeIdPrefix {
    Memory,
    Proposal,
    Change,
    Decision,
    Document,
}

impl KnowledgeIdPrefix {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Memory => "mem",
            Self::Proposal => "prop",
            Self::Change => "change",
            Self::Decision => "decision",
            Self::Document => "doc",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum KnowledgeErrorCode {
    InvalidArgument,
    ValidationFailed,
    UnsafePath,
    AlreadyExists,
    NotPending,
    ApplyInProgress,
    ApplyRecoveryRequired,
    ApplyFailed,
    DocumentChanged,
    IoError,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KnowledgeError {
    pub code: KnowledgeErrorCode,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum KnowledgeCommandResult<T> {
    Ok { ok: bool, value: T },
    Err { ok: bool, error: KnowledgeError },
}

impl<T> KnowledgeCommandResult<T> {
    pub fn ok(value: T) -> Self {
        Self::Ok { ok: true, value }
    }

    pub fn err(code: KnowledgeErrorCode, message: impl Into<String>) -> Self {
        Self::err_with_details(code, message, None)
    }

    pub fn err_with_details(
        code: KnowledgeErrorCode,
        message: impl Into<String>,
        details: Option<serde_json::Value>,
    ) -> Self {
        Self::Err {
            ok: false,
            error: KnowledgeError {
                code,
                message: message.into(),
                details,
            },
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct KnowledgeStatusResult {
    pub initialized: bool,
    pub root_exists: bool,
    pub memory_dir_exists: bool,
    pub proposals_dir_exists: bool,
    pub decisions_dir_exists: bool,
    pub cache_dir_exists: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct KnowledgeInitResult {
    pub initialized: bool,
    pub root_exists: bool,
    pub memory_dir_exists: bool,
    pub proposals_dir_exists: bool,
    pub decisions_dir_exists: bool,
    pub cache_dir_exists: bool,
    pub created_dirs: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProposalRequestSource {
    AiTool,
    UiCommand,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CreateDecisionDocumentRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context: Option<String>,
    #[serde(default)]
    pub source_refs: Vec<SourceRefInput>,
    pub proposed_memories: Vec<ProposedMemoryInput>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_source: Option<ProposalRequestSource>,
    #[serde(default)]
    pub default_selection: ProposalDefaultSelection,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MemoryProposeRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context: Option<String>,
    #[serde(default)]
    pub source_refs: Vec<SourceRefInput>,
    pub proposed_memories: Vec<ProposedMemoryInput>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_source: Option<ProposalRequestSource>,
    #[serde(default)]
    pub default_selection: ProposalDefaultSelection,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum ProposalDefaultSelection {
    #[default]
    Yes,
    None,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProposedMemoryInput {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub suggested_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    pub title: String,
    pub body: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub source_refs: Vec<SourceRefInput>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub decision: Option<ProposedDecisionInput>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProposedDecisionInput {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub question: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selected_option_id: Option<DecisionOptionId>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub other_text: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DecisionOptionId {
    Yes,
    No,
    Other,
}

impl DecisionOptionId {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Yes => "yes",
            Self::No => "no",
            Self::Other => "other",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateDecisionDocumentResult {
    pub doc_id: String,
    pub proposal_id: String,
    pub path: String,
    pub title: String,
    pub created: bool,
    pub should_open: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ApplyDecisionDocumentRequest {
    pub path: String,
    pub expected_checksum: String,
    pub source: String,
    #[serde(default = "default_recover")]
    pub recover: bool,
}

fn default_recover() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReadDecisionDocumentRequest {
    pub path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReadDecisionDocumentResult {
    pub doc_id: String,
    pub proposal_id: String,
    pub path: String,
    pub markdown: String,
    pub checksum: String,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReadMemoryRequest {
    pub id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReadMemoryItem {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    pub title: String,
    pub body: String,
    pub tags: Vec<String>,
    pub source_refs: Vec<SourceRef>,
    pub status: MemoryStatus,
    pub created_at: String,
    pub updated_at: String,
    pub proposal_id: String,
    pub decision_document: String,
}

impl From<MemoryItem> for ReadMemoryItem {
    fn from(value: MemoryItem) -> Self {
        Self {
            id: value.id,
            kind: value.kind,
            title: value.title,
            body: value.body,
            tags: value.tags,
            source_refs: value.source_refs,
            status: value.status,
            created_at: value.created_at,
            updated_at: value.updated_at,
            proposal_id: value.proposal_id,
            decision_document: value.decision_document,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReadMemoryResult {
    pub memory: ReadMemoryItem,
    pub path: String,
    pub markdown: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ApplyDecisionDocumentStatus {
    Applied,
    PartiallyApplied,
    NeedsRevision,
}

impl ApplyDecisionDocumentStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Applied => "applied",
            Self::PartiallyApplied => "partially_applied",
            Self::NeedsRevision => "needs_revision",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ApplyDecisionDocumentResult {
    pub doc_id: String,
    pub path: String,
    pub status: ApplyDecisionDocumentStatus,
    pub committed_memory_paths: Vec<String>,
    pub rejected_decision_ids: Vec<String>,
    pub needs_revision_decision_ids: Vec<String>,
    pub recovered_from_journal: bool,
    pub warnings: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub journal_cleanup_required: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub journal_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SearchMemoryRequest {
    pub query: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<usize>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub kinds: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MemoryContextRequest {
    pub query: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<usize>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MemorySearchResult {
    pub hits: Vec<MemorySearchHit>,
    pub warnings: Vec<String>,
    pub skipped_paths: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MemorySearchHit {
    pub id: String,
    pub path: String,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    pub snippet: String,
    pub tags: Vec<String>,
    pub source_refs: Vec<SourceRef>,
    pub score: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MemoryContextResult {
    pub query: String,
    pub memories: Vec<MemorySearchHit>,
    pub warnings: Vec<String>,
    pub skipped_paths: Vec<String>,
}

impl KnowledgeInitResult {
    pub fn from_status(status: KnowledgeStatusResult, created_dirs: Vec<String>) -> Self {
        Self {
            initialized: status.initialized,
            root_exists: status.root_exists,
            memory_dir_exists: status.memory_dir_exists,
            proposals_dir_exists: status.proposals_dir_exists,
            decisions_dir_exists: status.decisions_dir_exists,
            cache_dir_exists: status.cache_dir_exists,
            created_dirs,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SourceRange {
    pub start_line: u32,
    pub end_line: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SourceRefInput {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub section_path: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub range: Option<SourceRange>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub checksum: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub captured_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SourceRef {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub section_path: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub range: Option<SourceRange>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub checksum: Option<String>,
    pub captured_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MemoryItem {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    pub title: String,
    pub status: MemoryStatus,
    pub tags: Vec<String>,
    pub source_refs: Vec<SourceRef>,
    pub created_at: String,
    pub updated_at: String,
    pub proposal_id: String,
    pub decision_document: String,
    #[serde(skip)]
    pub body: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MemoryStatus {
    Active,
    Archived,
    Superseded,
}
