use async_trait::async_trait;
use chrono::Local;
use kuku_ai::{
    AiNativeTool, MutationOp, MutationPlan, NativeToolResult, ToolAccess, ToolCallContext,
    ToolDescriptor, ToolError,
};

use super::project_context::{build_project_context, build_project_next_steps, discover_projects};
use super::project_proposal::build_handoff_proposal;
use super::project_tool_common::{
    descriptor, folder_arg, max_chars_arg, preview_excerpt, read_only_result, serialize,
    target_arg, vault_root,
};
use super::tool_ids;

pub struct ProjectListTool;
pub struct ProjectContextTool;
pub struct ProjectNextStepsTool;
pub struct ProjectProposeAgentHandoffTool;

#[async_trait]
impl AiNativeTool for ProjectListTool {
    fn descriptor(&self) -> ToolDescriptor {
        descriptor(
            "project_list",
            tool_ids::PROJECT_LIST,
            "List first-level vault folders as Folder Agent projects with PROJECT/NEXT/AGENTS status.",
            ToolAccess::ReadOnly,
            serde_json::json!({
                "title": "project_list",
                "type": "object",
                "properties": {}
            }),
        )
    }

    async fn call(
        &self,
        ctx: &ToolCallContext<'_>,
        _args: serde_json::Value,
    ) -> Result<NativeToolResult, ToolError> {
        let root = vault_root(ctx.app)?;
        let projects = discover_projects(&root)
            .await
            .map_err(ToolError::ExecutionFailed)?;

        Ok(read_only_result(serialize(&projects)?))
    }
}

#[async_trait]
impl AiNativeTool for ProjectContextTool {
    fn descriptor(&self) -> ToolDescriptor {
        descriptor(
            "project_context",
            tool_ids::PROJECT_CONTEXT,
            "Assemble a read-only Folder Agent context bundle for one first-level project folder.",
            ToolAccess::ReadOnly,
            serde_json::json!({
                "title": "project_context",
                "type": "object",
                "properties": {
                    "folder": {
                        "type": "string",
                        "description": "First-level vault folder name. Omit when a folder scope is selected."
                    },
                    "max_chars": {
                        "type": "integer",
                        "description": "Optional total content character budget. Defaults to 24000."
                    }
                },
                "required": []
            }),
        )
    }

    async fn call(
        &self,
        ctx: &ToolCallContext<'_>,
        args: serde_json::Value,
    ) -> Result<NativeToolResult, ToolError> {
        let folder = folder_arg(&args, ctx.editor_context.project_folder.as_deref())?;
        let max_chars = max_chars_arg(&args)?;
        let root = vault_root(ctx.app)?;
        let bundle = build_project_context(&root, &folder, max_chars)
            .await
            .map_err(ToolError::ExecutionFailed)?;

        Ok(read_only_result(serialize(&bundle)?))
    }
}

#[async_trait]
impl AiNativeTool for ProjectNextStepsTool {
    fn descriptor(&self) -> ToolDescriptor {
        descriptor(
            "project_next_steps",
            tool_ids::PROJECT_NEXT_STEPS,
            "Read NEXT.md for one Folder Agent project without mutating the vault.",
            ToolAccess::ReadOnly,
            serde_json::json!({
                "title": "project_next_steps",
                "type": "object",
                "properties": {
                    "folder": {
                        "type": "string",
                        "description": "First-level vault folder name. Omit when a folder scope is selected."
                    }
                },
                "required": []
            }),
        )
    }

    async fn call(
        &self,
        ctx: &ToolCallContext<'_>,
        args: serde_json::Value,
    ) -> Result<NativeToolResult, ToolError> {
        let folder = folder_arg(&args, ctx.editor_context.project_folder.as_deref())?;
        let root = vault_root(ctx.app)?;
        let next_steps = build_project_next_steps(&root, &folder)
            .await
            .map_err(ToolError::ExecutionFailed)?;

        Ok(read_only_result(serialize(&next_steps)?))
    }
}

#[async_trait]
impl AiNativeTool for ProjectProposeAgentHandoffTool {
    fn descriptor(&self) -> ToolDescriptor {
        descriptor(
            "project_propose_agent_handoff",
            tool_ids::PROJECT_PROPOSE_AGENT_HANDOFF,
            "Create a reviewable handoff Markdown proposal for Codex, Hermes, or another agent.",
            ToolAccess::ProposesMutation,
            serde_json::json!({
                "title": "project_propose_agent_handoff",
                "type": "object",
                "properties": {
                    "folder": {
                        "type": "string",
                        "description": "First-level vault folder name. Omit when a folder scope is selected."
                    },
                    "target": {
                        "type": "string",
                        "description": "Agent target slug. Defaults to codex."
                    },
                    "max_chars": {
                        "type": "integer",
                        "description": "Optional source context character budget. Defaults to 24000."
                    }
                },
                "required": []
            }),
        )
    }

    async fn call(
        &self,
        ctx: &ToolCallContext<'_>,
        args: serde_json::Value,
    ) -> Result<NativeToolResult, ToolError> {
        let folder = folder_arg(&args, ctx.editor_context.project_folder.as_deref())?;
        let target = target_arg(&args)?;
        let max_chars = max_chars_arg(&args)?;
        let root = vault_root(ctx.app)?;
        let bundle = build_project_context(&root, &folder, max_chars)
            .await
            .map_err(ToolError::ExecutionFailed)?;
        let date = Local::now().format("%Y-%m-%d").to_string();
        let proposal = build_handoff_proposal(&folder, &target, &bundle, &date);
        let plan = MutationPlan {
            summary: format!("Create {target} handoff proposal for {}", folder.as_str()),
            operations: vec![MutationOp::CreateFile {
                path: proposal.path.clone(),
                content: proposal.content.clone(),
            }],
        };

        Ok(NativeToolResult {
            text: format!("Proposed handoff document at {}", proposal.path),
            mutation: Some(plan),
            preview_text: Some(preview_excerpt(&proposal.content)),
        })
    }
}
