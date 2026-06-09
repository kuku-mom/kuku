use std::{ffi::OsString, process::Stdio};

use async_stream::try_stream;
use async_trait::async_trait;
use serde_json::{Value, json};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines},
    process::{ChildStdout, Command},
};

use crate::{
    AiError,
    provider::{
        CompletionBackend, CompletionEvent, CompletionTurnRequest, CompletionTurnStream,
        ToolCallResponse,
    },
    tools::ToolDescriptor,
    types::{ChatMode, FinishReason, ModelToolCall},
};

pub struct CodexAppServerBackend {
    command: String,
    cwd: Option<String>,
    model: String,
}

impl CodexAppServerBackend {
    pub fn new(
        command: impl Into<String>,
        cwd: Option<String>,
        model: impl Into<String>,
    ) -> Result<Self, AiError> {
        let command = command.into();
        if command.trim().is_empty() {
            return Err(AiError::ProviderInit(
                "Codex app-server command cannot be empty".to_string(),
            ));
        }
        Ok(Self {
            command,
            cwd,
            model: model.into(),
        })
    }
}

#[async_trait]
impl CompletionBackend for CodexAppServerBackend {
    async fn stream_turn(
        &self,
        request: CompletionTurnRequest,
    ) -> Result<CompletionTurnStream, AiError> {
        let prompt = prompt_from_request(&request);
        if prompt.trim().is_empty() {
            return Err(AiError::InvalidArguments(
                "Codex app-server requires a user prompt".to_string(),
            ));
        }

        let command_name = self.command.clone();
        let model = self.model.clone();
        let cwd = cwd_for_request(&request, self.cwd.as_deref()).or_else(|| {
            std::env::current_dir()
                .ok()
                .map(|path| path.to_string_lossy().to_string())
        });

        Ok(Box::pin(try_stream! {
            let mut child = Command::new(&command_name)
                .args(app_server_args())
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .spawn()
                .map_err(|error| AiError::ProviderError(format!("failed to run Codex app-server: {error}")))?;

            let mut stdin = child
                .stdin
                .take()
                .ok_or_else(|| AiError::ProviderError("Codex app-server stdin was unavailable".to_string()))?;
            let stdout = child
                .stdout
                .take()
                .ok_or_else(|| AiError::ProviderError("Codex app-server stdout was unavailable".to_string()))?;
            let mut lines = BufReader::new(stdout).lines();

            send_json(&mut stdin, &build_initialize_request(0)).await?;
            let _ = wait_for_response(&mut lines, 0).await?;
            send_json(&mut stdin, &build_initialized_notification()).await?;

            send_json(
                &mut stdin,
                &build_thread_start_request(
                    1,
                    &model,
                    cwd.as_deref(),
                    &request.mode,
                    &request.tools,
                ),
            )
            .await?;
            let thread_response = wait_for_response(&mut lines, 1).await?;
            let thread_id = extract_thread_id(&thread_response)?;

            send_json(
                &mut stdin,
                &build_turn_start_request(
                    2,
                    &thread_id,
                    &prompt,
                    &model,
                    cwd.as_deref(),
                    &request.mode,
                ),
            )
            .await?;

            let mut completed = false;
            while let Some(line) = lines
                .next_line()
                .await
                .map_err(|error| AiError::ProviderError(format!("failed to read Codex app-server: {error}")))?
            {
                let message = parse_message(&line)?;

                if is_response_to(&message, 2) {
                    if let Some(error) = message.get("error") {
                        Err(AiError::ProviderError(jsonrpc_error_message(error)))?;
                    }
                    continue;
                }

                if let Some((response_id, call)) = tool_call_from_request(&message)? {
                    let (respond_to, response) = tokio::sync::oneshot::channel();
                    yield CompletionEvent::ToolCallRequest { call, respond_to };
                    let response = response
                        .await
                        .map_err(|_| AiError::ProviderError("Codex app-server tool responder dropped".to_string()))?;
                    send_json(
                        &mut stdin,
                        &build_tool_call_response(response_id, &response),
                    )
                    .await?;
                    continue;
                }

                if let Some((response_id, method)) = unsupported_server_request(&message) {
                    send_json(
                        &mut stdin,
                        &build_unsupported_server_request_response(response_id, &method),
                    )
                    .await?;
                    continue;
                }

                let Some(event) = completion_event_from_notification(&message)? else {
                    continue;
                };
                let is_finished = matches!(event, CompletionEvent::Finished { .. });
                yield event;
                if is_finished {
                    completed = true;
                    break;
                }
            }

            let _ = child.kill().await;
            if !completed {
                Err(AiError::ProviderError(
                    "Codex app-server stream ended without turn/completed".to_string(),
                ))?;
            }
        }))
    }

