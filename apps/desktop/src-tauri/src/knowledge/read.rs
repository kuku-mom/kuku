use std::path::Path;

use crate::knowledge::decision_document::parse_decision_document;
use crate::knowledge::markdown::{
    is_valid_knowledge_id, parse_memory_item, sha256_checksum_bytes,
    validate_safe_vault_relative_path,
};
use crate::knowledge::models::{
    KnowledgeErrorCode, ReadDecisionDocumentRequest, ReadDecisionDocumentResult, ReadMemoryItem,
    ReadMemoryRequest, ReadMemoryResult,
};

#[derive(Debug, Clone)]
pub struct ReadServiceError {
    pub code: KnowledgeErrorCode,
    pub message: String,
}

impl ReadServiceError {
    fn validation(message: impl Into<String>) -> Self {
        Self {
            code: KnowledgeErrorCode::ValidationFailed,
            message: message.into(),
        }
    }

    fn io(message: impl Into<String>) -> Self {
        Self {
            code: KnowledgeErrorCode::IoError,
            message: message.into(),
        }
    }
}

pub async fn read_decision_document_for_root(
    root: &Path,
    request: ReadDecisionDocumentRequest,
) -> Result<ReadDecisionDocumentResult, ReadServiceError> {
    let path = validate_decision_document_path(&request.path)?;
    let absolute_path = root.join(&path);
    let markdown = tokio::fs::read_to_string(&absolute_path)
        .await
        .map_err(|error| ReadServiceError::io(error.to_string()))?;
    let parsed = parse_decision_document(&markdown).map_err(|error| ReadServiceError {
        code: error.code,
        message: error.message,
    })?;
    let checksum = sha256_checksum_bytes(markdown.as_bytes());

    Ok(ReadDecisionDocumentResult {
        doc_id: parsed.frontmatter.id,
        proposal_id: parsed.frontmatter.proposal_id,
        path,
        markdown,
        checksum,
        status: parsed.frontmatter.status,
    })
}

pub async fn read_memory_for_root(
    root: &Path,
    request: ReadMemoryRequest,
) -> Result<ReadMemoryResult, ReadServiceError> {
    validate_memory_id(&request.id)?;
    let path = memory_path_for_id(&request.id);
    let absolute_path = root.join(&path);
    let markdown = tokio::fs::read_to_string(&absolute_path)
        .await
        .map_err(|error| match error.kind() {
            std::io::ErrorKind::NotFound => ReadServiceError::validation("Memory not found"),
            _ => ReadServiceError::io(error.to_string()),
        })?;
    let item = parse_memory_item(&markdown).map_err(|error| {
        ReadServiceError::validation(format!("{}: {}", error.field, error.message))
    })?;
    if item.id != request.id {
        return Err(ReadServiceError::validation(
            "Memory file id does not match requested id",
        ));
    }

    Ok(ReadMemoryResult {
        memory: ReadMemoryItem::from(item),
        path,
        markdown,
    })
}

fn validate_decision_document_path(path: &str) -> Result<String, ReadServiceError> {
    let path = validate_safe_vault_relative_path(path, "path").map_err(|error| {
        ReadServiceError::validation(format!("{}: {}", error.field, error.message))
    })?;
    if !path.starts_with("Knowledge/decisions/") || !path.ends_with(".md") {
        return Err(ReadServiceError::validation(
            "Decision document path must be under Knowledge/decisions/",
        ));
    }
    Ok(path)
}

fn validate_memory_id(id: &str) -> Result<(), ReadServiceError> {
    if id.starts_with("mem_") && is_valid_knowledge_id(id) {
        return Ok(());
    }
    Err(ReadServiceError::validation("Invalid memory id"))
}

