use async_trait::async_trait;
use tauri::{AppHandle, Wry};

use crate::{
    AiError, AiState, ChatMode, FinishReason, NewSessionPayload,
    agent_runtime::{AgentRuntime, AgentSendMessageRequest},
    session,
};

pub struct NativeAgentRuntime;

impl NativeAgentRuntime {
    pub fn new_session(state: &AiState, mode: ChatMode) -> NewSessionPayload {
        let session = state.create_session(mode);
        NewSessionPayload {
            session_id: session.id.clone(),
        }
    }

    pub fn send_message(
        app: AppHandle<Wry>,
        state: AiState,
        request: AgentSendMessageRequest,
    ) -> Result<(), AiError> {
        let session = state.get_session(&request.session_id)?;
        let state_clone = state.clone();
        let app_clone = app.clone();
        tauri::async_runtime::spawn(async move {
            let title = request.title_candidate();
            let session_id = request.session_id.clone();
            let finish_reason = session::run_turn(
                app_clone,
                state_clone.clone(),
                session,
                request.mode,
                request.content,
                request.editor_context,
            )
            .await;
            if !matches!(finish_reason, FinishReason::Cancelled | FinishReason::Error) {
                if let Err(error) = state_clone.touch_agent_session(&session_id, title) {
                    log::warn!("failed to persist AI session metadata: {error}");
                }
            }
        });
        Ok(())
    }

    pub fn cancel(state: &AiState, session_id: &str) -> Result<(), AiError> {
        let session = state.get_session(session_id)?;
        session.cancel();
        Ok(())
    }

    pub fn close_session(state: &AiState, session_id: &str) -> Result<(), AiError> {
        let session = state.remove_session(session_id)?;
        session.cancel();
        Ok(())
    }
}

#[async_trait]
impl AgentRuntime for NativeAgentRuntime {
    async fn new_session(
        &self,
        _app: AppHandle<Wry>,
        state: &AiState,
        mode: ChatMode,
    ) -> Result<NewSessionPayload, AiError> {
        Ok(Self::new_session(state, mode))
    }

    async fn send_message(
        &self,
        app: AppHandle<Wry>,
        state: AiState,
        request: AgentSendMessageRequest,
    ) -> Result<(), AiError> {
        Self::send_message(app, state, request)
    }

    async fn cancel(&self, state: &AiState, session_id: &str) -> Result<(), AiError> {
        Self::cancel(state, session_id)
    }

    async fn close_session(&self, state: &AiState, session_id: &str) -> Result<(), AiError> {
        Self::close_session(state, session_id)
    }
}

#[cfg(test)]
mod tests {
    use crate::{AiState, ChatMode};

    use super::NativeAgentRuntime;

    #[test]
    fn new_session_creates_retrievable_session() {
        let state = AiState::default();

        let payload = NativeAgentRuntime::new_session(&state, ChatMode::Ask);

        assert!(state.get_session(&payload.session_id).is_ok());
    }

    #[test]
    fn close_session_removes_existing_session() {
        let state = AiState::default();
        let payload = NativeAgentRuntime::new_session(&state, ChatMode::Ask);

        NativeAgentRuntime::close_session(&state, &payload.session_id).unwrap();

        assert!(state.get_session(&payload.session_id).is_err());
    }

    #[test]
    fn cancel_existing_session_returns_ok() {
        let state = AiState::default();
        let payload = NativeAgentRuntime::new_session(&state, ChatMode::Ask);

        let result = NativeAgentRuntime::cancel(&state, &payload.session_id);

        assert!(result.is_ok());
    }
}