    async fn list_models(&self) -> Result<Vec<String>, AiError> {
        Ok(vec![self.model.clone()])
    }
}

fn app_server_args() -> Vec<OsString> {
    vec![
        OsString::from("app-server"),
        OsString::from("--listen"),
        OsString::from("stdio://"),
    ]
}

fn cwd_for_request(
    request: &CompletionTurnRequest,
    backend_default: Option<&str>,
) -> Option<String> {
    request
        .cwd
        .as_deref()
        .filter(|cwd| !cwd.trim().is_empty())
        .or(backend_default)
        .map(str::to_string)
}

fn build_initialize_request(id: u64) -> Value {
    json!({
        "id": id,
        "method": "initialize",
        "params": {
            "clientInfo": {
                "name": "kuku_desktop",
                "title": "Kuku Desktop",
                "version": env!("CARGO_PKG_VERSION")
            },
            "capabilities": {
                "experimentalApi": true
            }
        }
    })
}

fn build_initialized_notification() -> Value {
    json!({
        "method": "initialized",
        "params": {}
    })
}

fn build_thread_start_request(
    id: u64,
    model: &str,
    cwd: Option<&str>,
    mode: &ChatMode,
    tools: &[ToolDescriptor],
) -> Value {
    json!({
        "id": id,
        "method": "thread/start",
        "params": {
            "model": model_value(model),
            "cwd": cwd,
            "approvalPolicy": "never",
            "sandbox": app_server_sandbox_mode(mode),
            "dynamicTools": dynamic_tool_specs(tools),
            "ephemeral": true,
            "threadSource": "user"
        }
    })
}

fn build_turn_start_request(
    id: u64,
    thread_id: &str,
    prompt: &str,
    model: &str,
    cwd: Option<&str>,
    mode: &ChatMode,
) -> Value {
    json!({
        "id": id,
        "method": "turn/start",
        "params": {
            "threadId": thread_id,
            "cwd": cwd,
            "model": model_value(model),
            "approvalPolicy": "never",
            "sandboxPolicy": app_server_sandbox_policy(mode, cwd),
            "input": [
                {
                    "type": "text",
                    "text": prompt
                }
            ]
        }
    })
}

fn app_server_sandbox_mode(mode: &ChatMode) -> &'static str {
    match mode {
        ChatMode::Agent => "workspace-write",
        ChatMode::Ask | ChatMode::Inline => "read-only",
    }
}

fn app_server_sandbox_policy(mode: &ChatMode, cwd: Option<&str>) -> Value {
    match mode {
        ChatMode::Agent => json!({
            "type": "workspaceWrite",
            "networkAccess": false,
            "writableRoots": writable_roots(cwd)
        }),
        ChatMode::Ask | ChatMode::Inline => json!({
            "type": "readOnly",
            "networkAccess": false
        }),
    }
}

fn writable_roots(cwd: Option<&str>) -> Vec<String> {
    cwd.into_iter()
        .map(str::trim)
        .filter(|root| !root.is_empty())
        .map(str::to_string)
        .collect()
}

