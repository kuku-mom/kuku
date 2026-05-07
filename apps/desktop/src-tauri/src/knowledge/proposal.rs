use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use serde::Serialize;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use tokio::io::AsyncWriteExt;

use crate::knowledge::markdown::{
    KnowledgeModelError, format_path_timestamp, format_utc_timestamp,
    make_collision_free_knowledge_id, normalize_source_ref, sha256_checksum_bytes, slugify_title,
    validate_safe_vault_relative_path,
};
use crate::knowledge::models::{
    CreateDecisionDocumentRequest, CreateDecisionDocumentResult, DecisionOptionId,
    KnowledgeErrorCode, KnowledgeIdPrefix, ProposalDefaultSelection, ProposalRequestSource,
    ProposedDecisionInput, ProposedMemoryInput, SourceRef,
};
use crate::knowledge::service::{KnowledgeServiceError, knowledge_init_for_root};

const MAX_PROPOSED_MEMORIES: usize = 20;
const MAX_TITLE_CHARS: usize = 160;
const MAX_BODY_CHARS: usize = 20_000;
const MAX_CONTEXT_CHARS: usize = 10_000;
const MAX_TAGS: usize = 30;
const MAX_TAG_CHARS: usize = 40;
const MAX_KIND_CHARS: usize = 40;
const MAX_OTHER_TEXT_CHARS: usize = 4_000;

#[derive(Debug, Clone)]
pub struct ProposalServiceError {
    pub code: KnowledgeErrorCode,
    pub message: String,
    pub details: Option<Value>,
}

impl ProposalServiceError {
    fn invalid(message: impl Into<String>) -> Self {
        Self {
            code: KnowledgeErrorCode::InvalidArgument,
            message: message.into(),
            details: None,
        }
    }

    fn already_exists(message: impl Into<String>) -> Self {
        Self {
            code: KnowledgeErrorCode::AlreadyExists,
            message: message.into(),
            details: None,
        }
    }

    fn io(message: impl Into<String>) -> Self {
        Self {
            code: KnowledgeErrorCode::IoError,
            message: message.into(),
            details: None,
        }
    }

    fn io_with_details(message: impl Into<String>, details: Value) -> Self {
        Self {
            code: KnowledgeErrorCode::IoError,
            message: message.into(),
            details: Some(details),
        }
    }
}

impl From<KnowledgeServiceError> for ProposalServiceError {
    fn from(value: KnowledgeServiceError) -> Self {
        Self {
            code: value.code,
            message: value.message,
            details: None,
        }
    }
}

impl From<KnowledgeModelError> for ProposalServiceError {
    fn from(value: KnowledgeModelError) -> Self {
        Self::invalid(format!("{}: {}", value.field, value.message))
    }
}

pub async fn create_decision_document_for_root(
    root: &Path,
    request: CreateDecisionDocumentRequest,
    request_source: ProposalRequestSource,
) -> Result<CreateDecisionDocumentResult, ProposalServiceError> {
    knowledge_init_for_root(root).await?;
    let now = SystemTime::now();
    let normalized = normalize_request(request, request_source, now)?;
    let rendered = render_decision_document(&normalized)?;
    publish_decision_document(root, &normalized.path_slug, rendered, now).await
}

