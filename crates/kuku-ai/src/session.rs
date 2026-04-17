use std::{collections::HashMap, sync::Arc};

use parking_lot::{Mutex, RwLock};
use serde_json::Value;
use tauri::{AppHandle, Emitter, Wry};
use tokio::sync::oneshot;
use tokio::time::{Duration, timeout};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::{
    AiError,
    mutation::{MutationApplyResult, MutationOp},
    prompts::build_system_prompt,
    provider::{CompletionEvent, CompletionTurnRequest},
    state::AiState,
    tools::{ToolAccess, ToolCallContext, ToolDescriptor, ToolSource, allowed_tools},
    types::{
        ChatMessage, ChatMode, DonePayload, EditorContext, EmbeddedFileContext, ErrorPayload,
        FinishReason, ModelToolCall, PendingApprovalPayload, ProxyToolCallPayload,
        StreamChunkPayload, ToolCallEndPayload, ToolCallStartPayload,
    },
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionStatus {
    Idle,
    Streaming,
    AwaitingApproval,
    Applying,
}

#[derive(Debug, Clone, Copy)]
pub enum ApprovalDecision {
    Approve,
    Reject,
}

const REMOTE_AUTH_REQUESTER_PLUGIN_ID: &str = "ai-chat";

// TEMP DEBUG: remove after tool round continuation is verified in runtime.
#[cfg(debug_assertions)]
fn debug_ai_log(message: impl AsRef<str>) {
    eprintln!("[ai-debug][session] {}", message.as_ref());
}

#[cfg(not(debug_assertions))]
fn debug_ai_log(_message: impl AsRef<str>) {}

struct SessionControl {
    status: SessionStatus,
    cancel: Option<CancellationToken>,
    deferred_cancel: bool,
}

#[derive(Debug, Clone)]
struct PathSnapshot {
    checksum: String,
    is_dir: bool,
}

pub struct SessionRuntime {
    pub id: String,
    mode: RwLock<ChatMode>,
    pub messages: RwLock<Vec<ChatMessage>>,
    pub editor_context: RwLock<EditorContext>,
    approvals: Mutex<HashMap<String, oneshot::Sender<ApprovalDecision>>>,
    path_snapshots: Mutex<HashMap<String, PathSnapshot>>,
    control: Mutex<SessionControl>,
}

impl SessionRuntime {
    pub fn new(mode: ChatMode) -> Self {
        Self {
            id: Uuid::new_v4().to_string(),
            mode: RwLock::new(mode),
            messages: RwLock::new(Vec::new()),
            editor_context: RwLock::new(EditorContext::default()),
            approvals: Mutex::new(HashMap::new()),
            path_snapshots: Mutex::new(HashMap::new()),
            control: Mutex::new(SessionControl {
                status: SessionStatus::Idle,
                cancel: None,
                deferred_cancel: false,
            }),
        }
    }

    fn replace_mode(&self, mode: ChatMode) -> ChatMode {
        let mut current = self.mode.write();
        std::mem::replace(&mut *current, mode)
    }

    pub fn start_run(&self) -> Result<CancellationToken, AiError> {
        let mut control = self.control.lock();
        if control.status != SessionStatus::Idle {
            return Err(AiError::SessionBusy);
        }

        let cancel = CancellationToken::new();
        control.status = SessionStatus::Streaming;
        control.cancel = Some(cancel.clone());
        control.deferred_cancel = false;
        Ok(cancel)
    }

    pub fn cancel(&self) {
        let mut control = self.control.lock();
        match control.status {
            SessionStatus::Applying => {
                control.deferred_cancel = true;
                if let Some(cancel) = control.cancel.as_ref() {
                    cancel.cancel();
                }
            }
            _ => {
                if let Some(cancel) = control.cancel.take() {
                    cancel.cancel();
                }
            }
        }
    }

    pub fn begin_awaiting_approval(
        &self,
        call_id: String,
    ) -> Result<oneshot::Receiver<ApprovalDecision>, AiError> {
        let (tx, rx) = oneshot::channel();
        self.approvals.lock().insert(call_id, tx);
        self.control.lock().status = SessionStatus::AwaitingApproval;
        Ok(rx)
    }

    pub fn resolve_approval(&self, call_id: &str, approved: bool) -> Result<(), AiError> {
        let sender = self
            .approvals
            .lock()
            .remove(call_id)
            .ok_or(AiError::ApprovalNotFound)?;
        sender
            .send(if approved {
                ApprovalDecision::Approve
            } else {
                ApprovalDecision::Reject
            })
            .map_err(|_| AiError::ApprovalNotFound)
    }

    pub fn clear_approval(&self, call_id: &str) {
        self.approvals.lock().remove(call_id);
    }

    pub fn set_status(&self, status: SessionStatus) {
        self.control.lock().status = status;
    }

    pub fn remember_path_snapshot(&self, path: String, checksum: String, is_dir: bool) {
        self.path_snapshots
            .lock()
            .insert(path, PathSnapshot { checksum, is_dir });
    }

    pub fn path_snapshot(&self, path: &str) -> Option<(String, bool)> {
        self.path_snapshots
            .lock()
            .get(path)
            .map(|snapshot| (snapshot.checksum.clone(), snapshot.is_dir))
    }

    pub fn apply_successful_mutation(&self, operations: &[MutationOp]) {
        let mut snapshots = self.path_snapshots.lock();
        for op in operations {
            match op {
                MutationOp::CreateFile { path, content }
                | MutationOp::ReplaceFile { path, content, .. } => {
                    snapshots.insert(
                        path.clone(),
                        PathSnapshot {
                            checksum: checksum_for_content(content),
                            is_dir: false,
                        },
                    );
                }
                MutationOp::CreateDirectory { path } => {
                    snapshots.insert(
                        path.clone(),
                        PathSnapshot {
                            checksum: empty_directory_checksum(),
                            is_dir: true,
                        },
                    );
                }
                MutationOp::DeleteFile { path, .. } | MutationOp::DeleteDirectory { path, .. } => {
                    snapshots.remove(path);
                }
                MutationOp::RenameFile { from, to } => {
                    if let Some(snapshot) = snapshots.remove(from) {
                        snapshots.insert(to.clone(), snapshot);
                    } else {
                        snapshots.remove(to);
                    }
                }
            }
        }
    }

    pub fn clear_mutation_snapshots(&self, operations: &[MutationOp]) {
        let mut snapshots = self.path_snapshots.lock();
        for op in operations {
            match op {
                MutationOp::CreateFile { path, .. }
                | MutationOp::CreateDirectory { path }
                | MutationOp::ReplaceFile { path, .. }
                | MutationOp::DeleteFile { path, .. }
                | MutationOp::DeleteDirectory { path, .. } => {
                    snapshots.remove(path);
                }
                MutationOp::RenameFile { from, to } => {
                    snapshots.remove(from);
                    snapshots.remove(to);
                }
            }
        }
    }

    pub fn complete_run(&self) -> bool {
        let mut control = self.control.lock();
        let was_deferred = control.deferred_cancel;
        control.status = SessionStatus::Idle;
        control.cancel = None;
        control.deferred_cancel = false;
        was_deferred
    }
}

pub async fn run_turn(
    app: AppHandle<Wry>,
    state: AiState,
    session: Arc<SessionRuntime>,
    mode: ChatMode,
    content: String,
    editor_context: EditorContext,
) {
    debug_ai_log(format!(
        "run start session={} mode={:?} input_len={}",
        session.id,
        mode,
        content.len()
    ));
    let result = run_turn_inner(&app, &state, session.clone(), mode, content, editor_context).await;

    match result {
        Ok((finish_reason, usage)) => {
            let finish_reason = if session.complete_run() {
                FinishReason::Cancelled
            } else {
                finish_reason
            };
            debug_ai_log(format!(
                "run complete session={} finish_reason={finish_reason:?} usage={usage:?}",
                session.id
            ));
            emit_done(&app, &session.id, finish_reason, usage);
        }
        Err(error) => {
            let finish_reason = if matches!(error, AiError::Cancelled) || session.complete_run() {
                FinishReason::Cancelled
            } else {
                FinishReason::Error
            };
            debug_ai_log(format!(
                "run error session={} finish_reason={finish_reason:?} error={error}",
                session.id
            ));
            emit_error(&app, &session.id, &error);
            emit_done(&app, &session.id, finish_reason, None);
        }
    }
}

async fn run_turn_inner(
    app: &AppHandle<Wry>,
    state: &AiState,
    session: Arc<SessionRuntime>,
    mode: ChatMode,
    content: String,
    editor_context: EditorContext,
) -> Result<(FinishReason, Option<crate::types::TokenUsage>), AiError> {
    let cancel = session.start_run()?;
    let previous_mode = session.replace_mode(mode.clone());
    let run_mode = mode;
    remember_embedded_file_snapshots(&session, &editor_context);
    let content =
        content_with_turn_context(previous_mode, run_mode.clone(), content, &editor_context);
    *session.editor_context.write() = editor_context.clone();
    session.messages.write().push(ChatMessage::User {
        content,
        editor_context: Some(editor_context),
    });
    debug_ai_log(format!(
        "user message appended session={} total_messages={}",
        session.id,
        session.messages.read().len()
    ));

    let backend = state.backend()?;
    let config = state.config();
    let descriptors = state.tool_descriptors();
    let allowed = allowed_tools(run_mode.clone(), &descriptors);

    let mut final_usage = None;

    for round in 0..config.round_limit {
        let system_prompt = build_system_prompt(run_mode.clone(), &allowed);
        let authorization_header = match config.provider {
            crate::types::ProviderKind::Remote => Some(
                state
                    .host()
                    .ok_or(AiError::HostUnavailable)?
                    .authorization_header(REMOTE_AUTH_REQUESTER_PLUGIN_ID)
                    .await?
                    .ok_or(AiError::NotConfigured)?,
            ),
            _ => None,
        };
        let request = CompletionTurnRequest {
            model: config.model.clone(),
            system_prompt: Some(system_prompt),
            messages: session.messages.read().clone(),
            tools: allowed.clone(),
            authorization_header,
        };
        debug_ai_log(format!(
            "round start session={} round={} history_messages={} allowed_tools={}",
            session.id,
            round + 1,
            request.messages.len(),
            request.tools.len()
        ));

        // Token may have expired between the proactive 60s-buffer check above
        // and the server actually serving the request (long upstream latency,
        // client clock drift, etc). On Unauthorized, force a refresh and try
        // exactly once more before surfacing the error.
        let mut stream = match backend.stream_turn(request.clone()).await {
            Ok(stream) => stream,
            Err(AiError::Unauthorized)
                if matches!(config.provider, crate::types::ProviderKind::Remote) =>
            {
                debug_ai_log(format!(
                    "round auth refresh session={} round={}",
                    session.id,
                    round + 1
                ));
                let refreshed_header = state
                    .host()
                    .ok_or(AiError::HostUnavailable)?
                    .refresh_authorization_header(REMOTE_AUTH_REQUESTER_PLUGIN_ID)
                    .await?
                    .ok_or(AiError::NotConfigured)?;
                let mut retry = request;
                retry.authorization_header = Some(refreshed_header);
                backend.stream_turn(retry).await?
            }
            Err(error) => return Err(error),
        };
        let mut assistant_text = String::new();
        let mut tool_calls = Vec::new();
        let mut round_reason = FinishReason::Stop;
        let mut round_usage = None;

        loop {
            tokio::select! {
                _ = cancel.cancelled() => {
                    return Err(AiError::Cancelled);
                }
                item = futures::StreamExt::next(&mut stream) => {
                    let Some(item) = item else {
                        break;
                    };

                    match item? {
                        CompletionEvent::TextDelta(delta) => {
                            assistant_text.push_str(&delta);
                            emit_stream_chunk(app, &session.id, delta);
                        }
                        CompletionEvent::ToolCalls(calls) => {
                            let summary = calls
                                .iter()
                                .map(|call| {
                                    format!(
                                        "{}(internal={}, tool_call_id={:?}, provider_call_id={:?})",
                                        call.tool_name, call.call_id, call.tool_call_id, call.provider_call_id
                                    )
                                })
                                .collect::<Vec<_>>()
                                .join(", ");
                            debug_ai_log(format!(
                                "round tool calls session={} round={} count={} {summary}",
                                session.id,
                                round + 1,
                                calls.len()
                            ));
                            tool_calls.extend(calls);
                        }
                        CompletionEvent::Finished { finish_reason, usage } => {
                            debug_ai_log(format!(
                                "round finished event session={} round={} finish_reason={finish_reason:?} usage={usage:?}",
                                session.id,
                                round + 1
                            ));
                            round_reason = finish_reason;
                            round_usage = usage;
                        }
                    }
                }
            }
        }

        if !assistant_text.is_empty() || !tool_calls.is_empty() {
            session.messages.write().push(ChatMessage::Assistant {
                content: assistant_text,
                tool_calls: tool_calls.clone(),
            });
            debug_ai_log(format!(
                "assistant message appended session={} round={} text_len={} tool_calls={}",
                session.id,
                round + 1,
                session
                    .messages
                    .read()
                    .last()
                    .and_then(|message| match message {
                        ChatMessage::Assistant { content, .. } => Some(content.len()),
                        _ => None,
                    })
                    .unwrap_or_default(),
                tool_calls.len()
            ));
        }

        final_usage = round_usage;

        if tool_calls.is_empty() {
            debug_ai_log(format!(
                "round exit session={} round={} no_tool_calls finish_reason={round_reason:?}",
                session.id,
                round + 1
            ));
            return Ok((round_reason, final_usage));
        }

        for tool_call in tool_calls {
            debug_ai_log(format!(
                "tool dispatch session={} round={} tool={} internal_call_id={} tool_call_id={:?} provider_call_id={:?}",
                session.id,
                round + 1,
                tool_call.tool_name,
                tool_call.call_id,
                tool_call.tool_call_id,
                tool_call.provider_call_id
            ));
            let result = handle_tool_call(
                app, state, &session, &cancel, &run_mode, &allowed, &tool_call,
            )
            .await?;
            session.messages.write().push(ChatMessage::ToolResult {
                call_id: tool_call.call_id.clone(),
                tool_name: tool_call.tool_name.clone(),
                output: result.0.clone(),
                is_error: result.1,
                tool_call_id: tool_call.tool_call_id.clone(),
                provider_call_id: tool_call.provider_call_id.clone(),
            });
            debug_ai_log(format!(
                "tool result appended session={} round={} tool={} is_error={} output_len={} tool_call_id={:?} provider_call_id={:?}",
                session.id,
                round + 1,
                tool_call.tool_name,
                result.1,
                result.0.len(),
                tool_call.tool_call_id,
                tool_call.provider_call_id
            ));
        }

        debug_ai_log(format!(
            "tool phase complete session={} round={} continuing_to_next_round",
            session.id,
            round + 1
        ));
    }

    Ok((FinishReason::ToolRoundLimit, final_usage))
}

async fn handle_tool_call(
    app: &AppHandle<Wry>,
    state: &AiState,
    session: &Arc<SessionRuntime>,
    cancel: &CancellationToken,
    mode: &ChatMode,
    allowed: &[ToolDescriptor],
    tool_call: &ModelToolCall,
) -> Result<(String, bool), AiError> {
    let descriptor = allowed
        .iter()
        .find(|tool| tool.name == tool_call.tool_name)
        .cloned();
    let tool_id = descriptor
        .as_ref()
        .map(|tool| tool.tool_id.clone())
        .unwrap_or_else(|| fallback_tool_id(&tool_call.tool_name));

    emit_tool_start(app, &session.id, tool_call, &tool_id);
    debug_ai_log(format!(
        "tool start session={} tool={} tool_id={} internal_call_id={}",
        session.id, tool_call.tool_name, tool_id, tool_call.call_id
    ));

    let outcome = match descriptor {
        None => (tool_not_allowed_message(&tool_call.tool_name, mode), true),
        Some(descriptor) => match descriptor.source {
            ToolSource::Native => {
                match execute_native_tool(app, state, session, cancel, mode, tool_call, descriptor)
                    .await
                {
                    Ok(outcome) => outcome,
                    Err(AiError::Cancelled) => return Err(AiError::Cancelled),
                    Err(error) => (error.to_string(), true),
                }
            }
            ToolSource::Proxy => {
                match execute_proxy_tool(app, state, session, cancel, tool_call, &tool_id).await {
                    Ok(outcome) => outcome,
                    Err(AiError::Cancelled) => return Err(AiError::Cancelled),
                    Err(error) => (error.to_string(), true),
                }
            }
        },
    };

    emit_tool_end(
        app,
        &session.id,
        &tool_call.call_id,
        &tool_id,
        &tool_call.tool_name,
        &outcome.0,
        outcome.1,
    );
    debug_ai_log(format!(
        "tool end session={} tool={} internal_call_id={} is_error={}",
        session.id, tool_call.tool_name, tool_call.call_id, outcome.1
    ));
    Ok(outcome)
}

fn content_with_mode_notice(
    previous_mode: ChatMode,
    run_mode: ChatMode,
    content: String,
) -> String {
    if previous_mode == run_mode {
        return content;
    }

    format!(
        "[Internal context: The user switched AI mode from {} to {} before this message. Use the current {} mode instructions and available tools for this turn.]\n\n{}",
        mode_label(previous_mode),
        mode_label(run_mode.clone()),
        mode_label(run_mode),
        content
    )
}

fn content_with_turn_context(
    previous_mode: ChatMode,
    run_mode: ChatMode,
    content: String,
    editor_context: &EditorContext,
) -> String {
    let selected_text = selected_text_context(editor_context);
    let active_editor_context = active_editor_context_block(editor_context);
    if selected_text.is_none()
        && editor_context.embedded_files.is_empty()
        && active_editor_context.is_none()
    {
        return content_with_mode_notice(previous_mode, run_mode, content);
    }

    let mut sections = Vec::new();
    if previous_mode != run_mode {
        sections.push(mode_notice(previous_mode, run_mode));
    }
    if let Some(active_editor_context) = active_editor_context {
        sections.push(active_editor_context);
    }
    if let Some(selected_text) = selected_text {
        sections.push(selected_text_block(
            selected_text,
            editor_context.active_file.as_deref(),
        ));
    }
    if !editor_context.embedded_files.is_empty() {
        sections.push(embedded_files_context(&editor_context.embedded_files));
    }
    sections.push(format!("--- USER MESSAGE ---\n{content}"));
    sections.join("\n\n")
}

fn remember_embedded_file_snapshots(session: &SessionRuntime, editor_context: &EditorContext) {
    for file in &editor_context.embedded_files {
        session.remember_path_snapshot(file.path.clone(), file.checksum.clone(), false);
    }
}

fn mode_notice(previous_mode: ChatMode, run_mode: ChatMode) -> String {
    format!(
        "[Internal context: The user switched AI mode from {} to {} before this message. Use the current {} mode instructions and available tools for this turn.]",
        mode_label(previous_mode),
        mode_label(run_mode.clone()),
        mode_label(run_mode)
    )
}

fn selected_text_context(editor_context: &EditorContext) -> Option<&str> {
    editor_context
        .selected_text
        .as_deref()
        .filter(|text| !text.trim().is_empty())
}

fn active_editor_context_block(editor_context: &EditorContext) -> Option<String> {
    let active_file = editor_context
        .active_file
        .as_deref()
        .map(str::trim)
        .filter(|path| !path.is_empty());
    let open_tabs = editor_context
        .open_tabs
        .iter()
        .map(String::as_str)
        .map(str::trim)
        .filter(|path| !path.is_empty())
        .fold(Vec::<&str>::new(), |mut acc, path| {
            if !acc.contains(&path) {
                acc.push(path);
            }
            acc
        });

    if active_file.is_none() && open_tabs.is_empty() {
        return None;
    }

    let mut output = String::from(
        "[Internal context: The user is working in the editor. Resolve references like 'this document' against the active file first. Open tabs provide nearby document context by path only; they are not attached as full content.]",
    );

    if let Some(active_file) = active_file {
        output.push_str("\n\n");
        output.push_str(&format!("Active file: {}", escape_prompt_attr(active_file)));
    }

    if !open_tabs.is_empty() {
        output.push_str("\nOpen tabs:");
        for path in open_tabs {
            output.push_str("\n- ");
            output.push_str(&escape_prompt_attr(path));
        }
    }

    Some(output)
}

fn selected_text_block(selected_text: &str, active_file: Option<&str>) -> String {
    let active_file = active_file.unwrap_or_default();
    let guidance = if active_file.is_empty() {
        "This selected text is a focus excerpt, not a full document.".to_string()
    } else {
        format!(
            "This selected text is a focus excerpt from the active file, not the full document. If you need to modify {}, read the full active file before proposing edits and preserve all unrelated content outside the target section.",
            active_file
        )
    };
    let mut output = format!(
        "[Internal context: The user selected text in the active editor. {guidance}]\n\n--- BEGIN SELECTED TEXT activeFile=\"{}\" sizeBytes=\"{}\" ---\n",
        escape_prompt_attr(active_file),
        selected_text.len()
    );
    output.push_str(selected_text);
    if !selected_text.ends_with('\n') {
        output.push('\n');
    }
    output.push_str("--- END SELECTED TEXT ---");
    output
}

fn embedded_files_context(files: &[EmbeddedFileContext]) -> String {
    let label = if files.len() == 1 { "file" } else { "files" };
    let mut output = format!(
        "[Internal context: The user attached {} vault markdown {label}. Treat them as user-provided context. Paths are vault-relative. Attached files are already available in this user message.]",
        files.len()
    );

    for file in files {
        output.push_str("\n\n");
        output.push_str(&format!(
            "--- BEGIN ATTACHED FILE path=\"{}\" checksum=\"{}\" sizeBytes=\"{}\" ---\n",
            escape_prompt_attr(&file.path),
            escape_prompt_attr(&file.checksum),
            file.size_bytes
        ));
        output.push_str(&file.content);
        if !file.content.ends_with('\n') {
            output.push('\n');
        }
        output.push_str(&format!(
            "--- END ATTACHED FILE path=\"{}\" ---",
            escape_prompt_attr(&file.path)
        ));
    }

    output
}

fn escape_prompt_attr(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}

fn tool_not_allowed_message(tool_name: &str, mode: &ChatMode) -> String {
    format!(
        "Tool '{tool_name}' is not available in {} mode for this turn.",
        mode_label(mode.clone())
    )
}

fn mode_label(mode: ChatMode) -> &'static str {
    match mode {
        ChatMode::Ask => "Ask",
        ChatMode::Agent => "Agent",
        ChatMode::Inline => "Inline",
    }
}

