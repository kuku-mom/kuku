use std::path::{Path, PathBuf};

use crate::knowledge::models::{KnowledgeErrorCode, KnowledgeInitResult, KnowledgeStatusResult};

const REQUIRED_DIRS: &[&str] = &[
    "Knowledge",
    "Knowledge/memory",
    "Knowledge/proposals",
    "Knowledge/decisions",
    ".kuku/knowledge",
    ".kuku/knowledge/apply-journal",
    ".kuku/knowledge/apply-tmp",
    ".kuku/knowledge/apply-lock",
    ".kuku/knowledge/document-write-lock",
];

#[derive(Debug, Clone)]
pub struct KnowledgeServiceError {
    pub code: KnowledgeErrorCode,
    pub message: String,
}

impl KnowledgeServiceError {
    fn already_exists(path: &str) -> Self {
        Self {
            code: KnowledgeErrorCode::AlreadyExists,
            message: format!("Required Knowledge directory path exists as a file: {path}"),
        }
    }

    fn io(message: impl Into<String>) -> Self {
        Self {
            code: KnowledgeErrorCode::IoError,
            message: message.into(),
        }
    }
}

pub async fn knowledge_status_for_root(
    root: &Path,
) -> Result<KnowledgeStatusResult, KnowledgeServiceError> {
    let root_exists = is_dir(root.join("Knowledge")).await?;
    let memory_dir_exists = is_dir(root.join("Knowledge/memory")).await?;
    let proposals_dir_exists = is_dir(root.join("Knowledge/proposals")).await?;
    let decisions_dir_exists = is_dir(root.join("Knowledge/decisions")).await?;
    let cache_dir_exists = is_dir(root.join(".kuku/knowledge")).await?;
    let initialized = root_exists
        && memory_dir_exists
        && proposals_dir_exists
        && decisions_dir_exists
        && cache_dir_exists;

    Ok(KnowledgeStatusResult {
        initialized,
        root_exists,
        memory_dir_exists,
        proposals_dir_exists,
        decisions_dir_exists,
        cache_dir_exists,
    })
}

pub async fn knowledge_init_for_root(
    root: &Path,
) -> Result<KnowledgeInitResult, KnowledgeServiceError> {
    for dir in REQUIRED_DIRS {
        reject_file_at_required_dir(root, dir).await?;
    }

    let mut created_dirs = Vec::new();
    for dir in REQUIRED_DIRS {
        let path = root.join(dir);
        if !path_exists(&path).await? {
            created_dirs.push((*dir).to_string());
        }
        tokio::fs::create_dir_all(&path).await.map_err(|error| {
            KnowledgeServiceError::io(format!("Failed to create {dir}: {error}"))
        })?;
    }

    let status = knowledge_status_for_root(root).await?;
    Ok(KnowledgeInitResult::from_status(status, created_dirs))
}

async fn reject_file_at_required_dir(root: &Path, dir: &str) -> Result<(), KnowledgeServiceError> {
    let path = root.join(dir);
    match tokio::fs::metadata(&path).await {
        Ok(metadata) if metadata.is_file() => Err(KnowledgeServiceError::already_exists(dir)),
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(KnowledgeServiceError::io(format!(
            "Failed to inspect {dir}: {error}"
        ))),
    }
}

async fn is_dir(path: PathBuf) -> Result<bool, KnowledgeServiceError> {
    match tokio::fs::metadata(&path).await {
        Ok(metadata) => Ok(metadata.is_dir()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(KnowledgeServiceError::io(error.to_string())),
    }
}

async fn path_exists(path: &Path) -> Result<bool, KnowledgeServiceError> {
    match tokio::fs::try_exists(path).await {
        Ok(exists) => Ok(exists),
        Err(error) => Err(KnowledgeServiceError::io(error.to_string())),
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    use tauri::async_runtime;

    use super::{knowledge_init_for_root, knowledge_status_for_root};
    use crate::knowledge::models::KnowledgeErrorCode;

    static TEST_COUNTER: AtomicU64 = AtomicU64::new(0);

    #[test]
    fn status_reports_missing_layout() {
        let root = temp_vault();
        let status = async_runtime::block_on(knowledge_status_for_root(&root)).unwrap();

        assert!(!status.initialized);
        assert!(!status.root_exists);
        assert!(!status.memory_dir_exists);
        assert!(!status.proposals_dir_exists);
        assert!(!status.decisions_dir_exists);
        assert!(!status.cache_dir_exists);

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn init_creates_required_layout_and_is_idempotent() {
        let root = temp_vault();
        let first = async_runtime::block_on(knowledge_init_for_root(&root)).unwrap();

        assert!(first.initialized);
        assert!(first.created_dirs.contains(&"Knowledge".to_string()));
        assert!(root.join("Knowledge/memory").is_dir());
        assert!(root.join("Knowledge/proposals").is_dir());
        assert!(root.join("Knowledge/decisions").is_dir());
        assert!(root.join(".kuku/knowledge/apply-journal").is_dir());
        assert!(root.join(".kuku/knowledge/apply-tmp").is_dir());
        assert!(root.join(".kuku/knowledge/apply-lock").is_dir());
        assert!(root.join(".kuku/knowledge/document-write-lock").is_dir());

        let second = async_runtime::block_on(knowledge_init_for_root(&root)).unwrap();
        assert!(second.initialized);
        assert!(second.created_dirs.is_empty());

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn init_rejects_file_where_directory_is_required() {
        let root = temp_vault();
        fs::create_dir_all(root.join("Knowledge")).unwrap();
        fs::write(root.join("Knowledge/memory"), "not a directory").unwrap();

        let error = async_runtime::block_on(knowledge_init_for_root(&root)).unwrap_err();
        assert!(matches!(error.code, KnowledgeErrorCode::AlreadyExists));
        assert!(error.message.contains("Knowledge/memory"));

        let _ = fs::remove_dir_all(root);
    }

    fn temp_vault() -> PathBuf {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis();
        let seq = TEST_COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("kuku-knowledge-test-{now}-{seq}"));
        fs::create_dir_all(&dir).unwrap();
        dir
    }
}