fn normalize_request(
    request: CreateDecisionDocumentRequest,
    request_source: ProposalRequestSource,
    now: SystemTime,
) -> Result<NormalizedProposal, ProposalServiceError> {
    if request.proposed_memories.is_empty() {
        return Err(ProposalServiceError::invalid(
            "proposed_memories must contain at least one item",
        ));
    }
    if request.proposed_memories.len() > MAX_PROPOSED_MEMORIES {
        return Err(ProposalServiceError::invalid(
            "proposed_memories contains too many items",
        ));
    }

    let captured_at = format_utc_timestamp(now);
    let first_title = trim_required(
        &request.proposed_memories[0].title,
        "proposed_memories[0].title",
        MAX_TITLE_CHARS,
    )?;
    let title = match request.title {
        Some(title) => trim_required(&title, "title", MAX_TITLE_CHARS)?,
        None => format!("Memory Proposal - {first_title}"),
    };
    let path_slug = slugify_title(&title);
    let context = optional_limited(request.context, "context", MAX_CONTEXT_CHARS)?;
    let source_refs = request
        .source_refs
        .into_iter()
        .map(|source_ref| normalize_source_ref(source_ref, &captured_at))
        .collect::<Result<Vec<_>, _>>()?;

    let mut used_memory_ids = BTreeSet::new();
    let mut used_change_ids = BTreeSet::new();
    let mut used_decision_ids = BTreeSet::new();
    let mut normalized_memories = Vec::new();
    for (index, proposed) in request.proposed_memories.into_iter().enumerate() {
        normalized_memories.push(normalize_proposed_memory(
            proposed,
            index,
            &captured_at,
            request.default_selection.clone(),
            &mut used_memory_ids,
            &mut used_change_ids,
            &mut used_decision_ids,
        )?);
    }

    let mut used_doc_ids = BTreeSet::new();
    let doc_id = make_collision_free_knowledge_id(KnowledgeIdPrefix::Document, &title, |id| {
        used_doc_ids.contains(id)
    })?;
    used_doc_ids.insert(doc_id.clone());
    let proposal_id =
        make_collision_free_knowledge_id(KnowledgeIdPrefix::Proposal, &title, |_| false)?;

    Ok(NormalizedProposal {
        doc_id,
        proposal_id,
        title,
        context,
        request_source,
        status: "pending".to_string(),
        created_at: captured_at.clone(),
        updated_at: captured_at,
        source_refs,
        proposed_memories: normalized_memories,
        path_slug,
    })
}

fn normalize_proposed_memory(
    proposed: ProposedMemoryInput,
    index: usize,
    captured_at: &str,
    default_selection: ProposalDefaultSelection,
    used_memory_ids: &mut BTreeSet<String>,
    used_change_ids: &mut BTreeSet<String>,
    used_decision_ids: &mut BTreeSet<String>,
) -> Result<NormalizedProposedMemory, ProposalServiceError> {
    let field = |name: &str| format!("proposed_memories[{index}].{name}");
    let title = trim_required(&proposed.title, &field("title"), MAX_TITLE_CHARS)?;
    let body = trim_required(&proposed.body, &field("body"), MAX_BODY_CHARS)?;
    let kind = optional_limited(proposed.kind, &field("kind"), MAX_KIND_CHARS)?;
    let tags = normalize_tags(proposed.tags, &field("tags"))?;
    let source_refs = proposed
        .source_refs
        .into_iter()
        .map(|source_ref| normalize_source_ref(source_ref, captured_at))
        .collect::<Result<Vec<_>, _>>()?;

    let memory_seed = proposed.suggested_id.as_deref().unwrap_or(&title);
    let memory_id =
        make_collision_free_knowledge_id(KnowledgeIdPrefix::Memory, memory_seed, |id| {
            used_memory_ids.contains(id)
        })?;
    used_memory_ids.insert(memory_id.clone());

    let change_id = make_collision_free_knowledge_id(KnowledgeIdPrefix::Change, &title, |id| {
        used_change_ids.contains(id)
    })?;
    used_change_ids.insert(change_id.clone());

    let decision_id =
        make_collision_free_knowledge_id(KnowledgeIdPrefix::Decision, &title, |id| {
            used_decision_ids.contains(id)
        })?;
    used_decision_ids.insert(decision_id.clone());

    let decision = normalize_decision(proposed.decision, default_selection, &field("decision"))?;

    Ok(NormalizedProposedMemory {
        change_id,
        memory_id,
        kind,
        title,
        body,
        tags,
        source_refs,
        decision_id,
        decision,
    })
}

fn normalize_decision(
    decision: Option<ProposedDecisionInput>,
    default_selection: ProposalDefaultSelection,
    field: &str,
) -> Result<NormalizedDecisionDraft, ProposalServiceError> {
    let question = match decision.as_ref().and_then(|value| value.question.as_ref()) {
        Some(question) => trim_required(question, &format!("{field}.question"), MAX_TITLE_CHARS)?,
        None => "Remember this memory?".to_string(),
    };
    let selected_option_id = decision
        .as_ref()
        .and_then(|value| value.selected_option_id.clone())
        .or(match default_selection {
            ProposalDefaultSelection::Yes => Some(DecisionOptionId::Yes),
            ProposalDefaultSelection::None => None,
        });
    let other_text = match decision.and_then(|value| value.other_text) {
        Some(value) => optional_limited(
            Some(value),
            &format!("{field}.other_text"),
            MAX_OTHER_TEXT_CHARS,
        )?,
        None => None,
    };

    Ok(NormalizedDecisionDraft {
        question,
        selected_option_id,
        other_text,
    })
}

