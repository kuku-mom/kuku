use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use serde::{Deserialize, Serialize};
use serde_json::{Value as JsonValue, json};
use serde_yaml::{Mapping, Value};
use sha2::{Digest, Sha256};
use tokio::io::AsyncWriteExt;

use crate::knowledge::decision_document::{
    DecisionBlock, DecisionDocumentError, MemoryProposalBlock, ParsedDecisionDocument,
    ParsedKukuBlock, parse_decision_document, render_decision_document,
    validate_decision_document_integrity,
};
use crate::knowledge::markdown::{
    format_utc_timestamp, serialize_memory_item, sha256_checksum_bytes,
    validate_safe_vault_relative_path, validate_sha256_checksum,
};
use crate::knowledge::models::{
    ApplyDecisionDocumentRequest, ApplyDecisionDocumentResult, ApplyDecisionDocumentStatus,
    DecisionOptionId, KnowledgeErrorCode, MemoryItem, MemoryStatus,
};

#[cfg(test)]
const LOCK_STALE_AFTER: Duration = Duration::from_secs(1);
#[cfg(not(test))]
const LOCK_STALE_AFTER: Duration = Duration::from_secs(30 * 60);

#[derive(Debug, Clone)]
pub struct ApplyServiceError {
    pub code: KnowledgeErrorCode,
    pub message: String,
    pub details: Option<JsonValue>,
}

impl ApplyServiceError {
    fn validation(message: impl Into<String>) -> Self {
        Self {
            code: KnowledgeErrorCode::ValidationFailed,
            message: message.into(),
            details: None,
        }
    }

    fn document_changed(message: impl Into<String>) -> Self {
        Self {
            code: KnowledgeErrorCode::DocumentChanged,
            message: message.into(),
            details: None,
        }
    }