fn dynamic_tool_specs(tools: &[ToolDescriptor]) -> Value {
    Value::Array(
        tools
            .iter()
            .map(|tool| {
                json!({
                    "name": tool.name,
                    "namespace": "kuku",
                    "description": tool.description,
                    "inputSchema": tool.parameters
                })
            })
            .collect(),
    )
}

fn model_value(model: &str) -> Value {
    let trimmed = model.trim();
    if trimmed.is_empty() || trimmed == "codex" {
        Value::Null
    } else {
        Value::String(trimmed.to_string())
    }
}

fn prompt_from_request(request: &CompletionTurnRequest) -> String {
    let mut sections = Vec::new();
    if let Some(system_prompt) = request.system_prompt.as_deref() {
        let trimmed = system_prompt.trim();
        if !trimmed.is_empty() {
            sections.push(format!("System instructions:\n{trimmed}"));
        }
    }

    for message in &request.messages {
        match message {
            crate::types::ChatMessage::System { content } => {
                push_prompt_section(&mut sections, "System", content);
            }
            crate::types::ChatMessage::User { content, .. } => {
                push_prompt_section(&mut sections, "User", content);
            }
            crate::types::ChatMessage::Assistant { content, .. } => {
                push_prompt_section(&mut sections, "Assistant", content);
            }
            crate::types::ChatMessage::ToolResult {
                tool_name,
                output,
                is_error,
                ..
            } => {
                let label = if *is_error {
                    format!("Tool result ({tool_name}, error)")
                } else {
                    format!("Tool result ({tool_name})")
                };
                push_prompt_section(&mut sections, &label, output);
            }
        }
    }

    sections.join("\n\n")
}

fn push_prompt_section(sections: &mut Vec<String>, label: &str, content: &str) {
    let trimmed = content.trim();
    if !trimmed.is_empty() {
        sections.push(format!("{label}:\n{trimmed}"));
    }
}

fn completion_event_from_notification(message: &Value) -> Result<Option<CompletionEvent>, AiError> {
    match message.get("method").and_then(Value::as_str) {
        Some("item/agentMessage/delta") => {
            let delta = message
                .get("params")
                .and_then(|params| params.get("delta"))
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    AiError::ProviderError(
                        "Codex app-server delta notification omitted params.delta".to_string(),
                    )
                })?;
            if delta.is_empty() {
                return Ok(None);
            }
            Ok(Some(CompletionEvent::TextDelta(delta.to_string())))
        }
        Some("turn/completed") => {
            let turn = message
                .get("params")
                .and_then(|params| params.get("turn"))
                .ok_or_else(|| {
                    AiError::ProviderError(
                        "Codex app-server turn/completed omitted params.turn".to_string(),
                    )
                })?;
            match turn.get("status").and_then(Value::as_str) {
                Some("completed") => Ok(Some(CompletionEvent::Finished {
                    finish_reason: FinishReason::Stop,
                    usage: None,
                })),
                Some("interrupted") => Ok(Some(CompletionEvent::Finished {
                    finish_reason: FinishReason::Cancelled,
                    usage: None,
                })),
                Some("failed") => Err(AiError::ProviderError(
                    turn.get("error")
                        .and_then(|error| error.get("message"))
                        .and_then(Value::as_str)
                        .unwrap_or("Codex app-server turn failed")
                        .to_string(),
                )),
                _ => Ok(None),
            }
        }
        Some("error") => Err(AiError::ProviderError(
            message
                .get("params")
                .and_then(|params| params.get("message"))
                .and_then(Value::as_str)
                .unwrap_or("Codex app-server reported an error")
                .to_string(),
        )),
        _ => Ok(None),
    }
}