fn trim_required(
    value: &str,
    field: &str,
    max_chars: usize,
) -> Result<String, ProposalServiceError> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(ProposalServiceError::invalid(format!("{field} is empty")));
    }
    if trimmed.chars().count() > max_chars {
        return Err(ProposalServiceError::invalid(format!(
            "{field} is too long"
        )));
    }
    Ok(trimmed.to_string())
}

fn optional_limited(
    value: Option<String>,
    field: &str,
    max_chars: usize,
) -> Result<Option<String>, ProposalServiceError> {
    let Some(value) = value else {
        return Ok(None);
    };
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    if trimmed.chars().count() > max_chars {
        return Err(ProposalServiceError::invalid(format!(
            "{field} is too long"
        )));
    }
    Ok(Some(trimmed.to_string()))
}

fn normalize_tags(tags: Vec<String>, field: &str) -> Result<Vec<String>, ProposalServiceError> {
    let mut normalized = Vec::new();
    for tag in tags {
        let trimmed = tag.trim();
        if trimmed.is_empty() {
            continue;
        }
        if trimmed.chars().count() > MAX_TAG_CHARS {
            return Err(ProposalServiceError::invalid(format!(
                "{field} contains a tag that is too long"
            )));
        }
        normalized.push(trimmed.to_string());
    }
    if normalized.len() > MAX_TAGS {
        return Err(ProposalServiceError::invalid(format!(
            "{field} contains too many tags"
        )));
    }
    Ok(normalized)
}

async fn publish_decision_document(
    root: &Path,
    slug: &str,
    rendered: RenderedDecisionDocument,
    now: SystemTime,
) -> Result<CreateDecisionDocumentResult, ProposalServiceError> {
    let timestamp = format_path_timestamp(now);
    for index in 1..=100 {
        let candidate_slug = if index == 1 {
            slug.to_string()
        } else {
            let suffix = format!("-{index}");
            let base = slug.chars().take(80 - suffix.len()).collect::<String>();
            format!("{base}{suffix}")
        };
        let relative_path = format!("Knowledge/decisions/{timestamp}-{candidate_slug}.md");
        validate_safe_vault_relative_path(&relative_path, "path")?;
        let lock = match DocumentWriteLock::acquire(root, &relative_path).await {
            Ok(lock) => lock,
            Err(error) => return Err(error),
        };

        let destination = root.join(&relative_path);
        if exact_or_case_insensitive_exists(&destination).await? {
            drop(lock);
            continue;
        }

        match write_exclusive_verified(&destination, &relative_path, rendered.markdown.as_bytes())
            .await
        {
            Ok(()) => {
                drop(lock);
                return Ok(CreateDecisionDocumentResult {
                    doc_id: rendered.doc_id,
                    proposal_id: rendered.proposal_id,
                    path: relative_path,
                    title: rendered.title,
                    created: true,
                    should_open: true,
                });
            }
            Err(error) if error.code == KnowledgeErrorCode::AlreadyExists => {
                drop(lock);
                continue;
            }
            Err(error) => return Err(error),
        }
    }

    Err(ProposalServiceError::already_exists(
        "No available decision document path after 100 attempts",
    ))
}