    fn apply_in_progress(message: impl Into<String>) -> Self {
        Self {
            code: KnowledgeErrorCode::ApplyInProgress,
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

    fn not_pending(message: impl Into<String>) -> Self {
        Self {
            code: KnowledgeErrorCode::NotPending,
            message: message.into(),
            details: None,
        }
    }

    fn apply_recovery_required(message: impl Into<String>) -> Self {
        Self {
            code: KnowledgeErrorCode::ApplyRecoveryRequired,
            message: message.into(),
            details: None,
        }
    }

    fn apply_failed(message: impl Into<String>) -> Self {
        Self {
            code: KnowledgeErrorCode::ApplyFailed,
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

    fn with_details(mut self, details: JsonValue) -> Self {
        self.details = Some(details);
        self
    }
}

impl From<DecisionDocumentError> for ApplyServiceError {
    fn from(value: DecisionDocumentError) -> Self {
        Self {
            code: value.code,
            message: value.message,
            details: None,
        }
    }
}

pub async fn apply_decision_document_for_root(
    root: &Path,
    request: ApplyDecisionDocumentRequest,
) -> Result<ApplyDecisionDocumentResult, ApplyServiceError> {
    validate_apply_request(&request)?;
    let relative_path = validate_decision_document_path(&request.path)?;
    let path = root.join(&relative_path);
    let initial_markdown = tokio::fs::read_to_string(&path)
        .await
        .map_err(|error| ApplyServiceError::io(error.to_string()))?;
    let initial_document = parse_decision_document(&initial_markdown)?;
    let doc_id = initial_document.frontmatter.id.clone();

    let apply_lock = ApplyLock::acquire(root, &doc_id).await?;
    let document_lock = DocumentWriteLock::acquire(root, &relative_path).await?;

    let result = apply_decision_document_with_locks(root, &path, &relative_path, request).await;

    drop(document_lock);
    drop(apply_lock);

    result
}

async fn apply_decision_document_with_locks(
    root: &Path,
    path: &Path,
    relative_path: &str,
    request: ApplyDecisionDocumentRequest,
) -> Result<ApplyDecisionDocumentResult, ApplyServiceError> {
    let current_markdown = tokio::fs::read_to_string(path)
        .await
        .map_err(|error| ApplyServiceError::io(error.to_string()))?;
    let current_checksum = sha256_checksum_bytes(current_markdown.as_bytes());
    let mut document = parse_decision_document(&current_markdown)?;
    let existing_journal_path = journal_path(root, &document.frontmatter.id);
    if let Some(journal) = read_journal(&existing_journal_path).await? {
        match handle_existing_journal(
            ExistingJournalContext {
                root,
                decision_document_path: path,
                relative_decision_document_path: relative_path,
                request: &request,
                current_checksum: &current_checksum,
                journal_path: &existing_journal_path,
            },
            &mut document,
            journal,
        )
        .await?
        {
            ExistingJournalAction::ContinueNormalApply => {}
            ExistingJournalAction::Return(result) => return Ok(result),
        }
    }

    if current_checksum != request.expected_checksum {
        return Err(ApplyServiceError::document_changed(
            "Decision document changed before apply",
        ));
    }

    if document.frontmatter.status != "pending" {
        return Err(ApplyServiceError::not_pending(
            "Decision document is not pending",
        ));
    }
    validate_decision_document_integrity(&document, Some(root))?;

    let outcomes = collect_decision_outcomes(&document)?;
    let document_status = document_status_for_outcomes(&outcomes);
    let resolved_at = format_utc_timestamp(SystemTime::now());
    if outcomes
        .iter()
        .any(|outcome| outcome.selected == DecisionOptionId::Yes)
    {
        return apply_with_memory_writes(MemoryWriteApplyInput {
            root,
            decision_document_path: path,
            relative_decision_document_path: relative_path,
            decision_document_checksum_before: current_checksum,
            document,
            outcomes,
            document_status,
            resolved_at,
        })
        .await;
    }

    apply_decision_updates(
        &mut document,
        &outcomes,
        document_status.as_str(),
        &resolved_at,
    );
    let next_markdown = render_decision_document(&document)?;

    guarded_replace_file(path, current_checksum, next_markdown.as_bytes()).await?;

    Ok(ApplyDecisionDocumentResult {
        doc_id: document.frontmatter.id,
        path: relative_path.to_string(),
        status: document_status,
        committed_memory_paths: vec![],
        rejected_decision_ids: outcomes
            .iter()
            .filter(|outcome| outcome.selected == DecisionOptionId::No)
            .map(|outcome| outcome.decision_id.clone())
            .collect(),
        needs_revision_decision_ids: outcomes
            .iter()
            .filter(|outcome| outcome.selected == DecisionOptionId::Other)
            .map(|outcome| outcome.decision_id.clone())
            .collect(),
        recovered_from_journal: false,
        warnings: vec![],
        journal_cleanup_required: None,
        journal_path: None,
    })
}

enum ExistingJournalAction {
    ContinueNormalApply,
    Return(ApplyDecisionDocumentResult),
}

struct ExistingJournalContext<'a> {
    root: &'a Path,
    decision_document_path: &'a Path,
    relative_decision_document_path: &'a str,
    request: &'a ApplyDecisionDocumentRequest,
    current_checksum: &'a str,
    journal_path: &'a Path,
}

async fn handle_existing_journal(
    context: ExistingJournalContext<'_>,
    document: &mut ParsedDecisionDocument,
    journal: ApplyJournal,
) -> Result<ExistingJournalAction, ApplyServiceError> {
    match journal.state {
        ApplyJournalState::Staged => {
            recover_staged_journal(context.root, context.journal_path, journal).await?;
            Ok(ExistingJournalAction::ContinueNormalApply)
        }
        ApplyJournalState::Finalized => {
            if document.frontmatter.status != "pending" {
                cleanup_completed_orphan_journal(
                    context.root,
                    document,
                    context.journal_path,
                    journal,
                )
                .await?;
                return Ok(ExistingJournalAction::ContinueNormalApply);
            }
            if !context.request.recover {
                return Err(ApplyServiceError::apply_recovery_required(
                    "Finalized apply journal requires recovery",
                )
                .with_details(recovery_error_details(&journal)));
            }
            match validate_finalized_journal_match(
                context.root,
                context.relative_decision_document_path,
                context.request,
                context.current_checksum,
                document,
                &journal,
            )
            .await
            {
                Ok(()) => {
                    let result = recover_finalized_journal(
                        context.root,
                        context.decision_document_path,
                        context.current_checksum,
                        document,
                        context.journal_path,
                        journal,
                    )
                    .await?;
                    Ok(ExistingJournalAction::Return(result))
                }
                Err(reason) => {
                    let error = handle_finalized_journal_mismatch(
                        context.decision_document_path,
                        context.current_checksum,
                        context.request,
                        document,
                        context.journal_path,
                        journal,
                        reason,
                    )
                    .await;
                    Err(error)
                }
            }
        }
        ApplyJournalState::DocumentSaved => {
            remove_journal_file(context.journal_path)
                .await
                .map_err(|error| {
                    ApplyServiceError::not_pending("Decision document is not pending").with_details(
                        json!({
                            "journal_path": journal_vault_path(&journal.doc_id),
                            "journal_cleanup_required": true,
                            "cleanup_error": error.message,
                        }),
                    )
                })?;
            Ok(ExistingJournalAction::ContinueNormalApply)
        }
        ApplyJournalState::CleanupRequired => Err(ApplyServiceError::apply_recovery_required(
            "Apply journal requires manual cleanup",
        )
        .with_details(recovery_error_details(&journal))),
    }
}

async fn recover_staged_journal(
    root: &Path,
    journal_path: &Path,
    journal: ApplyJournal,
) -> Result<(), ApplyServiceError> {
    if journal.created_paths.is_empty() && journal.inflight_publish_path.is_none() {
        cleanup_staging_dir(root, &journal.doc_id)
            .await
            .map_err(|error| {
                ApplyServiceError::apply_recovery_required("Staged apply journal cleanup failed")
                    .with_details(json!({
                        "journal_path": journal_vault_path(&journal.doc_id),
                        "cleanup_error": error.message,
                    }))
            })?;
        remove_journal_file(journal_path).await.map_err(|error| {
            ApplyServiceError::apply_recovery_required("Staged apply journal cleanup failed")
                .with_details(json!({
                    "journal_path": journal_vault_path(&journal.doc_id),
                    "cleanup_error": error.message,
                }))
        })?;
        return Ok(());
    }

    rollback_staged_journal(root, journal_path, journal).await
}

async fn rollback_staged_journal(
    root: &Path,
    journal_path: &Path,
    journal: ApplyJournal,
) -> Result<(), ApplyServiceError> {
    let mut rollback_candidates = journal
        .created_paths
        .iter()
        .cloned()
        .collect::<BTreeSet<_>>();
    if let Some(inflight_path) = journal.inflight_publish_path.as_deref() {
        if !journal
            .planned_memory_paths
            .iter()
            .any(|path| path == inflight_path)
        {
            return Err(persist_cleanup_required_error(
                journal_path,
                journal.clone(),
                format!("Inflight publish path is not planned: {inflight_path}"),
                KnowledgeErrorCode::ApplyRecoveryRequired,
            )
            .await);
        }
        let Some(checksum) = journal.memory_checksums.get(inflight_path) else {
            return Err(persist_cleanup_required_error(
                journal_path,
                journal.clone(),
                format!("Inflight publish path has no checksum: {inflight_path}"),
                KnowledgeErrorCode::ApplyRecoveryRequired,
            )
            .await);
        };
        match journal_path_state(root, inflight_path, checksum).await? {
            JournalPathState::ChecksumMatch => {
                rollback_candidates.insert(inflight_path.to_string());
            }
            JournalPathState::Missing => {}
            JournalPathState::ChecksumMismatch => {
                return Err(persist_cleanup_required_error(
                    journal_path,
                    journal.clone(),
                    format!("Inflight publish checksum mismatch: {inflight_path}"),
                    KnowledgeErrorCode::ApplyRecoveryRequired,
                )
                .await);
            }
        }
    }

    for candidate in rollback_candidates {
        if !journal
            .planned_memory_paths
            .iter()
            .any(|path| path == &candidate)
        {
            return Err(persist_cleanup_required_error(
                journal_path,
                journal.clone(),
                format!("Created path is not planned: {candidate}"),
                KnowledgeErrorCode::ApplyRecoveryRequired,
            )
            .await);
        }
        let Some(checksum) = journal.memory_checksums.get(&candidate) else {
            return Err(persist_cleanup_required_error(
                journal_path,
                journal.clone(),
                format!("Created path has no checksum: {candidate}"),
                KnowledgeErrorCode::ApplyRecoveryRequired,
            )
            .await);
        };
        match journal_path_state(root, &candidate, checksum).await? {
            JournalPathState::ChecksumMatch => {
                if let Err(error) = tokio::fs::remove_file(root.join(&candidate)).await {
                    return Err(persist_cleanup_required_error(
                        journal_path,
                        journal.clone(),
                        format!("Failed to rollback created memory path {candidate}: {error}"),
                        KnowledgeErrorCode::ApplyRecoveryRequired,
                    )
                    .await);
                }
            }
            JournalPathState::Missing => {}
            JournalPathState::ChecksumMismatch => {
                return Err(persist_cleanup_required_error(
                    journal_path,
                    journal.clone(),
                    format!("Created path checksum mismatch: {candidate}"),
                    KnowledgeErrorCode::ApplyRecoveryRequired,
                )
                .await);
            }
        }
    }

    if let Err(error) = cleanup_staging_dir(root, &journal.doc_id).await {
        return Err(persist_cleanup_required_error(
            journal_path,
            journal.clone(),
            error.message,
            KnowledgeErrorCode::ApplyRecoveryRequired,
        )
        .await);
    }
    if let Err(error) = remove_journal_file(journal_path).await {
        return Err(persist_cleanup_required_error(
            journal_path,
            journal.clone(),
            error.message,
            KnowledgeErrorCode::ApplyRecoveryRequired,
        )
        .await);
    }
    Ok(())
}

async fn rollback_after_publish_journal_update_failure(
    root: &Path,
    journal_path: &Path,
    journal: ApplyJournal,
    original_error: ApplyServiceError,
) -> ApplyServiceError {
    match rollback_staged_journal(root, journal_path, journal).await {
        Ok(()) => original_error,
        Err(mut rollback_error) => {
            rollback_error.code = KnowledgeErrorCode::ApplyFailed;
            rollback_error.message = format!(
                "Journal update failed after publish and rollback did not complete: {}",
                rollback_error.message
            );
            rollback_error
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum JournalPathState {
    Missing,
    ChecksumMatch,
    ChecksumMismatch,
}

async fn journal_path_state(
    root: &Path,
    relative_path: &str,
    expected_checksum: &str,
) -> Result<JournalPathState, ApplyServiceError> {
    validate_safe_vault_relative_path(relative_path, "journal memory path")
        .map_err(|error| ApplyServiceError::validation(error.message))?;
    let bytes = match tokio::fs::read(root.join(relative_path)).await {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(JournalPathState::Missing);
        }
        Err(error) => return Err(ApplyServiceError::io(error.to_string())),
    };
    if sha256_checksum_bytes(&bytes) == expected_checksum {
        Ok(JournalPathState::ChecksumMatch)
    } else {
        Ok(JournalPathState::ChecksumMismatch)
    }
}

async fn validate_finalized_journal_match(
    root: &Path,
    relative_decision_document_path: &str,
    request: &ApplyDecisionDocumentRequest,
    current_checksum: &str,
    document: &ParsedDecisionDocument,
    journal: &ApplyJournal,
) -> Result<(), String> {
    if journal.doc_id != document.frontmatter.id {
        return Err("Journal doc_id does not match decision document".to_string());
    }
    if journal.proposal_id != document.frontmatter.proposal_id {
        return Err("Journal proposal_id does not match decision document".to_string());
    }
    if journal.decision_document_path != relative_decision_document_path {
        return Err("Journal decision document path does not match request path".to_string());
    }
    if current_checksum != request.expected_checksum {
        return Err("Decision document checksum does not match request".to_string());
    }
    if current_checksum != journal.decision_document_checksum_before {
        return Err("Decision document checksum does not match finalized journal".to_string());
    }

    for path in &journal.finalized_memory_paths {
        let Some(checksum) = journal.memory_checksums.get(path) else {
            return Err(format!("Finalized memory path has no checksum: {path}"));
        };
        match journal_path_state(root, path, checksum)
            .await
            .map_err(|error| error.message)?
        {
            JournalPathState::ChecksumMatch => {}
            JournalPathState::Missing => {
                return Err(format!("Finalized memory path is missing: {path}"));
            }
            JournalPathState::ChecksumMismatch => {
                return Err(format!("Finalized memory checksum mismatch: {path}"));
            }
        }
    }

    let decision_counts = decision_id_counts(document);
    for result in &journal.decision_results {
        if decision_counts
            .get(result.decision_id.as_str())
            .copied()
            .unwrap_or(0)
            != 1
        {
            return Err(format!(
                "Journal decision id is missing or duplicated: {}",
                result.decision_id
            ));
        }
    }

    let finalized_paths = journal
        .finalized_memory_paths
        .iter()
        .map(String::as_str)
        .collect::<BTreeSet<_>>();
    if let Ok(outcomes) = collect_decision_outcomes(document) {
        for outcome in outcomes {
            let Some(memory_path) = outcome.memory_path else {
                continue;
            };
            if finalized_paths.contains(memory_path.as_str()) {
                continue;
            }
            match journal_path_state(root, &memory_path, "sha256:unused").await {
                Ok(JournalPathState::Missing) => {}
                Ok(_) => {
                    return Err(format!(
                        "Memory target collision is not covered by finalized journal: {memory_path}"
                    ));
                }
                Err(error) => return Err(error.message),
            }
        }
    }

    Ok(())
}

fn decision_id_counts(document: &ParsedDecisionDocument) -> BTreeMap<&str, usize> {
    let mut counts = BTreeMap::new();
    for decision in document.decision_blocks() {
        *counts.entry(decision.value.id.as_str()).or_insert(0) += 1;
    }
    counts
}

async fn recover_finalized_journal(
    root: &Path,
    decision_document_path: &Path,
    current_checksum: &str,
    document: &mut ParsedDecisionDocument,
    journal_path: &Path,
    mut journal: ApplyJournal,
) -> Result<ApplyDecisionDocumentResult, ApplyServiceError> {
    let outcomes = outcomes_from_journal(&journal);
    let document_status = document_status_for_outcomes(&outcomes);
    apply_decision_updates(
        document,
        &outcomes,
        document_status.as_str(),
        &journal.created_at,
    );
    let next_markdown = render_decision_document(document)?;
    guarded_replace_file(
        decision_document_path,
        current_checksum.to_string(),
        next_markdown.as_bytes(),
    )
    .await
    .map_err(|error| {
        ApplyServiceError::apply_recovery_required(
            "Finalized journal recovery could not save decision document",
        )
        .with_details(json!({
            "journal_path": journal_vault_path(&journal.doc_id),
            "save_error": error.message,
        }))
    })?;

    let mut warnings = Vec::new();
    journal.state = ApplyJournalState::DocumentSaved;
    journal.updated_at = format_utc_timestamp(SystemTime::now());
    if let Err(error) = write_journal_atomic(journal_path, &journal).await {
        warnings.push(format!(
            "Recovered decision document, but journal update failed: {}",
            error.message
        ));
        return Ok(apply_result_from_outcomes(ApplyResultInput {
            doc_id: &journal.doc_id,
            path: &journal.decision_document_path,
            status: document_status,
            outcomes: &outcomes,
            committed_memory_paths: journal.finalized_memory_paths.clone(),
            recovered_from_journal: true,
            warnings,
            journal_cleanup_required: Some(true),
            journal_path: Some(journal_vault_path(&journal.doc_id)),
        }));
    }
    if let Err(error) = remove_journal_file(journal_path).await {
        warnings.push(format!(
            "Recovered decision document, but journal cleanup failed: {}",
            error.message
        ));
        return Ok(apply_result_from_outcomes(ApplyResultInput {
            doc_id: &journal.doc_id,
            path: &journal.decision_document_path,
            status: document_status,
            outcomes: &outcomes,
            committed_memory_paths: journal.finalized_memory_paths.clone(),
            recovered_from_journal: true,
            warnings,
            journal_cleanup_required: Some(true),
            journal_path: Some(journal_vault_path(&journal.doc_id)),
        }));
    }
    if let Err(error) = cleanup_staging_dir(root, &journal.doc_id).await {
        warnings.push(format!(
            "Recovered decision document, but staging cleanup failed: {}",
            error.message
        ));
    }

    Ok(apply_result_from_outcomes(ApplyResultInput {
        doc_id: &journal.doc_id,
        path: &journal.decision_document_path,
        status: document_status,
        outcomes: &outcomes,
        committed_memory_paths: journal.finalized_memory_paths.clone(),
        recovered_from_journal: true,
        warnings,
        journal_cleanup_required: None,
        journal_path: None,
    }))
}

async fn handle_finalized_journal_mismatch(
    decision_document_path: &Path,
    current_checksum: &str,
    request: &ApplyDecisionDocumentRequest,
    document: &mut ParsedDecisionDocument,
    journal_path: &Path,
    journal: ApplyJournal,
    reason: String,
) -> ApplyServiceError {
    let journal_update = persist_cleanup_required(journal_path, journal.clone(), &reason).await;
    if current_checksum == request.expected_checksum {
        mark_document_apply_failed(document, &reason);
        match render_decision_document(document) {
            Ok(markdown) => {
                if guarded_replace_file(
                    decision_document_path,
                    current_checksum.to_string(),
                    markdown.as_bytes(),
                )
                .await
                .is_err()
                {
                    return ApplyServiceError::apply_recovery_required(
                        "Finalized journal mismatch requires recovery",
                    )
                    .with_details(recovery_error_details(&journal));
                }
            }
            Err(error) => {
                return ApplyServiceError::apply_recovery_required(error.message)
                    .with_details(recovery_error_details(&journal));
            }
        }
        if let Ok(cleanup_journal) = journal_update {
            return ApplyServiceError::apply_failed(
                "Finalized journal mismatch marked decision document apply_failed",
            )
            .with_details(recovery_error_details(&cleanup_journal));
        }
        return ApplyServiceError::apply_failed(
            "Finalized journal mismatch could not persist cleanup_required journal",
        )
        .with_details(json!({
            "journal_path": journal_vault_path(&journal.doc_id),
            "created_paths": &journal.created_paths,
            "cleanup_required": true,
        }));
    }

    match journal_update {
        Ok(cleanup_journal) => ApplyServiceError::apply_recovery_required(
            "Finalized journal mismatch requires recovery",
        )
        .with_details(recovery_error_details(&cleanup_journal)),
        Err(error) => ApplyServiceError::apply_recovery_required(error.message)
            .with_details(recovery_error_details(&journal)),
    }
}

async fn cleanup_completed_orphan_journal(
    root: &Path,
    document: &ParsedDecisionDocument,
    journal_path: &Path,
    journal: ApplyJournal,
) -> Result<(), ApplyServiceError> {
    if !completed_orphan_matches(root, document, &journal).await? {
        return Err(ApplyServiceError::apply_recovery_required(
            "Finalized journal does not match completed decision document",
        )
        .with_details(recovery_error_details(&journal)));
    }
    remove_journal_file(journal_path).await.map_err(|error| {
        ApplyServiceError::not_pending("Decision document is not pending").with_details(json!({
            "journal_path": journal_vault_path(&journal.doc_id),
            "journal_cleanup_required": true,
            "cleanup_error": error.message,
        }))
    })
}

async fn completed_orphan_matches(
    root: &Path,
    document: &ParsedDecisionDocument,
    journal: &ApplyJournal,
) -> Result<bool, ApplyServiceError> {
    if !matches!(
        document.frontmatter.status.as_str(),
        "applied" | "partially_applied" | "needs_revision"
    ) {
        return Ok(false);
    }
    for path in &journal.finalized_memory_paths {
        let Some(checksum) = journal.memory_checksums.get(path) else {
            return Ok(false);
        };
        if journal_path_state(root, path, checksum).await? != JournalPathState::ChecksumMatch {
            return Ok(false);
        }
    }

    let status_by_decision = journal
        .decision_results
        .iter()
        .map(|result| (result.decision_id.as_str(), result.status.as_str()))
        .collect::<BTreeMap<_, _>>();
    if document.decision_blocks().count() != status_by_decision.len() {
        return Ok(false);
    }
    for decision in document.decision_blocks() {
        let Some(expected_status) = status_by_decision.get(decision.value.id.as_str()) else {
            return Ok(false);
        };
        if decision.value.status != *expected_status {
            return Ok(false);
        }
    }
    Ok(true)
}

fn outcomes_from_journal(journal: &ApplyJournal) -> Vec<ZeroWriteOutcome> {
    journal
        .decision_results
        .iter()
        .map(|result| ZeroWriteOutcome {
            decision_id: result.decision_id.clone(),
            target_change_id: result.target_change_id.clone(),
            selected: result.selected_option_id.clone(),
            memory_path: result.memory_path.clone(),
        })
        .collect()
}

struct ApplyResultInput<'a> {
    doc_id: &'a str,
    path: &'a str,
    status: ApplyDecisionDocumentStatus,
    outcomes: &'a [ZeroWriteOutcome],
    committed_memory_paths: Vec<String>,
    recovered_from_journal: bool,
    warnings: Vec<String>,
    journal_cleanup_required: Option<bool>,
    journal_path: Option<String>,
}

fn apply_result_from_outcomes(input: ApplyResultInput<'_>) -> ApplyDecisionDocumentResult {
    ApplyDecisionDocumentResult {
        doc_id: input.doc_id.to_string(),
        path: input.path.to_string(),
        status: input.status,
        committed_memory_paths: input.committed_memory_paths,
        rejected_decision_ids: input
            .outcomes
            .iter()
            .filter(|outcome| outcome.selected == DecisionOptionId::No)
            .map(|outcome| outcome.decision_id.clone())
            .collect(),
        needs_revision_decision_ids: input
            .outcomes
            .iter()
            .filter(|outcome| outcome.selected == DecisionOptionId::Other)
            .map(|outcome| outcome.decision_id.clone())
            .collect(),
        recovered_from_journal: input.recovered_from_journal,
        warnings: input.warnings,
        journal_cleanup_required: input.journal_cleanup_required,
        journal_path: input.journal_path,
    }
}

fn mark_document_apply_failed(document: &mut ParsedDecisionDocument, error: &str) {
    let updated_at = format_utc_timestamp(SystemTime::now());
    document.frontmatter.status = "apply_failed".to_string();
    document.frontmatter.updated_at = updated_at.clone();
    set_frontmatter_string(&mut document.frontmatter.raw, "status", "apply_failed");
    set_frontmatter_string(&mut document.frontmatter.raw, "updated_at", &updated_at);
    set_frontmatter_string(&mut document.frontmatter.raw, "last_apply_error", error);
}

async fn persist_cleanup_required(
    journal_path: &Path,
    mut journal: ApplyJournal,
    error: &str,
) -> Result<ApplyJournal, ApplyServiceError> {
    journal.state = ApplyJournalState::CleanupRequired;
    journal.error = Some(error.to_string());
    journal.updated_at = format_utc_timestamp(SystemTime::now());
    write_journal_atomic(journal_path, &journal).await?;
    Ok(journal)
}

async fn persist_cleanup_required_error(
    journal_path: &Path,
    journal: ApplyJournal,
    message: String,
    code: KnowledgeErrorCode,
) -> ApplyServiceError {
    match persist_cleanup_required(journal_path, journal.clone(), &message).await {
        Ok(cleanup_journal) => ApplyServiceError {
            code,
            message,
            details: Some(recovery_error_details(&cleanup_journal)),
        },
        Err(error) => {
            ApplyServiceError::apply_failed("Could not persist cleanup_required apply journal")
                .with_details(json!({
                    "journal_path": journal_vault_path(&journal.doc_id),
                    "created_paths": &journal.created_paths,
                    "cleanup_required": true,
                    "journal_update_error": error.message,
                }))
        }
    }
}

#[cfg(test)]
async fn consume_test_failpoint(root: &Path, name: &str) -> Result<bool, ApplyServiceError> {
    let path = root.join(".kuku/knowledge/test-failpoints").join(name);
    match tokio::fs::remove_file(&path).await {
        Ok(()) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(ApplyServiceError::io(error.to_string())),
    }
}

#[cfg(not(test))]
async fn consume_test_failpoint(_root: &Path, _name: &str) -> Result<bool, ApplyServiceError> {
    Ok(false)
}

fn validate_apply_request(request: &ApplyDecisionDocumentRequest) -> Result<(), ApplyServiceError> {
    if request.source != "editor_document_apply" {
        return Err(ApplyServiceError::validation(
            "Unsupported decision document apply source",
        ));
    }
    validate_sha256_checksum(&request.expected_checksum, "expected_checksum")
        .map_err(|error| ApplyServiceError::validation(error.message))?;
    Ok(())
}

fn validate_decision_document_path(path: &str) -> Result<String, ApplyServiceError> {
    let path = validate_safe_vault_relative_path(path, "path")
        .map_err(|error| ApplyServiceError::validation(error.message))?;
    if !path.starts_with("Knowledge/decisions/") {
        return Err(ApplyServiceError::validation(
            "Decision document path must be under Knowledge/decisions/",
        ));
    }
    Ok(path)
}

#[derive(Debug, Clone)]
struct ZeroWriteOutcome {
    decision_id: String,
    target_change_id: String,
    selected: DecisionOptionId,
    memory_path: Option<String>,
}

fn collect_decision_outcomes(
    document: &ParsedDecisionDocument,
) -> Result<Vec<ZeroWriteOutcome>, ApplyServiceError> {
    let proposal_by_id = document
        .proposal_blocks()
        .map(|proposal| (proposal.value.id.as_str(), &proposal.value))
        .collect::<BTreeMap<_, _>>();
    let mut outcomes = Vec::new();
    for decision in document.decision_blocks() {
        let selected = selected_decision_option(&decision.value)?;
        if selected == DecisionOptionId::Other {
            let other_text = decision.value.other_text.as_deref().unwrap_or_default();
            if other_text.trim().is_empty() {
                return Err(ApplyServiceError::validation(
                    "Other decisions require non-empty other_text",
                ));
            }
        }
        let memory_path = if selected == DecisionOptionId::Yes {
            let proposal = proposal_by_id
                .get(decision.value.target_change_id.as_str())
                .ok_or_else(|| {
                    ApplyServiceError::validation("Decision target has no memory proposal")
                })?;
            Some(memory_path_for_id(&proposal.memory.id))
        } else {
            None
        };
        outcomes.push(ZeroWriteOutcome {
            decision_id: decision.value.id.clone(),
            target_change_id: decision.value.target_change_id.clone(),
            selected,
            memory_path,
        });
    }
    Ok(outcomes)
}

fn selected_decision_option(block: &DecisionBlock) -> Result<DecisionOptionId, ApplyServiceError> {
    match block.selected_option_id.as_deref() {
        Some("yes") => Ok(DecisionOptionId::Yes),
        Some("no") => Ok(DecisionOptionId::No),
        Some("other") => Ok(DecisionOptionId::Other),
        Some(value) => Err(ApplyServiceError::validation(format!(
            "Unsupported selected option id: {value}"
        ))),
        None => Err(ApplyServiceError::validation(
            "Required decision is missing selected_option_id",
        )),
    }
}

fn memory_path_for_id(memory_id: &str) -> String {
    format!("Knowledge/memory/{memory_id}.md")
}

fn document_status_for_outcomes(outcomes: &[ZeroWriteOutcome]) -> ApplyDecisionDocumentStatus {
    let has_committed = outcomes
        .iter()
        .any(|outcome| outcome.selected == DecisionOptionId::Yes);
    let has_needs_revision = outcomes
        .iter()
        .any(|outcome| outcome.selected == DecisionOptionId::Other);
    if has_committed && has_needs_revision {
        ApplyDecisionDocumentStatus::PartiallyApplied
    } else if has_needs_revision {
        ApplyDecisionDocumentStatus::NeedsRevision
    } else {
        ApplyDecisionDocumentStatus::Applied
    }
}

fn apply_decision_updates(
    document: &mut ParsedDecisionDocument,
    outcomes: &[ZeroWriteOutcome],
    document_status: &str,
    resolved_at: &str,
) {
    let committed = outcomes
        .iter()
        .filter(|outcome| outcome.selected == DecisionOptionId::Yes)
        .map(|outcome| outcome.decision_id.as_str())
        .collect::<BTreeSet<_>>();
    let rejected = outcomes
        .iter()
        .filter(|outcome| outcome.selected == DecisionOptionId::No)
        .map(|outcome| outcome.decision_id.as_str())
        .collect::<BTreeSet<_>>();
    let needs_revision = outcomes
        .iter()
        .filter(|outcome| outcome.selected == DecisionOptionId::Other)
        .map(|outcome| outcome.decision_id.as_str())
        .collect::<BTreeSet<_>>();

    document.frontmatter.status = document_status.to_string();
    document.frontmatter.updated_at = resolved_at.to_string();
    set_frontmatter_string(&mut document.frontmatter.raw, "status", document_status);
    set_frontmatter_string(&mut document.frontmatter.raw, "updated_at", resolved_at);

    for block in &mut document.blocks {
        let ParsedKukuBlock::Decision(decision) = block else {
            continue;
        };
        if committed.contains(decision.value.id.as_str()) {
            decision.value.status = "committed".to_string();
            decision.value.resolved_at = Some(resolved_at.to_string());
        } else if rejected.contains(decision.value.id.as_str()) {
            decision.value.status = "rejected".to_string();
            decision.value.resolved_at = Some(resolved_at.to_string());
        } else if needs_revision.contains(decision.value.id.as_str()) {
            decision.value.status = "needs_revision".to_string();
            decision.value.resolved_at = Some(resolved_at.to_string());
        }
    }
}

fn set_frontmatter_string(frontmatter: &mut Mapping, key: &str, value: &str) {
    frontmatter.insert(
        Value::String(key.to_string()),
        Value::String(value.to_string()),
    );
}

struct MemoryWriteApplyInput<'a> {
    root: &'a Path,
    decision_document_path: &'a Path,
    relative_decision_document_path: &'a str,
    decision_document_checksum_before: String,
    document: ParsedDecisionDocument,
    outcomes: Vec<ZeroWriteOutcome>,
    document_status: ApplyDecisionDocumentStatus,
    resolved_at: String,
}

async fn apply_with_memory_writes(
    input: MemoryWriteApplyInput<'_>,
) -> Result<ApplyDecisionDocumentResult, ApplyServiceError> {
    let MemoryWriteApplyInput {
        root,
        decision_document_path,
        relative_decision_document_path,
        decision_document_checksum_before,
        mut document,
        outcomes,
        document_status,
        resolved_at,
    } = input;

    let planned_writes = plan_memory_writes(
        root,
        &document,
        &outcomes,
        relative_decision_document_path,
        &resolved_at,
    )?;
    preflight_memory_paths(root, &planned_writes).await?;

    let journal_path = journal_path(root, &document.frontmatter.id);
    let mut journal = ApplyJournal::new(
        &document.frontmatter.id,
        &document.frontmatter.proposal_id,
        relative_decision_document_path,
        &decision_document_checksum_before,
        &planned_writes,
        &outcomes,
        &resolved_at,
    );
    write_journal_atomic(&journal_path, &journal).await?;

    for planned in &planned_writes {
        if let Err(error) = stage_memory_file(planned).await {
            let _ = cleanup_staging_dir(root, &document.frontmatter.id).await;
            let _ = remove_journal_file(&journal_path).await;
            return Err(error);
        }
    }

    for planned in &planned_writes {
        journal.inflight_publish_path = Some(planned.final_path.clone());
        journal.updated_at = format_utc_timestamp(SystemTime::now());
        write_journal_atomic(&journal_path, &journal).await?;

        if consume_test_failpoint(root, "destination-race-before-publish").await? {
            let destination = root.join(&planned.final_path);
            if let Some(parent) = destination.parent() {
                tokio::fs::create_dir_all(parent)
                    .await
                    .map_err(|error| ApplyServiceError::io(error.to_string()))?;
            }
            tokio::fs::write(destination, b"raced")
                .await
                .map_err(|error| ApplyServiceError::io(error.to_string()))?;
        }
        if let Err(error) = publish_memory_file(root, planned).await {
            journal.inflight_publish_path = None;
            journal.updated_at = format_utc_timestamp(SystemTime::now());
            let _ = write_journal_atomic(&journal_path, &journal).await;
            let _ = cleanup_staging_dir(root, &document.frontmatter.id).await;
            let _ = remove_journal_file(&journal_path).await;
            return Err(error);
        }

        journal.created_paths.push(planned.final_path.clone());
        journal
            .memory_checksums
            .insert(planned.final_path.clone(), planned.checksum.clone());
        journal.inflight_publish_path = None;
        journal.updated_at = format_utc_timestamp(SystemTime::now());
        let journal_update = if consume_test_failpoint(root, "journal-update-after-publish").await?
        {
            Err(ApplyServiceError::io(
                "test failpoint: journal update after publish",
            ))
        } else {
            write_journal_atomic(&journal_path, &journal).await
        };
        if let Err(error) = journal_update {
            return Err(rollback_after_publish_journal_update_failure(
                root,
                &journal_path,
                journal,
                error,
            )
            .await);
        }
    }

    journal.state = ApplyJournalState::Finalized;
    journal.finalized_memory_paths = journal.created_paths.clone();
    journal.updated_at = format_utc_timestamp(SystemTime::now());
    if let Err(error) = write_journal_atomic(&journal_path, &journal).await {
        return Err(rollback_after_publish_journal_update_failure(
            root,
            &journal_path,
            journal,
            error,
        )
        .await);
    }

    apply_decision_updates(
        &mut document,
        &outcomes,
        document_status.as_str(),
        &resolved_at,
    );
    let next_markdown = render_decision_document(&document).map_err(|error| {
        ApplyServiceError::apply_recovery_required(error.message)
            .with_details(recovery_error_details(&journal))
    })?;
    if consume_test_failpoint(root, "decision-save-after-finalization").await?
        || guarded_replace_file(
            decision_document_path,
            decision_document_checksum_before.clone(),
            next_markdown.as_bytes(),
        )
        .await
        .is_err()
    {
        journal.error = Some("Decision document save failed after memory finalization".to_string());
        journal.updated_at = format_utc_timestamp(SystemTime::now());
        let _ = write_journal_atomic(&journal_path, &journal).await;
        return Err(ApplyServiceError::apply_recovery_required(
            "Decision document save failed after memory finalization",
        )
        .with_details(recovery_error_details(&journal)));
    }

    let mut warnings = Vec::new();
    journal.state = ApplyJournalState::DocumentSaved;
    journal.updated_at = format_utc_timestamp(SystemTime::now());
    if let Err(error) = write_journal_atomic(&journal_path, &journal).await {
        warnings.push(format!(
            "Decision document saved, but apply journal update failed: {}",
            error.message
        ));
        return Ok(apply_result_from_outcomes(ApplyResultInput {
            doc_id: &document.frontmatter.id,
            path: relative_decision_document_path,
            status: document_status,
            outcomes: &outcomes,
            committed_memory_paths: planned_writes
                .iter()
                .map(|planned| planned.final_path.clone())
                .collect(),
            recovered_from_journal: false,
            warnings,
            journal_cleanup_required: Some(true),
            journal_path: Some(journal_vault_path(&document.frontmatter.id)),
        }));
    }
    if let Err(error) = remove_journal_file(&journal_path).await {
        warnings.push(format!(
            "Decision document saved, but apply journal cleanup failed: {}",
            error.message
        ));
        return Ok(apply_result_from_outcomes(ApplyResultInput {
            doc_id: &document.frontmatter.id,
            path: relative_decision_document_path,
            status: document_status,
            outcomes: &outcomes,
            committed_memory_paths: planned_writes
                .iter()
                .map(|planned| planned.final_path.clone())
                .collect(),
            recovered_from_journal: false,
            warnings,
            journal_cleanup_required: Some(true),
            journal_path: Some(journal_vault_path(&document.frontmatter.id)),
        }));
    }
    if let Err(error) = cleanup_staging_dir(root, &document.frontmatter.id).await {
        warnings.push(format!("Apply staging cleanup failed: {}", error.message));
    }

    Ok(apply_result_from_outcomes(ApplyResultInput {
        doc_id: &document.frontmatter.id,
        path: relative_decision_document_path,
        status: document_status,
        outcomes: &outcomes,
        committed_memory_paths: planned_writes
            .iter()
            .map(|planned| planned.final_path.clone())
            .collect(),
        recovered_from_journal: false,
        warnings,
        journal_cleanup_required: None,
        journal_path: None,
    }))
}

#[derive(Debug, Clone)]
struct PlannedMemoryWrite {
    memory_id: String,
    final_path: String,
    staged_path: PathBuf,
    bytes: Vec<u8>,
    checksum: String,
}

fn plan_memory_writes(
    root: &Path,
    document: &ParsedDecisionDocument,
    outcomes: &[ZeroWriteOutcome],
    decision_document_path: &str,
    timestamp: &str,
) -> Result<Vec<PlannedMemoryWrite>, ApplyServiceError> {
    let proposals = document
        .proposal_blocks()
        .map(|proposal| (proposal.value.id.as_str(), &proposal.value))
        .collect::<BTreeMap<_, _>>();
    let mut planned = Vec::new();
    for outcome in outcomes {
        if outcome.selected != DecisionOptionId::Yes {
            continue;
        }
        let proposal = proposals
            .get(outcome.target_change_id.as_str())
            .ok_or_else(|| ApplyServiceError::validation("Decision target has no proposal"))?;
        let bytes = render_memory_item_bytes(
            proposal,
            &document.frontmatter.proposal_id,
            decision_document_path,
            timestamp,
        )?;
        let final_path = outcome
            .memory_path
            .clone()
            .unwrap_or_else(|| memory_path_for_id(&proposal.memory.id));
        let staged_path = root
            .join(".kuku/knowledge/apply-tmp")
            .join(&document.frontmatter.id)
            .join(format!("{}.md", proposal.memory.id));
        let checksum = sha256_checksum_bytes(&bytes);
        planned.push(PlannedMemoryWrite {
            memory_id: proposal.memory.id.clone(),
            final_path,
            staged_path,
            bytes,
            checksum,
        });
    }
    Ok(planned)
}

fn render_memory_item_bytes(
    proposal: &MemoryProposalBlock,
    proposal_id: &str,
    decision_document_path: &str,
    timestamp: &str,
) -> Result<Vec<u8>, ApplyServiceError> {
    let item = MemoryItem {
        id: proposal.memory.id.clone(),
        kind: proposal.memory.kind.clone(),
        title: proposal.memory.title.clone(),
        status: MemoryStatus::Active,
        tags: proposal.memory.tags.clone(),
        source_refs: proposal.memory.source_refs.clone(),
        created_at: timestamp.to_string(),
        updated_at: timestamp.to_string(),
        proposal_id: proposal_id.to_string(),
        decision_document: decision_document_path.to_string(),
        body: proposal.memory.body.clone(),
    };
    let markdown = serialize_memory_item(&item)
        .map_err(|error| ApplyServiceError::validation(error.message))?;
    Ok(markdown.into_bytes())
}

async fn preflight_memory_paths(
    root: &Path,
    planned_writes: &[PlannedMemoryWrite],
) -> Result<(), ApplyServiceError> {
    let mut paths = BTreeSet::new();
    for planned in planned_writes {
        if !paths.insert(planned.final_path.as_str()) {
            return Err(ApplyServiceError::validation(format!(
                "Duplicate memory output path: {}",
                planned.final_path
            )));
        }
        let destination = root.join(&planned.final_path);
        if exact_or_case_insensitive_exists(&destination).await? {
            return Err(ApplyServiceError::already_exists(format!(
                "Memory output path already exists: {}",
                planned.final_path
            )));
        }
    }
    Ok(())
}

async fn stage_memory_file(planned: &PlannedMemoryWrite) -> Result<(), ApplyServiceError> {
    if let Some(parent) = planned.staged_path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|error| ApplyServiceError::io(error.to_string()))?;
    }
    let mut file = tokio::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .open(&planned.staged_path)
        .await
        .map_err(|error| ApplyServiceError::io(error.to_string()))?;
    file.write_all(&planned.bytes)
        .await
        .map_err(|error| ApplyServiceError::io(error.to_string()))?;
    file.sync_all()
        .await
        .map_err(|error| ApplyServiceError::io(error.to_string()))?;
    drop(file);

    let staged = tokio::fs::read(&planned.staged_path)
        .await
        .map_err(|error| ApplyServiceError::io(error.to_string()))?;
    if sha256_checksum_bytes(&staged) != planned.checksum {
        return Err(ApplyServiceError::io(format!(
            "Staged memory checksum verification failed for {}",
            planned.memory_id
        )));
    }
    Ok(())
}

async fn publish_memory_file(
    root: &Path,
    planned: &PlannedMemoryWrite,
) -> Result<(), ApplyServiceError> {
    let destination = root.join(&planned.final_path);
    if let Some(parent) = destination.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|error| ApplyServiceError::io(error.to_string()))?;
    }
    tokio::fs::hard_link(&planned.staged_path, &destination)
        .await
        .map_err(|error| {
            if error.kind() == std::io::ErrorKind::AlreadyExists {
                ApplyServiceError::already_exists(format!(
                    "Memory output path already exists: {}",
                    planned.final_path
                ))
            } else {
                ApplyServiceError::io(error.to_string())
            }
        })?;

    let published = tokio::fs::read(&destination)
        .await
        .map_err(|error| ApplyServiceError::io(error.to_string()))?;
    if sha256_checksum_bytes(&published) != planned.checksum {
        return Err(ApplyServiceError::io(format!(
            "Published memory checksum verification failed for {}",
            planned.final_path
        )));
    }
    tokio::fs::remove_file(&planned.staged_path)
        .await
        .map_err(|error| ApplyServiceError::io(error.to_string()))?;
    Ok(())
}