async fn execute_native_tool(
    app: &AppHandle<Wry>,
    state: &AiState,
    session: &Arc<SessionRuntime>,
    cancel: &CancellationToken,
    mode: &ChatMode,
    tool_call: &ModelToolCall,
    descriptor: ToolDescriptor,
) -> Result<(String, bool), AiError> {
    let tool = state
        .tools()
        .get_native(&tool_call.tool_name)
        .ok_or_else(|| AiError::ToolNotFound(tool_call.tool_name.clone()))?;

    let editor_context = session.editor_context.read().clone();
    let ctx = ToolCallContext {
        app,
        session_id: &session.id,
        mode: mode.clone(),
        editor_context: &editor_context,
    };

    let native_result = match tool.call(&ctx, tool_call.arguments.clone()).await {
        Ok(result) => result,
        Err(error) => {
            return Ok((error.to_string(), true));
        }
    };

    if descriptor.access == ToolAccess::ReadOnly || native_result.mutation.is_none() {
        debug_ai_log(format!(
            "native tool read-only session={} tool={} output_len={}",
            session.id,
            tool_call.tool_name,
            native_result.text.len()
        ));
        return Ok((native_result.text, false));
    }

    let mutation = native_result.mutation.clone().unwrap();
    let mutation_operations = mutation.operations.clone();
    let approval_rx = session.begin_awaiting_approval(tool_call.call_id.clone())?;
    emit_pending_approval(
        app,
        &session.id,
        &tool_call.call_id,
        &descriptor.tool_id,
        &tool_call.tool_name,
        mutation.clone(),
        native_result.preview_text.clone(),
    );

    let decision = tokio::select! {
        _ = cancel.cancelled() => {
            session.clear_approval(&tool_call.call_id);
            return Err(AiError::Cancelled);
        }
        decision = approval_rx => decision.map_err(|_| AiError::ApprovalNotFound)?,
    };
    debug_ai_log(format!(
        "approval resolved session={} tool={} decision={decision:?}",
        session.id, tool_call.tool_name
    ));

    if matches!(decision, ApprovalDecision::Reject) {
        session.set_status(SessionStatus::Streaming);
        return Ok(("Rejected by user".to_string(), true));
    }

    let host = state.host().ok_or(AiError::HostUnavailable)?;
    session.set_status(SessionStatus::Applying);
    let apply_result = host.apply_mutation(mutation).await?;
    match &apply_result {
        MutationApplyResult::Applied { .. } => {
            session.apply_successful_mutation(&mutation_operations);
        }
        MutationApplyResult::PartiallyApplied { .. } => {
            session.clear_mutation_snapshots(&mutation_operations);
        }
        MutationApplyResult::Conflict { .. } => {}
    }
    let output = describe_apply_result(&apply_result);
    session.set_status(SessionStatus::Streaming);
    debug_ai_log(format!(
        "mutation applied session={} tool={} result={apply_result:?}",
        session.id, tool_call.tool_name
    ));

    if cancel.is_cancelled() {
        return Err(AiError::Cancelled);
    }

    Ok((
        output,
        matches!(apply_result, MutationApplyResult::Conflict { .. }),
    ))
}

