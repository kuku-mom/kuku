use async_trait::async_trait;
use kuku_ai::{
    AiNativeTool, NativeToolResult, ToolAccess, ToolCallContext, ToolDescriptor, ToolError,
    ToolKind, ToolRiskLevel, ToolSource,
};
use kuku_ai::ChatMode;
use tauri::Manager;

use crate::search::SearchState;

use super::tool_ids;

pub struct SearchVaultTool;

#[async_trait]
impl AiNativeTool for SearchVaultTool {
    fn descriptor(&self) -> ToolDescriptor {
        ToolDescriptor {
            tool_id: tool_ids::SEARCH_VAULT.into(),
            name: "search_vault".into(),
            description: "Search indexed markdown content in the vault".into(),
            parameters: serde_json::json!({
                "title": "search_vault",
                "type": "object",
                "properties": {
                    "query": { "type": "string" },
                    "max_results": { "type": "integer" }
                },
                "required": ["query"]
            }),
            category: "search".into(),
            kind: ToolKind::Search,
            requires_approval: false,
            risk_level: ToolRiskLevel::Low,
            mode_availability: vec![ChatMode::Ask, ChatMode::Inline, ChatMode::Agent],
            permission_rule_key: tool_ids::SEARCH_VAULT.into(),
            access: ToolAccess::ReadOnly,
            source: ToolSource::Native,
        }
    }

    async fn call(
        &self,
        ctx: &ToolCallContext<'_>,
        args: serde_json::Value,
    ) -> Result<NativeToolResult, ToolError> {
        let query = args
            .get("query")
            .and_then(|value| value.as_str())
            .ok_or_else(|| ToolError::InvalidArguments("Missing query".into()))?;
        let max_results = args
            .get("max_results")
            .and_then(|value| value.as_u64())
            .unwrap_or(20);

        let search = ctx.app.state::<SearchState>();
        let result = search
            .query_simple(query, max_results as usize)
            .map_err(ToolError::ExecutionFailed)?;

        Ok(NativeToolResult {
            text: serde_json::to_string_pretty(&result)
                .map_err(|error| ToolError::ExecutionFailed(error.to_string()))?,
            mutation: None,
            preview_text: None,
        })
    }
}