fn tool_call_from_request(message: &Value) -> Result<Option<(Value, ModelToolCall)>, AiError> {
    if message.get("method").and_then(Value::as_str) != Some("item/tool/call") {
        return Ok(None);
    }

    let response_id = message.get("id").cloned().ok_or_else(|| {
        AiError::ProviderError("Codex app-server tool call omitted JSON-RPC id".to_string())
    })?;
    let params = message.get("params").ok_or_else(|| {
        AiError::ProviderError("Codex app-server tool call omitted params".to_string())
    })?;
    let call_id = params
        .get("callId")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            AiError::ProviderError("Codex app-server tool call omitted params.callId".to_string())
        })?
        .to_string();
    let tool_name =
        normalize_tool_name(params.get("tool").and_then(Value::as_str).ok_or_else(|| {
            AiError::ProviderError("Codex app-server tool call omitted params.tool".to_string())
        })?);

    let arguments = params
        .get("arguments")
        .map(normalize_tool_arguments)
        .transpose()?
        .unwrap_or_else(|| json!({}));

    Ok(Some((
        response_id,
        ModelToolCall {
            call_id: call_id.clone(),
            tool_name,
            arguments,
            signature: None,
            tool_call_id: Some(call_id.clone()),
            provider_call_id: Some(call_id),
        },
    )))
}

fn normalize_tool_name(tool_name: &str) -> String {
    tool_name
        .strip_prefix("kuku.")
        .unwrap_or(tool_name)
        .to_string()
}

fn normalize_tool_arguments(arguments: &Value) -> Result<Value, AiError> {
    match arguments {
        Value::String(raw) => serde_json::from_str(raw).map_err(|error| {
            AiError::ProviderError(format!(
                "Codex app-server tool call arguments were not valid JSON: {error}"
            ))
        }),
        Value::Null => Ok(json!({})),
        value => Ok(value.clone()),
    }
}

fn unsupported_server_request(message: &Value) -> Option<(Value, String)> {
    let response_id = message.get("id")?.clone();
    let method = message.get("method")?.as_str()?;
    if method == "item/tool/call" {
        return None;
    }
    Some((response_id, method.to_string()))
}

fn build_unsupported_server_request_response(id: Value, method: &str) -> Value {
    let result = match method {
        "item/fileChange/requestApproval" => Some(json!({ "decision": "decline" })),
        "item/commandExecution/requestApproval" => Some(json!({ "decision": "decline" })),
        "item/permissions/requestApproval" => Some(json!({ "permissions": {} })),
        "item/tool/requestUserInput" => Some(json!({ "answers": {} })),
        "mcpServer/elicitation/request" => Some(json!({ "action": "decline" })),
        "applyPatchApproval" | "execCommandApproval" => Some(json!({ "decision": "denied" })),
        _ => None,
    };

    if let Some(result) = result {
        json!({
            "id": id,
            "result": result
        })
    } else {
        json!({
            "id": id,
            "error": {
                "code": -32601,
                "message": format!("Kuku does not support Codex app-server request method: {method}")
            }
        })
    }
}

fn build_tool_call_response(id: Value, response: &ToolCallResponse) -> Value {
    json!({
        "id": id,
        "result": {
            "success": !response.is_error,
            "contentItems": [
                {
                    "type": "inputText",
                    "text": response.output
                }
            ]
        }
    })
}

async fn send_json(stdin: &mut tokio::process::ChildStdin, message: &Value) -> Result<(), AiError> {
    let mut line = serde_json::to_vec(message).map_err(|error| {
        AiError::ProviderError(format!("failed to encode Codex request: {error}"))
    })?;
    line.push(b'\n');
    stdin.write_all(&line).await.map_err(|error| {
        AiError::ProviderError(format!("failed to write Codex app-server: {error}"))
    })?;
    stdin.flush().await.map_err(|error| {
        AiError::ProviderError(format!("failed to flush Codex app-server: {error}"))
    })
}