async fn write_exclusive_verified(
    destination: &Path,
    relative_path: &str,
    bytes: &[u8],
) -> Result<(), ProposalServiceError> {
    if let Some(parent) = destination.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|error| ProposalServiceError::io(error.to_string()))?;
    }
    let mut file = tokio::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(destination)
        .await
        .map_err(|error| {
            if error.kind() == std::io::ErrorKind::AlreadyExists {
                ProposalServiceError::already_exists("Decision document already exists")
            } else {
                ProposalServiceError::io(error.to_string())
            }
        })?;
    file.write_all(bytes)
        .await
        .map_err(|error| ProposalServiceError::io(error.to_string()))?;
    file.sync_all()
        .await
        .map_err(|error| ProposalServiceError::io(error.to_string()))?;
    drop(file);

    let observed = tokio::fs::read(destination)
        .await
        .map_err(|error| ProposalServiceError::io(error.to_string()))?;
    let expected_checksum = sha256_checksum_bytes(bytes);
    let actual_checksum = sha256_checksum_bytes(&observed);
    if expected_checksum != actual_checksum {
        let cleanup = tokio::fs::remove_file(destination).await;
        let cleanup_required = cleanup.is_err();
        let details = verification_failure_details(
            relative_path,
            &expected_checksum,
            &actual_checksum,
            cleanup_required,
        );
        let message = match cleanup {
            Ok(()) => "Decision document verification failed".to_string(),
            Err(error) => {
                format!("Decision document verification failed and cleanup failed: {error}")
            }
        };
        return Err(ProposalServiceError::io_with_details(message, details));
    }
    Ok(())
}

fn verification_failure_details(
    relative_path: &str,
    expected_checksum: &str,
    actual_checksum: &str,
    cleanup_required: bool,
) -> Value {
    let mut details = Map::new();
    details.insert(
        "expected_checksum".to_string(),
        Value::String(expected_checksum.to_string()),
    );
    details.insert(
        "actual_checksum".to_string(),
        Value::String(actual_checksum.to_string()),
    );
    if cleanup_required {
        details.insert("cleanup_required".to_string(), Value::Bool(true));
        details.insert("created_paths".to_string(), json!([relative_path]));
    }
    Value::Object(details)
}

async fn exact_or_case_insensitive_exists(path: &Path) -> Result<bool, ProposalServiceError> {
    match tokio::fs::try_exists(path).await {
        Ok(true) => return Ok(true),
        Ok(false) => {}
        Err(error) => return Err(ProposalServiceError::io(error.to_string())),
    }

    let Some(parent) = path.parent() else {
        return Ok(false);
    };
    let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
        return Ok(false);
    };
    let mut entries = match tokio::fs::read_dir(parent).await {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(ProposalServiceError::io(error.to_string())),
    };
    while let Some(entry) = entries
        .next_entry()
        .await
        .map_err(|error| ProposalServiceError::io(error.to_string()))?
    {
        if entry
            .file_name()
            .to_str()
            .is_some_and(|candidate| candidate.eq_ignore_ascii_case(name))
        {
            return Ok(true);
        }
    }
    Ok(false)
}

struct DocumentWriteLock {
    path: PathBuf,
}

impl DocumentWriteLock {
    async fn acquire(root: &Path, relative_path: &str) -> Result<Self, ProposalServiceError> {
        let lock_dir = root.join(".kuku/knowledge/document-write-lock");
        tokio::fs::create_dir_all(&lock_dir)
            .await
            .map_err(|error| ProposalServiceError::io(error.to_string()))?;
        let lock_hash = hex::encode(Sha256::digest(relative_path.as_bytes()));
        let lock_path = lock_dir.join(format!("{lock_hash}.lock"));
        tokio::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&lock_path)
            .await
            .map_err(|error| {
                if error.kind() == std::io::ErrorKind::AlreadyExists {
                    ProposalServiceError {
                        code: KnowledgeErrorCode::ApplyInProgress,
                        message: "Decision document write is already in progress".to_string(),
                        details: None,
                    }
                } else {
                    ProposalServiceError::io(error.to_string())
                }
            })?;
        Ok(Self { path: lock_path })
    }
}

