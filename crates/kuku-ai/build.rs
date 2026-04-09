const COMMANDS: &[&str] = &[
    "ai_new_session",
    "ai_send_message",
    "ai_cancel",
    "ai_get_config",
    "ai_set_config",
    "ai_reset_state",
    "ai_list_tools",
    "ai_resolve_approval",
    "ai_register_proxy_tool",
    "ai_unregister_proxy_tool",
    "ai_submit_proxy_tool_result",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).build();
}
