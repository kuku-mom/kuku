pub mod agent_runtime;
mod commands;
mod contract;
mod error;
mod host;
mod mcp_bridge;
mod mutation;
mod prompts;
mod provider;
mod session;
mod state;
mod tools;
mod types;

use std::{
    path::{Path, PathBuf},
    sync::Arc,
};

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
    ToolCallContext, ToolDescriptor, ToolKind, ToolRiskLevel, ToolSource,
};
pub use types::{
    AgentDescriptor, AgentId, AgentKind, AiConfig, ChatMode, EditorContext, EmbeddedFileContext,
    ExternalAgentConfig, FinishReason, ModelToolCall, NewAgentSessionRequest, NewSessionPayload,
    PersistedAgentSession, PersistedChatSessionSnapshot, ProviderKind,
};

pub fn init() -> TauriPlugin<Wry> {
    Builder::new("kuku-ai")
        .setup(|app, _api| {
            let state = AiState::with_data_root(resolve_data_root(&app.config().identifier));
            app.manage(state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::ai_new_session,
            commands::ai_restore_session,
            commands::ai_send_message,
            commands::ai_cancel,
            commands::ai_close_session,
            commands::ai_get_config,
            commands::ai_set_config,
            commands::ai_reset_state,
            commands::ai_list_tools,
            commands::ai_list_agents,
            commands::ai_list_sessions,
            commands::ai_list_chat_sessions,
            commands::ai_save_chat_sessions,
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

fn resolve_data_root(identifier: &str) -> PathBuf {
    let home = dirs::home_dir().unwrap_or_else(std::env::temp_dir);
    data_root_for_identifier(identifier, &home)
}

fn data_root_for_identifier(identifier: &str, home: &Path) -> PathBuf {
    let suffix = match identifier {
        "mom.kuku.app.dev" => ".dev",
        "mom.kuku.app.preview" => ".preview",
        _ => "",
    };
    if suffix.is_empty() {
        home.join(".kuku")
    } else {
        home.join(format!(".kuku{suffix}"))
    }
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    #[test]
    fn data_root_for_identifier_uses_kuku_dev_for_development_bundle() {
        let home = Path::new("/Users/proposition");

        assert_eq!(
            super::data_root_for_identifier("mom.kuku.app.dev", home),
            home.join(".kuku.dev")
        );
        assert_eq!(
            super::data_root_for_identifier("mom.kuku.app", home),
            home.join(".kuku")
        );
    }
}
