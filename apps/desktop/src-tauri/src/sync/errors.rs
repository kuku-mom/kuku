use serde::{Deserialize, Serialize};

pub type SyncResult<T> = Result<T, SyncError>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum SyncErrorCategory {
    NotConfigured,
    LoginRequired,
    PermissionRequired,
    SyncDisabled,
    Offline,
    QuotaExceeded,
    PassphraseFailed,
    Server,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncCommandError {
    pub category: SyncErrorCategory,
    pub message: String,
}

impl SyncCommandError {
    pub fn from_sync_error(error: SyncError) -> Self {
        Self {
            category: error.category(),
            message: error.to_string(),
        }
    }

    pub fn server(message: impl Into<String>) -> Self {
        Self {
            category: SyncErrorCategory::Server,
            message: message.into(),
        }
    }
}

#[allow(dead_code)]
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SyncError {
    Crypto(String),
    Integrity(String),
    InvalidArgument(String),
    LoginRequired,
    NotConfigured,
    Offline(String),
    PermissionRequired,
    QuotaExceeded(String),
    Serialization(String),
    Server(String),
    Storage(String),
    SyncDisabled,
    Transport(String),
    UnsupportedVersion(u8),
}

impl std::fmt::Display for SyncError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SyncError::Crypto(message) => write!(f, "sync crypto error: {message}"),
            SyncError::Integrity(message) => write!(f, "sync integrity error: {message}"),
            SyncError::InvalidArgument(message) => write!(f, "invalid sync argument: {message}"),
            SyncError::LoginRequired => write!(f, "sync login is required"),
            SyncError::NotConfigured => write!(f, "sync is not configured"),
            SyncError::Offline(message) => write!(f, "sync connection error: {message}"),
            SyncError::PermissionRequired => write!(f, "sync account permission is required"),
            SyncError::QuotaExceeded(message) => write!(f, "sync quota exceeded: {message}"),
            SyncError::Serialization(message) => write!(f, "sync serialization error: {message}"),
            SyncError::Server(message) => write!(f, "sync server error: {message}"),
            SyncError::Storage(message) => write!(f, "sync storage error: {message}"),
            SyncError::SyncDisabled => write!(f, "sync is disabled on this server"),
            SyncError::Transport(message) => write!(f, "sync transport error: {message}"),
            SyncError::UnsupportedVersion(version) => {
                write!(f, "unsupported sync version: {version}")
            }
        }
    }
}

impl std::error::Error for SyncError {}

impl SyncError {
    pub fn category(&self) -> SyncErrorCategory {
        match self {
            Self::NotConfigured => SyncErrorCategory::NotConfigured,
            Self::LoginRequired => SyncErrorCategory::LoginRequired,
            Self::PermissionRequired => SyncErrorCategory::PermissionRequired,
            Self::SyncDisabled => SyncErrorCategory::SyncDisabled,
            Self::Offline(_) => SyncErrorCategory::Offline,
            Self::QuotaExceeded(_) => SyncErrorCategory::QuotaExceeded,
            Self::Server(_) => SyncErrorCategory::Server,
            Self::Crypto(message)
                if contains_case_insensitive(message, "passphrase")
                    || contains_case_insensitive(message, "recovery phrase") =>
            {
                SyncErrorCategory::PassphraseFailed
            }
            Self::Transport(message) => category_from_transport_message(message),
            _ => SyncErrorCategory::Unknown,
        }
    }
}

pub fn command_error(error: SyncError) -> SyncCommandError {
    SyncCommandError::from_sync_error(error)
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

fn contains_case_insensitive(value: &str, needle: &str) -> bool {
    value.to_lowercase().contains(needle)
}

fn category_from_transport_message(message: &str) -> SyncErrorCategory {
    let lower = message.to_lowercase();
    match () {
        _ if lower.contains("sync disabled") => SyncErrorCategory::SyncDisabled,
        _ if lower.contains("resource_exhausted") || lower.contains("quota") => {
            SyncErrorCategory::QuotaExceeded
        }
        _ if lower.contains("permission_denied") || lower.contains("permission denied") => {
            SyncErrorCategory::PermissionRequired
        }
        _ if lower.contains("unauthenticated")
            || lower.contains("unauthorized")
            || lower.contains("login") =>
        {
            SyncErrorCategory::LoginRequired
        }
        _ if lower.contains("unavailable")
            || lower.contains("deadline_exceeded")
            || lower.contains("network")
            || lower.contains("offline")
            || lower.contains("connection refused")
            || lower.contains("error sending request") =>
        {
            SyncErrorCategory::Offline
        }
        _ if lower.contains("internal") || lower.contains("unknown") => SyncErrorCategory::Server,
        _ => SyncErrorCategory::Unknown,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn command_error_serializes_category_and_message() {
        let error = command_error(SyncError::NotConfigured);

        assert_eq!(error.category, SyncErrorCategory::NotConfigured);
        assert_eq!(error.message, "sync is not configured");
    }

    #[test]
    fn sync_error_category_classifies_user_actionable_errors() {
        assert_eq!(
            SyncError::Crypto("passphrase unwrap failed".into()).category(),
            SyncErrorCategory::PassphraseFailed
        );
        assert_eq!(
            SyncError::Crypto("account recovery phrase unwrap failed".into()).category(),
            SyncErrorCategory::PassphraseFailed
        );
        assert_eq!(
            SyncError::Transport(
                "CreateWorkspace failed: failed_precondition: sync disabled".into()
            )
            .category(),
            SyncErrorCategory::SyncDisabled
        );
        assert_eq!(
            SyncError::Transport("CreateObjectUploadBatch failed: resource_exhausted".into())
                .category(),
            SyncErrorCategory::QuotaExceeded
        );
        assert_eq!(
            SyncError::Transport("request failed: error sending request".into()).category(),
            SyncErrorCategory::Offline
        );
    }
}
