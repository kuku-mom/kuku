use std::sync::Arc;

use agent_client_protocol::{
    Agent, Error,
    mcp_server::{McpConnectionTo, McpServer, McpTool},
};
use agent_client_protocol_rmcp::McpServerExt;
use parking_lot::RwLock;
use tauri::{AppHandle, Wry};
use tokio::time::{Duration, timeout};
use uuid::Uuid;

use crate::{
    AiError, AiState, ChatMode, EditorContext, MutationApplyResult, MutationPlan, NativeToolResult,
    ProxyToolResult, ToolAccess, ToolCallContext, ToolDescriptor, ToolError, ToolSource,
    agent_runtime::events::{emit_pending_approval, emit_proxy_call},
    session::ApprovalDecision,
    tools::{ToolPermissionDecision, allowed_tools, tool_permission_decision},
};

pub(crate) fn mcp_tool_descriptors(state: &AiState) -> Vec<ToolDescriptor> {
    state
        .tools()
        .descriptors()
        .into_iter()
        .filter(|descriptor| matches!(descriptor.source, ToolSource::Native | ToolSource::Proxy))
        .collect()
}

pub(crate) fn allowed_mcp_tool_descriptors(state: &AiState, mode: ChatMode) -> Vec<ToolDescriptor> {
    allowed_tools(mode, &mcp_tool_descriptors(state))
}

pub(crate) type SharedEditorContext = Arc<RwLock<EditorContext>>;
pub(crate) type SharedChatMode = Arc<RwLock<ChatMode>>;

pub(crate) fn current_mcp_mode(current_mode: &SharedChatMode) -> ChatMode {
    current_mode.read().clone()
}

pub(crate) fn kuku_mcp_server(
    app: AppHandle<Wry>,
    state: AiState,
    session_id: String,
    editor_context: SharedEditorContext,
    current_mode: SharedChatMode,
) -> McpServer<Agent> {
    let mut builder = McpServer::<Agent>::builder("kuku")
        .instructions("Kuku vault tools. Mutating tools require user approval and are limited by the current Kuku chat mode.");

    for descriptor in mcp_tool_descriptors(&state) {
        builder = builder.tool(KukuMcpTool {
            app: app.clone(),
            state: state.clone(),
            session_id: session_id.clone(),
            editor_context: editor_context.clone(),
            current_mode: current_mode.clone(),
            descriptor,
        });
    }

    builder.build()
}

struct KukuMcpTool {
    app: AppHandle<Wry>,
    state: AiState,
    session_id: String,
    editor_context: SharedEditorContext,
    current_mode: SharedChatMode,
    descriptor: ToolDescriptor,
}

impl McpTool<Agent> for KukuMcpTool {
    type Input = serde_json::Value;
    type Output = String;

    fn name(&self) -> String {
        self.descriptor.name.clone()
    }

    fn description(&self) -> String {
        self.descriptor.description.clone()
    }

    fn title(&self) -> Option<String> {
        Some(self.descriptor.name.clone())
    }

    async fn call_tool(
        &self,
        input: Self::Input,
        _context: McpConnectionTo<Agent>,
    ) -> Result<Self::Output, Error> {
        let mode = current_mcp_mode(&self.current_mode);
        if let Some(error) = mcp_tool_policy_error(&mode, &self.descriptor) {
            return Err(error);
        }

        let editor_context = self.editor_context.read().clone();
        let ctx = ToolCallContext {
            app: &self.app,
            session_id: &self.session_id,
            mode: mode.clone(),
            editor_context: &editor_context,
        };

        match self.descriptor.source {
            ToolSource::Native => {
                let tool = self
                    .state
                    .tools()
                    .get_native(&self.descriptor.name)
                    .ok_or_else(|| {
                        Error::invalid_request()
                            .data(format!("unknown tool: {}", self.descriptor.name))
                    })?;
                let result = tool
                    .call(&ctx, input)
                    .await
                    .map_err(tool_error_to_acp_error)?;

                let call_id = Uuid::new_v4().to_string();
                complete_native_mcp_tool_result(
                    self.state.clone(),
                    self.session_id.clone(),
                    call_id,
                    self.descriptor.clone(),
                    result,
                    |session_id, call_id, descriptor, mutation, preview_text| {
                        emit_pending_approval(
                            &self.app,
                            session_id,
                            call_id,
                            &descriptor.tool_id,
                            &descriptor.name,
                            mutation.clone(),
                            preview_text,
                        );
                    },
                )
                .await
            }
            ToolSource::Proxy => {
                if self
                    .state
                    .tools()
                    .get_proxy(&self.descriptor.name)
                    .is_none()
                {
                    return Err(Error::invalid_request().data(format!(
                        "proxy tool {} is not registered",
                        self.descriptor.name
                    )));
                }
                let call_id = Uuid::new_v4().to_string();
                complete_proxy_mcp_tool_call(
                    self.state.clone(),
                    self.session_id.clone(),
                    call_id,
                    self.descriptor.clone(),
                    input,
                    |session_id, call_id, descriptor, mutation, preview_text| {
                        emit_pending_approval(
                            &self.app,
                            session_id,
                            call_id,
                            &descriptor.tool_id,
                            &descriptor.name,
                            mutation,
                            preview_text,
                        );
                    },
                    |session_id, call_id, descriptor, tool_name, arguments| {
                        emit_proxy_call(
                            &self.app,
                            session_id,
                            call_id,
                            &descriptor.tool_id,
                            tool_name,
                            arguments,
                        );
                    },
                )
                .await
            }
        }
    }
}