async fn cleanup_staging_dir(root: &Path, doc_id: &str) -> Result<(), ApplyServiceError> {
    let dir = root.join(".kuku/knowledge/apply-tmp").join(doc_id);
    match tokio::fs::remove_dir_all(&dir).await {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotADirectory => {
            tokio::fs::remove_file(&dir)
                .await
                .map_err(|error| ApplyServiceError::io(error.to_string()))
        }
        Err(error) => Err(ApplyServiceError::io(error.to_string())),
    }
}

fn journal_path(root: &Path, doc_id: &str) -> PathBuf {
    root.join(".kuku/knowledge/apply-journal")
        .join(format!("{doc_id}.json"))
}

fn journal_vault_path(doc_id: &str) -> String {
    format!(".kuku/knowledge/apply-journal/{doc_id}.json")
}

fn recovery_error_details(journal: &ApplyJournal) -> JsonValue {
    json!({
        "journal_path": journal_vault_path(&journal.doc_id),
        "created_paths": &journal.created_paths,
        "cleanup_required": journal.state == ApplyJournalState::CleanupRequired,
    })
}

async fn read_journal(path: &Path) -> Result<Option<ApplyJournal>, ApplyServiceError> {
    let bytes = match tokio::fs::read(path).await {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(ApplyServiceError::io(error.to_string())),
    };
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|error| ApplyServiceError::validation(format!("Malformed apply journal: {error}")))
}

