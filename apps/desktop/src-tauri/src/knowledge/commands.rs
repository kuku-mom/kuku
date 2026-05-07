use tauri::{State, command};

use crate::knowledge::apply::apply_decision_document_for_root;
use crate::knowledge::models::{
    ApplyDecisionDocumentRequest, ApplyDecisionDocumentResult, CreateDecisionDocumentRequest,
    CreateDecisionDocumentResult, KnowledgeCommandResult, KnowledgeInitResult,
    KnowledgeStatusResult, MemoryContextRequest, MemoryContextResult, MemoryProposeRequest,
    MemorySearchResult, ProposalRequestSource, ReadDecisionDocumentRequest,
    ReadDecisionDocumentResult, ReadMemoryRequest, ReadMemoryResult, SearchMemoryRequest,
};
use crate::knowledge::proposal::create_decision_document_for_root;
use crate::knowledge::read::{read_decision_document_for_root, read_memory_for_root};
use crate::knowledge::search::{memory_context_for_root, search_memory_for_root};
use crate::knowledge::service::{knowledge_init_for_root, knowledge_status_for_root};
use crate::search::SearchState;
use crate::vault::{VaultState, get_vault_root};

#[command]
pub async fn knowledge_status(
    state: State<'_, VaultState>,
) -> Result<KnowledgeCommandResult<KnowledgeStatusResult>, String> {
    let root = match get_vault_root(&state) {
        Ok(root) => root,
        Err(error) => {
            return Ok(KnowledgeCommandResult::err(
                crate::knowledge::models::KnowledgeErrorCode::IoError,
                error,
            ));
        }
    };

    Ok(match knowledge_status_for_root(&root).await {
        Ok(status) => KnowledgeCommandResult::ok(status),
        Err(error) => KnowledgeCommandResult::err(error.code, error.message),
    })
}

#[command]
pub async fn knowledge_init(
    state: State<'_, VaultState>,
) -> Result<KnowledgeCommandResult<KnowledgeInitResult>, String> {
    let root = match get_vault_root(&state) {
        Ok(root) => root,
        Err(error) => {
            return Ok(KnowledgeCommandResult::err(
                crate::knowledge::models::KnowledgeErrorCode::IoError,
                error,
            ));
        }
    };

    Ok(match knowledge_init_for_root(&root).await {
        Ok(result) => KnowledgeCommandResult::ok(result),
        Err(error) => KnowledgeCommandResult::err(error.code, error.message),
    })
}

#[command]
pub async fn knowledge_create_decision_document(
    state: State<'_, VaultState>,
    request: CreateDecisionDocumentRequest,
) -> Result<KnowledgeCommandResult<CreateDecisionDocumentResult>, String> {
    let root = match get_vault_root(&state) {
        Ok(root) => root,
        Err(error) => {
            return Ok(KnowledgeCommandResult::err(
                crate::knowledge::models::KnowledgeErrorCode::IoError,
                error,
            ));
        }
    };

    match create_decision_document_for_root(&root, request, ProposalRequestSource::UiCommand).await
    {
        Ok(result) => Ok(KnowledgeCommandResult::ok(result)),
        Err(error) => Ok(KnowledgeCommandResult::err_with_details(
            error.code,
            error.message,
            error.details,
        )),
    }
}

#[command]
pub async fn memory_propose(
    state: State<'_, VaultState>,
    request: MemoryProposeRequest,
) -> Result<KnowledgeCommandResult<CreateDecisionDocumentResult>, String> {
    let root = match get_vault_root(&state) {
        Ok(root) => root,
        Err(error) => {
            return Ok(KnowledgeCommandResult::err(
                crate::knowledge::models::KnowledgeErrorCode::IoError,
                error,
            ));
        }
    };

    let request = CreateDecisionDocumentRequest {
        title: request.title,
        context: request.context,
        source_refs: request.source_refs,
        proposed_memories: request.proposed_memories,
        request_source: Some(ProposalRequestSource::AiTool),
        default_selection: request.default_selection,
    };

    match create_decision_document_for_root(&root, request, ProposalRequestSource::AiTool).await {
        Ok(result) => Ok(KnowledgeCommandResult::ok(result)),
        Err(error) => Ok(KnowledgeCommandResult::err_with_details(
            error.code,
            error.message,
            error.details,
        )),
    }
}