async fn execute_proxy_tool(
    app: &AppHandle<Wry>,
    state: &AiState,
    session: &Arc<SessionRuntime>,
    cancel: &CancellationToken,
    tool_call: &ModelToolCall,
    tool_id: &str,
) -> Result<(String, bool), AiError> {
    if state.tools().get_proxy(&tool_call.tool_name).is_none() {
        return Ok((
            format!("Proxy tool {} is not registered", tool_call.tool_name),
            true,
        ));
    }

    let receiver = state
        .proxy_broker()
        .register_pending(tool_call.call_id.clone());
    emit_proxy_call(
        app,
        &session.id,
        &tool_call.call_id,
        tool_id,
        &tool_call.tool_name,
        tool_call.arguments.clone(),
    );

    let response = tokio::select! {
        _ = cancel.cancelled() => {
            state.proxy_broker().clear(&tool_call.call_id);
            return Err(AiError::Cancelled);
        }
        result = timeout(Duration::from_millis(state.config().proxy_tool_timeout_ms), receiver) => {
            match result {
                Ok(Ok(output)) => output,
                Ok(Err(_)) => return Ok(("Proxy tool responder dropped".to_string(), true)),
                Err(_) => {
                    state.proxy_broker().clear(&tool_call.call_id);
                    return Err(AiError::ProxyTimeout(tool_call.tool_name.clone()));
                }
            }
        }
    };
    debug_ai_log(format!(
        "proxy tool response session={} tool={} is_error={} output_len={}",
        session.id,
        tool_call.tool_name,
        response.is_error,
        response.output.len()
    ));

    Ok((response.output, response.is_error))
}

