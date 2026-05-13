use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::mutation::MutationPlan;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ProviderKind {
    Gemini,
    Remote,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ChatMode {
    Ask,
    Agent,
    Inline,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddedFileContext {
    pub path: String,
    pub content: String,
    pub checksum: String,
    pub size_bytes: u64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorContext {
    pub active_file: Option<String>,
    pub selected_text: Option<String>,
    #[serde(default)]
    pub embedded_files: Vec<EmbeddedFileContext>,
    #[serde(default)]
    pub open_tabs: Vec<String>,
    pub cursor_line: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiConfig {
    pub provider: ProviderKind,
    pub api_key: Option<String>,
    pub model: String,
    pub server_url: Option<String>,
    pub round_limit: u32,
    pub proxy_tool_timeout_ms: u64,
}

impl Default for AiConfig {
    fn default() -> Self {
        Self {
            provider: ProviderKind::Remote,
            api_key: None,
            model: "gemini-3.1-flash-lite".to_string(),
            server_url: Some(default_server_url()),
            round_limit: 12,
            proxy_tool_timeout_ms: 15_000,
        }
    }
}

fn default_server_url() -> String {
    // Rust-side compile-time env. Mirrors the desktop crate's
    // `config::api_url()` so the auth client and the AI client agree on
    // which backend to hit. The Vite-prefixed variant used to live here
    // as a fallback, but that's a TS-build-system namespace leaking
    // into Rust — stick to `KUKU_API_URL` and leave Vite consumers to
    // set their own `VITE_KUKU_API_URL`.
    option_env!("KUKU_API_URL")
        .unwrap_or(if cfg!(debug_assertions) {
            "http://localhost:8080"
        } else {
            "https://api.kuku.mom"
        })
        .to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelToolCall {
    pub call_id: String,
    pub tool_name: String,
    pub arguments: Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    // Gemini's opaque reasoning signature travels as-is across turns.
    // Uses Vec<u8> because ThoughtSignature bytes aren't guaranteed
    // valid UTF-8 — forcing them into a String would fail on the
    // server's proto marshal. See `.proto` for the wire-level reason.
    pub signature: Option<Vec<u8>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_call_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenUsage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub total_tokens: u64,
    pub cached_input_tokens: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum FinishReason {
    Stop,
    ToolCalls,
    ToolRoundLimit,
    Cancelled,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ChatMessage {
    System {
        content: String,
    },
    User {
        content: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        editor_context: Option<EditorContext>,
    },
    Assistant {
        content: String,
        #[serde(default)]
        tool_calls: Vec<ModelToolCall>,
    },
    ToolResult {
        call_id: String,
        tool_name: String,
        output: String,
        is_error: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        tool_call_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        provider_call_id: Option<String>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewSessionPayload {
    pub session_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamChunkPayload {
    pub session_id: String,
    pub delta: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DonePayload {
    pub session_id: String,
    pub finish_reason: FinishReason,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage: Option<TokenUsage>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ErrorPayload {
    pub session_id: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCallStartPayload {
    pub session_id: String,
    pub call_id: String,
    pub tool_id: String,
    pub tool_name: String,
    pub arguments: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCallEndPayload {
    pub session_id: String,
    pub call_id: String,
    pub tool_id: String,
    pub tool_name: String,
    pub output: String,
    pub is_error: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingApprovalPayload {
    pub session_id: String,
    pub call_id: String,
    pub tool_id: String,
    pub tool_name: String,
    pub mutation: MutationPlan,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preview_text: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyToolCallPayload {
    pub session_id: String,
    pub call_id: String,
    pub tool_id: String,
    pub tool_name: String,
    pub arguments: Value,
}