async fn wait_for_response(
    lines: &mut Lines<BufReader<ChildStdout>>,
    id: u64,
) -> Result<Value, AiError> {
    while let Some(line) = lines.next_line().await.map_err(|error| {
        AiError::ProviderError(format!("failed to read Codex app-server: {error}"))
    })? {
        let message = parse_message(&line)?;
        if !is_response_to(&message, id) {
            if message.get("method").and_then(Value::as_str) == Some("error") {
                completion_event_from_notification(&message)?;
            }
            continue;
        }

        if let Some(error) = message.get("error") {
            return Err(AiError::ProviderError(jsonrpc_error_message(error)));
        }
        return Ok(message);
    }

    Err(AiError::ProviderError(format!(
        "Codex app-server exited before response id {id}",
    )))
}

fn is_response_to(message: &Value, id: u64) -> bool {
    message.get("method").is_none() && message.get("id").and_then(Value::as_u64) == Some(id)
}

fn parse_message(line: &str) -> Result<Value, AiError> {
    serde_json::from_str(line).map_err(|error| {
        AiError::ProviderError(format!("invalid Codex app-server JSON message: {error}"))
    })
}

fn extract_thread_id(message: &Value) -> Result<String, AiError> {
    message
        .get("result")
        .and_then(|result| result.get("thread"))
        .and_then(|thread| thread.get("id"))
        .and_then(Value::as_str)
        .map(ToString::to_string)
        .ok_or_else(|| {
            AiError::ProviderError(
                "Codex app-server thread/start response omitted result.thread.id".to_string(),
            )
        })
}