fn describe_apply_result(result: &MutationApplyResult) -> String {
    match result {
        MutationApplyResult::Applied { summary, warnings } => {
            if warnings.is_empty() {
                format!("Applied: {summary}")
            } else {
                format!("Applied: {summary}\nWarnings: {}", warnings.join("; "))
            }
        }
        MutationApplyResult::PartiallyApplied {
            summary,
            applied,
            failed,
            skipped,
            warnings,
        } => {
            let mut parts = vec![format!("Partially applied: {summary}")];
            if !applied.is_empty() {
                parts.push(format!("Applied: {}", applied.join(", ")));
            }
            if !failed.is_empty() {
                parts.push(format!("Failed: {}", failed.join(", ")));
            }
            if !skipped.is_empty() {
                parts.push(format!("Skipped: {}", skipped.join(", ")));
            }
            if !warnings.is_empty() {
                parts.push(format!("Warnings: {}", warnings.join("; ")));
            }
            parts.join("\n")
        }
        MutationApplyResult::Conflict { summary, conflicts } => {
            let detail = conflicts
                .iter()
                .map(|conflict| format!("{} ({})", conflict.path, conflict.reason))
                .collect::<Vec<_>>()
                .join(", ");
            format!("Conflict: {summary}. {detail}")
        }
    }
}

