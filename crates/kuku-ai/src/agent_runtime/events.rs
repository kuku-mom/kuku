use serde_json::Value;
use tauri::{AppHandle, Emitter, Wry};

use crate::{
    AiError,
    mutation::MutationPlan,
    types::{
        DonePayload, ErrorPayload, FinishReason, ModelToolCall, PendingApprovalPayload,
        ProxyToolCallPayload, StreamChunkPayload, TokenUsage, ToolCallEndPayload,
        ToolCallStartPayload,
    },
};

pub(crate) fn emit_stream_chunk(app: &AppHandle<Wry>, session_id: &str, delta: String) {
    let _ = app.emit(
        "ai:stream-chunk",
        StreamChunkPayload {
            session_id: session_id.to_string(),
            delta,
        },
    );
}

pub(crate) fn emit_done(
    app: &AppHandle<Wry>,
    session_id: &str,
    finish_reason: FinishReason,
    usage: Option<TokenUsage>,
) {
    let _ = app.emit(
        "ai:done",
        DonePayload {
            session_id: session_id.to_string(),
            finish_reason,
            usage,
        },
    );
}

pub(crate) fn emit_error(app: &AppHandle<Wry>, session_id: &str, error: &AiError) {
    let _ = app.emit(
        "ai:error",
        ErrorPayload {
            session_id: session_id.to_string(),
            message: error.message(),
        },
    );
}

pub(crate) fn emit_tool_start(
    app: &AppHandle<Wry>,
    session_id: &str,
    tool_call: &ModelToolCall,
    tool_id: &str,
) {
    let _ = app.emit(
        "ai:tool-call-start",
        ToolCallStartPayload {
            session_id: session_id.to_string(),
            call_id: tool_call.call_id.clone(),
            tool_id: tool_id.to_string(),
            tool_name: tool_call.tool_name.clone(),
            arguments: tool_call.arguments.clone(),
        },
    );
}

pub(crate) fn emit_tool_end(
    app: &AppHandle<Wry>,
    session_id: &str,
    call_id: &str,
    tool_id: &str,
    tool_name: &str,
    output: &str,
    is_error: bool,
) {
    let output = summarize_output(output);
    let _ = app.emit(
        "ai:tool-call-end",
        ToolCallEndPayload {
            session_id: session_id.to_string(),
            call_id: call_id.to_string(),
            tool_id: tool_id.to_string(),
            tool_name: tool_name.to_string(),
            output,
            is_error,
        },
    );
}

pub(crate) fn emit_pending_approval(
    app: &AppHandle<Wry>,
    session_id: &str,
    call_id: &str,
    tool_id: &str,
    tool_name: &str,
    mutation: MutationPlan,
    preview_text: Option<String>,
) {
    let _ = app.emit(
        "ai:pending-approval",
        PendingApprovalPayload {
            session_id: session_id.to_string(),
            call_id: call_id.to_string(),
            tool_id: tool_id.to_string(),
            tool_name: tool_name.to_string(),
            mutation,
            preview_text,
        },
    );
}

pub(crate) fn emit_proxy_call(
    app: &AppHandle<Wry>,
    session_id: &str,
    call_id: &str,
    tool_id: &str,
    tool_name: &str,
    arguments: Value,
) {
    let _ = app.emit(
        "ai:proxy-tool-call",
        ProxyToolCallPayload {
            session_id: session_id.to_string(),
            call_id: call_id.to_string(),
            tool_id: tool_id.to_string(),
            tool_name: tool_name.to_string(),
            arguments,
        },
    );
}

fn summarize_output(output: &str) -> String {
    const MAX: usize = 600;
    let Some((end, _)) = output.char_indices().nth(MAX) else {
        return output.to_string();
    };
    format!("{}...", &output[..end])
}

#[cfg(test)]
mod tests {
    use super::summarize_output;

    #[test]
    fn summarize_output_keeps_short_strings() {
        let input = "short output";
        assert_eq!(summarize_output(input), input);
    }

    #[test]
    fn summarize_output_truncates_on_char_boundary() {
        let input = format!("{}끝", "가".repeat(600));
        let summarized = summarize_output(&input);

        assert!(summarized.ends_with("..."));
        assert_eq!(summarized.chars().count(), 603);
        assert_eq!(summarized, format!("{}...", "가".repeat(600)));
    }
}
