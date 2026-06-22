use async_trait::async_trait;
use chrono::Local;
use kuku_ai::{
    AiNativeTool, MutationOp, MutationPlan, NativeToolResult, ToolAccess, ToolCallContext,
    ToolDescriptor, ToolError,
};

use super::project_memory_proposal::{
    ProjectMemoryKind, build_memory_markdown_plan, build_next_steps_plan, build_scaffold_plan,
};
use super::project_tool_common::{
    descriptor, folder_arg, optional_string_arg, preview_excerpt, required_string_arg, vault_root,
};
use super::tool_ids;

pub struct ProjectProposeScaffoldTool;
pub struct ProjectProposeNextStepsTool;
pub struct ProjectProposeDecisionTool;
pub struct ProjectProposeMeetingSummaryTool;

#[async_trait]
impl AiNativeTool for ProjectProposeScaffoldTool {
    fn descriptor(&self) -> ToolDescriptor {
        descriptor(
            "project_propose_scaffold",
            tool_ids::PROJECT_PROPOSE_SCAFFOLD,
            "Propose missing Folder Agent standard files and folders for the selected project.",
            ToolAccess::ProposesMutation,
            folder_schema("project_propose_scaffold"),
        )
    }

    async fn call(
        &self,
        ctx: &ToolCallContext<'_>,
        args: serde_json::Value,
    ) -> Result<NativeToolResult, ToolError> {
        let folder = folder_arg(&args, ctx.editor_context.project_folder.as_deref())?;
        let root = vault_root(ctx.app)?;
        let Some(plan) = build_scaffold_plan(&root, &folder)
            .await
            .map_err(ToolError::ExecutionFailed)?
        else {
            return Ok(NativeToolResult {
                text: format!("Folder Agent files already exist for {}", folder.as_str()),
                mutation: None,
                preview_text: None,
            });
        };
        Ok(mutation_result(
            format!("Proposed Folder Agent setup for {}", folder.as_str()),
            plan,
        ))
    }
}

#[async_trait]
impl AiNativeTool for ProjectProposeNextStepsTool {
    fn descriptor(&self) -> ToolDescriptor {
        descriptor(
            "project_propose_next_steps",
            tool_ids::PROJECT_PROPOSE_NEXT_STEPS,
            "Propose a reviewed NEXT.md create or replacement for the selected Folder Agent project.",
            ToolAccess::ProposesMutation,
            serde_json::json!({
                "title": "project_propose_next_steps",
                "type": "object",
                "properties": {
                    "folder": {
                        "type": "string",
                        "description": "First-level vault folder name. Omit when a folder scope is selected."
                    },
                    "content": {
                        "type": "string",
                        "description": "Complete desired NEXT.md markdown content."
                    },
                    "summary": {
                        "type": "string",
                        "description": "Optional approval summary."
                    }
                },
                "required": ["content"]
            }),
        )
    }

    async fn call(
        &self,
        ctx: &ToolCallContext<'_>,
        args: serde_json::Value,
    ) -> Result<NativeToolResult, ToolError> {
        let folder = folder_arg(&args, ctx.editor_context.project_folder.as_deref())?;
        let content = required_string_arg(&args, "content")?;
        let summary = optional_string_arg(&args, "summary");
        let root = vault_root(ctx.app)?;
        let plan = build_next_steps_plan(&root, &folder, &content, summary.as_deref())
            .await
            .map_err(ToolError::ExecutionFailed)?;
        Ok(mutation_result(
            format!("Proposed NEXT.md update for {}", folder.as_str()),
            plan,
        ))
    }
}

#[async_trait]
impl AiNativeTool for ProjectProposeDecisionTool {
    fn descriptor(&self) -> ToolDescriptor {
        descriptor(
            "project_propose_decision",
            tool_ids::PROJECT_PROPOSE_DECISION,
            "Propose a reviewed decision note inside the selected Folder Agent project.",
            ToolAccess::ProposesMutation,
            memory_schema("project_propose_decision"),
        )
    }

    async fn call(
        &self,
        ctx: &ToolCallContext<'_>,
        args: serde_json::Value,
    ) -> Result<NativeToolResult, ToolError> {
        propose_memory(ctx, &args, ProjectMemoryKind::Decision).await
    }
}

#[async_trait]
impl AiNativeTool for ProjectProposeMeetingSummaryTool {
    fn descriptor(&self) -> ToolDescriptor {
        descriptor(
            "project_propose_meeting_summary",
            tool_ids::PROJECT_PROPOSE_MEETING_SUMMARY,
            "Propose a reviewed meeting summary inside the selected Folder Agent project.",
            ToolAccess::ProposesMutation,
            memory_schema("project_propose_meeting_summary"),
        )
    }

    async fn call(
        &self,
        ctx: &ToolCallContext<'_>,
        args: serde_json::Value,
    ) -> Result<NativeToolResult, ToolError> {
        propose_memory(ctx, &args, ProjectMemoryKind::Meeting).await
    }
}

async fn propose_memory(
    ctx: &ToolCallContext<'_>,
    args: &serde_json::Value,
    kind: ProjectMemoryKind,
) -> Result<NativeToolResult, ToolError> {
    let folder = folder_arg(args, ctx.editor_context.project_folder.as_deref())?;
    let title = required_string_arg(args, "title")?;
    let content = required_string_arg(args, "content")?;
    let date = optional_string_arg(args, "date").unwrap_or_else(today);
    let root = vault_root(ctx.app)?;
    let plan = build_memory_markdown_plan(&root, &folder, kind, &title, &content, &date)
        .await
        .map_err(ToolError::ExecutionFailed)?;
    Ok(mutation_result(
        format!(
            "Proposed {} for {}",
            kind_result_label(kind),
            folder.as_str()
        ),
        plan,
    ))
}

fn folder_schema(title: &str) -> serde_json::Value {
    serde_json::json!({
        "title": title,
        "type": "object",
        "properties": {
            "folder": {
                "type": "string",
                "description": "First-level vault folder name. Omit when a folder scope is selected."
            }
        },
        "required": []
    })
}

fn memory_schema(title: &str) -> serde_json::Value {
    serde_json::json!({
        "title": title,
        "type": "object",
        "properties": {
            "folder": {
                "type": "string",
                "description": "First-level vault folder name. Omit when a folder scope is selected."
            },
            "title": {
                "type": "string",
                "description": "Decision or meeting title."
            },
            "content": {
                "type": "string",
                "description": "Reviewed markdown body to record."
            },
            "date": {
                "type": "string",
                "description": "Optional YYYY-MM-DD date. Defaults to today."
            }
        },
        "required": ["title", "content"]
    })
}

fn mutation_result(text: String, plan: MutationPlan) -> NativeToolResult {
    NativeToolResult {
        text,
        preview_text: Some(plan_preview(&plan)),
        mutation: Some(plan),
    }
}

fn plan_preview(plan: &MutationPlan) -> String {
    plan.operations
        .iter()
        .find_map(|operation| match operation {
            MutationOp::CreateFile { content, .. } | MutationOp::ReplaceFile { content, .. } => {
                Some(preview_excerpt(content))
            }
            MutationOp::CreateDirectory { path } => Some(format!("Create directory {path}")),
            _ => None,
        })
        .unwrap_or_else(|| plan.summary.clone())
}

fn today() -> String {
    Local::now().format("%Y-%m-%d").to_string()
}

fn kind_result_label(kind: ProjectMemoryKind) -> &'static str {
    match kind {
        ProjectMemoryKind::Decision => "decision",
        ProjectMemoryKind::Meeting => "meeting summary",
    }
}