pub fn emit_stream_chunk(app: &AppHandle<Wry>, session_id: &str, delta: String) {
    let _ = app.emit(
        "ai:stream-chunk",
        StreamChunkPayload {
            session_id: session_id.to_string(),
            delta,
        },
    );
}

pub fn emit_done(
    app: &AppHandle<Wry>,
    session_id: &str,
    finish_reason: FinishReason,
    usage: Option<crate::types::TokenUsage>,
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

pub fn emit_error(app: &AppHandle<Wry>, session_id: &str, error: &AiError) {
    let _ = app.emit(
        "ai:error",
        ErrorPayload {
            session_id: session_id.to_string(),
            message: error.message(),
        },
    );
}

fn emit_tool_start(
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

fn emit_tool_end(
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

fn emit_pending_approval(
    app: &AppHandle<Wry>,
    session_id: &str,
    call_id: &str,
    tool_id: &str,
    tool_name: &str,
    mutation: crate::mutation::MutationPlan,
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

fn emit_proxy_call(
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

fn fallback_tool_id(tool_name: &str) -> String {
    if tool_name.contains('.') {
        tool_name.to_string()
    } else {
        format!("builtin.{tool_name}")
    }
}

fn summarize_output(output: &str) -> String {
    const MAX: usize = 600;
    let Some((end, _)) = output.char_indices().nth(MAX) else {
        return output.to_string();
    };
    format!("{}...", &output[..end])
}

fn checksum_for_content(content: &str) -> String {
    blake3::hash(content.as_bytes()).to_hex().to_string()
}

fn empty_directory_checksum() -> String {
    blake3::Hasher::new().finalize().to_hex().to_string()
}

#[cfg(test)]
mod tests {
    use super::{
        SessionRuntime, SessionStatus, content_with_mode_notice, content_with_turn_context,
        remember_embedded_file_snapshots, summarize_output, tool_not_allowed_message,
    };
    use crate::types::{ChatMode, EditorContext, EmbeddedFileContext};

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

    #[test]
    fn cancel_during_apply_cancels_the_running_token() {
        let session = SessionRuntime::new(ChatMode::Agent);
        let cancel = session.start_run().expect("start run");
        session.set_status(SessionStatus::Applying);

        session.cancel();

        assert!(cancel.is_cancelled());
        assert!(session.complete_run());
    }

    #[test]
    fn content_with_mode_notice_keeps_content_when_mode_is_same() {
        let content = "hello".to_string();

        assert_eq!(
            content_with_mode_notice(ChatMode::Ask, ChatMode::Ask, content),
            "hello"
        );
    }

    #[test]
    fn content_with_mode_notice_describes_mode_changes() {
        let content = content_with_mode_notice(
            ChatMode::Agent,
            ChatMode::Ask,
            "answer without editing".to_string(),
        );

        assert!(content.contains("from Agent to Ask"));
        assert!(content.contains("current Ask mode"));
        assert!(content.ends_with("answer without editing"));
    }

    #[test]
    fn content_with_turn_context_includes_embedded_files() {
        let context = EditorContext {
            embedded_files: vec![EmbeddedFileContext {
                path: "notes/Base.md".to_string(),
                content: "# Base\ncontent".to_string(),
                checksum: "checksum-1".to_string(),
                size_bytes: 14,
            }],
            ..EditorContext::default()
        };

        let content = content_with_turn_context(
            ChatMode::Ask,
            ChatMode::Ask,
            "summarize it".to_string(),
            &context,
        );

        assert!(content.contains("attached 1 vault markdown file"));
        assert!(content.contains("--- BEGIN ATTACHED FILE path=\"notes/Base.md\""));
        assert!(content.contains("checksum=\"checksum-1\""));
        assert!(content.contains("# Base\ncontent"));
        assert!(content.ends_with("--- USER MESSAGE ---\nsummarize it"));
    }

    #[test]
    fn content_with_turn_context_includes_active_file_and_open_tabs() {
        let context = EditorContext {
            active_file: Some("notes/Current.md".to_string()),
            open_tabs: vec![
                "notes/Current.md".to_string(),
                "notes/Related.md".to_string(),
                "notes/Related.md".to_string(),
            ],
            ..EditorContext::default()
        };

        let content = content_with_turn_context(
            ChatMode::Ask,
            ChatMode::Ask,
            "고도화해줘".to_string(),
            &context,
        );

        assert!(content.contains("Resolve references like 'this document'"));
        assert!(content.contains("Active file: notes/Current.md"));
        assert!(content.contains("Open tabs:"));
        assert!(content.contains("- notes/Current.md"));
        assert!(content.contains("- notes/Related.md"));
        assert_eq!(content.matches("- notes/Related.md").count(), 1);
        assert!(content.ends_with("--- USER MESSAGE ---\n고도화해줘"));
    }

    #[test]
    fn content_with_turn_context_includes_selected_text() {
        let context = EditorContext {
            active_file: Some("notes/Base.md".to_string()),
            selected_text: Some("selected paragraph".to_string()),
            ..EditorContext::default()
        };

        let content = content_with_turn_context(
            ChatMode::Ask,
            ChatMode::Ask,
            "explain this".to_string(),
            &context,
        );

        assert!(content.contains("selected text in the active editor"));
        assert!(content.contains("focus excerpt"));
        assert!(content.contains("not the full document"));
        assert!(content.contains("read the full active file before proposing edits"));
        assert!(content.contains("preserve all unrelated content"));
        assert!(content.contains("--- BEGIN SELECTED TEXT activeFile=\"notes/Base.md\""));
        assert!(content.contains("selected paragraph"));
        assert!(content.contains("--- END SELECTED TEXT ---"));
        assert!(content.ends_with("--- USER MESSAGE ---\nexplain this"));
        assert!(!content.contains("attached 0"));
    }

    #[test]
    fn embedded_files_register_session_snapshots() {
        let session = SessionRuntime::new(ChatMode::Agent);
        let context = EditorContext {
            embedded_files: vec![EmbeddedFileContext {
                path: "notes/Base.md".to_string(),
                content: "content".to_string(),
                checksum: "checksum-1".to_string(),
                size_bytes: 7,
            }],
            ..EditorContext::default()
        };

        remember_embedded_file_snapshots(&session, &context);

        assert_eq!(
            session.path_snapshot("notes/Base.md"),
            Some(("checksum-1".to_string(), false))
        );
    }

    #[test]
    fn tool_not_allowed_message_mentions_current_mode() {
        assert_eq!(
            tool_not_allowed_message("edit_file", &ChatMode::Ask),
            "Tool 'edit_file' is not available in Ask mode for this turn."
        );
    }
}
