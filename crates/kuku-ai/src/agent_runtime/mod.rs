use async_trait::async_trait;
use std::path::PathBuf;
use tauri::{AppHandle, Wry};

use crate::{AiError, AiState, ChatMode, EditorContext, NewSessionPayload, types::ChatMessage};

pub(crate) mod acp;
pub(crate) mod events;
pub mod native;
pub(crate) mod store;

#[derive(Debug, Clone)]
pub struct AgentNewSessionRequest {
    pub mode: ChatMode,
    pub working_directory: Option<PathBuf>,
}

#[derive(Debug, Clone)]
pub struct AgentSendMessageRequest {
    pub session_id: String,
    pub mode: ChatMode,
    pub content: String,
    pub editor_context: EditorContext,
}

impl AgentSendMessageRequest {
    pub(crate) fn title_candidate(&self) -> String {
        let title = self
            .content
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        if title.chars().count() <= 80 {
            return title;
        }
        title.chars().take(80).collect()
    }
}

#[derive(Debug, Clone)]
pub struct AgentRestoreSessionRequest {
    pub session_id: String,
    pub external_session_id: Option<String>,
    pub mode: ChatMode,
    pub working_directory: Option<PathBuf>,
    pub messages: Vec<ChatMessage>,
}

#[async_trait]
pub trait AgentRuntime: Send + Sync {
    async fn new_session(
        &self,
        app: AppHandle<Wry>,
        state: &AiState,
        request: AgentNewSessionRequest,
    ) -> Result<NewSessionPayload, AiError>;

    async fn send_message(
        &self,
        app: AppHandle<Wry>,
        state: AiState,
        request: AgentSendMessageRequest,
    ) -> Result<(), AiError>;

    async fn restore_session(
        &self,
        app: AppHandle<Wry>,
        state: &AiState,
        request: AgentRestoreSessionRequest,
    ) -> Result<NewSessionPayload, AiError>;

    async fn cancel(&self, state: &AiState, session_id: &str) -> Result<(), AiError>;

    async fn close_session(&self, state: &AiState, session_id: &str) -> Result<(), AiError>;
}