#[command]
pub async fn knowledge_read_decision_document(
    state: State<'_, VaultState>,
    request: ReadDecisionDocumentRequest,
) -> Result<KnowledgeCommandResult<ReadDecisionDocumentResult>, String> {
    let root = match get_vault_root(&state) {
        Ok(root) => root,
        Err(error) => {
            return Ok(KnowledgeCommandResult::err(
                crate::knowledge::models::KnowledgeErrorCode::IoError,
                error,
            ));
        }
    };

    match read_decision_document_for_root(&root, request).await {
        Ok(result) => Ok(KnowledgeCommandResult::ok(result)),
        Err(error) => Ok(KnowledgeCommandResult::err(error.code, error.message)),
    }
}

#[command]
pub async fn knowledge_read_memory(
    state: State<'_, VaultState>,
    request: ReadMemoryRequest,
) -> Result<KnowledgeCommandResult<ReadMemoryResult>, String> {
    let root = match get_vault_root(&state) {
        Ok(root) => root,
        Err(error) => {
            return Ok(KnowledgeCommandResult::err(
                crate::knowledge::models::KnowledgeErrorCode::IoError,
                error,
            ));
        }
    };

    match read_memory_for_root(&root, request).await {
        Ok(result) => Ok(KnowledgeCommandResult::ok(result)),
        Err(error) => Ok(KnowledgeCommandResult::err(error.code, error.message)),
    }
}

#[command]
pub async fn knowledge_apply_decision_document(
    state: State<'_, VaultState>,
    search: State<'_, SearchState>,
    request: ApplyDecisionDocumentRequest,
) -> Result<KnowledgeCommandResult<ApplyDecisionDocumentResult>, String> {
    let root = match get_vault_root(&state) {
        Ok(root) => root,
        Err(error) => {
            return Ok(KnowledgeCommandResult::err(
                crate::knowledge::models::KnowledgeErrorCode::IoError,
                error,
            ));
        }
    };

    match apply_decision_document_for_root(&root, request).await {
        Ok(mut result) => {
            for path in &result.committed_memory_paths {
                if let Err(error) = search.notify_written_with_source(path, "knowledge-apply") {
                    result.warnings.push(error);
                }
            }
            Ok(KnowledgeCommandResult::ok(result))
        }
        Err(error) => Ok(KnowledgeCommandResult::err_with_details(
            error.code,
            error.message,
            error.details,
        )),
    }
}

#[command]
pub async fn knowledge_search_memory(
    state: State<'_, VaultState>,
    request: SearchMemoryRequest,
) -> Result<KnowledgeCommandResult<MemorySearchResult>, String> {
    let root = match get_vault_root(&state) {
        Ok(root) => root,
        Err(error) => {
            return Ok(KnowledgeCommandResult::err(
                crate::knowledge::models::KnowledgeErrorCode::IoError,
                error,
            ));
        }
    };

    match search_memory_for_root(&root, request).await {
        Ok(result) => Ok(KnowledgeCommandResult::ok(result)),
        Err(error) => Ok(KnowledgeCommandResult::err(error.code, error.message)),
    }
}

#[command]
pub async fn knowledge_memory_context(
    state: State<'_, VaultState>,
    request: MemoryContextRequest,
) -> Result<KnowledgeCommandResult<MemoryContextResult>, String> {
    let root = match get_vault_root(&state) {
        Ok(root) => root,
        Err(error) => {
            return Ok(KnowledgeCommandResult::err(
                crate::knowledge::models::KnowledgeErrorCode::IoError,
                error,
            ));
        }
    };

    match memory_context_for_root(&root, request).await {
        Ok(result) => Ok(KnowledgeCommandResult::ok(result)),
        Err(error) => Ok(KnowledgeCommandResult::err(error.code, error.message)),
    }
}