impl Drop for DocumentWriteLock {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

#[derive(Debug, Clone)]
struct NormalizedProposal {
    doc_id: String,
    proposal_id: String,
    title: String,
    context: Option<String>,
    request_source: ProposalRequestSource,
    status: String,
    created_at: String,
    updated_at: String,
    source_refs: Vec<SourceRef>,
    proposed_memories: Vec<NormalizedProposedMemory>,
    path_slug: String,
}

#[derive(Debug, Clone)]
struct NormalizedProposedMemory {
    change_id: String,
    memory_id: String,
    kind: Option<String>,
    title: String,
    body: String,
    tags: Vec<String>,
    source_refs: Vec<SourceRef>,
    decision_id: String,
    decision: NormalizedDecisionDraft,
}

#[derive(Debug, Clone)]
struct NormalizedDecisionDraft {
    question: String,
    selected_option_id: Option<DecisionOptionId>,
    other_text: Option<String>,
}

struct RenderedDecisionDocument {
    doc_id: String,
    proposal_id: String,
    title: String,
    markdown: String,
}

#[derive(Serialize)]
struct DecisionDocumentFrontmatter<'a> {
    id: &'a str,
    proposal_id: &'a str,
    target_kind: &'a str,
    request_source: ProposalRequestSource,
    status: &'a str,
    created_at: &'a str,
    updated_at: &'a str,
    source_refs: &'a [SourceRef],
}

#[derive(Serialize)]
struct MemoryProposalBlock<'a> {
    id: &'a str,
    operation: &'a str,
    memory: MemoryProposalMemory<'a>,
}

#[derive(Serialize)]
struct MemoryProposalMemory<'a> {
    id: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    kind: Option<&'a str>,
    title: &'a str,
    tags: &'a [String],
    body: &'a str,
    source_refs: &'a [SourceRef],
}

impl<'a> From<&'a NormalizedProposedMemory> for MemoryProposalBlock<'a> {
    fn from(value: &'a NormalizedProposedMemory) -> Self {
        Self {
            id: &value.change_id,
            operation: "create_memory",
            memory: MemoryProposalMemory {
                id: &value.memory_id,
                kind: value.kind.as_deref(),
                title: &value.title,
                tags: &value.tags,
                body: &value.body,
                source_refs: &value.source_refs,
            },
        }
    }
}

#[derive(Serialize)]
struct DecisionBlock<'a> {
    id: &'a str,
    proposal_id: &'a str,
    target_change_id: &'a str,
    question: &'a str,
    selection_mode: &'a str,
    required: bool,
    status: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    selected_option_id: Option<&'a str>,
    options: Vec<DecisionOptionBlock<'a>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    other_text: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    resolved_at: Option<&'a str>,
}

#[derive(Serialize)]
struct DecisionOptionBlock<'a> {
    id: &'a str,
    label: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    requires_input: Option<bool>,
}

impl<'a> DecisionBlock<'a> {
    fn from_parts(proposal: &'a NormalizedProposal, memory: &'a NormalizedProposedMemory) -> Self {
        Self {
            id: &memory.decision_id,
            proposal_id: &proposal.proposal_id,
            target_change_id: &memory.change_id,
            question: &memory.decision.question,
            selection_mode: "single",
            required: true,
            status: "pending",
            selected_option_id: memory
                .decision
                .selected_option_id
                .as_ref()
                .map(DecisionOptionId::as_str),
            options: vec![
                DecisionOptionBlock {
                    id: "yes",
                    label: "Yes",
                    requires_input: None,
                },
                DecisionOptionBlock {
                    id: "no",
                    label: "No",
                    requires_input: None,
                },
                DecisionOptionBlock {
                    id: "other",
                    label: "Other",
                    requires_input: Some(true),
                },
            ],
            other_text: memory.decision.other_text.as_deref(),
            resolved_at: None,
        }
    }
}

fn canonical_yaml<T: Serialize>(value: &T) -> Result<String, ProposalServiceError> {
    let mut yaml = serde_yaml::to_string(value)
        .map_err(|error| ProposalServiceError::io(error.to_string()))?;
    if let Some(stripped) = yaml.strip_prefix("---\n") {
        yaml = stripped.to_string();
    }
    if !yaml.ends_with('\n') {
        yaml.push('\n');
    }
    Ok(yaml)
}

fn ensure_one_final_newline(mut value: String) -> String {
    while value.ends_with('\n') {
        value.pop();
    }
    value.push('\n');
    value
}

fn render_decision_document(
    proposal: &NormalizedProposal,
) -> Result<RenderedDecisionDocument, ProposalServiceError> {
    Ok(RenderedDecisionDocument {
        doc_id: proposal.doc_id.clone(),
        proposal_id: proposal.proposal_id.clone(),
        title: proposal.title.clone(),
        markdown: render_decision_document_markdown(proposal)?,
    })
}

