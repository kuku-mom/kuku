use automerge::AutomergeError;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum SyncCoreError {
    #[error("automerge operation failed: {0}")]
    Automerge(#[from] AutomergeError),
    #[error("manifest is missing filesById")]
    MissingFilesById,
    #[error("file metadata is missing for {0}")]
    MissingFile(String),
    #[error("text document is missing body")]
    MissingTextBody,
    #[error("expected {field} to be a string")]
    ExpectedString { field: &'static str },
    #[error("expected object at {field}")]
    ExpectedObject { field: &'static str },
}

pub type Result<T> = std::result::Result<T, SyncCoreError>;
