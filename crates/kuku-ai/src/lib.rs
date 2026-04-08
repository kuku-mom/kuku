mod commands;
mod error;
mod host;
mod mutation;
mod prompts;
mod provider;
mod session;
mod state;
mod tools;
mod types;

use std::sync::Arc;

pub use error::{AiError, ToolError};
pub use host::AiHostBindings;
pub use mutation::{ConflictItem, MutationApplyResult, MutationOp, MutationPlan};
pub use state::AiState;
use tauri::{
    AppHandle, Manager, Wry,
    plugin::{Builder, TauriPlugin},
};
pub use tools::{
    AiNativeTool, NativeToolResult, ProxyToolDescriptor, ProxyToolResult, ToolAccess,
    ToolCallContext, ToolDescriptor, ToolSource,
};
pub use types::{
    AiConfig, ChatMode, EditorContext, FinishReason, ModelToolCall, NewSessionPayload, ProviderKind,
};

pub fn init() -> TauriPlugin<Wry> {
    Builder::new("kuku-ai")
        .setup(|app, _api| {
            app.manage(AiState::default());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::ai_new_session,
            commands::ai_send_message,
            commands::ai_cancel,
            commands::ai_get_config,
            commands::ai_set_config,
            commands::ai_list_tools,
            commands::ai_resolve_approval,
            commands::ai_register_proxy_tool,
            commands::ai_unregister_proxy_tool,
            commands::ai_submit_proxy_tool_result,
        ])
        .build()
}

pub fn register_host(app: &AppHandle<Wry>, host: Arc<dyn AiHostBindings>) {
    let state = app.state::<AiState>();
    state.set_host(host);
}

pub fn register_tool(app: &AppHandle<Wry>, tool: Arc<dyn AiNativeTool>) {
    let state = app.state::<AiState>();
    state.register_tool(tool);
}
