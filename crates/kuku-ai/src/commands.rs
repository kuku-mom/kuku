use tauri::{AppHandle, State, Wry, command};

use crate::{
    AiConfig, AiState, ChatMode, EditorContext, NewSessionPayload, ProxyToolDescriptor,
    ProxyToolResult, session,
};

#[command]
pub async fn ai_new_session(
    state: State<'_, AiState>,
    mode: ChatMode,
) -> Result<NewSessionPayload, String> {
    let session = state.create_session(mode);
    Ok(NewSessionPayload {
        session_id: session.id.clone(),
    })
}

#[command]
pub async fn ai_send_message(
    app: AppHandle<Wry>,
    state: State<'_, AiState>,
    session_id: String,
    content: String,
    editor_context: Option<EditorContext>,
) -> Result<(), String> {
    let session = state
        .get_session(&session_id)
        .map_err(|error| error.to_string())?;
    let state_clone = state.inner().clone();
    let app_clone = app.clone();
    tauri::async_runtime::spawn(async move {
        session::run_turn(
            app_clone,
            state_clone,
            session,
            content,
            editor_context.unwrap_or_default(),
        )
        .await;
    });
    Ok(())
}

#[command]
pub async fn ai_cancel(state: State<'_, AiState>, session_id: String) -> Result<(), String> {
    let session = state
        .get_session(&session_id)
        .map_err(|error| error.to_string())?;
    session.cancel();
    Ok(())
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
pub async fn ai_resolve_approval(
    state: State<'_, AiState>,
    session_id: String,
    call_id: String,
    approved: bool,
) -> Result<(), String> {
    let session = state
        .get_session(&session_id)
        .map_err(|error| error.to_string())?;
    session
        .resolve_approval(&call_id, approved)
        .map_err(|error| error.to_string())
}

#[command]
pub async fn ai_register_proxy_tool(
    state: State<'_, AiState>,
    descriptor: ProxyToolDescriptor,
) -> Result<(), String> {
    state.register_proxy_tool(descriptor);
    Ok(())
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
