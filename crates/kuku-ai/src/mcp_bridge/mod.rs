use std::sync::Arc;

use agent_client_protocol::{
    Agent, Error,
    mcp_server::{McpConnectionTo, McpServer, McpTool},
};
use parking_lot::RwLock;
use tauri::{AppHandle, Wry};
use uuid::Uuid;

use crate::{
    AiError, AiState, ChatMode, EditorContext, MutationApplyResult, MutationPlan, NativeToolResult,
    ToolAccess, ToolCallContext, ToolDescriptor, ToolError, ToolSource,
    agent_runtime::events::emit_pending_approval, session::ApprovalDecision,
};

const READ_ONLY_MCP_TOOL_NAMES: &[&str] = &[
    "read_file",
    "list_files",
    "search_vault",
    "get_outline",
    "get_tags",
];

const MUTATION_MCP_TOOL_NAMES: &[&str] = &["create_file", "edit_file", "delete_file", "move_file"];

pub(crate) fn bridged_tool_descriptors(state: &AiState) -> Vec<ToolDescriptor> {
    state
        .tools()
        .descriptors()
        .into_iter()
        .filter(|descriptor| {
            descriptor.source == ToolSource::Native
                && ((descriptor.access == ToolAccess::ReadOnly
                    && READ_ONLY_MCP_TOOL_NAMES.contains(&descriptor.name.as_str()))
                    || (descriptor.access == ToolAccess::ProposesMutation
                        && descriptor.requires_approval
                        && MUTATION_MCP_TOOL_NAMES.contains(&descriptor.name.as_str())))
        })
        .collect()
}

#[cfg(test)]
pub(crate) fn read_only_tool_descriptors(state: &AiState) -> Vec<ToolDescriptor> {
    bridged_tool_descriptors(state)
        .into_iter()
        .filter(|descriptor| descriptor.access == ToolAccess::ReadOnly)
        .collect()
}

pub(crate) type SharedEditorContext = Arc<RwLock<EditorContext>>;

pub(crate) fn read_only_mcp_server(
    app: AppHandle<Wry>,
    state: AiState,
    session_id: String,
    editor_context: SharedEditorContext,
) -> McpServer<Agent> {
    let mut builder = McpServer::<Agent>::builder("kuku")
        .instructions("Read-only Kuku vault tools. These tools can inspect vault content but cannot mutate files.");

    for descriptor in bridged_tool_descriptors(&state) {
        builder = builder.tool(KukuNativeMcpTool {
            app: app.clone(),
            state: state.clone(),
            session_id: session_id.clone(),
            editor_context: editor_context.clone(),
            descriptor,
        });
    }

    builder.build()
}

struct KukuNativeMcpTool {
    app: AppHandle<Wry>,
    state: AiState,
    session_id: String,
    editor_context: SharedEditorContext,
    descriptor: ToolDescriptor,
}

impl McpTool<Agent> for KukuNativeMcpTool {
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
        let tool = self
            .state
            .tools()
            .get_native(&self.descriptor.name)
            .ok_or_else(|| {
                Error::invalid_request().data(format!("unknown tool: {}", self.descriptor.name))
            })?;
        let editor_context = self.editor_context.read().clone();
        let ctx = ToolCallContext {
            app: &self.app,
            session_id: &self.session_id,
            mode: ChatMode::Agent,
            editor_context: &editor_context,
        };
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

fn tool_error_to_acp_error(error: ToolError) -> Error {
    match error {
        ToolError::InvalidArguments(message) => Error::invalid_request().data(message),
        ToolError::ExecutionFailed(message) => Error::internal_error().data(message),
    }
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
    use std::sync::Arc;

    use async_trait::async_trait;
    use serde_json::json;

    use crate::{
        AiError, AiHostBindings, AiNativeTool, AiState, ChatMode, MutationApplyResult, MutationOp,
        MutationPlan, NativeToolResult, ToolAccess, ToolCallContext, ToolDescriptor, ToolError,
        ToolKind, ToolRiskLevel, ToolSource,
        agent_runtime::acp::{AcpSessionCapabilities, AcpSessionHandle},
    };

    use super::{
        bridged_tool_descriptors, complete_native_mcp_tool_result, read_only_tool_descriptors,
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
    fn read_only_mcp_bridge_exposes_only_initial_safe_tool_set() {
        let state = AiState::default();
        for name in [
            "read_file",
            "list_files",
            "search_vault",
            "get_outline",
            "get_tags",
        ] {
            state.register_tool(Arc::new(TestTool {
                name,
                access: ToolAccess::ReadOnly,
            }));
        }
        state.register_tool(Arc::new(TestTool {
            name: "edit_file",
            access: ToolAccess::ProposesMutation,
        }));

        let descriptors = read_only_tool_descriptors(&state);
        let names = descriptors
            .iter()
            .map(|descriptor| descriptor.name.as_str())
            .collect::<Vec<_>>();

        assert_eq!(
            names,
            vec![
                "get_outline",
                "get_tags",
                "list_files",
                "read_file",
                "search_vault"
            ]
        );
        assert!(
            descriptors
                .iter()
                .all(|descriptor| descriptor.access == ToolAccess::ReadOnly)
        );
    }

    #[test]
    fn mcp_bridge_exposes_approved_mutation_tool_set() {
        let state = AiState::default();
        for name in ["create_file", "edit_file", "delete_file", "move_file"] {
            state.register_tool(Arc::new(TestTool {
                name,
                access: ToolAccess::ProposesMutation,
            }));
        }
        state.register_tool(Arc::new(TestTool {
            name: "dangerous_shell",
            access: ToolAccess::ProposesMutation,
        }));

        let descriptors = bridged_tool_descriptors(&state);
        let names = descriptors
            .iter()
            .map(|descriptor| descriptor.name.as_str())
            .collect::<Vec<_>>();

        assert_eq!(
            names,
            vec!["create_file", "delete_file", "edit_file", "move_file"]
        );
        assert!(descriptors.iter().all(|descriptor| {
            descriptor.access == ToolAccess::ProposesMutation && descriptor.requires_approval
        }));
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
}
