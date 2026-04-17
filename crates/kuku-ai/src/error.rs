use rig::completion::CompletionError;
use thiserror::Error;

#[derive(Debug, Error, Clone)]
pub enum AiError {
    #[error("AI is not configured. Set a Gemini API key first.")]
    NotConfigured,
    #[error("AI session not found.")]
    SessionNotFound,
    #[error("AI session is already running.")]
    SessionBusy,
    #[error("AI request was cancelled.")]
    Cancelled,
    #[error("AI host is not registered.")]
    HostUnavailable,
    #[error("Approval request not found.")]
    ApprovalNotFound,
    #[error("Authorization expired or invalid.")]
    Unauthorized,
    #[error("Provider init failed: {0}")]
    ProviderInit(String),
    #[error("Provider request failed: {0}")]
    ProviderError(String),
    #[error("Invalid arguments: {0}")]
    InvalidArguments(String),
    #[error("Tool not found: {0}")]
    ToolNotFound(String),
    #[error("Proxy tool timeout: {0}")]
    ProxyTimeout(String),
    #[error("State error: {0}")]
    State(String),
    #[error("I/O error: {0}")]
    Io(String),
}

impl AiError {
    pub fn message(&self) -> String {
        self.to_string()
    }
}

impl From<std::io::Error> for AiError {
    fn from(value: std::io::Error) -> Self {
        Self::Io(value.to_string())
    }
}

impl From<CompletionError> for AiError {
    fn from(value: CompletionError) -> Self {
        Self::ProviderError(value.to_string())
    }
}

#[derive(Debug, Error, Clone)]
pub enum ToolError {
    #[error("Invalid tool arguments: {0}")]
    InvalidArguments(String),
    #[error("Tool execution failed: {0}")]
    ExecutionFailed(String),
}