fn jsonrpc_error_message(error: &Value) -> String {
    error
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or("Codex app-server request failed")
        .to_string()
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{
        app_server_args, app_server_sandbox_mode, app_server_sandbox_policy,
        build_initialize_request, build_thread_start_request, build_tool_call_response,
        build_turn_start_request, build_unsupported_server_request_response,
        completion_event_from_notification, cwd_for_request, dynamic_tool_specs, is_response_to,
        prompt_from_request, tool_call_from_request,
    };
    use crate::{
        provider::CompletionTurnRequest,
        tools::{ToolAccess, ToolDescriptor, ToolSource},
        types::{ChatMessage, ChatMode, FinishReason, ProviderKind},
    };

    #[test]
    fn provider_kind_accepts_app_server_and_legacy_codex_cli() {
        let app_server: ProviderKind = serde_json::from_str("\"codexAppServer\"").unwrap();
        let legacy: ProviderKind = serde_json::from_str("\"codexCli\"").unwrap();

        assert_eq!(app_server, ProviderKind::CodexAppServer);
        assert_eq!(legacy, ProviderKind::CodexAppServer);
    }

    #[test]
    fn app_server_args_use_stdio_transport() {
        let args: Vec<String> = app_server_args()
            .into_iter()
            .map(|arg| arg.to_string_lossy().to_string())
            .collect();

        assert_eq!(args, vec!["app-server", "--listen", "stdio://"]);
    }

    #[test]
    fn builds_initialize_and_thread_start_requests() {
        assert_eq!(
            build_initialize_request(0),
            json!({
                "id": 0,
                "method": "initialize",
                "params": {
                    "clientInfo": {
                        "name": "kuku_desktop",
                        "title": "Kuku Desktop",
                        "version": env!("CARGO_PKG_VERSION")
                    },
                    "capabilities": {
                        "experimentalApi": true
                    }
                }
            }),
        );
        assert_eq!(
            build_thread_start_request(1, "codex", Some("/repo"), &ChatMode::Ask, &[]),
            json!({
                "id": 1,
                "method": "thread/start",
                "params": {
                    "model": null,
                    "cwd": "/repo",
                    "approvalPolicy": "never",
                    "sandbox": "read-only",
                    "dynamicTools": [],
                    "ephemeral": true,
                    "threadSource": "user"
                }
            }),
        );
    }

    #[test]
    fn builds_turn_start_request_with_read_only_sandbox() {
        assert_eq!(
            build_turn_start_request(
                2,
                "thread-1",
                "hello",
                "gpt-5.5",
                Some("/repo"),
                &ChatMode::Ask
            ),
            json!({
                "id": 2,
                "method": "turn/start",
                "params": {
                    "threadId": "thread-1",
                    "cwd": "/repo",
                    "model": "gpt-5.5",
                    "approvalPolicy": "never",
                    "sandboxPolicy": {
                        "type": "readOnly",
                        "networkAccess": false
                    },
                    "input": [
                        {
                            "type": "text",
                            "text": "hello"
                        }
                    ]
                }
            }),
        );
    }

    #[test]
    fn agent_mode_uses_workspace_write_sandbox() {
        assert_eq!(app_server_sandbox_mode(&ChatMode::Agent), "workspace-write");
        assert_eq!(
            app_server_sandbox_policy(&ChatMode::Agent, Some("/vault")),
            json!({
                "type": "workspaceWrite",
                "networkAccess": false,
                "writableRoots": ["/vault"]
            }),
        );
    }

    #[test]
    fn agent_turn_start_makes_request_cwd_writable() {
        assert_eq!(
            build_turn_start_request(
                2,
                "thread-1",
                "hello",
                "codex",
                Some("/vault"),
                &ChatMode::Agent
            ),
            json!({
                "id": 2,
                "method": "turn/start",
                "params": {
                    "threadId": "thread-1",
                    "cwd": "/vault",
                    "model": null,
                    "approvalPolicy": "never",
                    "sandboxPolicy": {
                        "type": "workspaceWrite",
                        "networkAccess": false,
                        "writableRoots": ["/vault"]
                    },
                    "input": [
                        {
                            "type": "text",
                            "text": "hello"
                        }
                    ]
                }
            }),
        );
    }

    #[test]
    fn dynamic_tool_specs_include_allowed_kuku_tools() {
        let tools = vec![ToolDescriptor {
            tool_id: "widget.create_widget".to_string(),
            name: "create_widget".to_string(),
            description: "Create a widget".to_string(),
            parameters: json!({"type": "object"}),
            category: "widget".to_string(),
            access: ToolAccess::ProposesMutation,
            source: ToolSource::Proxy,
        }];

        assert_eq!(
            dynamic_tool_specs(&tools),
            json!([
                {
                    "name": "create_widget",
                    "namespace": "kuku",
                    "description": "Create a widget",
                    "inputSchema": {"type": "object"}
                }
            ]),
        );
    }

    #[test]
    fn converts_app_server_dynamic_tool_call_request() {
        let (response_id, call) = tool_call_from_request(&json!({
            "id": 42,
            "method": "item/tool/call",
            "params": {
                "threadId": "thread-1",
                "turnId": "turn-1",
                "callId": "call-1",
                "tool": "create_widget",
                "namespace": "kuku",
                "arguments": {
                    "widgetName": "Chart",
                    "type": "html",
                    "code": "<div></div>"
                }
            }
        }))
        .unwrap()
        .expect("tool call request should convert");

        assert_eq!(response_id, json!(42));
        assert_eq!(call.call_id, "call-1");
        assert_eq!(call.tool_name, "create_widget");
        assert_eq!(call.arguments["widgetName"], "Chart");
        assert_eq!(call.tool_call_id.as_deref(), Some("call-1"));
        assert_eq!(call.provider_call_id.as_deref(), Some("call-1"));
    }

    #[test]
    fn server_request_with_client_request_id_is_not_treated_as_client_response() {
        let server_request = json!({
            "id": 2,
            "method": "item/tool/call",
            "params": {
                "callId": "call-2",
                "tool": "edit_file",
                "arguments": {}
            }
        });

        assert!(!is_response_to(&server_request, 2));
        assert!(tool_call_from_request(&server_request).unwrap().is_some());
    }

    #[test]
    fn converts_qualified_app_server_dynamic_tool_names() {
        let (_response_id, call) = tool_call_from_request(&json!({
            "id": "request-1",
            "method": "item/tool/call",
            "params": {
                "callId": "call-1",
                "tool": "kuku.create_widget",
                "arguments": "{}"
            }
        }))
        .unwrap()
        .expect("tool call request should convert");

        assert_eq!(call.tool_name, "create_widget");
    }

    #[test]
    fn declines_server_requests_instead_of_leaving_app_server_waiting() {
        assert_eq!(
            build_unsupported_server_request_response(
                json!("approval-1"),
                "item/fileChange/requestApproval"
            ),
            json!({
                "id": "approval-1",
                "result": {
                    "decision": "decline"
                }
            }),
        );
        assert_eq!(
            build_unsupported_server_request_response(
                json!("permission-1"),
                "item/permissions/requestApproval"
            ),
            json!({
                "id": "permission-1",
                "result": {
                    "permissions": {}
                }
            }),
        );
        assert_eq!(
            build_unsupported_server_request_response(
                json!("input-1"),
                "item/tool/requestUserInput"
            ),
            json!({
                "id": "input-1",
                "result": {
                    "answers": {}
                }
            }),
        );
    }

    #[test]
    fn builds_app_server_tool_call_response() {
        assert_eq!(
            build_tool_call_response(
                json!(42),
                &crate::provider::ToolCallResponse {
                    output: "created".to_string(),
                    is_error: false,
                },
            ),
            json!({
                "id": 42,
                "result": {
                    "success": true,
                    "contentItems": [
                        {
                            "type": "inputText",
                            "text": "created"
                        }
                    ]
                }
            }),
        );
    }

    #[test]
    fn request_cwd_overrides_backend_default_cwd() {
        let request = CompletionTurnRequest {
            model: "codex".to_string(),
            mode: ChatMode::Agent,
            system_prompt: None,
            messages: vec![ChatMessage::User {
                content: "hello".to_string(),
                editor_context: None,
            }],
            tools: vec![],
            authorization_header: None,
            cwd: Some("/vault".to_string()),
        };

        assert_eq!(
            cwd_for_request(&request, Some("/app")),
            Some("/vault".to_string())
        );
    }

    #[test]
    fn converts_agent_delta_and_completed_notifications() {
        let delta = completion_event_from_notification(&json!({
            "method": "item/agentMessage/delta",
            "params": {
                "threadId": "thread-1",
                "turnId": "turn-1",
                "itemId": "item-1",
                "delta": "hello"
            }
        }))
        .unwrap();
        assert!(matches!(
            delta,
            Some(crate::provider::CompletionEvent::TextDelta(text)) if text == "hello"
        ));

        let completed = completion_event_from_notification(&json!({
            "method": "turn/completed",
            "params": {
                "threadId": "thread-1",
                "turn": {
                    "id": "turn-1",
                    "status": "completed",
                    "items": []
                }
            }
        }))
        .unwrap();
        assert!(matches!(
            completed,
            Some(crate::provider::CompletionEvent::Finished {
                finish_reason: FinishReason::Stop,
                usage: None
            })
        ));
    }

    #[test]
    fn prompt_includes_conversation_history() {
        let request = CompletionTurnRequest {
            model: "codex".to_string(),
            mode: ChatMode::Ask,
            system_prompt: Some("Use concise Korean.".to_string()),
            messages: vec![
                ChatMessage::User {
                    content: "old".to_string(),
                    editor_context: None,
                },
                ChatMessage::Assistant {
                    content: "assistant".to_string(),
                    tool_calls: vec![],
                },
                ChatMessage::User {
                    content: "new".to_string(),
                    editor_context: None,
                },
            ],
            tools: vec![],
            authorization_header: None,
            cwd: None,
        };

        assert_eq!(
            prompt_from_request(&request),
            "System instructions:\nUse concise Korean.\n\nUser:\nold\n\nAssistant:\nassistant\n\nUser:\nnew",
        );
    }
}
