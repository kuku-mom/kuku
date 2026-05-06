pub type SyncResult<T> = Result<T, SyncError>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SyncError {
    Crypto(String),
    InvalidArgument(String),
    NotConfigured,
    Serialization(String),
    Storage(String),
    UnsupportedVersion(u8),
}

impl std::fmt::Display for SyncError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SyncError::Crypto(message) => write!(f, "sync crypto error: {message}"),
            SyncError::InvalidArgument(message) => write!(f, "invalid sync argument: {message}"),
            SyncError::NotConfigured => write!(f, "sync is not configured"),
            SyncError::Serialization(message) => write!(f, "sync serialization error: {message}"),
            SyncError::Storage(message) => write!(f, "sync storage error: {message}"),
            SyncError::UnsupportedVersion(version) => {
                write!(f, "unsupported sync version: {version}")
            }
        }
    }
}

impl std::error::Error for SyncError {}

pub fn command_error(error: SyncError) -> String {
    error.to_string()
}

impl From<std::io::Error> for SyncError {
    fn from(value: std::io::Error) -> Self {
        Self::Storage(value.to_string())
    }
}

impl From<serde_json::Error> for SyncError {
    fn from(value: serde_json::Error) -> Self {
        Self::Serialization(value.to_string())
    }
}
