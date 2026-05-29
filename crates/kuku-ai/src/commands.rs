use tauri::{AppHandle, State, Wry, command};

use crate::{
    AgentId, AiConfig, AiError, AiState, ChatMode, EditorContext, NewSessionPayload,
    PersistedAgentSession, ProxyToolDescriptor, ProxyToolResult,
    agent_runtime::AgentSendMessageRequest,
};

#[command]
pub async fn ai_new_session(
    app: AppHandle<Wry>,
    state: State<'_, AiState>,
    mode: ChatMode,
    agent_id: Option<AgentId>,
) -> Result<NewSessionPayload, String> {
    let agent_id = agent_id.unwrap_or_else(AgentId::kuku_native);
    let runtime = state
        .runtime_for_agent(&agent_id)
        .map_err(|error| error.to_string())?;
    let payload = runtime
        .new_session(app, &state, mode)
        .await
        .map_err(|error| error.to_string())?;
    if let Err(error) = state.record_agent_session(payload.session_id.clone(), agent_id) {
        log::warn!("failed to persist AI session metadata: {error}");
    }
    Ok(payload)
}

#[command]
pub async fn ai_send_message(
    app: AppHandle<Wry>,
    state: State<'_, AiState>,
    agent_id: Option<AgentId>,
    session_id: String,
    mode: ChatMode,
    content: String,
    editor_context: Option<EditorContext>,
) -> Result<(), String> {
    let agent_id = agent_id.unwrap_or_else(AgentId::kuku_native);
    let runtime = state
        .runtime_for_agent(&agent_id)
        .map_err(|error| error.to_string())?;
    runtime
        .send_message(
            app,
            state.inner().clone(),
            AgentSendMessageRequest {
                session_id: session_id.clone(),
                mode,
                content: content.clone(),
                editor_context: editor_context.unwrap_or_default(),
            },
        )
        .await
        .map_err(|error| error.to_string())
}

#[command]
pub async fn ai_cancel(
    state: State<'_, AiState>,
    agent_id: Option<AgentId>,
    session_id: String,
) -> Result<(), String> {
    let agent_id = agent_id.unwrap_or_else(AgentId::kuku_native);
    let runtime = state
        .runtime_for_agent(&agent_id)
        .map_err(|error| error.to_string())?;
    runtime
        .cancel(&state, &session_id)
        .await
        .map_err(|error| error.to_string())
}

#[command]
pub async fn ai_close_session(
    state: State<'_, AiState>,
    agent_id: Option<AgentId>,
    session_id: String,
) -> Result<(), String> {
    let agent_id = agent_id.unwrap_or_else(AgentId::kuku_native);
    match state.runtime_for_agent(&agent_id) {
        Ok(runtime) => match runtime.close_session(&state, &session_id).await {
            Ok(()) | Err(AiError::SessionNotFound) => {}
            Err(error) => return Err(error.to_string()),
        },
        Err(AiError::AgentUnavailable(_) | AiError::UnknownAgent(_)) => {}
        Err(error) => return Err(error.to_string()),
    }
    state
        .remove_agent_session(&session_id)
        .map_err(|error| error.to_string())
}

#[command]
pub async fn ai_get_config(state: State<'_, AiState>) -> Result<AiConfig, String> {
    Ok(state.config())
}

#[command]
pub async fn ai_set_config(state: State<'_, AiState>, config: AiConfig) -> Result<(), String> {
    state.set_config(config).map_err(|error| error.to_string())
}

#[command]
pub async fn ai_reset_state(state: State<'_, AiState>) -> Result<(), String> {
    state.reset_state().map_err(|error| error.to_string())
}

#[command]
pub async fn ai_list_tools(
    state: State<'_, AiState>,
) -> Result<Vec<crate::ToolDescriptor>, String> {
    Ok(state.tool_descriptors())
}

#[command]
pub async fn ai_list_agents(
    state: State<'_, AiState>,
) -> Result<Vec<crate::AgentDescriptor>, String> {
    Ok(state.agent_descriptors())
}

#[command]
pub async fn ai_list_sessions(
    state: State<'_, AiState>,
) -> Result<Vec<PersistedAgentSession>, String> {
    Ok(state.persisted_sessions())
}

#[command]
pub async fn ai_resolve_approval(
    state: State<'_, AiState>,
    session_id: String,
    call_id: String,
    approved: bool,
) -> Result<(), String> {
    state
        .resolve_approval(&session_id, &call_id, approved)
        .map_err(|error| error.to_string())
}

#[command]
pub async fn ai_register_proxy_tool(
    state: State<'_, AiState>,
    descriptor: ProxyToolDescriptor,
) -> Result<(), String> {
    state
        .register_proxy_tool(descriptor)
        .map_err(|error| error.to_string())
}

#[command]
pub async fn ai_unregister_proxy_tool(
    state: State<'_, AiState>,
    name: String,
) -> Result<(), String> {
    state.unregister_proxy_tool(&name);
    Ok(())
}

#[command]
pub async fn ai_submit_proxy_tool_result(
    state: State<'_, AiState>,
    call_id: String,
    output: String,
    is_error: bool,
) -> Result<(), String> {
    state
        .proxy_broker()
        .resolve(&call_id, ProxyToolResult { output, is_error })
        .map_err(|error| error.to_string())
}