fn render_decision_document_markdown(
    proposal: &NormalizedProposal,
) -> Result<String, ProposalServiceError> {
    let frontmatter = DecisionDocumentFrontmatter {
        id: &proposal.doc_id,
        proposal_id: &proposal.proposal_id,
        target_kind: "memory",
        request_source: proposal.request_source.clone(),
        status: &proposal.status,
        created_at: &proposal.created_at,
        updated_at: &proposal.updated_at,
        source_refs: &proposal.source_refs,
    };
    let mut output = String::new();
    output.push_str("---\n");
    output.push_str(&canonical_yaml(&frontmatter)?);
    output.push_str("---\n\n");
    output.push_str("# Memory Proposal\n\n");
    output.push_str("## Context\n\n");
    if let Some(context) = proposal.context.as_deref() {
        output.push_str(context);
        output.push_str("\n\n");
    }
    output.push_str("## Source References\n\n");
    for source_ref in &proposal.source_refs {
        output.push_str("- ");
        output.push_str(&source_ref.path);
        output.push('\n');
    }
    output.push('\n');
    output.push_str("## Proposed Changes\n\n");
    for proposed in &proposal.proposed_memories {
        let block = MemoryProposalBlock::from(proposed);
        output.push_str("```kuku-memory-proposal\n");
        output.push_str(&canonical_yaml(&block)?);
        output.push_str("```\n\n");
    }
    output.push_str("## Decisions\n\n");
    for proposed in &proposal.proposed_memories {
        let block = DecisionBlock::from_parts(proposal, proposed);
        output.push_str("```kuku-decision\n");
        output.push_str(&canonical_yaml(&block)?);
        output.push_str("```\n\n");
    }
    output.push_str("## Notes\n\n");
    output.push_str("## Final Approval\n");
    Ok(ensure_one_final_newline(output))
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    use serde_json::json;
    use tauri::async_runtime;

    use super::*;
    use crate::knowledge::models::{
        CreateDecisionDocumentRequest, DecisionOptionId, ProposalDefaultSelection,
        ProposedDecisionInput, ProposedMemoryInput,
    };

    static TEST_COUNTER: AtomicU64 = AtomicU64::new(0);

    #[test]
    fn create_decision_document_writes_decision_doc_only() {
        let root = temp_vault();
        let request = request_with_one_memory();

        let result = async_runtime::block_on(create_decision_document_for_root(
            &root,
            request,
            ProposalRequestSource::UiCommand,
        ))
        .unwrap();

        assert!(result.created);
        assert!(result.should_open);
        assert!(result.path.starts_with("Knowledge/decisions/"));
        assert!(root.join(&result.path).is_file());
        assert!(root.join("Knowledge/memory").is_dir());
        assert_eq!(
            fs::read_dir(root.join("Knowledge/memory")).unwrap().count(),
            0
        );

        let markdown = fs::read_to_string(root.join(&result.path)).unwrap();
        assert!(markdown.contains("request_source: ui_command"));
        assert!(markdown.contains("```kuku-memory-proposal"));
        assert!(markdown.contains("```kuku-decision"));
        assert!(markdown.contains("selected_option_id: yes"));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn default_selection_none_leaves_decision_unselected() {
        let now = UNIX_EPOCH + Duration::from_secs(1);
        let mut request = request_with_one_memory();
        request.default_selection = ProposalDefaultSelection::None;

        let normalized = normalize_request(request, ProposalRequestSource::UiCommand, now).unwrap();
        let markdown = render_decision_document_markdown(&normalized).unwrap();

        assert!(!markdown.contains("selected_option_id"));
    }

    #[test]
    fn draft_other_without_text_is_allowed_at_creation() {
        let now = UNIX_EPOCH + Duration::from_secs(1);
        let mut request = request_with_one_memory();
        request.proposed_memories[0].decision = Some(ProposedDecisionInput {
            question: None,
            selected_option_id: Some(DecisionOptionId::Other),
            other_text: None,
        });

        let normalized = normalize_request(request, ProposalRequestSource::AiTool, now).unwrap();
        let markdown = render_decision_document_markdown(&normalized).unwrap();

        assert!(markdown.contains("selected_option_id: other"));
    }

    #[test]
    fn duplicate_memory_title_ids_retry_inside_document() {
        let now = UNIX_EPOCH + Duration::from_secs(1);
        let mut request = request_with_one_memory();
        request.proposed_memories.push(ProposedMemoryInput {
            suggested_id: None,
            kind: None,
            title: "Session cookie first".to_string(),
            body: "Second memory body.".to_string(),
            tags: vec![],
            source_refs: vec![],
            decision: None,
        });

        let normalized = normalize_request(request, ProposalRequestSource::UiCommand, now).unwrap();
        let markdown = render_decision_document_markdown(&normalized).unwrap();

        assert!(markdown.contains("id: mem_session_cookie_first\n"));
        assert!(markdown.contains("id: mem_session_cookie_first_2\n"));
    }

    #[test]
    fn proposal_validation_rejects_empty_and_too_many_memories() {
        let now = UNIX_EPOCH + Duration::from_secs(1);
        let mut empty = request_with_one_memory();
        empty.proposed_memories.clear();
        assert!(normalize_request(empty, ProposalRequestSource::UiCommand, now).is_err());

        let mut too_many = request_with_one_memory();
        too_many.proposed_memories = (0..=MAX_PROPOSED_MEMORIES)
            .map(|index| ProposedMemoryInput {
                suggested_id: None,
                kind: None,
                title: format!("Memory {index}"),
                body: "Body".to_string(),
                tags: vec![],
                source_refs: vec![],
                decision: None,
            })
            .collect();
        assert!(normalize_request(too_many, ProposalRequestSource::UiCommand, now).is_err());
    }

    #[test]
    fn request_deserialization_rejects_unknown_fields() {
        let value = json!({
            "proposed_memories": [
                {
                    "title": "Memory",
                    "body": "Body",
                    "unexpected": true
                }
            ]
        });

        assert!(serde_json::from_value::<CreateDecisionDocumentRequest>(value).is_err());
    }

    #[test]
    fn verification_failure_details_include_cleanup_metadata_when_cleanup_fails() {
        let details = verification_failure_details(
            "Knowledge/decisions/2026-05-07-auth.md",
            "sha256:expected",
            "sha256:actual",
            true,
        );

        assert_eq!(details["expected_checksum"], "sha256:expected");
        assert_eq!(details["actual_checksum"], "sha256:actual");
        assert_eq!(details["cleanup_required"], true);
        assert_eq!(
            details["created_paths"],
            json!(["Knowledge/decisions/2026-05-07-auth.md"])
        );
    }

    #[test]
    fn publish_retries_path_collision_with_suffix() {
        let root = temp_vault();
        let now = UNIX_EPOCH + Duration::from_secs(1);
        let timestamp = format_path_timestamp(now);
        let dir = root.join("Knowledge/decisions");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join(format!("{timestamp}-auth.md")), "existing").unwrap();
        let rendered = RenderedDecisionDocument {
            doc_id: "doc_auth".to_string(),
            proposal_id: "prop_auth".to_string(),
            title: "Auth".to_string(),
            markdown: "---\nid: doc_auth\n---\n".to_string(),
        };

        let result =
            async_runtime::block_on(publish_decision_document(&root, "auth", rendered, now))
                .unwrap();

        assert!(result.path.ends_with("-auth-2.md"));
        assert!(root.join(result.path).is_file());

        let _ = fs::remove_dir_all(root);
    }

    fn request_with_one_memory() -> CreateDecisionDocumentRequest {
        CreateDecisionDocumentRequest {
            title: Some("Auth".to_string()),
            context: Some("Context".to_string()),
            source_refs: vec![],
            proposed_memories: vec![ProposedMemoryInput {
                suggested_id: None,
                kind: Some("decision".to_string()),
                title: "Session cookie first".to_string(),
                body: "Use session cookie auth before OAuth.".to_string(),
                tags: vec![" auth ".to_string(), "".to_string()],
                source_refs: vec![],
                decision: None,
            }],
            request_source: None,
            default_selection: ProposalDefaultSelection::Yes,
        }
    }

    fn temp_vault() -> PathBuf {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis();
        let seq = TEST_COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("kuku-knowledge-proposal-test-{now}-{seq}"));
        fs::create_dir_all(&dir).unwrap();
        dir
    }
}