async fn remove_journal_file(path: &Path) -> Result<(), ApplyServiceError> {
    match tokio::fs::remove_file(path).await {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(ApplyServiceError::io(error.to_string())),
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ApplyJournal {
    apply_id: String,
    doc_id: String,
    proposal_id: String,
    decision_document_path: String,
    decision_document_checksum_before: String,
    state: ApplyJournalState,
    planned_memory_paths: Vec<String>,
    created_paths: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    inflight_publish_path: Option<String>,
    finalized_memory_paths: Vec<String>,
    memory_checksums: BTreeMap<String, String>,
    decision_results: Vec<JournalDecisionResult>,
    created_at: String,
    updated_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

impl ApplyJournal {
    fn new(
        doc_id: &str,
        proposal_id: &str,
        decision_document_path: &str,
        decision_document_checksum_before: &str,
        planned_writes: &[PlannedMemoryWrite],
        outcomes: &[ZeroWriteOutcome],
        timestamp: &str,
    ) -> Self {
        Self {
            apply_id: format!("apply_{doc_id}_{}", timestamp.replace(['-', ':'], "")),
            doc_id: doc_id.to_string(),
            proposal_id: proposal_id.to_string(),
            decision_document_path: decision_document_path.to_string(),
            decision_document_checksum_before: decision_document_checksum_before.to_string(),
            state: ApplyJournalState::Staged,
            planned_memory_paths: planned_writes
                .iter()
                .map(|planned| planned.final_path.clone())
                .collect(),
            created_paths: vec![],
            inflight_publish_path: None,
            finalized_memory_paths: vec![],
            memory_checksums: planned_writes
                .iter()
                .map(|planned| (planned.final_path.clone(), planned.checksum.clone()))
                .collect(),
            decision_results: outcomes
                .iter()
                .map(JournalDecisionResult::from_outcome)
                .collect(),
            created_at: timestamp.to_string(),
            updated_at: timestamp.to_string(),
            error: None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum ApplyJournalState {
    Staged,
    Finalized,
    DocumentSaved,
    CleanupRequired,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct JournalDecisionResult {
    decision_id: String,
    target_change_id: String,
    selected_option_id: DecisionOptionId,
    status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    memory_path: Option<String>,
}

impl JournalDecisionResult {
    fn from_outcome(outcome: &ZeroWriteOutcome) -> Self {
        let status = match outcome.selected {
            DecisionOptionId::Yes => "committed",
            DecisionOptionId::No => "rejected",
            DecisionOptionId::Other => "needs_revision",
        };
        Self {
            decision_id: outcome.decision_id.clone(),
            target_change_id: outcome.target_change_id.clone(),
            selected_option_id: outcome.selected.clone(),
            status: status.to_string(),
            memory_path: outcome.memory_path.clone(),
        }
    }
}

async fn write_journal_atomic(
    path: &Path,
    journal: &ApplyJournal,
) -> Result<(), ApplyServiceError> {
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|error| ApplyServiceError::io(error.to_string()))?;
    }
    let bytes = serde_json::to_vec_pretty(journal)
        .map_err(|error| ApplyServiceError::io(error.to_string()))?;
    let tmp_path = path.with_extension("json.tmp");
    let mut file = tokio::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .open(&tmp_path)
        .await
        .map_err(|error| ApplyServiceError::io(error.to_string()))?;
    file.write_all(&bytes)
        .await
        .map_err(|error| ApplyServiceError::io(error.to_string()))?;
    file.sync_all()
        .await
        .map_err(|error| ApplyServiceError::io(error.to_string()))?;
    drop(file);
    tokio::fs::rename(&tmp_path, path)
        .await
        .map_err(|error| ApplyServiceError::io(error.to_string()))?;
    Ok(())
}

async fn exact_or_case_insensitive_exists(path: &Path) -> Result<bool, ApplyServiceError> {
    match tokio::fs::try_exists(path).await {
        Ok(true) => return Ok(true),
        Ok(false) => {}
        Err(error) => return Err(ApplyServiceError::io(error.to_string())),
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
        Err(error) => return Err(ApplyServiceError::io(error.to_string())),
    };
    while let Some(entry) = entries
        .next_entry()
        .await
        .map_err(|error| ApplyServiceError::io(error.to_string()))?
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

async fn guarded_replace_file(
    destination: &Path,
    expected_checksum: String,
    bytes: &[u8],
) -> Result<(), ApplyServiceError> {
    let observed = tokio::fs::read(destination)
        .await
        .map_err(|error| ApplyServiceError::io(error.to_string()))?;
    if sha256_checksum_bytes(&observed) != expected_checksum {
        return Err(ApplyServiceError::document_changed(
            "Decision document changed during apply",
        ));
    }

    let parent = destination.parent().ok_or_else(|| {
        ApplyServiceError::io("Decision document destination has no parent directory")
    })?;
    let tmp_path = parent.join(format!(
        ".{}.apply-tmp",
        destination
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("decision-document")
    ));

    let mut file = tokio::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .open(&tmp_path)
        .await
        .map_err(|error| ApplyServiceError::io(error.to_string()))?;
    file.write_all(bytes)
        .await
        .map_err(|error| ApplyServiceError::io(error.to_string()))?;
    file.sync_all()
        .await
        .map_err(|error| ApplyServiceError::io(error.to_string()))?;
    drop(file);

    tokio::fs::rename(&tmp_path, destination)
        .await
        .map_err(|error| {
            let _ = std::fs::remove_file(&tmp_path);
            ApplyServiceError::io(error.to_string())
        })?;

    let written = tokio::fs::read(destination)
        .await
        .map_err(|error| ApplyServiceError::io(error.to_string()))?;
    if sha256_checksum_bytes(bytes) != sha256_checksum_bytes(&written) {
        return Err(ApplyServiceError::io(
            "Decision document write verification failed",
        ));
    }
    Ok(())
}

struct ApplyLock {
    path: PathBuf,
}

impl ApplyLock {
    async fn acquire(root: &Path, doc_id: &str) -> Result<Self, ApplyServiceError> {
        let lock_dir = root.join(".kuku/knowledge/apply-lock");
        tokio::fs::create_dir_all(&lock_dir)
            .await
            .map_err(|error| ApplyServiceError::io(error.to_string()))?;
        let lock_path = lock_dir.join(format!("{doc_id}.lock"));
        acquire_lock_file(&lock_path, "Decision document apply is already in progress").await?;
        Ok(Self { path: lock_path })
    }
}

impl Drop for ApplyLock {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

struct DocumentWriteLock {
    path: PathBuf,
}

impl DocumentWriteLock {
    async fn acquire(root: &Path, relative_path: &str) -> Result<Self, ApplyServiceError> {
        let lock_dir = root.join(".kuku/knowledge/document-write-lock");
        tokio::fs::create_dir_all(&lock_dir)
            .await
            .map_err(|error| ApplyServiceError::io(error.to_string()))?;
        let lock_hash = hex::encode(Sha256::digest(relative_path.as_bytes()));
        let lock_path = lock_dir.join(format!("{lock_hash}.lock"));
        acquire_lock_file(&lock_path, "Decision document write is already in progress").await?;
        Ok(Self { path: lock_path })
    }
}

impl Drop for DocumentWriteLock {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

async fn acquire_lock_file(
    lock_path: &Path,
    in_progress_message: &str,
) -> Result<(), ApplyServiceError> {
    match create_lock_file(lock_path).await {
        Ok(()) => Ok(()),
        Err(error) if error.code == KnowledgeErrorCode::AlreadyExists => {
            if !lock_is_stale(lock_path).await? {
                return Err(ApplyServiceError::apply_in_progress(in_progress_message));
            }
            replace_stale_lock(lock_path, in_progress_message).await
        }
        Err(error) => Err(error),
    }
}

async fn create_lock_file(lock_path: &Path) -> Result<(), ApplyServiceError> {
    tokio::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(lock_path)
        .await
        .map(|_| ())
        .map_err(|error| {
            if error.kind() == std::io::ErrorKind::AlreadyExists {
                ApplyServiceError::already_exists("Lock already exists")
            } else {
                ApplyServiceError::io(error.to_string())
            }
        })
}

async fn lock_is_stale(lock_path: &Path) -> Result<bool, ApplyServiceError> {
    let metadata = match tokio::fs::metadata(lock_path).await {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(true),
        Err(error) => return Err(ApplyServiceError::io(error.to_string())),
    };
    let modified = metadata
        .modified()
        .map_err(|error| ApplyServiceError::io(error.to_string()))?;
    Ok(SystemTime::now()
        .duration_since(modified)
        .is_ok_and(|age| age > LOCK_STALE_AFTER))
}

async fn replace_stale_lock(
    lock_path: &Path,
    in_progress_message: &str,
) -> Result<(), ApplyServiceError> {
    let stale_path = lock_path.with_extension(format!(
        "stale-{}",
        format_utc_timestamp(SystemTime::now())
            .replace(['-', ':'], "")
            .replace('T', "-")
            .trim_end_matches('Z')
    ));
    match tokio::fs::rename(lock_path, &stale_path).await {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(ApplyServiceError::io(error.to_string())),
    }
    match create_lock_file(lock_path).await {
        Ok(()) => {
            let _ = tokio::fs::remove_file(&stale_path).await;
            Ok(())
        }
        Err(error) if error.code == KnowledgeErrorCode::AlreadyExists => {
            Err(ApplyServiceError::apply_in_progress(in_progress_message))
        }
        Err(error) => Err(error),
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    use tauri::async_runtime;

    use super::*;
    use crate::knowledge::markdown::{parse_memory_item, sha256_checksum_bytes};

    static TEST_COUNTER: AtomicU64 = AtomicU64::new(0);

    #[test]
    fn one_yes_apply_writes_expected_memory_and_marks_applied() {
        let root = setup_vault(decision_document_with_memory_source_ref("yes"));
        let result = apply_fixture(&root).unwrap();

        assert_eq!(result.status, ApplyDecisionDocumentStatus::Applied);
        assert_eq!(
            result.committed_memory_paths,
            vec!["Knowledge/memory/mem_auth.md"]
        );
        assert!(result.rejected_decision_ids.is_empty());
        assert!(result.needs_revision_decision_ids.is_empty());
        assert_no_journal_or_temp_files(&root);

        let memory_markdown =
            fs::read_to_string(root.join("Knowledge/memory/mem_auth.md")).unwrap();
        let memory = parse_memory_item(&memory_markdown).unwrap();
        assert_eq!(memory.id, "mem_auth");
        assert_eq!(memory.title, "Auth decision");
        assert_eq!(memory.status, MemoryStatus::Active);
        assert_eq!(memory.proposal_id, "prop_auth");
        assert_eq!(memory.decision_document, "Knowledge/decisions/auth.md");
        assert_eq!(memory.body, "Use session cookie auth first.\n");
        assert_eq!(memory.source_refs.len(), 1);
        assert_eq!(memory.source_refs[0].path, "Notes/Auth.md");

        let updated = fs::read_to_string(root.join("Knowledge/decisions/auth.md")).unwrap();
        assert!(updated.contains("status: applied\n"));
        assert!(updated.contains("status: committed\n"));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn mixed_yes_no_other_writes_only_yes_and_marks_partially_applied() {
        let root = setup_vault(yes_no_other_decision_document());
        let result = apply_fixture(&root).unwrap();

        assert_eq!(result.status, ApplyDecisionDocumentStatus::PartiallyApplied);
        assert_eq!(
            result.committed_memory_paths,
            vec!["Knowledge/memory/mem_auth.md"]
        );
        assert_eq!(result.rejected_decision_ids, vec!["decision_cache"]);
        assert_eq!(result.needs_revision_decision_ids, vec!["decision_policy"]);
        assert!(root.join("Knowledge/memory/mem_auth.md").is_file());
        assert!(!root.join("Knowledge/memory/mem_cache.md").exists());
        assert!(!root.join("Knowledge/memory/mem_policy.md").exists());
        assert_no_journal_or_temp_files(&root);

        let updated = fs::read_to_string(root.join("Knowledge/decisions/auth.md")).unwrap();
        assert!(updated.contains("status: partially_applied\n"));
        assert!(updated.contains("status: committed\n"));
        assert!(updated.contains("status: rejected\n"));
        assert!(updated.contains("status: needs_revision\n"));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn yes_apply_rejects_existing_memory_before_journal() {
        let root = setup_vault(decision_document("yes", None));
        fs::write(root.join("Knowledge/memory/mem_auth.md"), "existing").unwrap();

        let error = apply_fixture(&root).unwrap_err();
        assert_eq!(error.code, KnowledgeErrorCode::ValidationFailed);
        assert!(root.join("Knowledge/memory/mem_auth.md").is_file());
        assert_no_journal_or_temp_files(&root);

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn preflight_memory_paths_rejects_duplicate_planned_paths() {
        let root = temp_vault();
        let bytes = b"memory".to_vec();
        let planned = vec![
            PlannedMemoryWrite {
                memory_id: "mem_auth_a".to_string(),
                final_path: "Knowledge/memory/mem_auth.md".to_string(),
                staged_path: root.join(".kuku/knowledge/apply-tmp/doc_auth/mem_auth_a.md"),
                checksum: sha256_checksum_bytes(&bytes),
                bytes: bytes.clone(),
            },
            PlannedMemoryWrite {
                memory_id: "mem_auth_b".to_string(),
                final_path: "Knowledge/memory/mem_auth.md".to_string(),
                staged_path: root.join(".kuku/knowledge/apply-tmp/doc_auth/mem_auth_b.md"),
                checksum: sha256_checksum_bytes(&bytes),
                bytes,
            },
        ];

        let error = async_runtime::block_on(preflight_memory_paths(&root, &planned)).unwrap_err();
        assert_eq!(error.code, KnowledgeErrorCode::ValidationFailed);
        assert!(error.message.contains("Duplicate memory output path"));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn preflight_memory_paths_rejects_case_insensitive_existing_path() {
        let root = temp_vault();
        fs::create_dir_all(root.join("Knowledge/memory")).unwrap();
        fs::write(root.join("Knowledge/memory/MEM_AUTH.md"), "existing").unwrap();

        let bytes = b"memory".to_vec();
        let planned = vec![PlannedMemoryWrite {
            memory_id: "mem_auth".to_string(),
            final_path: "Knowledge/memory/mem_auth.md".to_string(),
            staged_path: root.join(".kuku/knowledge/apply-tmp/doc_auth/mem_auth.md"),
            checksum: sha256_checksum_bytes(&bytes),
            bytes,
        }];

        let error = async_runtime::block_on(preflight_memory_paths(&root, &planned)).unwrap_err();
        assert_eq!(error.code, KnowledgeErrorCode::AlreadyExists);
        assert!(error.message.contains("Memory output path already exists"));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn journal_creation_failure_leaves_pending_without_memory() {
        let root = setup_vault(decision_document("yes", None));
        fs::remove_dir_all(root.join(".kuku/knowledge/apply-journal")).unwrap();
        fs::write(
            root.join(".kuku/knowledge/apply-journal"),
            "not a directory",
        )
        .unwrap();

        let error = apply_fixture(&root).unwrap_err();
        assert_eq!(error.code, KnowledgeErrorCode::IoError);
        assert_memory_dir_empty(&root);
        let updated = fs::read_to_string(root.join("Knowledge/decisions/auth.md")).unwrap();
        assert!(updated.contains("status: pending\n"));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn journal_update_failure_after_publish_rolls_back_memory() {
        let root = setup_vault(decision_document("yes", None));
        fs::write(
            root.join("Knowledge/memory/pre_existing.md"),
            "pre-existing",
        )
        .unwrap();
        write_test_failpoint(&root, "journal-update-after-publish");

        let error = apply_fixture(&root).unwrap_err();
        assert_eq!(error.code, KnowledgeErrorCode::IoError);
        assert!(!root.join("Knowledge/memory/mem_auth.md").exists());
        assert_eq!(
            fs::read_to_string(root.join("Knowledge/memory/pre_existing.md")).unwrap(),
            "pre-existing"
        );
        assert_no_journal_or_temp_files(&root);
        let updated = fs::read_to_string(root.join("Knowledge/decisions/auth.md")).unwrap();
        assert!(updated.contains("status: pending\n"));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn staged_write_failure_cleans_journal_and_writes_no_memory() {
        let root = setup_vault(decision_document("yes", None));
        fs::write(root.join(".kuku/knowledge/apply-tmp/doc_auth"), "not a dir").unwrap();

        let error = apply_fixture(&root).unwrap_err();
        assert_eq!(error.code, KnowledgeErrorCode::IoError);
        assert_memory_dir_empty(&root);
        assert_no_journal_or_temp_files(&root);
        let updated = fs::read_to_string(root.join("Knowledge/decisions/auth.md")).unwrap();
        assert!(updated.contains("status: pending\n"));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn no_clobber_publish_failure_keeps_raced_file_and_cleans_journal() {
        let root = setup_vault(decision_document("yes", None));
        write_test_failpoint(&root, "destination-race-before-publish");

        let error = apply_fixture(&root).unwrap_err();
        assert_eq!(error.code, KnowledgeErrorCode::AlreadyExists);
        assert_eq!(
            fs::read_to_string(root.join("Knowledge/memory/mem_auth.md")).unwrap(),
            "raced"
        );
        assert_no_journal_or_temp_files(&root);
        let updated = fs::read_to_string(root.join("Knowledge/decisions/auth.md")).unwrap();
        assert!(updated.contains("status: pending\n"));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn stale_staged_created_path_checksum_mismatch_blocks_with_cleanup_required() {
        let root = setup_vault(decision_document("yes", None));
        let mut journal = write_staged_inflight_journal(&root);
        journal.created_paths = vec!["Knowledge/memory/mem_auth.md".to_string()];
        journal.inflight_publish_path = None;
        write_journal_sync(&root, &journal);
        fs::write(root.join("Knowledge/memory/mem_auth.md"), "changed").unwrap();
        create_stale_apply_lock(&root);

        let error = apply_fixture(&root).unwrap_err();
        assert_eq!(error.code, KnowledgeErrorCode::ApplyRecoveryRequired);
        assert_eq!(
            fs::read_to_string(root.join("Knowledge/memory/mem_auth.md")).unwrap(),
            "changed"
        );
        assert_journal_state(&root, ApplyJournalState::CleanupRequired);

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn crash_after_publish_before_created_paths_rolls_back_and_restarts() {
        let root = setup_vault(decision_document("yes", None));
        write_staged_inflight_journal(&root);
        create_stale_apply_lock(&root);

        let result = apply_fixture(&root).unwrap();
        assert_eq!(result.status, ApplyDecisionDocumentStatus::Applied);
        assert_eq!(
            result.committed_memory_paths,
            vec!["Knowledge/memory/mem_auth.md"]
        );
        assert!(root.join("Knowledge/memory/mem_auth.md").is_file());
        assert_no_journal_or_temp_files(&root);

        let memory = fs::read(root.join("Knowledge/memory/mem_auth.md")).unwrap();
        assert_eq!(
            parse_memory_item(std::str::from_utf8(&memory).unwrap())
                .unwrap()
                .id,
            "mem_auth"
        );

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn stale_staged_journal_without_created_paths_is_cleaned_before_apply() {
        let root = setup_vault(decision_document("yes", None));
        write_staged_empty_journal(&root);
        fs::write(
            root.join(".kuku/knowledge/apply-tmp/doc_auth/leftover.md"),
            "leftover",
        )
        .unwrap();
        create_stale_apply_lock(&root);

        let result = apply_fixture(&root).unwrap();
        assert_eq!(result.status, ApplyDecisionDocumentStatus::Applied);
        assert!(root.join("Knowledge/memory/mem_auth.md").is_file());
        assert_no_journal_or_temp_files(&root);

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn finalized_journal_recovery_updates_document_without_memory_rewrite() {
        let root = setup_vault(decision_document("yes", None));
        write_finalized_journal(&root, true);

        let result = apply_fixture(&root).unwrap();
        assert_eq!(result.status, ApplyDecisionDocumentStatus::Applied);
        assert!(result.recovered_from_journal);
        assert_eq!(
            result.committed_memory_paths,
            vec!["Knowledge/memory/mem_auth.md"]
        );
        let updated = fs::read_to_string(root.join("Knowledge/decisions/auth.md")).unwrap();
        assert!(updated.contains("status: applied\n"));
        assert!(updated.contains("status: committed\n"));
        assert_no_journal_or_temp_files(&root);

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn recover_false_with_finalized_journal_returns_recovery_required() {
        let root = setup_vault(decision_document("yes", None));
        write_finalized_journal(&root, true);
        let mut request = apply_request(&root);
        request.recover = false;

        let error =
            async_runtime::block_on(apply_decision_document_for_root(&root, request)).unwrap_err();
        assert_eq!(error.code, KnowledgeErrorCode::ApplyRecoveryRequired);
        assert!(
            root.join(".kuku/knowledge/apply-journal/doc_auth.json")
                .is_file()
        );
        let updated = fs::read_to_string(root.join("Knowledge/decisions/auth.md")).unwrap();
        assert!(updated.contains("status: pending\n"));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn decision_document_save_failure_after_finalization_recovers_next_apply() {
        let root = setup_vault(decision_document("yes", None));
        write_test_failpoint(&root, "decision-save-after-finalization");

        let error = apply_fixture(&root).unwrap_err();
        assert_eq!(error.code, KnowledgeErrorCode::ApplyRecoveryRequired);
        assert!(root.join("Knowledge/memory/mem_auth.md").is_file());
        assert_journal_state(&root, ApplyJournalState::Finalized);
        let pending = fs::read_to_string(root.join("Knowledge/decisions/auth.md")).unwrap();
        assert!(pending.contains("status: pending\n"));

        let result = apply_fixture(&root).unwrap();
        assert!(result.recovered_from_journal);
        assert_eq!(result.status, ApplyDecisionDocumentStatus::Applied);
        assert_no_journal_or_temp_files(&root);

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn finalized_journal_mismatch_persists_apply_failed_and_cleanup_required() {
        let root = setup_vault(decision_document("yes", None));
        write_finalized_journal(&root, false);

        let error = apply_fixture(&root).unwrap_err();
        assert_eq!(error.code, KnowledgeErrorCode::ApplyFailed);
        let updated = fs::read_to_string(root.join("Knowledge/decisions/auth.md")).unwrap();
        assert!(updated.contains("status: apply_failed\n"));
        assert!(updated.contains("last_apply_error:"));
        assert_journal_state(&root, ApplyJournalState::CleanupRequired);

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn cleanup_required_journal_blocks_future_apply() {
        let root = setup_vault(decision_document("yes", None));
        let mut journal = build_journal(&root);
        journal.state = ApplyJournalState::CleanupRequired;
        journal.error = Some("manual cleanup required".to_string());
        write_journal_sync(&root, &journal);

        let error = apply_fixture(&root).unwrap_err();
        assert_eq!(error.code, KnowledgeErrorCode::ApplyRecoveryRequired);
        assert!(
            root.join(".kuku/knowledge/apply-journal/doc_auth.json")
                .is_file()
        );
        assert_memory_dir_empty(&root);

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn completed_orphan_journal_cleanup_never_writes_memory() {
        let root = setup_vault(decision_document("yes", None));
        let journal = write_finalized_journal(&root, true);
        mark_document_completed_from_journal(&root, &journal);

        let error = apply_fixture(&root).unwrap_err();
        assert_eq!(error.code, KnowledgeErrorCode::NotPending);
        assert!(
            !root
                .join(".kuku/knowledge/apply-journal/doc_auth.json")
                .exists()
        );
        assert!(root.join("Knowledge/memory/mem_auth.md").is_file());

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn all_no_apply_writes_no_memory_and_marks_applied() {
        let root = setup_vault(decision_document("no", None));
        let result = apply_fixture(&root).unwrap();

        assert_eq!(result.status, ApplyDecisionDocumentStatus::Applied);
        assert_eq!(result.rejected_decision_ids, vec!["decision_auth"]);
        assert!(result.needs_revision_decision_ids.is_empty());
        assert_memory_dir_empty(&root);
        assert_no_journal_or_temp_files(&root);

        let updated = fs::read_to_string(root.join("Knowledge/decisions/auth.md")).unwrap();
        assert!(updated.contains("status: applied\n"));
        assert!(updated.contains("status: rejected\n"));
        assert!(updated.contains("resolved_at: "));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn all_other_apply_writes_no_memory_and_marks_needs_revision() {
        let root = setup_vault(decision_document(
            "other",
            Some("Use a different memory body."),
        ));
        let result = apply_fixture(&root).unwrap();

        assert_eq!(result.status, ApplyDecisionDocumentStatus::NeedsRevision);
        assert!(result.rejected_decision_ids.is_empty());
        assert_eq!(result.needs_revision_decision_ids, vec!["decision_auth"]);
        assert_memory_dir_empty(&root);
        assert_no_journal_or_temp_files(&root);

        let updated = fs::read_to_string(root.join("Knowledge/decisions/auth.md")).unwrap();
        assert!(updated.contains("status: needs_revision\n"));
        assert!(updated.contains("other_text: Use a different memory body."));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn mixed_no_other_apply_marks_needs_revision() {
        let root = setup_vault(mixed_decision_document());
        let result = apply_fixture(&root).unwrap();

        assert_eq!(result.status, ApplyDecisionDocumentStatus::NeedsRevision);
        assert_eq!(result.rejected_decision_ids, vec!["decision_auth"]);
        assert_eq!(result.needs_revision_decision_ids, vec!["decision_cache"]);
        assert_memory_dir_empty(&root);

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn missing_selection_and_other_without_text_fail_before_write() {
        let root = setup_vault(decision_document_without_selection());
        let error = apply_fixture(&root).unwrap_err();
        assert_eq!(error.code, KnowledgeErrorCode::ValidationFailed);
        assert_memory_dir_empty(&root);
        let _ = fs::remove_dir_all(root);

        let root = setup_vault(decision_document("other", None));
        let error = apply_fixture(&root).unwrap_err();
        assert_eq!(error.code, KnowledgeErrorCode::ValidationFailed);
        assert_memory_dir_empty(&root);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn checksum_mismatch_returns_document_changed() {
        let root = setup_vault(decision_document("no", None));
        let mut request = apply_request(&root);
        request.expected_checksum =
            "sha256:0000000000000000000000000000000000000000000000000000000000000000".to_string();

        let error =
            async_runtime::block_on(apply_decision_document_for_root(&root, request)).unwrap_err();
        assert_eq!(error.code, KnowledgeErrorCode::DocumentChanged);
        assert_memory_dir_empty(&root);

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn concurrent_apply_lock_blocks_apply() {
        let root = setup_vault(decision_document("no", None));
        fs::create_dir_all(root.join(".kuku/knowledge/apply-lock")).unwrap();
        fs::write(
            root.join(".kuku/knowledge/apply-lock/doc_auth.lock"),
            "locked",
        )
        .unwrap();

        let error = async_runtime::block_on(apply_decision_document_for_root(
            &root,
            apply_request(&root),
        ))
        .unwrap_err();
        assert_eq!(error.code, KnowledgeErrorCode::ApplyInProgress);
        assert_memory_dir_empty(&root);

        let _ = fs::remove_dir_all(root);
    }

    fn apply_fixture(root: &Path) -> Result<ApplyDecisionDocumentResult, ApplyServiceError> {
        async_runtime::block_on(apply_decision_document_for_root(root, apply_request(root)))
    }

    fn apply_request(root: &Path) -> ApplyDecisionDocumentRequest {
        let markdown = fs::read(root.join("Knowledge/decisions/auth.md")).unwrap();
        ApplyDecisionDocumentRequest {
            path: "Knowledge/decisions/auth.md".to_string(),
            expected_checksum: sha256_checksum_bytes(&markdown),
            source: "editor_document_apply".to_string(),
            recover: true,
        }
    }

    fn setup_vault(markdown: String) -> PathBuf {
        let root = temp_vault();
        fs::create_dir_all(root.join("Knowledge/decisions")).unwrap();
        fs::create_dir_all(root.join("Knowledge/memory")).unwrap();
        fs::create_dir_all(root.join(".kuku/knowledge/apply-journal")).unwrap();
        fs::create_dir_all(root.join(".kuku/knowledge/apply-tmp")).unwrap();
        fs::write(root.join("Knowledge/decisions/auth.md"), markdown).unwrap();
        root
    }

    fn assert_memory_dir_empty(root: &Path) {
        assert_eq!(
            fs::read_dir(root.join("Knowledge/memory")).unwrap().count(),
            0
        );
    }

    fn assert_no_journal_or_temp_files(root: &Path) {
        assert_eq!(
            fs::read_dir(root.join(".kuku/knowledge/apply-journal"))
                .unwrap()
                .count(),
            0
        );
        assert_eq!(
            fs::read_dir(root.join(".kuku/knowledge/apply-tmp"))
                .unwrap()
                .count(),
            0
        );
    }

    fn build_journal(root: &Path) -> ApplyJournal {
        let (journal, _) = build_journal_and_planned(root);
        journal
    }

    fn build_journal_and_planned(root: &Path) -> (ApplyJournal, Vec<PlannedMemoryWrite>) {
        let decision_document_path = "Knowledge/decisions/auth.md";
        let timestamp = "2026-05-07T00:00:01Z";
        let markdown = fs::read_to_string(root.join(decision_document_path)).unwrap();
        let checksum = sha256_checksum_bytes(markdown.as_bytes());
        let document = parse_decision_document(&markdown).unwrap();
        let outcomes = collect_decision_outcomes(&document).unwrap();
        let planned = plan_memory_writes(
            root,
            &document,
            &outcomes,
            decision_document_path,
            timestamp,
        )
        .unwrap();
        let journal = ApplyJournal::new(
            &document.frontmatter.id,
            &document.frontmatter.proposal_id,
            decision_document_path,
            &checksum,
            &planned,
            &outcomes,
            timestamp,
        );
        (journal, planned)
    }

    fn write_finalized_journal(root: &Path, write_memory: bool) -> ApplyJournal {
        let (mut journal, planned) = build_journal_and_planned(root);
        if write_memory {
            for planned_write in &planned {
                let path = root.join(&planned_write.final_path);
                fs::create_dir_all(path.parent().unwrap()).unwrap();
                fs::write(path, &planned_write.bytes).unwrap();
            }
        }
        journal.created_paths = planned
            .iter()
            .map(|planned_write| planned_write.final_path.clone())
            .collect();
        journal.finalized_memory_paths = journal.created_paths.clone();
        journal.state = ApplyJournalState::Finalized;
        journal.updated_at = "2026-05-07T00:00:02Z".to_string();
        write_journal_sync(root, &journal);
        journal
    }

    fn write_staged_inflight_journal(root: &Path) -> ApplyJournal {
        let (mut journal, planned) = build_journal_and_planned(root);
        let planned_write = planned.first().unwrap();
        let path = root.join(&planned_write.final_path);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, &planned_write.bytes).unwrap();
        journal.inflight_publish_path = Some(planned_write.final_path.clone());
        write_journal_sync(root, &journal);
        journal
    }

    fn write_staged_empty_journal(root: &Path) {
        let (journal, _) = build_journal_and_planned(root);
        fs::create_dir_all(root.join(".kuku/knowledge/apply-tmp/doc_auth")).unwrap();
        write_journal_sync(root, &journal);
    }

    fn write_journal_sync(root: &Path, journal: &ApplyJournal) {
        let path = journal_path(root, &journal.doc_id);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, serde_json::to_vec_pretty(journal).unwrap()).unwrap();
    }

    fn write_test_failpoint(root: &Path, name: &str) {
        let dir = root.join(".kuku/knowledge/test-failpoints");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join(name), "fail").unwrap();
    }

    fn create_stale_apply_lock(root: &Path) {
        let dir = root.join(".kuku/knowledge/apply-lock");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("doc_auth.lock"), "stale").unwrap();
        std::thread::sleep(LOCK_STALE_AFTER + Duration::from_millis(100));
    }

    fn assert_journal_state(root: &Path, state: ApplyJournalState) {
        let journal: ApplyJournal = serde_json::from_slice(
            &fs::read(root.join(".kuku/knowledge/apply-journal/doc_auth.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(journal.state, state);
    }

    fn mark_document_completed_from_journal(root: &Path, journal: &ApplyJournal) {
        let path = root.join("Knowledge/decisions/auth.md");
        let markdown = fs::read_to_string(&path).unwrap();
        let mut document = parse_decision_document(&markdown).unwrap();
        let outcomes = outcomes_from_journal(journal);
        let status = document_status_for_outcomes(&outcomes);
        apply_decision_updates(
            &mut document,
            &outcomes,
            status.as_str(),
            &journal.created_at,
        );
        fs::write(path, render_decision_document(&document).unwrap()).unwrap();
    }

    fn decision_document(selection: &str, other_text: Option<&str>) -> String {
        let other_text_yaml = other_text
            .map(|text| format!("other_text: {text}\n"))
            .unwrap_or_default();
        format!(
            "{}selected_option_id: {selection}\n{}{}",
            document_before_selection(),
            other_text_yaml,
            document_after_selection(),
        )
    }

    fn decision_document_with_memory_source_ref(selection: &str) -> String {
        decision_document(selection, None).replace(
            "  source_refs: []\n```\n\n```kuku-decision",
            concat!(
                "  source_refs:\n",
                "  - path: Notes/Auth.md\n",
                "    title: Auth Note\n",
                "    captured_at: 2026-05-07T00:00:00Z\n",
                "```\n\n```kuku-decision",
            ),
        )
    }

    fn decision_document_without_selection() -> String {
        format!(
            "{}{}",
            document_before_selection(),
            document_after_selection()
        )
    }

    fn mixed_decision_document() -> String {
        let mut document = decision_document("no", None);
        document.push_str(concat!(
            "\n```kuku-memory-proposal\n",
            "id: change_cache\n",
            "operation: create_memory\n",
            "memory:\n",
            "  id: mem_cache\n",
            "  title: Cache decision\n",
            "  tags: []\n",
            "  body: |-\n",
            "    Keep the cache local.\n",
            "  source_refs: []\n",
            "```\n",
            "\n```kuku-decision\n",
            "id: decision_cache\n",
            "proposal_id: prop_auth\n",
            "target_change_id: change_cache\n",
            "question: Remember this memory?\n",
            "selection_mode: single\n",
            "required: true\n",
            "status: pending\n",
            "selected_option_id: other\n",
            "options:\n",
            "- id: yes\n",
            "  label: Yes\n",
            "- id: no\n",
            "  label: No\n",
            "- id: other\n",
            "  label: Other\n",
            "  requires_input: true\n",
            "other_text: Needs a narrower cache policy.\n",
            "```\n",
        ));
        document
    }

    fn yes_no_other_decision_document() -> String {
        let mut document = decision_document("yes", None);
        document.push_str(concat!(
            "\n```kuku-memory-proposal\n",
            "id: change_cache\n",
            "operation: create_memory\n",
            "memory:\n",
            "  id: mem_cache\n",
            "  title: Cache decision\n",
            "  tags: []\n",
            "  body: |-\n",
            "    Keep the cache local.\n",
            "  source_refs: []\n",
            "```\n",
            "\n```kuku-decision\n",
            "id: decision_cache\n",
            "proposal_id: prop_auth\n",
            "target_change_id: change_cache\n",
            "question: Remember this memory?\n",
            "selection_mode: single\n",
            "required: true\n",
            "status: pending\n",
            "selected_option_id: no\n",
            "options:\n",
            "- id: yes\n",
            "  label: Yes\n",
            "- id: no\n",
            "  label: No\n",
            "- id: other\n",
            "  label: Other\n",
            "  requires_input: true\n",
            "```\n",
            "\n```kuku-memory-proposal\n",
            "id: change_policy\n",
            "operation: create_memory\n",
            "memory:\n",
            "  id: mem_policy\n",
            "  title: Policy decision\n",
            "  tags: []\n",
            "  body: |-\n",
            "    Keep the policy narrow.\n",
            "  source_refs: []\n",
            "```\n",
            "\n```kuku-decision\n",
            "id: decision_policy\n",
            "proposal_id: prop_auth\n",
            "target_change_id: change_policy\n",
            "question: Remember this memory?\n",
            "selection_mode: single\n",
            "required: true\n",
            "status: pending\n",
            "selected_option_id: other\n",
            "options:\n",
            "- id: yes\n",
            "  label: Yes\n",
            "- id: no\n",
            "  label: No\n",
            "- id: other\n",
            "  label: Other\n",
            "  requires_input: true\n",
            "other_text: Needs revision before saving.\n",
            "```\n",
        ));
        document
    }

    fn document_before_selection() -> &'static str {
        concat!(
            "---\n",
            "id: doc_auth\n",
            "proposal_id: prop_auth\n",
            "target_kind: memory\n",
            "request_source: ui_command\n",
            "status: pending\n",
            "created_at: 2026-05-07T00:00:00Z\n",
            "updated_at: 2026-05-07T00:00:00Z\n",
            "source_refs: []\n",
            "---\n",
            "\n",
            "```kuku-memory-proposal\n",
            "id: change_auth\n",
            "operation: create_memory\n",
            "memory:\n",
            "  id: mem_auth\n",
            "  title: Auth decision\n",
            "  tags: []\n",
            "  body: |-\n",
            "    Use session cookie auth first.\n",
            "  source_refs: []\n",
            "```\n",
            "\n",
            "```kuku-decision\n",
            "id: decision_auth\n",
            "proposal_id: prop_auth\n",
            "target_change_id: change_auth\n",
            "question: Remember this memory?\n",
            "selection_mode: single\n",
            "required: true\n",
            "status: pending\n",
        )
    }

    fn document_after_selection() -> &'static str {
        concat!(
            "options:\n",
            "- id: yes\n",
            "  label: Yes\n",
            "- id: no\n",
            "  label: No\n",
            "- id: other\n",
            "  label: Other\n",
            "  requires_input: true\n",
            "```\n",
        )
    }

    fn temp_vault() -> PathBuf {
        let mut path = std::env::temp_dir();
        let unique = TEST_COUNTER.fetch_add(1, Ordering::Relaxed);
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        path.push(format!("kuku-zero-apply-test-{nanos}-{unique}"));
        fs::create_dir_all(&path).unwrap();
        path
    }
}