fn memory_path_for_id(id: &str) -> String {
    format!("Knowledge/memory/{id}.md")
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    use tauri::async_runtime;

    use super::*;
    use crate::knowledge::markdown::serialize_memory_item;
    use crate::knowledge::models::{MemoryItem, MemoryStatus, SourceRef};

    static TEST_COUNTER: AtomicU64 = AtomicU64::new(0);

    #[test]
    fn reads_decision_document_with_sha256_checksum() {
        let root = temp_vault();
        fs::create_dir_all(root.join("Knowledge/decisions")).unwrap();
        fs::write(
            root.join("Knowledge/decisions/auth.md"),
            decision_document(),
        )
        .unwrap();

        let result = async_runtime::block_on(read_decision_document_for_root(
            &root,
            ReadDecisionDocumentRequest {
                path: "Knowledge/decisions/auth.md".to_string(),
            },
        ))
        .unwrap();

        assert_eq!(result.doc_id, "doc_auth");
        assert_eq!(result.proposal_id, "prop_auth");
        assert_eq!(result.status, "pending");
        assert!(result.checksum.starts_with("sha256:"));
        assert_eq!(result.checksum.len(), "sha256:".len() + 64);

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn rejects_decision_document_paths_outside_decisions() {
        let root = temp_vault();
        let error = async_runtime::block_on(read_decision_document_for_root(
            &root,
            ReadDecisionDocumentRequest {
                path: "Knowledge/memory/mem_auth.md".to_string(),
            },
        ))
        .unwrap_err();

        assert_eq!(error.code, KnowledgeErrorCode::ValidationFailed);

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn reads_memory_by_derived_id_path_and_preserves_body() {
        let root = temp_vault();
        fs::create_dir_all(root.join("Knowledge/memory")).unwrap();
        let item = memory_item("mem_auth");
        let markdown = serialize_memory_item(&item).unwrap();
        fs::write(root.join("Knowledge/memory/mem_auth.md"), &markdown).unwrap();

        let result = async_runtime::block_on(read_memory_for_root(
            &root,
            ReadMemoryRequest {
                id: "mem_auth".to_string(),
            },
        ))
        .unwrap();

        assert_eq!(result.path, "Knowledge/memory/mem_auth.md");
        assert_eq!(result.memory.id, "mem_auth");
        assert_eq!(result.memory.body, "Use session cookies first.\n");
        assert_eq!(result.markdown, markdown);

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn read_memory_rejects_invalid_or_mismatched_ids() {
        let root = temp_vault();
        fs::create_dir_all(root.join("Knowledge/memory")).unwrap();
        let markdown = serialize_memory_item(&memory_item("mem_other")).unwrap();
        fs::write(root.join("Knowledge/memory/mem_auth.md"), markdown).unwrap();

        let invalid = async_runtime::block_on(read_memory_for_root(
            &root,
            ReadMemoryRequest {
                id: "prop_auth".to_string(),
            },
        ))
        .unwrap_err();
        assert_eq!(invalid.code, KnowledgeErrorCode::ValidationFailed);

        let mismatched = async_runtime::block_on(read_memory_for_root(
            &root,
            ReadMemoryRequest {
                id: "mem_auth".to_string(),
            },
        ))
        .unwrap_err();
        assert_eq!(mismatched.code, KnowledgeErrorCode::ValidationFailed);

        let _ = fs::remove_dir_all(root);
    }

    fn decision_document() -> String {
        r#"---
id: doc_auth
proposal_id: prop_auth
target_kind: memory
request_source: ui_command
status: pending
created_at: 2026-05-07T00:00:00Z
updated_at: 2026-05-07T00:00:00Z
source_refs: []
---

```kuku-memory-proposal
id: change_auth
operation: create_memory
memory:
  id: mem_auth
  kind: decision
  title: Session cookie first
  tags: []
  body: Use session cookies first.
  source_refs: []
```

```kuku-decision
id: decision_auth
proposal_id: prop_auth
target_change_id: change_auth
question: Remember this memory?
selection_mode: single
required: true
status: pending
selected_option_id: yes
options:
- id: yes
  label: Yes
- id: no
  label: No
- id: other
  label: Other
  requires_input: true
```
"#
        .to_string()
    }

    fn memory_item(id: &str) -> MemoryItem {
        MemoryItem {
            id: id.to_string(),
            kind: Some("decision".to_string()),
            title: "Session cookie first".to_string(),
            status: MemoryStatus::Active,
            tags: vec!["auth".to_string()],
            source_refs: vec![SourceRef {
                path: "Notes/Auth.md".to_string(),
                title: Some("Auth notes".to_string()),
                section_path: None,
                range: None,
                checksum: None,
                captured_at: "2026-05-07T00:00:00Z".to_string(),
            }],
            created_at: "2026-05-07T00:00:00Z".to_string(),
            updated_at: "2026-05-07T00:00:00Z".to_string(),
            proposal_id: "prop_auth".to_string(),
            decision_document: "Knowledge/decisions/auth.md".to_string(),
            body: "Use session cookies first.".to_string(),
        }
    }

    fn temp_vault() -> PathBuf {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis();
        let seq = TEST_COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("kuku-knowledge-read-test-{now}-{seq}"));
        fs::create_dir_all(&dir).unwrap();
        dir
    }
}