async fn complete_native_mcp_tool_result(
    state: AiState,
    session_id: String,
    call_id: String,
    descriptor: ToolDescriptor,
    result: NativeToolResult,
    emit_pending: impl FnOnce(&str, &str, &ToolDescriptor, &MutationPlan, Option<String>) + Send,
) -> Result<String, Error> {
    let Some(mutation) = result.mutation else {
        return Ok(result.text);
    };
    if descriptor.access == ToolAccess::ReadOnly {
        return Err(Error::invalid_request().data(format!(
            "{} returned a mutation from a read-only MCP tool",
            descriptor.name
        )));
    }

    let approval = state
        .begin_acp_approval(&session_id, call_id.clone())
        .map_err(ai_error_to_acp_error)?;
    emit_pending(
        &session_id,
        &call_id,
        &descriptor,
        &mutation,
        result.preview_text,
    );

    let decision = approval.await.map_err(|_| {
        state.clear_acp_approval(&session_id, &call_id);
        Error::internal_error().data("approval channel closed")
    })?;
    if matches!(decision, ApprovalDecision::Reject) {
        return Ok("Rejected by user".to_string());
    }

    let host = state
        .host()
        .ok_or(AiError::HostUnavailable)
        .map_err(ai_error_to_acp_error)?;
    let apply_result = host
        .apply_mutation(mutation)
        .await
        .map_err(ai_error_to_acp_error)?;
    Ok(describe_apply_result(&apply_result))
}

async fn complete_proxy_mcp_tool_call(
    state: AiState,
    session_id: String,
    call_id: String,
    descriptor: ToolDescriptor,
    arguments: serde_json::Value,
    emit_pending: impl FnOnce(&str, &str, &ToolDescriptor, MutationPlan, Option<String>) + Send,
    emit_call: impl FnOnce(&str, &str, &ToolDescriptor, &str, serde_json::Value) + Send,
) -> Result<String, Error> {
    if descriptor.requires_approval || descriptor.access == ToolAccess::ProposesMutation {
        let approval = state
            .begin_acp_approval(&session_id, call_id.clone())
            .map_err(ai_error_to_acp_error)?;
        emit_pending(
            &session_id,
            &call_id,
            &descriptor,
            proxy_execution_approval_plan(&descriptor.name),
            Some(format!(
                "Run proxy tool {} before dispatching it to the plugin.",
                descriptor.name
            )),
        );

        let decision = approval.await.map_err(|_| {
            state.clear_acp_approval(&session_id, &call_id);
            Error::internal_error().data("approval channel closed")
        })?;
        if matches!(decision, ApprovalDecision::Reject) {
            return Ok("Rejected by user".to_string());
        }
    }

    let receiver = state.proxy_broker().register_pending(call_id.clone());
    emit_call(
        &session_id,
        &call_id,
        &descriptor,
        &descriptor.name,
        arguments,
    );

    let response = timeout(
        Duration::from_millis(state.config().proxy_tool_timeout_ms),
        receiver,
    )
    .await;
    let output: ProxyToolResult = match response {
        Ok(Ok(output)) => output,
        Ok(Err(_)) => return Err(Error::internal_error().data("Proxy tool responder dropped")),
        Err(_) => {
            state.proxy_broker().clear(&call_id);
            return Err(ai_error_to_acp_error(AiError::ProxyTimeout(
                descriptor.name.clone(),
            )));
        }
    };

    if output.is_error {
        return Err(Error::internal_error().data(output.output));
    }
    Ok(output.output)
}

