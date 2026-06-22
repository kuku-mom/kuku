mod document_tools;
mod file_tools;
mod project_context;
mod project_memory_proposal;
mod project_memory_tools;
mod project_model;
#[cfg(test)]
mod project_model_tests;
mod project_proposal;
mod project_tool_common;
mod project_tools;
mod search_tools;
mod tool_ids;

use std::sync::Arc;

use kuku_ai::{AiNativeTool, register_tool};
use tauri::AppHandle;

use document_tools::{GetOutlineTool, GetTagsTool};
use file_tools::MoveFileTool;
use file_tools::{CreateFileTool, DeleteFileTool, EditFileTool, ListFilesTool, ReadFileTool};
use project_memory_tools::{
    ProjectProposeDecisionTool, ProjectProposeMeetingSummaryTool, ProjectProposeNextStepsTool,
    ProjectProposeScaffoldTool,
};
use project_tools::{
    ProjectContextTool, ProjectListTool, ProjectNextStepsTool, ProjectProposeAgentHandoffTool,
};
use search_tools::SearchVaultTool;

pub fn register_all(app: &AppHandle) {
    let tools: Vec<Arc<dyn AiNativeTool>> = vec![
        Arc::new(ReadFileTool),
        Arc::new(ListFilesTool),
        Arc::new(SearchVaultTool),
        Arc::new(CreateFileTool),
        Arc::new(EditFileTool),
        Arc::new(DeleteFileTool),
        Arc::new(MoveFileTool),
        Arc::new(GetOutlineTool),
        Arc::new(GetTagsTool),
        Arc::new(ProjectListTool),
        Arc::new(ProjectContextTool),
        Arc::new(ProjectNextStepsTool),
        Arc::new(ProjectProposeAgentHandoffTool),
        Arc::new(ProjectProposeScaffoldTool),
        Arc::new(ProjectProposeNextStepsTool),
        Arc::new(ProjectProposeDecisionTool),
        Arc::new(ProjectProposeMeetingSummaryTool),
    ];

    for tool in tools {
        register_tool(app, tool);
    }
}