fn proxy_execution_approval_plan(tool_name: &str) -> MutationPlan {
    MutationPlan {
        summary: format!("Run proxy tool {tool_name} after user approval."),
        operations: Vec::new(),
    }
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

fn tool_error_to_acp_error(error: ToolError) -> Error {
    match error {
        ToolError::InvalidArguments(message) => Error::invalid_request().data(message),
        ToolError::ExecutionFailed(message) => Error::internal_error().data(message),
    }
}

fn mcp_tool_policy_error(mode: &ChatMode, descriptor: &ToolDescriptor) -> Option<Error> {
    (tool_permission_decision(mode.clone(), descriptor) == ToolPermissionDecision::Deny)
        .then(|| Error::invalid_request().data(tool_not_allowed_message(&descriptor.name, mode)))
}

fn ai_error_to_acp_error(error: AiError) -> Error {
    Error::internal_error().data(error.to_string())
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
            summary, warnings, ..
        } => {
            if warnings.is_empty() {
                format!("Partially applied: {summary}")
            } else {
                format!(
                    "Partially applied: {summary}\nWarnings: {}",
                    warnings.join("; ")
                )
            }
        }
        MutationApplyResult::Conflict { conflicts, .. } => {
            let details = conflicts
                .iter()
                .map(|conflict| format!("{}: {}", conflict.path, conflict.reason))
                .collect::<Vec<_>>()
                .join("; ");
            format!("Conflict: {details}")
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };

    use async_trait::async_trait;
    use parking_lot::RwLock;
    use serde_json::json;

    use crate::{
        AiError, AiHostBindings, AiNativeTool, AiState, ChatMode, MutationApplyResult, MutationOp,
        MutationPlan, NativeToolResult, ProxyToolDescriptor, ProxyToolResult, ToolAccess,
        ToolCallContext, ToolDescriptor, ToolError, ToolKind, ToolRiskLevel, ToolSource,
        agent_runtime::acp::{AcpSessionCapabilities, AcpSessionHandle},
    };

    use super::{
        SharedChatMode, allowed_mcp_tool_descriptors, complete_native_mcp_tool_result,
        complete_proxy_mcp_tool_call, current_mcp_mode, mcp_tool_descriptors,
        mcp_tool_policy_error,
    };

    struct TestTool {
        name: &'static str,
        access: ToolAccess,
    }

    struct ApplyingHost;

    #[async_trait]
    impl AiHostBindings for ApplyingHost {
        async fn apply_mutation(
            &self,
            _plan: MutationPlan,
        ) -> Result<MutationApplyResult, AiError> {
            Ok(MutationApplyResult::Applied {
                summary: "changed note.md".to_string(),
                warnings: Vec::new(),
            })
        }
    }

    #[async_trait]
    impl AiNativeTool for TestTool {
        fn descriptor(&self) -> ToolDescriptor {
            ToolDescriptor {
                tool_id: format!("builtin.{}", self.name),
                name: self.name.to_string(),
                description: format!("{} tool", self.name),
                parameters: json!({ "type": "object" }),
                category: "test".to_string(),
                kind: ToolKind::Read,
                requires_approval: self.access == ToolAccess::ProposesMutation,
                risk_level: ToolRiskLevel::Low,
                mode_availability: vec![ChatMode::Ask, ChatMode::Inline, ChatMode::Agent],
                permission_rule_key: format!("builtin.{}", self.name),
                access: self.access.clone(),
                source: ToolSource::Native,
            }
        }

        async fn call(
            &self,
            _ctx: &ToolCallContext<'_>,
            _args: serde_json::Value,
        ) -> Result<NativeToolResult, ToolError> {
            Ok(NativeToolResult {
                text: "ok".to_string(),
                mutation: None,
                preview_text: None,
            })
        }
    }

    #[test]
    fn mcp_bridge_exposes_registered_native_and_proxy_tools() {
        let state = AiState::default();
        for name in ["read_file", "custom_read", "edit_file"] {
            state.register_tool(Arc::new(TestTool {
                name,
                access: if name == "edit_file" {
                    ToolAccess::ProposesMutation
                } else {
                    ToolAccess::ReadOnly
                },
            }));
        }
        state
            .register_proxy_tool(proxy_descriptor(
                "memory_context",
                ToolAccess::ReadOnly,
                vec![ChatMode::Ask, ChatMode::Inline, ChatMode::Agent],
            ))
            .unwrap();
        state
            .register_proxy_tool(proxy_descriptor(
                "memory_propose",
                ToolAccess::ProposesMutation,
                vec![ChatMode::Agent],
            ))
            .unwrap();

        let descriptors = mcp_tool_descriptors(&state);
        let names = descriptors
            .iter()
            .map(|descriptor| descriptor.name.as_str())
            .collect::<Vec<_>>();

        assert_eq!(
            names,
            vec![
                "custom_read",
                "edit_file",
                "memory_context",
                "memory_propose",
                "read_file",
            ]
        );
    }

    #[test]
    fn mcp_bridge_filters_prompt_tools_by_current_mode_policy() {
        let state = AiState::default();
        for name in ["read_file", "create_file", "edit_file"] {
            state.register_tool(Arc::new(TestTool {
                name,
                access: if name == "read_file" {
                    ToolAccess::ReadOnly
                } else {
                    ToolAccess::ProposesMutation
                },
            }));
        }
        state
            .register_proxy_tool(proxy_descriptor(
                "memory_propose",
                ToolAccess::ProposesMutation,
                vec![ChatMode::Agent],
            ))
            .unwrap();

        let ask_names = allowed_mcp_tool_descriptors(&state, ChatMode::Ask)
            .into_iter()
            .map(|descriptor| descriptor.name)
            .collect::<Vec<_>>();
        let inline_names = allowed_mcp_tool_descriptors(&state, ChatMode::Inline)
            .into_iter()
            .map(|descriptor| descriptor.name)
            .collect::<Vec<_>>();
        let agent_names = allowed_mcp_tool_descriptors(&state, ChatMode::Agent)
            .into_iter()
            .map(|descriptor| descriptor.name)
            .collect::<Vec<_>>();

        assert_eq!(ask_names, vec!["read_file"]);
        assert_eq!(inline_names, vec!["edit_file", "read_file"]);
        assert_eq!(
            agent_names,
            vec!["create_file", "edit_file", "memory_propose", "read_file"]
        );
    }

    #[test]
    fn mcp_tool_context_reads_shared_current_mode() {
        let current_mode: SharedChatMode = Arc::new(RwLock::new(ChatMode::Ask));

        assert_eq!(current_mcp_mode(&current_mode), ChatMode::Ask);

        *current_mode.write() = ChatMode::Inline;

        assert_eq!(current_mcp_mode(&current_mode), ChatMode::Inline);
    }

    #[test]
    fn mcp_bridge_rejects_tools_disallowed_by_current_mode() {
        let edit_descriptor = TestTool {
            name: "edit_file",
            access: ToolAccess::ProposesMutation,
        }
        .descriptor();
        let read_descriptor = TestTool {
            name: "read_file",
            access: ToolAccess::ReadOnly,
        }
        .descriptor();

        assert!(mcp_tool_policy_error(&ChatMode::Ask, &edit_descriptor).is_some());
        assert!(mcp_tool_policy_error(&ChatMode::Inline, &edit_descriptor).is_none());
        assert!(mcp_tool_policy_error(&ChatMode::Agent, &edit_descriptor).is_none());
        assert!(mcp_tool_policy_error(&ChatMode::Ask, &read_descriptor).is_none());
    }

    #[tokio::test]
    async fn mcp_mutation_result_waits_for_user_approval_before_returning() {
        let state = AiState::default();
        state
            .insert_acp_session(
                "local-1".to_string(),
                AcpSessionHandle::with_capabilities_for_test(
                    "external-acp-session-1",
                    AcpSessionCapabilities::default(),
                ),
            )
            .unwrap();
        let descriptor = TestTool {
            name: "edit_file",
            access: ToolAccess::ProposesMutation,
        }
        .descriptor();
        let result = NativeToolResult {
            text: "Proposed edit".to_string(),
            mutation: Some(MutationPlan {
                summary: "Edit note.md".to_string(),
                operations: vec![MutationOp::ReplaceFile {
                    path: "note.md".to_string(),
                    content: "updated".to_string(),
                    expected_checksum: "old".to_string(),
                    before_excerpt: None,
                }],
            }),
            preview_text: Some("updated".to_string()),
        };
        let state_for_task = state.clone();
        let task = tokio::spawn(async move {
            complete_native_mcp_tool_result(
                state_for_task,
                "local-1".to_string(),
                "call-1".to_string(),
                descriptor,
                result,
                |_, _, _, _, _| {},
            )
            .await
        });
        tokio::task::yield_now().await;

        state.resolve_approval("local-1", "call-1", false).unwrap();

        assert_eq!(task.await.unwrap().unwrap(), "Rejected by user");
    }

    #[tokio::test]
    async fn mcp_mutation_result_applies_after_user_approval() {
        let state = AiState::default();
        state.set_host(Arc::new(ApplyingHost));
        state
            .insert_acp_session(
                "local-1".to_string(),
                AcpSessionHandle::with_capabilities_for_test(
                    "external-acp-session-1",
                    AcpSessionCapabilities::default(),
                ),
            )
            .unwrap();
        let descriptor = TestTool {
            name: "edit_file",
            access: ToolAccess::ProposesMutation,
        }
        .descriptor();
        let result = NativeToolResult {
            text: "Proposed edit".to_string(),
            mutation: Some(MutationPlan {
                summary: "Edit note.md".to_string(),
                operations: vec![MutationOp::ReplaceFile {
                    path: "note.md".to_string(),
                    content: "updated".to_string(),
                    expected_checksum: "old".to_string(),
                    before_excerpt: None,
                }],
            }),
            preview_text: Some("updated".to_string()),
        };
        let state_for_task = state.clone();
        let task = tokio::spawn(async move {
            complete_native_mcp_tool_result(
                state_for_task,
                "local-1".to_string(),
                "call-1".to_string(),
                descriptor,
                result,
                |_, _, _, _, _| {},
            )
            .await
        });
        tokio::task::yield_now().await;

        state.resolve_approval("local-1", "call-1", true).unwrap();

        assert_eq!(task.await.unwrap().unwrap(), "Applied: changed note.md");
    }

    #[tokio::test]
    async fn mcp_proxy_tool_waits_for_approval_before_dispatch() {
        let state = AiState::default();
        state
            .insert_acp_session(
                "local-1".to_string(),
                AcpSessionHandle::with_capabilities_for_test(
                    "external-acp-session-1",
                    AcpSessionCapabilities::default(),
                ),
            )
            .unwrap();
        let descriptor = proxy_descriptor(
            "memory_propose",
            ToolAccess::ProposesMutation,
            vec![ChatMode::Agent],
        )
        .as_tool_descriptor();
        let dispatch_count = Arc::new(AtomicUsize::new(0));
        let dispatch_count_for_call = dispatch_count.clone();
        let state_for_task = state.clone();
        let task = tokio::spawn(async move {
            complete_proxy_mcp_tool_call(
                state_for_task,
                "local-1".to_string(),
                "call-proxy-1".to_string(),
                descriptor,
                json!({ "topic": "memory" }),
                |_, _, _, _, _| {},
                move |_, _, _, _, _| {
                    dispatch_count_for_call.fetch_add(1, Ordering::SeqCst);
                },
            )
            .await
        });
        tokio::task::yield_now().await;

        assert_eq!(dispatch_count.load(Ordering::SeqCst), 0);
        state
            .resolve_approval("local-1", "call-proxy-1", false)
            .unwrap();

        assert_eq!(task.await.unwrap().unwrap(), "Rejected by user");
        assert_eq!(dispatch_count.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn mcp_proxy_tool_dispatches_through_proxy_broker() {
        let state = AiState::default();
        let descriptor = proxy_descriptor(
            "memory_context",
            ToolAccess::ReadOnly,
            vec![ChatMode::Ask, ChatMode::Inline, ChatMode::Agent],
        )
        .as_tool_descriptor();
        let dispatch_count = Arc::new(AtomicUsize::new(0));
        let dispatch_count_for_call = dispatch_count.clone();
        let state_for_call = state.clone();

        let output = complete_proxy_mcp_tool_call(
            state,
            "local-1".to_string(),
            "call-proxy-1".to_string(),
            descriptor,
            json!({ "topic": "memory" }),
            |_, _, _, _, _| {},
            move |_, call_id, _, _, _| {
                dispatch_count_for_call.fetch_add(1, Ordering::SeqCst);
                state_for_call
                    .proxy_broker()
                    .resolve(
                        call_id,
                        ProxyToolResult {
                            output: "proxy output".to_string(),
                            is_error: false,
                        },
                    )
                    .unwrap();
            },
        )
        .await
        .unwrap();

        assert_eq!(output, "proxy output");
        assert_eq!(dispatch_count.load(Ordering::SeqCst), 1);
    }

    fn proxy_descriptor(
        name: &str,
        access: ToolAccess,
        mode_availability: Vec<ChatMode>,
    ) -> ProxyToolDescriptor {
        ProxyToolDescriptor {
            tool_id: format!("proxy.{name}"),
            name: name.to_string(),
            description: format!("{name} proxy tool"),
            parameters: json!({ "type": "object" }),
            category: "test".to_string(),
            kind: Some(ToolKind::Other),
            requires_approval: None,
            risk_level: Some(ToolRiskLevel::Medium),
            mode_availability: Some(mode_availability),
            permission_rule_key: None,
            access: Some(access),
        }
    }
}
